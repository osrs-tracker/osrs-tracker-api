import { ConfigService } from '@nestjs/config';
import { ResilienceModule, ResilienceService } from '@nestjs/resilience';
import { Test } from '@nestjs/testing';
import { fetch } from 'undici';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT } from '../../common/agent/agent.provider';
import { MONGODB_DATABASE } from '../../common/mongo/mongo.provider';
import {
  JAGEX_HISCORES,
  JAGEX_HISCORES_PRESET,
  MAX_CONCURRENT_HISCORE_REQUESTS,
  MAX_QUEUED_HISCORE_REQUESTS,
} from './player.config';
import { PlayersService } from './players.service';

vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: vi.fn(),
}));

const mockFetch = vi.mocked(fetch);

/** What the fake Jagex answers: a player on the table, a 404, or a 503. */
type Answer = 'found' | 'notFound' | 'failed';

/** Overall and the seven combat skills, enough for the combat level. */
const skills = Array.from({ length: 8 }, (_, id) => ({ id, name: `Skill ${id}`, rank: 1, level: 10, xp: 1000 }));

function response(answer: Answer, body: unknown = { name: 'player', skills, activities: [] }) {
  const status = { found: 200, notFound: 404, failed: 503 }[answer];
  return { status, ok: status === 200, json: async () => body } as unknown as Awaited<ReturnType<typeof fetch>>;
}

/** The username a hiscore request asked for. */
const requestedName = (url: unknown) => new URL(String(url)).searchParams.get('player');

/** Answers every hiscore request with `answer` (and `body`) after a few milliseconds. */
function answerWith(answer: Answer, body?: unknown) {
  mockFetch.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return response(answer, body);
  });
}

/** Holds every hiscore request open until answered, in the order they reach `fetch`, tracking how many run at once. */
function holdRequests() {
  const stats = { running: 0, maxRunning: 0 };
  const held: { name: string | null; answer: (answer: Answer) => void }[] = [];
  mockFetch.mockImplementation(
    (url) =>
      new Promise((resolve) => {
        stats.maxRunning = Math.max(stats.maxRunning, ++stats.running);
        held.push({
          name: requestedName(url),
          answer: (answer) => {
            stats.running--;
            resolve(response(answer));
          },
        });
      }),
  );
  return { held, stats };
}

/** Answers held requests `from` to `to` (exclusive) with `answer` one by one, waiting for each to reach `fetch`. */
async function answerHeld(held: ReturnType<typeof holdRequests>['held'], from: number, to: number, answer: Answer) {
  for (let i = from; i < to; i++) {
    await vi.waitFor(() => expect(held.length).toBeGreaterThan(i));
    held[i].answer(answer);
  }
}

describe('PlayersService hiscore lookups', () => {
  let service: PlayersService;
  let resilience: ResilienceService;

  beforeEach(async () => {
    mockFetch.mockReset();
    // The same module options and preset as AppModule, so the limits tested are production's
    const moduleRef = await Test.createTestingModule({
      imports: [ResilienceModule.forRoot({ mapErrors: false, presets: { [JAGEX_HISCORES]: JAGEX_HISCORES_PRESET } })],
      providers: [
        PlayersService,
        { provide: AGENT, useValue: {} },
        { provide: MONGODB_DATABASE, useValue: {} }, // Previews never touch the database
        { provide: ConfigService, useValue: { get: () => 'https://secure.runescape.com' } },
      ],
    }).compile();
    service = moduleRef.get(PlayersService);
    resilience = moduleRef.get(ResilienceService);
  });

  it("asks only the normal table for a name that isn't on the hiscores, or when it fails", async () => {
    answerWith('notFound');
    expect(await service.previewPlayer('nobody', 0, false)).toEqual({ status: 'notFound' });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    mockFetch.mockClear();
    answerWith('failed');
    expect(await service.previewPlayer('down', 0, false)).toEqual({ status: 'failed' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('fails on a hiscore without the combat skills instead of throwing or storing a wrong combat level', async () => {
    answerWith('found', { name: 'truncated', skills: skills.slice(0, 5), activities: [] });
    expect(await service.previewPlayer('truncated', 0, false)).toEqual({ status: 'failed' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(await service.refreshPlayerInfo('truncated', 0, true)).toBe('failed');
  });

  it('asks all four tables for a player that is on the hiscores', async () => {
    answerWith('found');
    expect((await service.previewPlayer('toxsick', 0, false)).status).toBe('found');
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('shares one lookup between concurrent requests for a name', async () => {
    answerWith('found');
    const results = await Promise.all([
      service.previewPlayer('toxsick', 0, false),
      service.previewPlayer('toxsick', 0, true),
      service.previewPlayer('toxsick', 0, false),
    ]);
    expect(results.map((result) => result.status)).toEqual(['found', 'found', 'found']);
    expect(mockFetch).toHaveBeenCalledTimes(4);

    await service.previewPlayer('toxsick', 0, false); // Not cached once settled
    expect(mockFetch).toHaveBeenCalledTimes(8);
  });

  it('remembers names that are not on the hiscores for previews, but not failures', async () => {
    answerWith('notFound');
    await service.previewPlayer('nobody', 0, false);
    expect(await service.previewPlayer('nobody', 0, false)).toEqual({ status: 'notFound' });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    expect(await service.refreshPlayerInfo('nobody', 0, true)).toBe('notFound'); // A lookup asks again
    expect(mockFetch).toHaveBeenCalledTimes(2);

    answerWith('failed');
    await service.previewPlayer('down', 0, false);
    await service.previewPlayer('down', 0, false);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('caps the hiscore requests in flight across names, first come first served, and a failure frees its slot', async () => {
    const { held, stats } = holdRequests();
    const names = Array.from({ length: MAX_CONCURRENT_HISCORE_REQUESTS + 4 }, (_, i) => `player${i}`);
    const previews = Promise.all(names.map((name) => service.previewPlayer(name, 0, false)));

    await vi.waitFor(() => expect(held).toHaveLength(MAX_CONCURRENT_HISCORE_REQUESTS));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(held).toHaveLength(MAX_CONCURRENT_HISCORE_REQUESTS); // The rest wait

    held[0].answer('failed');
    await vi.waitFor(() => expect(held).toHaveLength(MAX_CONCURRENT_HISCORE_REQUESTS + 1));
    await answerHeld(held, 1, names.length, 'notFound');

    expect((await previews).map((result) => result.status)).toEqual([
      'failed',
      ...names.slice(1).map(() => 'notFound'),
    ]);
    expect(held.map(({ name }) => name)).toEqual(names);
    expect(stats.maxRunning).toBe(MAX_CONCURRENT_HISCORE_REQUESTS);
  });

  it('fails at once without asking Jagex when the queue is full', async () => {
    const { held } = holdRequests();
    const waiting = MAX_CONCURRENT_HISCORE_REQUESTS + MAX_QUEUED_HISCORE_REQUESTS;
    const previews = Promise.all(
      Array.from({ length: waiting }, (_, i) => service.previewPlayer(`player${i}`, 0, false)),
    );
    await vi.waitFor(() => expect(held).toHaveLength(MAX_CONCURRENT_HISCORE_REQUESTS));

    expect(await service.previewPlayer('one-too-many', 0, false)).toEqual({ status: 'failed' });
    expect(mockFetch).toHaveBeenCalledTimes(MAX_CONCURRENT_HISCORE_REQUESTS);

    await answerHeld(held, 0, waiting, 'notFound');
    expect((await previews).every((result) => result.status === 'notFound')).toBe(true);
    expect(held.map(({ name }) => name)).not.toContain('one-too-many');
  });

  it('stops asking Jagex once enough requests failed', async () => {
    answerWith('failed');
    const { minimumCalls } = JAGEX_HISCORES_PRESET.circuitBreaker as { minimumCalls: number };
    for (let i = 0; i < minimumCalls; i++) {
      expect(await service.previewPlayer(`down${i}`, 0, false)).toEqual({ status: 'failed' });
    }
    expect(resilience.circuitBreaker(JAGEX_HISCORES).state).toBe('open');

    expect(await service.previewPlayer('toxsick', 0, false)).toEqual({ status: 'failed' });
    expect(mockFetch).toHaveBeenCalledTimes(minimumCalls);
  });

  it('counts players that are not on the hiscores as successes, not failures', async () => {
    answerWith('notFound');
    for (let i = 0; i < 11; i++) await service.previewPlayer(`nobody${i}`, 0, false);
    answerWith('failed');
    for (let i = 0; i < 9; i++) await service.previewPlayer(`down${i}`, 0, false); // 45% of the last 20 failed

    expect(resilience.circuitBreaker(JAGEX_HISCORES).state).toBe('closed');
    expect(resilience.circuitBreaker(JAGEX_HISCORES).stats).toMatchObject({ total: 20, failures: 9 });
  });
});
