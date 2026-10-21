import { Logger } from '@nestjs/common';
import { Db } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it, MockInstance, vi } from 'vitest';
import { ITEM_SEARCH_RETRY_MS, ITEM_SEARCH_TTL_MS, ItemsService } from './items.service';

const whip = { id: 4151, icon: 'Abyssal whip.png', name: 'Abyssal whip' };
const tentacle = { id: 12006, icon: 'Abyssal tentacle.png', name: 'Abyssal tentacle' };

describe('ItemsService.searchItems', () => {
  let service: ItemsService;
  let find: ReturnType<typeof vi.fn>;
  let warn: MockInstance<Logger['warn']>;
  let now: number;

  /** Moves lru-cache's clock (`performance.now`), then waits out its 1ms `ttlResolution`, which caches the time. */
  async function advance(ms: number) {
    now += ms;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  /** The next load of the item names returns `items`, or fails. */
  const loads = (items: object[] | Error) =>
    find.mockReturnValueOnce({
      toArray: () => (items instanceof Error ? Promise.reject(items) : Promise.resolve(items)),
    });

  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    find = vi.fn();
    service = new ItemsService({ collection: () => ({ find }) } as unknown as Db);
  });

  afterEach(() => vi.restoreAllMocks());

  it('loads the names once for concurrent searches, with only id, icon and name, and reloads them after the ttl', async () => {
    loads([whip]);
    loads([whip, tentacle]);

    expect(await Promise.all([service.searchItems('abyssal'), service.searchItems('whip')])).toEqual([[whip], [whip]]);
    expect(find).toHaveBeenCalledExactlyOnceWith({}, { projection: { _id: 0, id: 1, icon: 1, name: 1 } });

    await advance(ITEM_SEARCH_TTL_MS - 10);
    expect(await service.searchItems('abyssal')).toEqual([whip]);
    expect(find).toHaveBeenCalledOnce();

    await advance(20);
    expect(await service.searchItems('abyssal')).toEqual([tentacle, whip]);
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('searches the stale names when a reload fails, and retries after a minute', async () => {
    loads([whip]);
    loads(new Error('connection closed'));
    loads([whip, tentacle]);

    await service.searchItems('abyssal');
    await advance(ITEM_SEARCH_TTL_MS + 10);
    expect(await service.searchItems('abyssal')).toEqual([whip]);
    expect(warn).toHaveBeenCalledOnce();

    await advance(ITEM_SEARCH_RETRY_MS - 10);
    expect(await service.searchItems('abyssal')).toEqual([whip]);
    expect(find).toHaveBeenCalledTimes(2);

    await advance(20);
    expect(await service.searchItems('abyssal')).toEqual([tentacle, whip]);
  });

  it('rejects when the first load fails, and loads again on the next search', async () => {
    loads(new Error('connection closed'));
    loads([whip]);

    await expect(service.searchItems('whip')).rejects.toThrow('connection closed');
    expect(await service.searchItems('whip')).toEqual([whip]);
  });
});
