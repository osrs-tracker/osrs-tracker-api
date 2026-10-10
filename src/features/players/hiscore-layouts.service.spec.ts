import {
  createHiscoreLayout,
  encodeHiscoreEntry,
  HiscoreEntry,
  HiscoreLayout,
  HiscoreLayoutNames,
  UnknownHiscoreLayoutError,
} from '@osrs-tracker/models';
import { Db } from 'mongodb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HISCORE_LAYOUTS_COLLECTION, HiscoreLayoutsService } from './hiscore-layouts.service';

const OLD_NAMES: HiscoreLayoutNames = { skills: ['Overall', 'Attack'], activities: ['Clue Scrolls (all)'] };
// 'Sailing' stands in for a skill Jagex adds that neither enum knows yet.
const NEW_NAMES: HiscoreLayoutNames = { skills: ['Overall', 'Attack', 'Sailing'], activities: ['Clue Scrolls (all)'] };

const OLD_LAYOUT = createHiscoreLayout(OLD_NAMES, new Date('2026-01-01T00:00:00Z'));
const NEW_LAYOUT = createHiscoreLayout(NEW_NAMES, new Date('2026-10-01T00:00:00Z'));

const NEW_ENTRY: HiscoreEntry = {
  date: new Date('2026-10-02T00:00:00Z'),
  scrapingOffset: 3,
  skills: {
    Overall: { rank: 10, level: 200, xp: 30_000 },
    Attack: { rank: 20, level: 40, xp: 37_224 },
    Sailing: { rank: null, level: 1, xp: 0 },
  },
  activities: { 'Clue Scrolls (all)': { rank: 5, score: 12 } },
};
const OLD_ENTRY: HiscoreEntry = {
  date: new Date('2026-09-01T00:00:00Z'),
  scrapingOffset: 3,
  skills: { Overall: { rank: 11, level: 190, xp: 25_000 }, Attack: { rank: 21, level: 35, xp: 22_406 } },
  activities: { 'Clue Scrolls (all)': null },
};
const STORED = [encodeHiscoreEntry(NEW_ENTRY, NEW_LAYOUT), encodeHiscoreEntry(OLD_ENTRY, OLD_LAYOUT)];

describe('HiscoreLayoutsService', () => {
  let stored: Map<number, HiscoreLayout>;
  let findOne: ReturnType<typeof vi.fn>;
  let findOneAndUpdate: ReturnType<typeof vi.fn>;
  let collection: ReturnType<typeof vi.fn>;
  let service: HiscoreLayoutsService;

  beforeEach(() => {
    stored = new Map([
      [OLD_LAYOUT._id, OLD_LAYOUT],
      [NEW_LAYOUT._id, NEW_LAYOUT],
    ]);
    findOne = vi.fn(async ({ _id }: { _id: number }) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return stored.get(_id) ?? null;
    });
    findOneAndUpdate = vi.fn(
      async ({ _id }: { _id: number }, { $setOnInsert }: { $setOnInsert: Omit<HiscoreLayout, '_id'> }) => {
        if (!stored.has(_id)) stored.set(_id, { _id, ...$setOnInsert });
        return stored.get(_id);
      },
    );
    collection = vi.fn(() => ({ findOne, findOneAndUpdate }));
    service = new HiscoreLayoutsService({ collection } as unknown as Db);
  });

  it('uses the hiscoreLayouts collection', () => {
    expect(collection).toHaveBeenCalledWith(HISCORE_LAYOUTS_COLLECTION);
  });

  describe('decode', () => {
    it('decodes entries across layouts, loading each distinct layout once, also when decodes run concurrently', async () => {
      const [first, second] = await Promise.all([service.decode(STORED), service.decode(STORED)]);

      expect(first).toEqual([NEW_ENTRY, OLD_ENTRY]);
      expect(second).toEqual(first);
      expect(findOne).toHaveBeenCalledTimes(2);
      expect(findOne.mock.calls.map(([filter]) => filter)).toEqual([{ _id: NEW_LAYOUT._id }, { _id: OLD_LAYOUT._id }]);
    });

    it('serves layouts from the cache on a later decode', async () => {
      await service.decode(STORED);
      await service.decode(STORED);

      expect(findOne).toHaveBeenCalledTimes(2);
    });

    it('returns [] for no entries without a database call', async () => {
      await expect(service.decode([])).resolves.toEqual([]);
      expect(findOne).not.toHaveBeenCalled();
    });

    it('throws UnknownHiscoreLayoutError for a layout id not in the database, and retries it next time', async () => {
      stored.delete(OLD_LAYOUT._id);

      await expect(service.decode(STORED)).rejects.toEqual(new UnknownHiscoreLayoutError(OLD_LAYOUT._id));
      await expect(service.decode(STORED)).rejects.toBeInstanceOf(UnknownHiscoreLayoutError);
      expect(findOne.mock.calls.filter(([filter]) => filter._id === OLD_LAYOUT._id)).toHaveLength(2);
    });
  });

  describe('ensure', () => {
    it('upserts a new layout once, then serves it from the cache', async () => {
      stored.clear();
      const names: HiscoreLayoutNames = { skills: [...NEW_NAMES.skills], activities: [...NEW_NAMES.activities] };

      const layout = await service.ensure(names);
      const again = await service.ensure(names);

      expect(layout).toMatchObject({ _id: NEW_LAYOUT._id, ...NEW_NAMES });
      expect(again).toBe(layout);
      expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
      expect(findOneAndUpdate).toHaveBeenCalledWith(
        { _id: NEW_LAYOUT._id },
        { $setOnInsert: { ...NEW_NAMES, since: expect.any(Date) } },
        { upsert: true, returnDocument: 'after' },
      );
      // The layout ensure stored decodes without loading it.
      await expect(service.decode([STORED[0]])).resolves.toEqual([NEW_ENTRY]);
      expect(findOne).not.toHaveBeenCalled();
    });

    it('returns the stored layout (with its original since) when it already exists', async () => {
      await expect(service.ensure(OLD_NAMES)).resolves.toBe(OLD_LAYOUT);
    });

    it('throws on a collision: a stored layout with the same id but other names', async () => {
      stored.set(OLD_LAYOUT._id, { ...OLD_LAYOUT, skills: ['Overall', 'Defence'] });

      await expect(service.ensure(OLD_NAMES)).rejects.toThrow(`Hiscore layout ${OLD_LAYOUT._id}`);
      // Not cached: the next call asks the database again.
      await expect(service.ensure(OLD_NAMES)).rejects.toThrow('collision');
      expect(findOneAndUpdate).toHaveBeenCalledTimes(2);
    });

    it('throws when the names differ only in order', async () => {
      stored.set(OLD_LAYOUT._id, { ...OLD_LAYOUT, skills: ['Attack', 'Overall'] });

      await expect(service.ensure(OLD_NAMES)).rejects.toThrow('collision');
    });
  });
});
