import { Inject, Injectable } from '@nestjs/common';
import {
  createHiscoreLayout,
  decodeHiscoreEntries,
  HiscoreEntry,
  HiscoreLayout,
  HiscoreLayoutNames,
  hiscoreLayoutIds,
  StoredHiscoreEntry,
  UnknownHiscoreLayoutError,
} from '@osrs-tracker/models';
import { LRUCache } from 'lru-cache';
import { Collection, Db } from 'mongodb';
import { MONGODB_DATABASE } from '../../common/mongo/mongo.provider';

export const HISCORE_LAYOUTS_COLLECTION = 'hiscoreLayouts';

/** Layouts in memory. They never change, so there's no ttl; few exist, so a small `max` holds them all. */
const MAX_CACHED_LAYOUTS = 100;

/** The `hiscoreLayouts` documents: the skill and activity names a stored hiscore entry's arrays follow. */
@Injectable()
export class HiscoreLayoutsService {
  private readonly collection: Collection<HiscoreLayout>;

  /** Loads unknown ids on demand; `forceFetch` shares a load in flight per id and doesn't cache a rejection. */
  private readonly cache = new LRUCache<number, HiscoreLayout>({
    max: MAX_CACHED_LAYOUTS,
    fetchMethod: async (id) => {
      const layout = await this.collection.findOne({ _id: id });
      if (!layout) throw new UnknownHiscoreLayoutError(id);
      return layout;
    },
  });

  constructor(@Inject(MONGODB_DATABASE) db: Db) {
    this.collection = db.collection<HiscoreLayout>(HISCORE_LAYOUTS_COLLECTION);
  }

  /**
   * Stores the layout for `names` if it's new (call before writing the entry that uses it) and returns it. Throws when
   * a stored layout with the same id has other names (a hash collision).
   */
  async ensure(names: HiscoreLayoutNames): Promise<HiscoreLayout> {
    const layout = createHiscoreLayout(names, new Date());
    const cached = this.cache.get(layout._id);
    if (cached && sameNames(cached, names)) return cached;

    // An update document, not a pipeline: values are stored as given, no `$literal` needed. A concurrent upsert of the
    // same `_id` that hits a duplicate key error is retried by MongoDB itself.
    const stored = await this.collection.findOneAndUpdate(
      { _id: layout._id },
      { $setOnInsert: { skills: layout.skills, activities: layout.activities, since: layout.since } },
      { upsert: true, returnDocument: 'after' },
    );
    if (!stored) throw new Error(`Upserting hiscore layout ${layout._id} returned no document`);
    if (!sameNames(stored, names)) {
      throw new Error(`Hiscore layout ${layout._id} is stored with other names (a layout id collision)`);
    }
    this.cache.set(stored._id, stored);
    return stored;
  }

  /** Decodes one player's stored entries (newest first, as stored), loading every layout they use first. */
  async decode(entries: readonly StoredHiscoreEntry[]): Promise<HiscoreEntry[]> {
    if (entries.length === 0) return [];
    const layouts = await Promise.all(hiscoreLayoutIds(entries).map((id) => this.cache.forceFetch(id)));
    return decodeHiscoreEntries(entries, new Map(layouts.map((layout) => [layout._id, layout])));
  }
}

/** Whether `layout` has exactly `names`, in the same order. */
function sameNames(layout: HiscoreLayoutNames, names: HiscoreLayoutNames): boolean {
  return sameArray(layout.skills, names.skills) && sameArray(layout.activities, names.activities);
}

function sameArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
