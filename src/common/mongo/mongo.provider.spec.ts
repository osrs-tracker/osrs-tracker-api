import { Logger } from '@nestjs/common';
import { MongoClient } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it, MockInstance, vi } from 'vitest';
import { connectWithRetry, MAX_CONNECT_ATTEMPTS, RETRY_DELAY_MS } from './mongo.provider';

/** Clients whose `connect` fails the first `failures` times, counting created and closed clients. */
function clientFactory(failures: number) {
  const stats = { created: 0, closed: 0 };
  const createClient = () => {
    const attempt = ++stats.created;
    const client = {
      connect: async () => {
        if (attempt <= failures) throw new Error('querySrv ENOTFOUND');
        return client;
      },
      close: async () => void stats.closed++,
    };
    return client as unknown as MongoClient;
  };
  return { createClient, stats };
}

describe('connectWithRetry', () => {
  let warn: MockInstance<Logger['warn']>;

  beforeEach(() => {
    vi.useFakeTimers();
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries every 10 seconds until it connects, warning about each failed attempt', async () => {
    const { createClient, stats } = clientFactory(3);
    const connecting = connectWithRetry(createClient);

    await vi.advanceTimersByTimeAsync(3 * RETRY_DELAY_MS - 1);
    expect(stats.created).toBe(3); // a constant delay, no jitter: the 4th attempt is due exactly 30s in
    await vi.advanceTimersByTimeAsync(1);

    await connecting;
    expect(stats).toEqual({ created: 4, closed: 3 });
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      'MongoDB connect attempt 1/12 failed, retrying: Error: querySrv ENOTFOUND',
      'MongoDB connect attempt 2/12 failed, retrying: Error: querySrv ENOTFOUND',
      'MongoDB connect attempt 3/12 failed, retrying: Error: querySrv ENOTFOUND',
    ]);
  });

  it('throws the last error after MAX_CONNECT_ATTEMPTS, without a warning for the last attempt', async () => {
    const { createClient, stats } = clientFactory(Infinity);
    const connecting = connectWithRetry(createClient).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync((MAX_CONNECT_ATTEMPTS - 1) * RETRY_DELAY_MS);

    expect(await connecting).toEqual(new Error('querySrv ENOTFOUND'));
    expect(stats).toEqual({ created: MAX_CONNECT_ATTEMPTS, closed: MAX_CONNECT_ATTEMPTS });
    expect(warn).toHaveBeenCalledTimes(MAX_CONNECT_ATTEMPTS - 1);
    expect(warn).toHaveBeenLastCalledWith('MongoDB connect attempt 11/12 failed, retrying: Error: querySrv ENOTFOUND');
  });
});
