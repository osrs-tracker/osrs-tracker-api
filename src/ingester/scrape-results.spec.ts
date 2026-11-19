import { StoredHiscoreEntry } from '@osrs-tracker/models';
import { describe, expect, it } from 'vitest';
import {
  hiscoreEntryUpdate,
  parseScrapeResult,
  pausedByNotFound,
  playerCountDaysPipeline,
  playerCountUpsert,
  slotStart,
  startOfUTCDay,
  UnknownScrapeResultError,
} from './scrape-results';

const entry = (o: number, d: string): StoredHiscoreEntry => ({ d: new Date(d), o, l: 1, s: [], a: [] });

/** Whether the built filter's guard lets `next` be stored, evaluating its `$not: { $elemMatch }` on `stored`. */
function guardStores(stored: StoredHiscoreEntry[], next: StoredHiscoreEntry): boolean {
  const { filter } = hiscoreEntryUpdate('toxsick', next);
  const { o, d } = (filter.hiscoreEntries as { $not: { $elemMatch: { o: number; d: { $gte: Date } } } }).$not
    .$elemMatch;
  return !stored.some((e) => e.o === o && e.d >= d.$gte);
}

describe('slotStart', () => {
  it('is the hour queue-players queues the offset at, at or before the scrape', () => {
    expect(slotStart(0, new Date('2026-10-21T00:00:00Z'))).toEqual(new Date('2026-10-21T00:00:00Z'));
    expect(slotStart(0, new Date('2026-10-21T00:00:42.123Z'))).toEqual(new Date('2026-10-21T00:00:00Z'));
    expect(slotStart(5, new Date('2026-10-21T07:59:59Z'))).toEqual(new Date('2026-10-21T05:00:00Z'));
  });

  it('puts a negative offset at hour 24 + offset, the day before when scraped after midnight', () => {
    expect(slotStart(-1, new Date('2026-10-21T23:00:30Z'))).toEqual(new Date('2026-10-21T23:00:00Z'));
    // a retried scrape of the 23:00 slot that ran after midnight
    expect(slotStart(-1, new Date('2026-10-22T00:10:00Z'))).toEqual(new Date('2026-10-21T23:00:00Z'));
  });

  it('gives offsets 12 and -12 the same hour, 12', () => {
    const scrapedAt = new Date('2026-10-21T12:00:30Z');
    expect(slotStart(12, scrapedAt)).toEqual(new Date('2026-10-21T12:00:00Z'));
    expect(slotStart(-12, scrapedAt)).toEqual(new Date('2026-10-21T12:00:00Z'));
  });

  it("is the previous day's slot when scraped just before the slot's hour", () => {
    expect(slotStart(0, new Date('2026-10-21T23:59:59Z'))).toEqual(new Date('2026-10-21T00:00:00Z'));
  });
});

describe('hiscoreEntryUpdate slot guard', () => {
  const stored = [entry(0, '2026-10-21T00:00:30Z')];

  it('skips a duplicate delivery of the stored entry', () => {
    expect(guardStores(stored, entry(0, '2026-10-21T00:00:30Z'))).toBe(false);
  });

  it('skips a second scrape of the same slot', () => {
    expect(guardStores(stored, entry(0, '2026-10-21T00:40:00Z'))).toBe(false);
  });

  it('skips a late entry older than a stored one', () => {
    expect(guardStores([entry(0, '2026-10-22T00:00:30Z'), ...stored], entry(0, '2026-10-21T00:00:30Z'))).toBe(false);
  });

  it("stores the next day's entry", () => {
    expect(guardStores(stored, entry(0, '2026-10-22T00:00:20Z'))).toBe(true);
  });

  it("stores an entry when only another offset's entry is newer", () => {
    expect(guardStores([entry(5, '2026-10-21T05:00:30Z')], entry(0, '2026-10-21T00:00:30Z'))).toBe(true);
  });

  it('stores the first entry of a player without entries', () => {
    expect(guardStores([], entry(0, '2026-10-21T00:00:30Z'))).toBe(true);
  });

  it('filters on the username and ends the not-found streak in the same update', () => {
    const { filter, update } = hiscoreEntryUpdate('toxsick', entry(0, '2026-10-21T00:00:30Z'));
    expect(filter).toMatchObject({ username: 'toxsick' });
    expect(update[1]).toEqual({ $unset: ['hiscoreNotFoundCount', 'hiscoreNotFoundSince'] });
  });
});

describe('pausedByNotFound', () => {
  const scrapedAt = new Date('2026-10-21T00:00:30Z');

  it('pauses once the streak started 7 days before the scrape', () => {
    const since = new Date('2026-10-14T00:00:30Z');
    expect(pausedByNotFound({ scrapingOffsets: [0], hiscoreNotFoundSince: since }, scrapedAt)).toBe(true);
    expect(
      pausedByNotFound({ scrapingOffsets: [0], hiscoreNotFoundSince: new Date(since.getTime() + 1) }, scrapedAt),
    ).toBe(false);
  });

  it("doesn't pause a player without offsets, or the first time it's not found", () => {
    const since = new Date('2026-10-01T00:00:00Z');
    expect(pausedByNotFound({ scrapingOffsets: [], hiscoreNotFoundSince: since }, scrapedAt)).toBe(false);
    expect(pausedByNotFound({ scrapingOffsets: [0] }, scrapedAt)).toBe(false);
  });
});

describe('playerCountUpsert', () => {
  const sample = {
    date: new Date('2026-10-21T00:10:00.123Z'),
    total: 120_000,
    members: 80_000,
    f2p: 40_000,
    hardcore: 8_000,
    worlds: 200,
    byLocation: { US: 60_000, GB: 60_000 },
  };

  it('inserts the sample only when none with its date is stored, so a repeated sample is a no-op', () => {
    const { date, ...counts } = sample;
    expect(playerCountUpsert(sample)).toEqual({ filter: { date }, update: { $setOnInsert: counts } });
    expect(playerCountUpsert(sample).update.$setOnInsert).toHaveProperty('hardcore', 8_000);
  });

  it("recomputes from the start of the sample's UTC day, also for a late sample of an earlier day", () => {
    expect(startOfUTCDay(sample.date)).toEqual(new Date('2026-10-21T00:00:00Z'));
    expect(startOfUTCDay(new Date('2026-10-20T23:50:00Z'))).toEqual(new Date('2026-10-20T00:00:00Z'));
  });
});

/** Checked as built, like the history's: there's no database in the tests. */
describe('playerCountDaysPipeline', () => {
  const from = new Date('2026-10-21T00:00:00Z');
  const once = (value: unknown) => ({ $sum: { $cond: [{ $eq: ['$i', 0] }, value, 0] } });

  it('averages each UTC day from `from` on, hardcore over only the samples that have it, with its peak and sample count', () => {
    const pipeline = playerCountDaysPipeline(from);

    expect(pipeline).toEqual([
      { $match: { date: { $gte: from } } },
      {
        $project: {
          date: { $dateTrunc: { date: '$date', unit: 'day' } },
          total: 1,
          members: 1,
          f2p: 1,
          hardcore: 1,
          location: { $objectToArray: '$byLocation' },
        },
      },
      { $unwind: { path: '$location', includeArrayIndex: 'i' } },
      {
        $group: {
          _id: { date: '$date', code: '$location.k' },
          players: { $avg: '$location.v' },
          samples: once(1),
          total: once('$total'),
          members: once('$members'),
          f2p: once('$f2p'),
          hardcore: once('$hardcore'),
          hardcoreSamples: once({ $cond: [{ $isNumber: '$hardcore' }, 1, 0] }),
          peak: { $max: '$total' },
        },
      },
      {
        $group: {
          _id: '$_id.date',
          samples: { $sum: '$samples' },
          total: { $sum: '$total' },
          members: { $sum: '$members' },
          f2p: { $sum: '$f2p' },
          hardcore: { $sum: '$hardcore' },
          hardcoreSamples: { $sum: '$hardcoreSamples' },
          peak: { $max: '$peak' },
          byLocation: { $push: { k: '$_id.code', v: { $round: ['$players', 0] } } },
        },
      },
      {
        $project: {
          _id: 0,
          date: '$_id',
          total: { $round: [{ $divide: ['$total', '$samples'] }, 0] },
          members: { $round: [{ $divide: ['$members', '$samples'] }, 0] },
          f2p: { $round: [{ $divide: ['$f2p', '$samples'] }, 0] },
          hardcore: {
            $cond: [
              { $gt: ['$hardcoreSamples', 0] },
              { $round: [{ $divide: ['$hardcore', '$hardcoreSamples'] }, 0] },
              '$$REMOVE',
            ],
          },
          byLocation: { $arrayToObject: '$byLocation' },
          peak: '$peak',
          samples: '$samples',
        },
      },
    ]);
  });

  it('stores the fields in PlayerCountDay order, without the helper sums', () => {
    expect(Object.keys(playerCountDaysPipeline(from).at(-1)?.$project)).toEqual([
      '_id',
      'date',
      'total',
      'members',
      'f2p',
      'hardcore',
      'byLocation',
      'peak',
      'samples',
    ]);
  });
});

describe('parseScrapeResult', () => {
  const hiscores = { v: 1, type: 'hiscores', scrapedAt: '2026-10-21T00:00:30.000Z', scrapingOffset: 0, found: [] };

  it('parses a hiscores and a playerCount message', () => {
    expect(parseScrapeResult(JSON.stringify(hiscores))).toEqual(hiscores);
    const playerCount = { v: 1, type: 'playerCount', playerCount: { date: '2026-10-21T00:10:00.000Z', total: 1 } };
    expect(parseScrapeResult(JSON.stringify(playerCount))).toEqual(playerCount);
  });

  it.each([
    ['an unknown version', JSON.stringify({ ...hiscores, v: 2 }), 'Unknown version 2'],
    ['no version', JSON.stringify({ type: 'hiscores' }), 'Unknown version undefined'],
    ['an unknown type', JSON.stringify({ v: 1, type: 'items' }), 'Unknown type "items"'],
    ['an invalid date', JSON.stringify({ ...hiscores, scrapedAt: 'yesterday' }), 'Invalid date "yesterday"'],
    ['a body that is not JSON', '{', 'Not JSON'],
    ['no body', undefined, 'Not JSON'],
  ])('rejects %s, so it is never deleted', (_, body, message) => {
    expect(() => parseScrapeResult(body)).toThrow(new UnknownScrapeResultError(message));
  });
});
