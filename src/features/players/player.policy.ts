import { hiscoreEntriesWriteExpression, Player, StoredHiscoreEntry } from '@osrs-tracker/models';
import { addHours, differenceInHours, differenceInSeconds } from 'date-fns';
import { Document } from 'mongodb';
import { MIN_PLAYER_REFRESH_HOURS } from './player.config';

/** Longest `max-age` for a stored player: 15 minutes. */
export const PLAYER_MAX_AGE_SECONDS = 900;

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

/**
 * The aggregation pipeline update `refreshPlayerInfo` upserts after a successful refresh. It resumes a paused player
 * (merges `pausedScrapingOffsets` back and unsets the pause fields, see the pause/resume contract there), adds
 * `scrapingOffset`, and, when the stored `scrapingOffsets` don't have it yet (the initial entry), writes
 * `storedEntry` with models' `hiscoreEntriesWriteExpression`: it prepends the entry (stored newest first) and, in the
 * previous newest entry with the same `o` and `l` (offset and layout), wherever it sits, reduces the values that didn't
 * change to their bare rank. That matters even for this "initial" entry: an offset in `pausedScrapingOffsets` isn't in
 * `scrapingOffsets`, so a lookup that resumes it prepends while older entries for that offset exist. Deciding all that
 * in the update rather than from an earlier read means concurrent lookups prepend it once.
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
