import { getOverallXpDiff } from '@osrs-tracker/hiscores';
import { HiscoreEntry, Player } from '@osrs-tracker/models';
import { millisecondsInDay as DAY, millisecondsInHour as HOUR } from 'date-fns/constants';
import { Document } from 'mongodb';
import { slotStart } from '../../ingester/scrape-results';
import { entriesForOffset } from './player-queries';

/** The stored fields a top gainer is served with: the web draws its account avatar from them. */
export type TopGainerPlayer = Pick<Player, 'username' | 'type' | 'status' | 'diedAsHardcore'>;

/** A player in the top gainers: `gain` is the Overall XP over its newest day of entries, `date` the newer entry's. */
export type TopGainer = TopGainerPlayer & { gain: number; date: Date };

/** The scraping offset the top gainers are ranked for: the default one, the offset most players are scraped at. */
const TOP_GAINERS_OFFSET = 0;

/** Most players returned; the cached list holds this many. */
export const MAX_TOP_GAINERS = 50;

/**
 * How long after a slot starts its scrape counts as done: process-players drops an event older than an hour, so
 * nearly every entry for the slot is stored by then. Until then the previous slot's list is served, not a partial one.
 */
const SCRAPE_SETTLE_MS = HOUR;

/** How long the ranked list is kept within a slot, so entries stored late (a requeued scrape) still make it. */
export const TOP_GAINERS_CACHE_TTL_MS = HOUR;

/** The start of the newest `TOP_GAINERS_OFFSET` scrape slot whose scrape has settled (`SCRAPE_SETTLE_MS`). */
export function topGainersSlot(now: Date): Date {
  return slotStart(TOP_GAINERS_OFFSET, new Date(now.getTime() - SCRAPE_SETTLE_MS));
}

/**
 * The candidates for the top gainers: players still scraped at `TOP_GAINERS_OFFSET` (so not paused), without a
 * not-found streak, and with an entry for it since `slot`, each with its two newest entries for that offset (as
 * stored, newest first). `rankTopGainers` makes the cut on the newest entry, which `$match` can't pick out.
 */
export function buildTopGainersPipeline(slot: Date): Document[] {
  return [
    {
      $match: {
        scrapingOffsets: TOP_GAINERS_OFFSET,
        hiscoreNotFoundCount: { $not: { $gt: 0 } },
        hiscoreEntries: { $elemMatch: { o: TOP_GAINERS_OFFSET, d: { $gte: slot } } },
      },
    },
    {
      $project: {
        _id: 0,
        username: 1,
        type: 1,
        status: 1,
        diedAsHardcore: 1,
        // From the newest: an unchanged value is stored as a bare rank, resolved from a newer entry
        hiscoreEntries: { $slice: [entriesForOffset('$hiscoreEntries', TOP_GAINERS_OFFSET), 2] },
      },
    },
  ];
}

/**
 * The players with the largest Overall XP gain between the previous and the newest day's entries (their two newest,
 * decoded, newest first), largest first, at most `MAX_TOP_GAINERS`. Leaves out a player whose newest entry isn't from
 * `slot`'s day, whose previous one is older than the previous slot (a paused or missed scrape: a gain over more than a
 * day), who has only one entry, or who gained nothing.
 */
export function rankTopGainers(players: (TopGainerPlayer & { entries: HiscoreEntry[] })[], slot: Date): TopGainer[] {
  const previousSlot = slot.getTime() - DAY;
  const slotEnd = slot.getTime() + DAY;
  return players
    .flatMap(({ entries: [newest, previous], ...player }) => {
      if (!newest || !previous) return [];
      if (newest.date.getTime() < slot.getTime() || newest.date.getTime() >= slotEnd) return [];
      if (previous.date.getTime() < previousSlot) return [];
      const gain = getOverallXpDiff(newest, previous);
      return gain > 0 ? [{ ...player, gain, date: newest.date }] : [];
    })
    .sort((a, b) => b.gain - a.gain || a.username.localeCompare(b.username))
    .slice(0, MAX_TOP_GAINERS);
}
