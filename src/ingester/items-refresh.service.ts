import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Item } from '@osrs-tracker/models';
import { Collection, Db } from 'mongodb';
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
 * Keeps `items` a copy of the OSRS Wiki's item list, every hour: upserts every item, then deletes the ones the list no
 * longer has. Ported from osrs-tracker-aws's refresh-items Lambda.
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
   * Upserts each item by `id` with `$set` of the Wiki's object (a field it omits keeps its stored value), then deletes
   * the items missing from the list (taken off the GE), unless more than `MAX_REMOVED_ITEMS` would go, so a truncated
   * response never wipes the collection.
   */
  async refresh(signal: AbortSignal): Promise<void> {
    const list = await this.fetchItems(signal);

    const { matchedCount, upsertedCount } = await this.items.bulkWrite(
      list.map((item) => ({
        updateOne: { filter: { id: item.id }, hint: { id: 1 }, update: { $set: item }, upsert: true },
      })),
    );
    const upserted = matchedCount + upsertedCount;
    signal.throwIfAborted();

    const removed = await this.removeItemsNotIn(list.map(({ id }) => id));
    this.logger.log(`Items refreshed: ${upserted} upserted, ${removed} removed`, { fetched: list.length, upserted });
  }

  private async fetchItems(signal: AbortSignal): Promise<Item[]> {
    const response = await fetch(ITEM_MAPPING_URL, {
      headers: { 'user-agent': USER_AGENT },
      dispatcher: this.agent,
      signal: AbortSignal.any([signal, AbortSignal.timeout(ITEMS_FETCH_TIMEOUT_MS)]),
    });
    if (!response.ok) throw new Error(`Item mapping request failed: HTTP ${response.status}`);

    const list = (await response.json()) as Item[];
    // bulkWrite rejects an empty batch with a less telling error
    if (!Array.isArray(list) || !list.length) throw new Error('Item mapping response has no items');
    return list;
  }

  /** Deletes the items whose `id` isn't in `ids` and returns how many, or 0 with a warning when over the limit. */
  private async removeItemsNotIn(ids: number[]): Promise<number> {
    const filter = { id: { $nin: ids } };
    const removable = await this.items.countDocuments(filter, { hint: { id: 1 } });

    if (removable > MAX_REMOVED_ITEMS) {
      this.logger.warn(
        `Skipped removing ${removable} items missing from the Wiki's list: more than ${MAX_REMOVED_ITEMS}`,
      );
      return 0;
    }
    if (removable === 0) return 0;

    const { deletedCount } = await this.items.deleteMany(filter, { hint: { id: 1 } });
    return deletedCount;
  }
}
