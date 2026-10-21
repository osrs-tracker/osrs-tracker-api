import { StoredHiscoreEntry } from '@osrs-tracker/models';
import { describe, expect, it } from 'vitest';
import {
  hiscoreEntryUpdate,
  parseScrapeResult,
  pausedByNotFound,
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
    worlds: 200,
    byLocation: { US: 60_000, GB: 60_000 },
  };

  it('inserts the sample only when none with its date is stored, so a repeated sample is a no-op', () => {
    const { date, ...counts } = sample;
    expect(playerCountUpsert(sample)).toEqual({ filter: { date }, update: { $setOnInsert: counts } });
  });

  it("recomputes from the start of the sample's UTC day, also for a late sample of an earlier day", () => {
    expect(startOfUTCDay(sample.date)).toEqual(new Date('2026-10-21T00:00:00Z'));
    expect(startOfUTCDay(new Date('2026-10-20T23:50:00Z'))).toEqual(new Date('2026-10-20T00:00:00Z'));
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
