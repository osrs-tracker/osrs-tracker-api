import { millisecondsInMinute as MINUTE } from 'date-fns/constants';

/**
 * One receive a minute while the queue is empty (about 43k a month; with the sends and deletes about 55k of SQS's 1M free
 * requests, roadmap osrs-tracker/osrs-tracker-aws#162). While receives return messages, the next follows at once.
 */
export const POLL_INTERVAL_MS = MINUTE;

/** A long poll: SQS answers as soon as a message arrives, or after this long with none. */
export const WAIT_TIME_SECONDS = 20;

/** SQS's maximum per receive. */
export const MAX_MESSAGES = 10;

/**
 * The liveness probe fails once the poll loop hasn't finished a cycle or a message for this long: a cycle takes at most
 * about a minute (a 10 s Mongo ping, the 20 s long poll, then the batch) plus the minute between polls. A Mongo or SQS
 * outage doesn't stop it (the cycle ends early), so it only restarts a loop stuck on a call that never returns.
 */
export const HEARTBEAT_MAX_AGE_MS = 5 * MINUTE;

/** Bounds each SQS request: the long poll plus a margin. The SDK retries a timed-out request (3 attempts in all). */
export const SQS_REQUEST_TIMEOUT_MS = (WAIT_TIME_SECONDS + 10) * 1000;

/** The subscriptions sync's schedule, in UTC, and the interval it amounts to (`JobRunsService.catchUp`): change both. */
export const SUBSCRIPTIONS_SYNC_CRON = '*/15 * * * *';
export const SUBSCRIPTIONS_SYNC_INTERVAL_MS = 15 * MINUTE;

/**
 * The gap after each write to the subscriptions table: 4 writes a second against its 5 WCU (an item is well under 1 KB,
 * so one unit), which the first fill's ~520 puts would otherwise exceed. The SDK retries a throttled write.
 */
export const SUBSCRIPTION_WRITE_GAP_MS = 250;

/** Bounds each DynamoDB request, so a hung one can't hold the sync (and with it every later run) forever. */
export const DYNAMODB_REQUEST_TIMEOUT_MS = 10_000;

/** The items refresh's schedule, in UTC, and the interval it amounts to (`JobRunsService.catchUp`): change both. */
export const ITEMS_REFRESH_CRON = '0 * * * *';
export const ITEMS_REFRESH_INTERVAL_MS = 60 * MINUTE;

/** Bounds the Wiki's item list request (about 1 MB). */
export const ITEMS_FETCH_TIMEOUT_MS = 15_000;

/**
 * More items missing from the Wiki's list than this in one run means its response is truncated or broken, not that Jagex
 * removed them from the GE (19 had piled up on 2026-10-10): the delete is skipped then.
 */
export const MAX_REMOVED_ITEMS = 50;

/** The hiscores clean-up's schedule, in UTC, and the interval it amounts to (`JobRunsService.catchUp`): change both. */
export const CLEAN_HISCORES_CRON = '0 0 * * *';
export const CLEAN_HISCORES_INTERVAL_MS = 24 * 60 * MINUTE;

/** Days of hiscore entries kept: older ones are pulled every night, counted from the start of the UTC day. */
export const MAX_AGE_IN_DAYS = 90;

/** Days without a lookup after which a player's scraping offset is dropped, together with its hiscore entries. */
export const UNUSED_SCRAPING_OFFSET_DAYS = 180;

/** Days without any new hiscore entry after which the clean-up alerts that scraping stopped. */
export const MAX_DAYS_WITHOUT_SCRAPES = 2;
