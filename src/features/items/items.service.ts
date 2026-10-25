import { Inject, Injectable, Logger } from '@nestjs/common';
import { Item } from '@osrs-tracker/models';
import { LRUCache } from 'lru-cache';
import { Collection, Db } from 'mongodb';
import { ITEMS_COLLECTION } from '../../common/mongo/collections';
import { ITEM_NAME_COLLATION, MONGODB_DATABASE } from '../../common/mongo/mongo.provider';
import { buildItemBrowseFilter } from './item-browse';
import { ItemSearchIndex, ItemSearchResult } from './item-search';

/** How long item search uses the item names it loaded: the hourly items refresh adds new items at most once an hour. */
export const ITEM_SEARCH_TTL_MS = 600_000;
/** After a failed reload, search the stale names this long before retrying. */
export const ITEM_SEARCH_RETRY_MS = 60_000;

@Injectable()
export class ItemsService {
  private readonly logger = new Logger(ItemsService.name);
  private readonly collection: Collection<Item>;

  /**
   * Every item's name, searched in memory (about 4.7k items), since self-managed MongoDB has no Atlas Search. `forceFetch`
   * shares one load between concurrent searches; `loadSearchIndex` keeps the stale names when Mongo fails.
   */
  private readonly searchIndex = new LRUCache<'items', ItemSearchIndex>({
    max: 1,
    ttl: ITEM_SEARCH_TTL_MS,
    fetchMethod: (_key, staleIndex, { options }) => this.loadSearchIndex(staleIndex, options),
  });

  constructor(@Inject(MONGODB_DATABASE) db: Db) {
    this.collection = db.collection(ITEMS_COLLECTION);
  }

  getLastFetchedItems(limit: number): Promise<Item[]> {
    return this.collection
      .find<Item>(
        {
          lastFetch: { $exists: true }, // Ensure lastFetch exists
        },
        {
          hint: { lastFetch: -1 }, // Use the index on lastFetch
          projection: { _id: 0, id: 1, icon: 1, name: 1, lastFetch: 1 }, // Include lastFetch in the projection
        },
      )
      .sort({ lastFetch: -1 }) // Sort by lastFetch in descending order
      .limit(limit)
      .toArray();
  }

  /** The items with an `addedAt` (all of them since the 2026-10-25 backfill), newest first. */
  getNewItems(limit: number): Promise<Item[]> {
    return this.collection
      .find<Item>(
        { addedAt: { $exists: true } },
        { hint: { addedAt: -1 }, projection: { _id: 0, id: 1, icon: 1, name: 1, addedAt: 1 } },
      )
      .sort({ addedAt: -1 })
      .limit(limit)
      .toArray();
  }

  getItem(id: number): Promise<Item | null> {
    return this.collection.findOne<Item>({ id: id }, { hint: { id: 1 }, projection: { _id: 0 } });
  }

  /** Records a visitor's lookup for the recent items list. Doesn't create unknown items. */
  async recordLookup(id: number): Promise<void> {
    await this.collection.updateOne({ id: id }, { $set: { lastFetch: new Date() } }, { hint: { id: 1 } });
  }

  /** The items whose name starts with `letter` (see `buildItemBrowseFilter`), by name case-insensitively. */
  browseItems(letter: string): Promise<Item[]> {
    return this.collection
      .find<Item>(buildItemBrowseFilter(letter), {
        collation: ITEM_NAME_COLLATION, // The `{ name: 1 }` index's, or Mongo can't use it
        hint: { name: 1 },
        projection: { _id: 0, id: 1, icon: 1, name: 1, updatedAt: 1 },
      })
      .sort({ name: 1 })
      .toArray();
  }

  async searchItems(query: string): Promise<ItemSearchResult[]> {
    return (await this.searchIndex.forceFetch('items')).search(query);
  }

  /**
   * The search cache's `fetchMethod`. When Mongo fails, searches the stale names for `ITEM_SEARCH_RETRY_MS` if there
   * are any, else rejects (not cached, so the next search retries).
   */
  private async loadSearchIndex(
    staleIndex: ItemSearchIndex | undefined,
    options: LRUCache.FetcherFetchOptions<'items', ItemSearchIndex>,
  ): Promise<ItemSearchIndex> {
    try {
      return new ItemSearchIndex(
        await this.collection.find<ItemSearchResult>({}, { projection: { _id: 0, id: 1, icon: 1, name: 1 } }).toArray(),
      );
    } catch (error) {
      if (!staleIndex) throw error;

      this.logger.warn(`Reloading the item names for search failed, searching the cached ones: ${error}`);
      options.ttl = ITEM_SEARCH_RETRY_MS; // the stale index is stored again with this ttl, so it's retried sooner
      return staleIndex;
    }
  }
}
