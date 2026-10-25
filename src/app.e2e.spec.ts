import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHiscoreLayout, encodeHiscoreEntry } from '@osrs-tracker/models';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from './app.module';
import { AGENT, IMAGE_AGENT } from './common/agent/agent.provider';
import { CACHE_CONTROL, PLAYER_MAX_AGE_SECONDS } from './common/http/cache-control';
import { HISCORE_LAYOUTS_COLLECTION } from './common/mongo/collections';
import { MONGO_CLIENT, MONGODB_DATABASE } from './common/mongo/mongo.provider';
import { ROUTE_CONFLICT_POLICY, SECURITY_HEADERS } from './config/app-options';
import { encodeNewsCursor } from './features/news/news-archive';
import { PlayerCountsService } from './features/player-counts/player-counts.service';
import { encodeWorldList } from './features/player-counts/world-list.fixture';
import { MIN_PLAYER_REFRESH_HOURS } from './features/players/player.config';
import { COMBAT_SKILLS } from './features/players/player.utils';

/**
 * Boots the whole app against a fake database and a fake Jagex, and checks the skill's Cache-Control rules for every
 * GET route: each sends a deliberate `Cache-Control` without `no-store`, `no-cache` or `private` (the web app's SSR
 * transfer cache drops those), and never writes to the database, except the news feed refresh storing Jagex's posts
 * (`FEED_STORE`). Also checks the POST lookup's outcomes (nothing recorded for a bot, the refresh's statuses and
 * writes), and the request IDs.
 */

const { fakeFetch, logLines } = vi.hoisted(() => {
  // Before AppModule is imported: `ConfigModule.forRoot` validates the environment then. These win over a local `.env`.
  vi.stubEnv('MONGODB_URI', 'mongodb://fake');
  vi.stubEnv('MONGODB_USERNAME', 'fake');
  vi.stubEnv('MONGODB_PASSWORD', 'fake');
  vi.stubEnv('MONGODB_DATABASE', 'fake');
  vi.stubEnv('OSRS_API_BASE_URL', 'https://secure.runescape.com');
  return { fakeFetch: vi.fn<(url: string) => Promise<Response>>(), logLines: [] as Record<string, unknown>[] };
});
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: fakeFetch,
}));
// Every log line (request lines, app lines; Nest's own are off) goes to `logLines`, not the test output
vi.mock('./common/logger/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./common/logger/logger')>();
  return {
    ...actual,
    logger: actual.createApiLogger({
      write: (line: string) => logLines.push(JSON.parse(line) as Record<string, unknown>),
    }),
  };
});

/** Collection methods that only read. Anything else a GET calls counts as a write, so new write methods fail too. */
const READ_METHODS = new Set(['find', 'findOne', 'aggregate', 'countDocuments', 'estimatedDocumentCount', 'distinct']);

/** What the fake database and fake Jagex answer for one request. */
interface Fakes {
  /**
   * Documents every `find`, `findOne`, `aggregate` and `findOneAndUpdate` returns, whatever the query (`hiscoreLayouts`
   * answers `LAYOUT`).
   */
  docs?: object[];
  /** The four hiscore tables: all found, all not found (404), or all failing. */
  hiscores?: 'found' | 'notFound' | 'failed';
  /** Jagex's world list: answered, or failing. */
  worldList?: 'found' | 'failed';
}

interface Case extends Fakes {
  name?: string;
  url: string;
  status: number;
  /** `null` for an error of a route that sets its `Cache-Control` only on success. */
  cacheControl: string | null;
  /** The only writes the request may make. */
  writes?: string[];
}

/** A news feed refresh (on the first request after 5 minutes) stores the feed's posts, whoever's request it is. */
const FEED_STORE = ['news.bulkWrite'];

const storedPlayer = {
  username: 'toxsick',
  combatLevel: 3,
  lastModified: new Date(Date.now() - 30 * 60_000), // 90 minutes before the refresh window: capped at 15 minutes
  scrapingOffsets: [0],
};
const item = { id: 4151, name: 'Abyssal whip', icon: 'whip.png' };
const post = { title: 'Game update', pubDate: new Date(), category: 'Game Updates', link: 'https://example.com' };
const playerCount = { date: new Date(), total: 84441, members: 60000, f2p: 24441, worlds: 321, byLocation: {} };
const LAYOUT = createHiscoreLayout({ skills: [...COMBAT_SKILLS], activities: [] }, new Date(0));
/** A stored hiscore entry, so reading it also loads its layout. */
const storedEntry = encodeHiscoreEntry(
  {
    date: new Date(),
    scrapingOffset: 0,
    skills: Object.fromEntries(COMBAT_SKILLS.map((name) => [name, { rank: 1, level: 10, xp: 1200 }])),
    activities: {},
  },
  LAYOUT,
);

/**
 * One or more requests per GET route, keyed by the route's path as Nest registers it: one per outcome that sends its
 * own `Cache-Control` (stored or unknown, success or outage). A new GET route fails the "covers every GET route" test
 * until it's added here, and a new `CACHE_CONTROL` value fails "expects every GET Cache-Control value".
 */
const CASES: Record<string, Case[]> = {
  '/players': [
    { url: '/players', status: 200, cacheControl: CACHE_CONTROL.REVALIDATE },
    {
      name: 'Overall only',
      url: '/players?entry=overall',
      docs: [{ ...storedPlayer, hiscoreEntries: [storedEntry] }],
      status: 200,
      cacheControl: CACHE_CONTROL.REVALIDATE,
    },
    { name: 'invalid entry', url: '/players?entry=all', status: 400, cacheControl: CACHE_CONTROL.REVALIDATE },
    {
      name: 'top gainers',
      url: '/players?sort=gain&limit=10',
      docs: [{ username: 'toxsick', hiscoreEntries: [storedEntry] }],
      status: 200,
      cacheControl: CACHE_CONTROL.TOP_GAINERS,
    },
    {
      name: 'top gainers, invalid limit',
      url: '/players?sort=gain&limit=51',
      status: 400,
      cacheControl: CACHE_CONTROL.REVALIDATE,
    },
    { name: 'invalid sort', url: '/players?sort=xp', status: 400, cacheControl: CACHE_CONTROL.REVALIDATE },
  ],
  '/players/:username': [
    {
      name: 'stored',
      url: '/players/toxsick',
      docs: [storedPlayer],
      status: 200,
      cacheControl: `max-age=${PLAYER_MAX_AGE_SECONDS}`,
    },
    {
      name: 'unknown',
      url: '/players/toxsick?includeLatestHiscoreEntry=true',
      hiscores: 'found',
      status: 200,
      cacheControl: CACHE_CONTROL.REVALIDATE,
    },
    {
      name: 'unknown, hiscores down',
      url: '/players/toxsick',
      hiscores: 'failed',
      status: 503,
      cacheControl: CACHE_CONTROL.REVALIDATE,
    },
    {
      name: 'unknown, no preview',
      url: '/players/toxsick?preview=false',
      status: 404,
      cacheControl: CACHE_CONTROL.REVALIDATE,
    },
  ],
  '/players/:username/hiscores': [
    {
      url: '/players/toxsick/hiscores',
      docs: [{ hiscoreEntries: [storedEntry] }],
      status: 200,
      cacheControl: CACHE_CONTROL.REVALIDATE,
    },
  ],
  '/sitemap/players': [
    {
      url: '/sitemap/players',
      docs: [{ username: 'toxsick', lastEntry: new Date() }],
      status: 200,
      cacheControl: CACHE_CONTROL.PLAYER_SITEMAP,
    },
  ],
  '/items': [
    { url: '/items', status: 200, cacheControl: CACHE_CONTROL.REVALIDATE },
    { name: 'search', url: '/items?search=whip', docs: [item], status: 200, cacheControl: CACHE_CONTROL.ITEM_SEARCH },
    { name: 'letter', url: '/items?letter=a', docs: [item], status: 200, cacheControl: CACHE_CONTROL.ITEM_BROWSE },
    {
      name: 'added',
      url: '/items?sort=added&limit=25',
      docs: [item],
      status: 200,
      cacheControl: CACHE_CONTROL.NEW_ITEMS,
    },
    {
      name: 'added, invalid limit',
      url: '/items?sort=added&limit=101',
      status: 400,
      cacheControl: CACHE_CONTROL.REVALIDATE,
    },
    { name: 'two modes', url: '/items?search=whip&letter=a', status: 400, cacheControl: CACHE_CONTROL.REVALIDATE },
  ],
  '/items/:id': [{ url: '/items/4151', docs: [item], status: 200, cacheControl: CACHE_CONTROL.REVALIDATE }],
  '/player-counts': [
    { url: '/player-counts?range=1y', docs: [playerCount], status: 200, cacheControl: CACHE_CONTROL.PLAYER_COUNT },
    { name: 'invalid range', url: '/player-counts?range=1w', status: 400, cacheControl: CACHE_CONTROL.PLAYER_COUNT },
  ],
  '/player-counts/latest': [
    { url: '/player-counts/latest', docs: [playerCount], status: 200, cacheControl: CACHE_CONTROL.PLAYER_COUNT },
    { name: 'none recorded', url: '/player-counts/latest', status: 404, cacheControl: CACHE_CONTROL.PLAYER_COUNT },
  ],
  '/player-counts/live': [
    { url: '/player-counts/live', worldList: 'found', status: 200, cacheControl: CACHE_CONTROL.PLAYER_COUNT_LIVE },
    {
      name: 'Jagex down',
      url: '/player-counts/live',
      worldList: 'failed',
      status: 502,
      cacheControl: CACHE_CONTROL.REVALIDATE,
    },
  ],
  '/news': [{ url: '/news', status: 200, cacheControl: CACHE_CONTROL.NEWS, writes: FEED_STORE }],
  '/news/archive': [
    {
      name: 'first page',
      url: '/news/archive?limit=1',
      docs: [post, post],
      status: 200,
      cacheControl: CACHE_CONTROL.NEWS_ARCHIVE,
      writes: FEED_STORE,
    },
    {
      name: 'next page, in a category',
      url: `/news/archive?before=${encodeNewsCursor(post)}&category=Game%20Updates`,
      docs: [post],
      status: 200,
      cacheControl: CACHE_CONTROL.NEWS_ARCHIVE,
    },
    { name: 'invalid before', url: '/news/archive?before=nope', status: 400, cacheControl: null },
    { name: 'invalid limit', url: '/news/archive?limit=51', status: 400, cacheControl: null },
    { name: 'repeated category', url: '/news/archive?category=a&category=b', status: 400, cacheControl: null },
  ],
  '/news/image': [
    {
      url: '/news/image?url=https://cdn.runescape.com/news.png',
      status: 200,
      cacheControl: CACHE_CONTROL.NEWS_IMAGE,
    },
  ],
};

/** `CACHE_CONTROL` values only the POST lookup sends, checked by its own tests below rather than by `CASES`. */
const POST_ONLY: string[] = [CACHE_CONTROL.PLAYER_REFRESH_FAILED, CACHE_CONTROL.PLAYER_REFRESHED];

let fakes: Fakes = {};
let collectionCalls: string[] = [];

const cursor = (docs: object[]) => {
  const self = {
    sort: () => self,
    limit: () => self,
    toArray: async () => docs,
    next: async () => docs[0] ?? null,
  };
  return self;
};

/** Only closed, by `MongoModule` on shutdown. */
const fakeMongoClient = { close: vi.fn(async () => undefined) };

/**
 * Records every method called on any collection, answers reads and `findOneAndUpdate` with `fakes.docs` (or `LAYOUT`),
 * and other writes as matching one document, so a refresh's upsert succeeds.
 */
const fakeDb = {
  collection: (name: string) =>
    new Proxy(
      {},
      {
        get: (_target, method: string) => (): unknown => {
          collectionCalls.push(`${name}.${method}`);
          const docs = name === HISCORE_LAYOUTS_COLLECTION ? [LAYOUT] : (fakes.docs ?? []);
          if (method === 'findOne' || method === 'findOneAndUpdate') return Promise.resolve(docs[0] ?? null);
          if (method === 'find' || method === 'aggregate') return cursor(docs);
          return Promise.resolve({ acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0 });
        },
      },
    ),
};

const RSS = `<rss><channel><item>
  <title>Game update</title><link>https://secure.runescape.com/m=news/game-update?oldschool=1</link>
  <pubDate>Wed, 08 Oct 2026 12:00:00 GMT</pubDate><category>Game Updates</category><description>News</description>
  <enclosure url="https://cdn.runescape.com/news.png" type="image/png"/>
</item></channel></rss>`;

const HISCORE = {
  skills: COMBAT_SKILLS.map((name, id) => ({ id, name, rank: 1, level: 10, xp: 1200 })),
  activities: [],
};

const WORLD_LIST = encodeWorldList([{ players: 1000, members: true }, { players: 500 }]);

let png: Buffer;

/** Fake Jagex: the news feed, the CDN and the hiscores. Anything else fails, so the test never reaches the network. */
async function fakeJagex(url: string): Promise<Response> {
  if (url.startsWith('https://secure.runescape.com/m=news/latest_news.rss')) return new Response(RSS);
  if (url.startsWith('https://cdn.runescape.com/'))
    return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } });
  if (url.startsWith('https://secure.runescape.com/m=hiscore_oldschool') && url.includes('/index_lite.json')) {
    if (fakes.hiscores === 'found') return Response.json(HISCORE);
    return new Response('', { status: fakes.hiscores === 'notFound' ? 404 : 503 });
  }
  if (url === 'https://www.runescape.com/g=oldscape/slr.ws?order=LPWM')
    return fakes.worldList === 'found' ? new Response(WORLD_LIST) : new Response('', { status: 503 });
  throw new Error(`Unexpected fetch: ${url}`);
}

describe('GET routes', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } })
      .png()
      .toBuffer();
    fakeFetch.mockImplementation(fakeJagex);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MONGO_CLIENT)
      .useValue(fakeMongoClient)
      .overrideProvider(MONGODB_DATABASE)
      .useValue(fakeDb)
      .overrideProvider(AGENT)
      .useValue(undefined)
      .overrideProvider(IMAGE_AGENT)
      .useValue(undefined)
      .compile();

    app = moduleRef.createNestApplication({ logger: false, routeConflictPolicy: ROUTE_CONFLICT_POLICY });
    app.useSecurityHeaders(SECURITY_HEADERS);
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    expect(fakeMongoClient.close).toHaveBeenCalledOnce();
  });

  beforeEach(() => {
    fakes = {};
    collectionCalls = [];
    // The live count and its failures are kept for a minute: each case asks Jagex afresh
    app.get(PlayerCountsService)['liveCache'].clear();
  });

  it('covers every GET route', () => {
    const router = app.getHttpAdapter().getInstance().router as {
      stack: { route?: { path: string; methods: Record<string, boolean> } }[];
    };
    const getRoutes = router.stack.flatMap(({ route }) => (route?.methods['get'] ? [route.path] : []));

    expect(getRoutes.sort()).toEqual(Object.keys(CASES).sort());
  });

  it('expects every GET Cache-Control value', () => {
    const expected = new Set(Object.values(CASES).flatMap((routeCases) => routeCases.map((c) => c.cacheControl)));
    const unchecked = Object.values(CACHE_CONTROL).filter(
      (value) => !expected.has(value) && !POST_ONLY.includes(value),
    );

    expect(unchecked).toEqual([]);
  });

  const cases = Object.entries(CASES).flatMap(([route, routeCases]) =>
    routeCases.map((c) => ({ ...c, title: c.name ? `${route} (${c.name})` : route })),
  );

  it.each(cases)('$title', async ({ url, status, cacheControl, docs, hiscores, worldList, writes = [] }) => {
    fakes = { docs, hiscores, worldList };

    const response = await fetch(baseUrl + url);

    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe(cacheControl);
    const otherWrites = collectionCalls.filter(
      (call) => !READ_METHODS.has(call.split('.')[1]) && !writes.includes(call),
    );
    expect(otherWrites).toEqual([]);
  });

  describe('POST /players/:username/lookup', () => {
    const VISITOR = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/140.0';
    /** Past the refresh window, so a lookup refreshes it. */
    const stalePlayer = {
      ...storedPlayer,
      lastModified: new Date(Date.now() - (MIN_PLAYER_REFRESH_HOURS + 1) * 3_600_000),
      scrapingOffsets: [-12],
    };

    const lookup = (userAgent?: string) =>
      fetch(`${baseUrl}/players/toxsick/lookup?scrapingOffset=-12`, {
        method: 'POST',
        headers: userAgent ? { 'User-Agent': userAgent } : {},
      });
    const writes = () => collectionCalls.filter((call) => !READ_METHODS.has(call.split('.')[1]));
    /** The `players` writes, in order; `hiscoreLayouts` is left out, as the layout may already be cached. */
    const playerWrites = () => writes().filter((call) => call.startsWith('players.'));

    it('records nothing for a bot', async () => {
      fakes = { docs: [storedPlayer] };

      const response = await lookup('Googlebot/2.1 (+http://www.google.com/bot.html)');

      expect(response.status).toBe(204);
      expect(collectionCalls).toEqual([]);
    });

    it("records a visitor's lookup of a stored player", async () => {
      fakes = { docs: [{ ...storedPlayer, scrapingOffsets: [-12] }] };

      const response = await lookup(VISITOR);

      expect(response.status).toBe(200);
      expect(collectionCalls).toContain('players.updateOne');
    });

    it('stores an unknown player found on the hiscores, and records the lookup', async () => {
      fakes = { docs: [], hiscores: 'found' };

      const response = await lookup(VISITOR);

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL.PLAYER_REFRESHED);
      expect(playerWrites()).toEqual(['players.updateOne', 'players.updateOne']); // The refresh's upsert, the lookup
    });

    it('answers 503 for an unknown player when the hiscores fail, and writes nothing', async () => {
      fakes = { docs: [], hiscores: 'failed' };

      const response = await lookup(VISITOR);

      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL.REVALIDATE);
      expect(writes()).toEqual([]);
    });

    it('returns a stale stored player with refreshFailed when the hiscores fail, and records the lookup', async () => {
      fakes = { docs: [stalePlayer], hiscores: 'failed' };

      const response = await lookup(VISITOR);

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL.PLAYER_REFRESH_FAILED);
      expect(await response.json()).toMatchObject({ username: 'toxsick', refreshFailed: true });
      expect(playerWrites()).toEqual(['players.updateOne']); // Only the lookup: a failed refresh writes nothing
    });

    it('answers 404 for a stored player no longer on the hiscores, and writes nothing', async () => {
      fakes = { docs: [stalePlayer], hiscores: 'notFound' };

      const response = await lookup(VISITOR);

      expect(response.status).toBe(404);
      // Not counted here: process-players owns the 404 bookkeeping (pause/resume contract)
      expect(writes()).toEqual([]);
    });
  });

  it('sends the security headers, letting other origins show its images', async () => {
    const response = await fetch(`${baseUrl}/news/image?url=https://cdn.runescape.com/news.png`);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(response.headers.has('x-powered-by')).toBe(false);
  });

  describe('request ID', () => {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    /** The response's `X-Request-Id`, after checking the request log line carries the same `requestId`. */
    async function requestId(headers?: Record<string, string>): Promise<string | null> {
      const response = await fetch(`${baseUrl}/items`, { headers });
      const id = response.headers.get('x-request-id');
      // The line is written once the response has finished, which can be after the client has it
      await vi.waitFor(() =>
        expect(logLines.filter((line) => line.type === 'incoming').at(-1)).toMatchObject({
          status: '200',
          route: '/items',
          requestId: id,
        }),
      );
      return id;
    }

    it('generates a new UUID per request, logged on its request line', async () => {
      const first = await requestId();
      const second = await requestId();

      expect(first).toMatch(UUID);
      expect(second).toMatch(UUID);
      expect(second).not.toBe(first);
    });

    it("ignores the client's X-Request-Id", async () => {
      const incoming = crypto.randomUUID();
      const id = await requestId({ 'X-Request-Id': incoming });

      expect(id).toMatch(UUID);
      expect(id).not.toBe(incoming);
    });
  });
});
