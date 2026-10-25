import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Item } from '@osrs-tracker/models';
import { Collection, Db } from 'mongodb';
import { isDeepStrictEqual } from 'node:util';
import { Agent, fetch } from 'undici';
import { AGENT, USER_AGENT } from '../common/agent/agent.provider';
import { ITEMS_COLLECTION } from '../common/mongo/collections';
import { MONGODB_DATABASE } from '../common/mongo/mongo.provider';
import {
  ITEMS_FETCH_TIMEOUT_MS,
  ITEMS_REFRESH_CRON,
  ITEMS_REFRESH_INTERVAL_MS,
  MAX_REMOVED_ITEMS,
} from './ingester.config';
import { JobRunsService } from './job-runs.service';

/** The OSRS Wiki's list of every GE item, with its static fields (no prices). */
export const ITEM_MAPPING_URL = 'https://prices.runescape.wiki/api/v2/osrs/mapping';

/**
 * Unobtainable copies of real items that Jagex leaves listed on the GE, examined as just "placeholder" (`Placeholder`,
 * a Hallowfell copy; `Dummy stymphike feather`). They never trade, so they're left out of `items`.
 */
const isPlaceholder = (item: Item) => /^placeholder\.?$/i.test(item.examine ?? '');

/**
 * Keeps `items` a copy of the OSRS Wiki's item list, every hour: upserts the items that are new or changed, then deletes
 * the ones the list no longer has. Ported from osrs-tracker-aws's refresh-items Lambda.
 */
@Injectable()
export class ItemsRefreshService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Items');
  private readonly items: Collection<Item>;

  constructor(
    @Inject(MONGODB_DATABASE) db: Db,
    @Inject(AGENT) private readonly agent: Agent,
    private readonly jobs: JobRunsService,
  ) {
    this.items = db.collection<Item>(ITEMS_COLLECTION);
  }

  onApplicationBootstrap(): void {
    void this.jobs.catchUp('items', ITEMS_REFRESH_INTERVAL_MS, (signal) => this.refresh(signal));
  }

  @Cron(ITEMS_REFRESH_CRON, { name: 'items', timeZone: 'UTC', waitForCompletion: true })
  scheduled(): Promise<void> {
    return this.jobs.run('items', (signal) => this.refresh(signal));
  }

  /**
   * Upserts by `id` with `$set` of the Wiki's object (a field it omits keeps its stored value) only the items that are
   * new or differ from the stored copy in a field the Wiki sends: the list changes only on game updates, and writing
   * every item each hour showed as a spike of ~4,700 ops. A new item gets `addedAt` and every written one `updatedAt`
   * (one time per run), so `updatedAt` moves only when a Wiki field changed: the comparison iterates the Wiki's keys, so
   * the stored dates never count as a change. Then deletes the items missing from the list (taken off the GE), unless
   * more than `MAX_REMOVED_ITEMS` would go, so a truncated response never wipes the collection. Placeholders
   * (`isPlaceholder`) count as missing.
   */
  async refresh(signal: AbortSignal): Promise<void> {
    const list = await this.fetchItems(signal);
    const stored = new Map(
      (await this.items.find({}, { projection: { _id: 0, lastFetch: 0 } }).toArray()).map((item) => [item.id, item]),
    );

    const changed = list.filter((item) => {
      const current = stored.get(item.id);
      return (
        !current || (Object.keys(item) as (keyof Item)[]).some((key) => !isDeepStrictEqual(current[key], item[key]))
      );
    });
    // bulkWrite rejects an empty batch
    if (changed.length) {
      const now = new Date();
      await this.items.bulkWrite(
        changed.map((item) => ({
          updateOne: {
            filter: { id: item.id },
            hint: { id: 1 },
            update: { $set: { ...item, updatedAt: now }, $setOnInsert: { addedAt: now } },
            upsert: true,
          },
        })),
      );
    }
    signal.throwIfAborted();

    const listed = new Set(list.map(({ id }) => id));
    const removable = [...stored.keys()].filter((id) => !listed.has(id)).length;
    const removed = await this.removeItemsNotIn([...listed], removable);
    this.logger.log(`Items refreshed: ${changed.length} changed, ${removed} removed`, {
      fetched: list.length,
      changed: changed.length,
    });
  }

  private async fetchItems(signal: AbortSignal): Promise<Item[]> {
    const response = await fetch(ITEM_MAPPING_URL, {
      headers: { 'user-agent': USER_AGENT },
      dispatcher: this.agent,
      signal: AbortSignal.any([signal, AbortSignal.timeout(ITEMS_FETCH_TIMEOUT_MS)]),
    });
    if (!response.ok) throw new Error(`Item mapping request failed: HTTP ${response.status}`);

    const list = (await response.json()) as Item[];
    if (!Array.isArray(list)) throw new Error('Item mapping response has no items');

    const items = list.filter((item) => !isPlaceholder(item));
    // bulkWrite rejects an empty batch with a less telling error
    if (!items.length) throw new Error('Item mapping response has no items');
    return items;
  }

  /**
   * Deletes the items whose `id` isn't in `ids` (`removable` of the stored ones) and returns how many, or 0 with a
   * warning when over the limit.
   */
  private async removeItemsNotIn(ids: number[], removable: number): Promise<number> {
    if (removable > MAX_REMOVED_ITEMS) {
      this.logger.warn(
        `Skipped removing ${removable} items missing from the Wiki's list: more than ${MAX_REMOVED_ITEMS}`,
      );
      return 0;
    }
    if (removable === 0) return 0;

    const { deletedCount } = await this.items.deleteMany({ id: { $nin: ids } }, { hint: { id: 1 } });
    return deletedCount;
  }
}
