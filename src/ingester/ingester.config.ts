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
