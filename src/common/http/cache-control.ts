/**
 * `Cache-Control` values for GET routes. The web app's SSR transfer cache drops `no-store`, `no-cache` and `private`
 * responses (the UI flashes back to skeletons on hydration), so none of these may use them.
 */
export const CACHE_CONTROL = {
  /** Always fresh: items, hiscores, recent lists, unknown player previews and outages. */
  REVALIDATE: 'max-age=0, must-revalidate',
  NEWS: 'public, max-age=300',
  NEWS_IMAGE: 'public, max-age=604800',
  ITEM_SEARCH: 'public, max-age=3600',
  /** A player lookup that couldn't refresh the stored player: retry the refresh soon. */
  PLAYER_REFRESH_FAILED: 'max-age=60',
  /** A player lookup that just refreshed the player: 15 minutes, `PLAYER_MAX_AGE_SECONDS` in `player.policy.ts`. */
  PLAYER_REFRESHED: 'max-age=900',
} as const;
