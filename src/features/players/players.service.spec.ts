import { ConfigService } from '@nestjs/config';
import { getHiscore, HiscoreResult } from '@osrs-tracker/hiscores';
import { Db } from 'mongodb';
import { Agent } from 'undici';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Env } from '../../config/env';
import { MAX_CONCURRENT_HISCORE_REQUESTS } from './player.config';
import { PlayersService } from './players.service';

vi.mock('@osrs-tracker/hiscores', () => ({ getHiscore: vi.fn() }));

const mockGetHiscore = vi.mocked(getHiscore);

/** Overall and the seven combat skills, enough for the combat level. */
const skills = Array.from({ length: 8 }, (_, id) => ({ id, name: `Skill ${id}`, rank: 1, level: 10, xp: 1000 }));
const found = { status: 'found', hiscore: { skills, activities: [] } } as unknown as HiscoreResult;
const notFound: HiscoreResult = { status: 'notFound', httpStatus: 404 } as HiscoreResult;
const failed: HiscoreResult = { status: 'failed', reason: 'HTTP 503' } as HiscoreResult;

/** Answers every hiscore request with `result` after a few milliseconds, tracking how many run at once. */
function answerWith(result: HiscoreResult) {
  const stats = { running: 0, maxRunning: 0 };
  mockGetHiscore.mockImplementation(async () => {
    stats.maxRunning = Math.max(stats.maxRunning, ++stats.running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    stats.running--;
    return result;
  });
  return stats;
}

describe('PlayersService hiscore lookups', () => {
  let service: PlayersService;

  beforeEach(() => {
    mockGetHiscore.mockReset();
    const config = { get: () => 'https://secure.runescape.com' } as unknown as ConfigService<Env, true>;
    service = new PlayersService(undefined as unknown as Agent, {} as Db, config); // Previews never touch the database
  });

  it("asks only the normal table for a name that isn't on the hiscores, or when it fails", async () => {
    answerWith(notFound);
    expect(await service.previewPlayer('nobody', 0, false)).toEqual({ status: 'notFound' });
    expect(mockGetHiscore).toHaveBeenCalledTimes(1);

    mockGetHiscore.mockClear();
    answerWith(failed);
    expect(await service.previewPlayer('down', 0, false)).toEqual({ status: 'failed' });
    expect(mockGetHiscore).toHaveBeenCalledTimes(1);
  });

  it('fails on a hiscore without the combat skills instead of throwing or storing a wrong combat level', async () => {
    answerWith({
      status: 'found',
      hiscore: { skills: skills.slice(0, 5), activities: [] },
    } as unknown as HiscoreResult);
    expect(await service.previewPlayer('truncated', 0, false)).toEqual({ status: 'failed' });
    expect(mockGetHiscore).toHaveBeenCalledTimes(1);
    expect(await service.refreshPlayerInfo('truncated', 0, true)).toBe('failed');
  });

  it('asks all four tables for a player that is on the hiscores', async () => {
    answerWith(found);
    expect((await service.previewPlayer('toxsick', 0, false)).status).toBe('found');
    expect(mockGetHiscore).toHaveBeenCalledTimes(4);
  });

  it('shares one lookup between concurrent requests for a name', async () => {
    answerWith(found);
    const results = await Promise.all([
      service.previewPlayer('toxsick', 0, false),
      service.previewPlayer('toxsick', 0, true),
      service.previewPlayer('toxsick', 0, false),
    ]);
    expect(results.map((result) => result.status)).toEqual(['found', 'found', 'found']);
    expect(mockGetHiscore).toHaveBeenCalledTimes(4);

    await service.previewPlayer('toxsick', 0, false); // Not cached once settled
    expect(mockGetHiscore).toHaveBeenCalledTimes(8);
  });

  it('remembers names that are not on the hiscores for previews, but not failures', async () => {
    answerWith(notFound);
    await service.previewPlayer('nobody', 0, false);
    expect(await service.previewPlayer('nobody', 0, false)).toEqual({ status: 'notFound' });
    expect(mockGetHiscore).toHaveBeenCalledTimes(1);

    expect(await service.refreshPlayerInfo('nobody', 0, true)).toBe('notFound'); // A lookup asks again
    expect(mockGetHiscore).toHaveBeenCalledTimes(2);

    answerWith(failed);
    await service.previewPlayer('down', 0, false);
    await service.previewPlayer('down', 0, false);
    expect(mockGetHiscore).toHaveBeenCalledTimes(4);
  });

  it('caps the hiscore requests in flight across names', async () => {
    const stats = answerWith(found);
    await Promise.all(Array.from({ length: 10 }, (_, i) => service.previewPlayer(`player${i}`, 0, false)));
    expect(mockGetHiscore).toHaveBeenCalledTimes(40);
    expect(stats.maxRunning).toBe(MAX_CONCURRENT_HISCORE_REQUESTS);
  });
});
