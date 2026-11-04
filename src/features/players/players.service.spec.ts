import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ResilienceModule, ResilienceService } from '@nestjs/resilience';
import { Test } from '@nestjs/testing';
import { HiscoreTable } from '@osrs-tracker/hiscores';
import {
  createHiscoreLayout,
  encodeHiscoreEntry,
  HiscoreEntry,
  PlayerType,
  SkillEnum,
  StoredHiscoreEntry,
  stripUnchangedValues,
} from '@osrs-tracker/models';
import { Document } from 'mongodb';
import { fetch } from 'undici';
import { afterEach, beforeEach, describe, expect, it, MockInstance, vi } from 'vitest';
import { HISCORE_LAYOUTS_COLLECTION } from '../../common/mongo/collections';
import { AGENT, USER_AGENT } from '../../common/agent/agent.provider';
import { MONGODB_DATABASE } from '../../common/mongo/mongo.provider';
import {
  HISCORE_QUEUE_TIMEOUT_MS,
  JAGEX_HISCORES,
  JAGEX_HISCORES_PRESET,
  MAX_CONCURRENT_HISCORE_REQUESTS,
  MAX_QUEUED_HISCORE_REQUESTS,
} from './player.config';
import { HiscoreLayoutsService } from './hiscore-layouts.service';
import { COMBAT_SKILLS } from './player.utils';
import { PlayersService, RECENT_PLAYERS_ENTRY } from './players.service';

vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: vi.fn(),
}));

const mockFetch = vi.mocked(fetch);

/** What the fake Jagex answers: a player on the table, a 404, or a 503. */
type Answer = 'found' | 'notFound' | 'failed';

/** Jagex's JSON for Overall and the seven combat skills, enough for the combat level. */
const skills = COMBAT_SKILLS.map((name, id) => ({ id, name, rank: 1, level: 10, xp: 1000 }));

/** Jagex's JSON with every combat skill (and Overall) at `rank`, `level` and `xp`, plus Overall's `death` if given. */
const jagexHiscore = (rank: number, level: number, xp: number, death?: { timeStamp: number }) => ({
  name: 'player',
  skills: COMBAT_SKILLS.map((name, id) => ({
    id,
    name,
    rank,
    level,
    xp,
    ...(name === SkillEnum.Overall && death && { death }),
  })),
  activities: [],
});

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
  let warn: MockInstance<Logger['warn']>;

  beforeEach(async () => {
    mockFetch.mockReset();
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    // The same module options and preset as AppModule, so the limits tested are production's
    const moduleRef = await Test.createTestingModule({
      imports: [ResilienceModule.forRoot({ mapErrors: false, presets: { [JAGEX_HISCORES]: JAGEX_HISCORES_PRESET } })],
      providers: [
        PlayersService,
        { provide: AGENT, useValue: {} },
        { provide: MONGODB_DATABASE, useValue: { collection: () => ({}) } }, // Previews never touch the database
        { provide: HiscoreLayoutsService, useValue: {} }, // Nor its layouts
        { provide: ConfigService, useValue: { get: () => 'https://secure.runescape.com' } },
      ],
    }).compile();
    service = moduleRef.get(PlayersService);
    resilience = moduleRef.get(ResilienceService);
  });

  afterEach(() => vi.restoreAllMocks());

  it("asks only the normal table for a name that isn't on the hiscores, or when it fails", async () => {
    answerWith('notFound');
    expect(await service.previewPlayer('nobody', 0, false)).toEqual({ status: 'notFound' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // Our user agent is added to the package's headers, not in their place
    expect(mockFetch.mock.calls[0][1]?.headers).toEqual({
      'cache-control': expect.any(String),
      'user-agent': USER_AGENT,
    });

    mockFetch.mockClear();
    answerWith('failed');
    expect(await service.previewPlayer('down', 0, false)).toEqual({ status: 'failed' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('fails on a hiscore without the combat skills instead of throwing or storing a wrong combat level', async () => {
    answerWith('found', { name: 'truncated', skills: skills.slice(0, 5), activities: [] });
    expect(await service.previewPlayer('truncated', 0, false)).toEqual({ status: 'failed' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(await service.refreshPlayerInfo('truncated', 0)).toBe('failed');
  });

  it('asks all five tables for a player that is on the hiscores', async () => {
    answerWith('found');
    expect((await service.previewPlayer('toxsick', 0, false)).status).toBe('found');
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  /** Answers each table in `tables` with its hiscore, and 404s the others. */
  function answerByTable(tables: Partial<Record<HiscoreTable, unknown>>) {
    mockFetch.mockImplementation(async (url) => {
      const table = new URL(String(url)).pathname.split('/')[1].replace(/^m=/, '') as HiscoreTable;
      return table in tables ? response('found', tables[table]) : response('notFound');
    });
  }

  async function preview(username: string) {
    const result = await service.previewPlayer(username, 0, true);
    if (result.status !== 'found') throw new Error(`Expected found, got ${result.status}`);
    return result.player;
  }

  describe('Hardcore Worlds', () => {
    // A main entry frozen before Hardcore Worlds opened, and the character's progress on its own table
    const stub = jagexHiscore(-1, 1, 1_154);
    const progress = jagexHiscore(5, 50, 101_333);
    const dead = jagexHiscore(5, 50, 101_333, { timeStamp: Date.parse('2026-11-04T18:00:00Z') });

    it("takes a Hardcore main's combat level and entry from its own table, not the main table's stub", async () => {
      answerByTable({ hiscore_oldschool: stub, hiscore_oldschool_hardcore_mains: progress });

      const player = await preview('hcmain');
      expect(player).toMatchObject({ type: PlayerType.HardcoreMain, combatLevel: 63, diedAsHardcore: false });
      expect(player.hiscoreEntries?.[0].skills[SkillEnum.Attack]).toEqual({ rank: 5, level: 50, xp: 101_333 });
    });

    it('keeps a dead Hardcore main on its own table, died as hardcore, while its main entry is the stub or equal to the dead row', async () => {
      answerByTable({ hiscore_oldschool: stub, hiscore_oldschool_hardcore_mains: dead });
      expect(await preview('dead hcmain')).toMatchObject({ type: PlayerType.HardcoreMain, diedAsHardcore: true });

      // As FailedHcMain at 17:59 UTC on 2026-11-04: main unranked at the dead row's xp, a Transfer or not yet
      answerByTable({ hiscore_oldschool: jagexHiscore(-1, 50, 101_333), hiscore_oldschool_hardcore_mains: dead });
      expect(await preview('failedhcmain')).toMatchObject({ type: PlayerType.HardcoreMain, diedAsHardcore: true });
    });

    it('makes a dead row whose main entry grew past it a Transfer: a main account that died as hardcore, from main', async () => {
      answerByTable({ hiscore_oldschool: jagexHiscore(4_000, 50, 101_400), hiscore_oldschool_hardcore_mains: dead });

      const player = await preview('transferred');
      expect(player).toMatchObject({ type: PlayerType.Normal, combatLevel: 63, diedAsHardcore: true });
      expect(player.hiscoreEntries?.[0].skills[SkillEnum.Attack]).toEqual({ rank: 4_000, level: 50, xp: 101_400 });
    });

    it('sees a main account once the row is gone (404): the stored type marks that Transfer (buildRefreshUpdate)', async () => {
      answerByTable({ hiscore_oldschool: jagexHiscore(4_000, 50, 101_333) });

      expect(await preview('gone')).toMatchObject({ type: PlayerType.Normal, diedAsHardcore: false });
    });
  });

  describe('hardcore ironmen', () => {
    // On the main, ironman and hardcore tables with the same xp
    const alive = jagexHiscore(5, 99, 26_207_134);
    // A dead row keeps its xp from the death, and Overall gets Jagex's death record (8 of 8 dead ones, 2017-2026)
    const dead = jagexHiscore(5, 99, 26_116_135, { timeStamp: Date.parse('2017-12-07T09:29:00Z') });

    it("reads a death from the hardcore table's death record, even with no xp gained since", async () => {
      answerByTable({
        hiscore_oldschool: dead,
        hiscore_oldschool_ironman: dead,
        hiscore_oldschool_hardcore_ironman: dead,
      });

      expect(await preview('itti')).toMatchObject({ type: PlayerType.Hardcore, diedAsHardcore: true });
    });

    it('is alive without a death record, even with the hardcore row behind the ironman one (no xp inference)', async () => {
      answerByTable({
        hiscore_oldschool: alive,
        hiscore_oldschool_ironman: alive,
        hiscore_oldschool_hardcore_ironman: alive,
      });
      expect(await preview('anypurps')).toMatchObject({ type: PlayerType.Hardcore, diedAsHardcore: false });

      const behind = jagexHiscore(5, 99, 26_000_000);
      answerByTable({
        hiscore_oldschool: alive,
        hiscore_oldschool_ironman: alive,
        hiscore_oldschool_hardcore_ironman: behind,
      });
      expect(await preview('no record')).toMatchObject({ type: PlayerType.Hardcore, diedAsHardcore: false });
    });
  });

  it('shares one lookup between concurrent requests for a name', async () => {
    answerWith('found');
    const results = await Promise.all([
      service.previewPlayer('toxsick', 0, false),
      service.previewPlayer('toxsick', 0, true),
      service.previewPlayer('toxsick', 0, false),
    ]);
    expect(results.map((result) => result.status)).toEqual(['found', 'found', 'found']);
    expect(mockFetch).toHaveBeenCalledTimes(5);

    await service.previewPlayer('toxsick', 0, false); // Not cached once settled
    expect(mockFetch).toHaveBeenCalledTimes(10);
  });

  it('remembers names that are not on the hiscores for previews, but not failures', async () => {
    answerWith('notFound');
    await service.previewPlayer('nobody', 0, false);
    expect(await service.previewPlayer('nobody', 0, false)).toEqual({ status: 'notFound' });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    expect(await service.refreshPlayerInfo('nobody', 0)).toBe('notFound'); // A lookup asks again
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
    expect(warn).not.toHaveBeenCalled(); // ResilienceEventsListener logs rejections, throttled

    await answerHeld(held, 0, waiting, 'notFound');
    expect((await previews).every((result) => result.status === 'notFound')).toBe(true);
    expect(held.map(({ name }) => name)).not.toContain('one-too-many');
  });

  it('fails a request that waits longer than the queue timeout for a slot, without asking Jagex', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { held } = holdRequests();
      const previews = Promise.all(
        Array.from({ length: MAX_CONCURRENT_HISCORE_REQUESTS }, (_, i) =>
          service.previewPlayer(`player${i}`, 0, false),
        ),
      );
      await vi.waitFor(() => expect(held).toHaveLength(MAX_CONCURRENT_HISCORE_REQUESTS));
      const queued = service.previewPlayer('waits-too-long', 0, false);

      await vi.advanceTimersByTimeAsync(HISCORE_QUEUE_TIMEOUT_MS);
      expect(await queued).toEqual({ status: 'failed' });
      expect(held.map(({ name }) => name)).not.toContain('waits-too-long');

      await answerHeld(held, 0, MAX_CONCURRENT_HISCORE_REQUESTS, 'notFound');
      await previews;
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops asking Jagex once enough requests failed', async () => {
    answerWith('failed');
    const { minimumCalls } = JAGEX_HISCORES_PRESET.circuitBreaker as { minimumCalls: number };
    for (let i = 0; i < minimumCalls; i++) {
      expect(await service.previewPlayer(`down${i}`, 0, false)).toEqual({ status: 'failed' });
    }
    expect(resilience.circuitBreaker(JAGEX_HISCORES).state).toBe('open');

    warn.mockClear();
    expect(await service.previewPlayer('toxsick', 0, false)).toEqual({ status: 'failed' });
    expect(mockFetch).toHaveBeenCalledTimes(minimumCalls);
    expect(warn).not.toHaveBeenCalled(); // An open circuit isn't logged per lookup
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

describe('PlayersService stored hiscore entries', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const layout = createHiscoreLayout({ skills: [...COMBAT_SKILLS], activities: ['Clue Scrolls (all)'] }, new Date(0));
  /** The level `decode` derives for each XP value these specs use. */
  const LEVEL_FOR_XP: Record<number, number> = { 1000: 9, 2000: 13 };
  /** A domain entry where every skill has `xp` (levels as `decode` derives them) and the activity `score`. */
  const entry = (day: number, xp: number, score: number): HiscoreEntry => ({
    date: new Date(day * DAY_MS),
    scrapingOffset: 0,
    skills: Object.fromEntries(COMBAT_SKILLS.map((name) => [name, { rank: 5, level: LEVEL_FOR_XP[xp], xp }])),
    activities: { 'Clue Scrolls (all)': { rank: 7, score } },
  });

  let service: PlayersService;
  let calls: string[];
  let storedEntries: StoredHiscoreEntry[];
  let pipeline: Document[];

  beforeEach(async () => {
    mockFetch.mockReset();
    calls = [];
    const players = {
      aggregate: (stages: Document[]) => {
        pipeline = stages;
        return {
          next: async () => {
            const [, position, n] = stages[1].$project.hiscoreEntries.$slice as [unknown, number, number]; // What MongoDB's `$slice` returns
            return { hiscoreEntries: storedEntries.slice(position, position + n) };
          },
          toArray: async () => [{ username: 'toxsick', hiscoreEntries: storedEntries.slice(0, 1) }], // The recent players
        };
      },
      updateOne: async () => {
        calls.push('players.updateOne');
        return { upsertedCount: 1, matchedCount: 0 };
      },
    };
    const layouts = {
      findOne: async () => layout,
      findOneAndUpdate: async ({ _id }: { _id: number }, { $setOnInsert }: Document) => {
        calls.push('hiscoreLayouts.findOneAndUpdate');
        return { _id, ...$setOnInsert };
      },
    };
    const moduleRef = await Test.createTestingModule({
      imports: [ResilienceModule.forRoot({ mapErrors: false, presets: { [JAGEX_HISCORES]: JAGEX_HISCORES_PRESET } })],
      providers: [
        PlayersService,
        HiscoreLayoutsService,
        { provide: AGENT, useValue: {} },
        {
          provide: MONGODB_DATABASE,
          useValue: { collection: (name: string) => (name === HISCORE_LAYOUTS_COLLECTION ? layouts : players) },
        },
        { provide: ConfigService, useValue: { get: () => 'https://secure.runescape.com' } },
      ],
    }).compile();
    service = moduleRef.get(PlayersService);
  });

  afterEach(() => vi.restoreAllMocks());

  it('reads a page from the newest entry, so its bare values resolve from entries before the page', async () => {
    const [newest, middle, oldest] = [entry(3, 2000, 10), entry(2, 2000, 10), entry(1, 1000, 10)].map((e) =>
      encodeHiscoreEntry(e, layout),
    );
    // As the write expression leaves them: each older entry stripped against the one written after it
    storedEntries = [newest, stripUnchangedValues(newest, middle), stripUnchangedValues(middle, oldest)];

    const page = await service.getPlayerHiscores('toxsick', 0, 1, 1);

    expect(pipeline[1].$project.hiscoreEntries.$slice.slice(1)).toEqual([0, 2]);
    expect(page).toEqual([entry(2, 2000, 10)]);
  });

  it('returns the recent players with their newest entry whole, or only its Overall with `entry=overall`', async () => {
    storedEntries = [encodeHiscoreEntry(entry(3, 2000, 10), layout)];

    expect(await service.getLastFetchedPlayers(5)).toEqual([
      { username: 'toxsick', hiscoreEntries: [entry(3, 2000, 10)] },
    ]);
    expect(await service.getLastFetchedPlayers(5, 0, RECENT_PLAYERS_ENTRY.Overall)).toEqual([
      {
        username: 'toxsick',
        hiscoreEntries: [
          {
            date: new Date(3 * DAY_MS),
            scrapingOffset: 0,
            skills: { [SkillEnum.Overall]: { rank: 5, level: LEVEL_FOR_XP[2000], xp: 2000 } },
            activities: {},
          },
        ],
      },
    ]);
  });

  it('stores the layout before the entry that uses it', async () => {
    answerWith('found');
    expect(await service.refreshPlayerInfo('toxsick', 0)).toBe('refreshed');
    expect(calls).toEqual(['hiscoreLayouts.findOneAndUpdate', 'players.updateOne']);
  });
});
