/**
 * `Cache-Control` values for GET routes. The web app's SSR transfer cache drops `no-store`, `no-cache` and `private`
 * responses (the UI flashes back to skeletons on hydration), so none of these may use them.
 */
export const CACHE_CONTROL = {
  /** Always fresh: items, hiscores, recent lists, unknown player previews and outages. */
  REVALIDATE: 'max-age=0, must-revalidate',
  NEWS: 'public, max-age=300',
  /** The stored posts since a date: as fresh as `NEWS`, which refreshes them. */
  NEWS_SINCE: 'public, max-age=300',
  /** A page of the stored posts: the first one is as fresh as `NEWS`, which refreshes it. */
  NEWS_ARCHIVE: 'public, max-age=300',
  /** The stored posts' categories: a new one appears at most a few times a year. */
  NEWS_CATEGORIES: 'public, max-age=3600',
  NEWS_IMAGE: 'public, max-age=604800',
  ITEM_SEARCH: 'public, max-age=3600',
  /** Item browse: the items collection changes at most daily. */
  ITEM_BROWSE: 'public, max-age=86400',
  /** The player sitemap, read by the web app's build. */
  PLAYER_SITEMAP: 'public, max-age=3600',
  /** The player count, latest and history: sampled every 10 minutes. */
  PLAYER_COUNT: 'public, max-age=300',
  /** A player lookup that couldn't refresh the stored player: retry the refresh soon. */
  PLAYER_REFRESH_FAILED: 'max-age=60',
  /** A player lookup that just refreshed the player: 15 minutes, `PLAYER_MAX_AGE_SECONDS` in `player.policy.ts`. */
  PLAYER_REFRESHED: 'max-age=900',
} as const;
