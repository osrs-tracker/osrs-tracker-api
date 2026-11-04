import {
  hiscoreEntriesWriteExpression,
  Player,
  PlayerType,
  StoredHiscoreEntry,
  StoredPlayer,
} from '@osrs-tracker/models';
import { addHours, differenceInHours, differenceInSeconds } from 'date-fns';
import { Document, UpdateFilter } from 'mongodb';
import { PLAYER_MAX_AGE_SECONDS } from '../../common/http/cache-control';
import { MIN_PLAYER_REFRESH_HOURS } from './player.config';

/**
 * `max-age` for a stored player: until its refresh window starts (a lookup then refreshes it), capped at
 * `PLAYER_MAX_AGE_SECONDS` and never negative.
 */
export function playerMaxAgeSeconds(lastModified: Date, now: Date): number {
  const untilRefresh = differenceInSeconds(addHours(lastModified, MIN_PLAYER_REFRESH_HOURS), now);
  return Math.max(0, Math.min(PLAYER_MAX_AGE_SECONDS, untilRefresh));
}

/** A lookup refreshes the player when it's unknown, isn't tracked for `scrapingOffset` yet, or is stale. */
export function needsRefresh(player: Player | null, scrapingOffset: number, now: Date): boolean {
  return (
    !player ||
    !player.scrapingOffsets?.includes(scrapingOffset) ||
    differenceInHours(now, player.lastModified) >= MIN_PLAYER_REFRESH_HOURS
  );
}

const SCRAPING_OFFSET_LOOKUPS = 'scrapingOffsetLookups' satisfies keyof StoredPlayer;

/**
 * The update `recordLookup` runs for a visitor's lookup: `lastHiscoreFetch` (the recent players list) and the lookup
 * date for `scrapingOffset` in models' `Player.scrapingOffsetLookups`, keyed by the offset as a string (`"-12"` to
 * `"11"`). The ingester's clean job drops an offset nobody looked up for 180 days; a dotted `$set` leaves the other
 * offsets' dates alone. The field name comes from the model (`SCRAPING_OFFSET_LOOKUPS`), since TypeScript doesn't
 * check a dotted key: a rename in models fails the build instead of writing a field clean-hiscores doesn't read.
 */
export function buildLookupUpdate(scrapingOffset: number, now: Date): UpdateFilter<StoredPlayer> {
  return { $set: { lastHiscoreFetch: now, [`${SCRAPING_OFFSET_LOOKUPS}.${scrapingOffset}`]: now } };
}

/**
 * The aggregation pipeline update `refreshPlayerInfo` upserts after a successful refresh. It resumes a paused player
 * (merges `pausedScrapingOffsets` back and unsets the pause fields, see the pause/resume contract there), adds
 * `scrapingOffset`, and, when the stored `scrapingOffsets` don't have it yet (the initial entry), writes
 * `storedEntry` with models' `hiscoreEntriesWriteExpression`: it prepends the entry (stored newest first) and, in the
 * previous newest entry with the same `o` and `l` (offset and layout), wherever it sits, reduces the values that didn't
 * change to their bare rank. That matters even for this "initial" entry: an offset in `pausedScrapingOffsets` isn't in
 * `scrapingOffsets`, so a lookup that resumes it prepends while older entries for that offset exist. Deciding all that
 * in the update rather than from an earlier read means concurrent lookups prepend it once. `diedAsHardcore` reads the
 * stored player too, for a Hardcore Worlds Transfer (`diedAsHardcoreExpression`).
 *
 * `storedEntry` is already encoded (`encodeHiscoreEntry`) and its layout upserted by the caller before `updateOne`.
 * Values are wrapped in `$literal`, so strings starting with '$' aren't read as field paths.
 */
export function buildRefreshUpdate(
  player: Player,
  storedEntry: StoredHiscoreEntry,
  scrapingOffset: number,
): Document[] {
  return [
    {
      // Field paths in one `$set` read the document as it was before it, so `$scrapingOffsets` is the stored value
      $set: {
        ...Object.fromEntries(Object.entries(player).map(([key, value]) => [key, { $literal: value }])),
        diedAsHardcore: diedAsHardcoreExpression(player),
        scrapingOffsets: {
          $setUnion: [
            { $ifNull: ['$scrapingOffsets', []] },
            { $ifNull: ['$pausedScrapingOffsets', []] },
            [scrapingOffset],
          ],
        },
        hiscoreEntries: {
          $cond: [
            { $in: [scrapingOffset, { $ifNull: ['$scrapingOffsets', []] }] },
            '$hiscoreEntries',
            hiscoreEntriesWriteExpression(storedEntry),
          ],
        },
      },
    },
    { $unset: ['pausedScrapingOffsets', 'hiscoreNotFoundSince', 'hiscoreNotFoundCount'] },
  ];
}

/**
 * `diedAsHardcore` for `buildRefreshUpdate`: the lookup's value, kept true once stored for a hardcore ironman and a
 * main account. A transferred Hardcore Worlds character is a main account to a lookup, and only the stored player still
 * shows what it was, so for a main account it's also true when the stored player is a Hardcore main (its row on Hardcore
 * Worlds' table is gone: a Transfer). A Hardcore main's own `true` (dead before its choice) doesn't stick: a Reset
 * brings it back alive.
 */
function diedAsHardcoreExpression({ type, diedAsHardcore }: Player): Document {
  switch (type) {
    case PlayerType.Normal:
      return {
        $or: [{ $literal: diedAsHardcore }, { $eq: ['$type', PlayerType.HardcoreMain] }, storedTrueFor(type)],
      };
    case PlayerType.Hardcore:
      return { $or: [{ $literal: diedAsHardcore }, storedTrueFor(type)] };
    default:
      return { $literal: diedAsHardcore };
  }
}

/** Whether the stored player is of `type` with `diedAsHardcore` true. */
function storedTrueFor(type: PlayerType): Document {
  return { $and: [{ $eq: ['$type', type] }, { $eq: ['$diedAsHardcore', true] }] };
}
