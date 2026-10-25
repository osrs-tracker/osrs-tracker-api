/** Longest `max-age` for a stored player (`playerMaxAgeSeconds`), and what a lookup that just refreshed it sends. */
export const PLAYER_MAX_AGE_SECONDS = 900;

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
  /** The newest items: the hourly items refresh adds them at most once an hour. */
  NEW_ITEMS: 'public, max-age=3600',
  /** The player sitemap, read by the web app's build. */
  PLAYER_SITEMAP: 'public, max-age=3600',
  /** The top gainers: kept by the API until new entries may have landed, at most an hour (`TOP_GAINERS_CACHE_TTL_MS`). */
  TOP_GAINERS: 'public, max-age=3600',
  /** The player count, latest and history: sampled every 10 minutes. */
  PLAYER_COUNT: 'public, max-age=300',
  /** The live player count: kept for a minute, Jagex asks for at most one world list poll a minute. */
  PLAYER_COUNT_LIVE: 'public, max-age=60',
  /** A player lookup that couldn't refresh the stored player: retry the refresh soon. */
  PLAYER_REFRESH_FAILED: 'max-age=60',
  /** A player lookup that just refreshed the player: 15 minutes, as long as a stored player's longest. */
  PLAYER_REFRESHED: `max-age=${PLAYER_MAX_AGE_SECONDS}`,
} as const;
