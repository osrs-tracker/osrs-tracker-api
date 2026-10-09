import type { ResiliencePreset } from '@nestjs/resilience';

/** A stored player is refreshed on lookup once it's this many hours old. */
export const MIN_PLAYER_REFRESH_HOURS = 2;

/** Hiscore requests to Jagex in flight at once per pod. The proxy is shared with the process-players Lambda. */
export const MAX_CONCURRENT_HISCORE_REQUESTS = 8;

/**
 * Hiscore requests waiting for a slot; beyond that they fail at once (503 or `refreshFailed`) instead of holding a
 * visitor's request open. 4x the concurrency: a lookup asks one table, then three at once, so this holds about eight
 * lookups' worth, roughly one hiscores timeout of waiting when Jagex is slow.
 */
export const MAX_QUEUED_HISCORE_REQUESTS = 4 * MAX_CONCURRENT_HISCORE_REQUESTS;

/**
 * Longest a hiscore request waits for a slot: the hiscores client's own timeout (10s), so a request doesn't wait longer
 * for a slot than for Jagex itself.
 */
export const HISCORE_QUEUE_TIMEOUT_MS = 10_000;

/** Name of the `@nestjs/resilience` preset that every request to Jagex's hiscores goes through. */
export const JAGEX_HISCORES = 'jagex-hiscores';

/**
 * Caps the requests in flight and queued per pod, and stops asking Jagex for 30s once at least half of the last 20
 * requests (at least 10) failed, so an outage answers at once instead of after a timeout per lookup. A not-found player
 * is a success. No `retry` (it adds latency to a visitor's lookup, and process-players retries on its own schedule) and
 * no `timeout` (the hiscores client has its own).
 */
export const JAGEX_HISCORES_PRESET: ResiliencePreset = {
  bulkhead: {
    maxConcurrent: MAX_CONCURRENT_HISCORE_REQUESTS,
    maxQueue: MAX_QUEUED_HISCORE_REQUESTS,
    queueTimeout: HISCORE_QUEUE_TIMEOUT_MS,
  },
  circuitBreaker: {
    failureRateThreshold: 50,
    minimumCalls: 10,
    slidingWindow: { type: 'count', size: 20 },
    openDuration: '30s',
  },
};

/** How long a preview remembers that a name isn't on the hiscores, and how many such names it remembers. */
export const NOT_FOUND_CACHE_TTL_MS = 60_000;
export const NOT_FOUND_CACHE_MAX = 10_000;
