/** A stored player is refreshed on lookup once it's this many hours old. */
export const MIN_PLAYER_REFRESH_HOURS = 2;

/** Hiscore requests to Jagex in flight at once per pod. The proxy is shared with the process-players Lambda. */
export const MAX_CONCURRENT_HISCORE_REQUESTS = 8;

/** How long a preview remembers that a name isn't on the hiscores, and how many such names it remembers. */
export const NOT_FOUND_CACHE_TTL_MS = 60_000;
export const NOT_FOUND_CACHE_MAX = 10_000;
