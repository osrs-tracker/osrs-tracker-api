import { subDays } from 'date-fns';
import { Document } from 'mongodb';

/** A player in the sitemap: `lastEntry` is the date of its newest hiscore entry, when its page last changed. */
export interface SitemapPlayer {
  username: string;
  lastEntry: Date;
}

/** Players without a hiscore entry for this many days are left out of the sitemap. */
export const SITEMAP_PLAYER_DAYS = 30;

const NEWEST_ENTRY = { $first: '$hiscoreEntries' } as const;

/**
 * The tracked players for the web app's sitemap, by username: those still scraped (with `scrapingOffsets`, so not
 * paused), without a not-found streak (`hiscoreNotFoundCount`, a renamed or banned account) and with a hiscore entry in
 * the last `SITEMAP_PLAYER_DAYS`. Not by `lastHiscoreFetch`: that's when a visitor last looked a player up, and many
 * tracked players have none. `hiscoreEntries` are stored newest first, so the first one is the newest.
 */
export function buildSitemapPlayersPipeline(now: Date): Document[] {
  return [
    {
      $match: {
        'scrapingOffsets.0': { $exists: true },
        'hiscoreNotFoundCount': { $not: { $gt: 0 } },
        'hiscoreEntries.0.d': { $gte: subDays(now, SITEMAP_PLAYER_DAYS) },
      },
    },
    { $sort: { username: 1 } },
    { $project: { _id: 0, username: 1, lastEntry: { $getField: { field: 'd', input: NEWEST_ENTRY } } } },
  ];
}
