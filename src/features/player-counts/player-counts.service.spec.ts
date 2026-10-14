import { BadGatewayException, Logger } from '@nestjs/common';
import { WORLD_LIST_URL } from '@osrs-tracker/hiscores';
import { Db } from 'mongodb';
import { Agent, fetch } from 'undici';
import { afterEach, beforeEach, describe, expect, it, MockInstance, vi } from 'vitest';
import { USER_AGENT } from '../../common/agent/agent.provider';
import { LIVE_PLAYER_COUNT_TTL_MS, PlayerCountsService } from './player-counts.service';
import { encodeWorldList } from './world-list.fixture';

vi.mock('undici', async (importOriginal) => ({ ...(await importOriginal<typeof import('undici')>()), fetch: vi.fn() }));
const mockFetch = vi.mocked(fetch);

const worldList = (...players: number[]) =>
  new Response(encodeWorldList(players.map((count, i) => ({ players: count, members: i % 2 === 0 }))));

describe('PlayerCountsService.getLive', () => {
  let service: PlayerCountsService;
  let warn: MockInstance<Logger['warn']>;
  let now: number;

  /** Moves lru-cache's clock (`performance.now`), then waits out its 1ms `ttlResolution`, which caches the time. */
  async function advance(ms: number) {
    now += ms;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  beforeEach(() => {
    mockFetch.mockReset();
    now = 1_000_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    // The live count never touches the database; the service only opens its collection
    service = new PlayerCountsService({ collection: () => ({}) } as unknown as Db, {} as Agent);
  });

  afterEach(() => vi.restoreAllMocks());

  it('counts the world list, with the user agent and the shared agent', async () => {
    mockFetch.mockResolvedValue(worldList(1000, 500) as never);

    const live = await service.getLive();

    expect(live).toEqual({
      date: expect.any(Date),
      total: 1500,
      members: 1000,
      f2p: 500,
      worlds: 2,
      byLocation: { 0: 1500 },
    });
    expect(mockFetch).toHaveBeenCalledWith(
      WORLD_LIST_URL,
      expect.objectContaining({ headers: expect.objectContaining({ 'user-agent': USER_AGENT }), dispatcher: {} }),
    );
  });

  it('shares one request between concurrent requests and keeps the count for a minute', async () => {
    mockFetch.mockImplementation(async () => worldList(1000) as never);

    const [first, second] = await Promise.all([service.getLive(), service.getLive()]);
    await advance(LIVE_PLAYER_COUNT_TTL_MS - 10);
    const cached = await service.getLive();

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(second).toBe(first);
    expect(cached).toBe(first);

    await advance(20);
    const refreshed = await service.getLive();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(refreshed).not.toBe(first);
  });

  it.each([
    ['Jagex fails', () => new Response('', { status: 503 })],
    ['the format check throws', () => new Response(new Uint8Array([0, 0, 0, 9, 0, 1]))],
    ['no worlds', () => worldList()],
    ['no players', () => worldList(0, 0)],
  ])('answers 502 when %s, without asking again for a minute', async (_name, response) => {
    mockFetch.mockImplementation(async () => response() as never);

    await expect(service.getLive()).rejects.toBeInstanceOf(BadGatewayException);
    await advance(LIVE_PLAYER_COUNT_TTL_MS - 10);
    await expect(service.getLive()).rejects.toBeInstanceOf(BadGatewayException);

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();

    mockFetch.mockImplementation(async () => worldList(1000) as never);
    await advance(20);
    await expect(service.getLive()).resolves.toMatchObject({ total: 1000 });
  });
});
