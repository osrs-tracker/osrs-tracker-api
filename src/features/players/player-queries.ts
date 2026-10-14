import { Document } from 'mongodb';

/** The player fields both player queries return (`getPlayer`, `getLastFetchedPlayers`). */
export const PLAYER_PROJECTION = {
  _id: 0,
  username: 1,
  combatLevel: 1,
  diedAsHardcore: 1,
  lastModified: 1,
  status: 1,
  type: 1,
  scrapingOffsets: 1,
} as const;

/** A stored player's `hiscoreEntries`, `[]` when it has none. */
export const HISCORE_ENTRIES = { $ifNull: ['$hiscoreEntries', []] } as const;

/**
 * The entries of `entries` (an expression for an array of stored entries, like `HISCORE_ENTRIES`) for `scrapingOffset`,
 * newest first as stored. `null` when `entries` is `null` or missing.
 */
export function entriesForOffset(entries: unknown, scrapingOffset: number): Document {
  return { $filter: { input: entries, as: 'entry', cond: { $eq: ['$$entry.o', scrapingOffset] } } };
}
