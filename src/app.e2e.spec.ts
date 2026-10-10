import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHiscoreLayout, encodeHiscoreEntry } from '@osrs-tracker/models';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from './app.module';
import { AGENT, IMAGE_AGENT } from './common/agent/agent.provider';
import { CACHE_CONTROL } from './common/http/cache-control';
import { MONGO_CLIENT, MONGODB_DATABASE } from './common/mongo/mongo.provider';
import { ROUTE_CONFLICT_POLICY } from './config/app-options';
import { HISCORE_LAYOUTS_COLLECTION } from './features/players/hiscore-layouts.service';
import { COMBAT_SKILLS } from './features/players/player.utils';

/**
 * Boots the whole app against a fake database and a fake Jagex, and checks the skill's Cache-Control rules for every
 * GET route: each sends a deliberate `Cache-Control` without `no-store`, `no-cache` or `private` (the web app's SSR
 * transfer cache drops those), and never writes to the database. Also checks that the POST lookup records nothing for a
 * bot, and the request IDs.
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
  /** Documents every `find`, `findOne` and `aggregate` returns, whatever the query (`hiscoreLayouts` answers `LAYOUT`). */
  docs?: object[];
  /** The four hiscore tables: all found, or all failing. */
  hiscores?: 'found' | 'failed';
}

interface Case extends Fakes {
  name?: string;
  url: string;
  status: number;
  cacheControl: string;
}

const storedPlayer = {
  username: 'toxsick',
  combatLevel: 3,
  lastModified: new Date(Date.now() - 30 * 60_000), // 90 minutes before the refresh window: capped at 15 minutes
  scrapingOffsets: [0],
};
const item = { id: 4151, name: 'Abyssal whip', icon: 'whip.png' };
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
  '/players': [{ url: '/players', status: 200, cacheControl: CACHE_CONTROL.REVALIDATE }],
  '/players/:username': [
    { name: 'stored', url: '/players/toxsick', docs: [storedPlayer], status: 200, cacheControl: 'max-age=900' },
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
  '/items': [{ url: '/items', status: 200, cacheControl: CACHE_CONTROL.REVALIDATE }],
  '/items/:id': [{ url: '/items/4151', docs: [item], status: 200, cacheControl: CACHE_CONTROL.REVALIDATE }],
  '/items/search/:query': [
    { name: 'found', url: '/items/search/whip', docs: [item], status: 200, cacheControl: CACHE_CONTROL.ITEM_SEARCH },
    { name: 'none found', url: '/items/search/nothing', status: 200, cacheControl: CACHE_CONTROL.ITEM_SEARCH },
  ],
  '/items/browse/:letter': [
    { url: '/items/browse/a', docs: [item], status: 200, cacheControl: CACHE_CONTROL.ITEM_BROWSE },
  ],
  '/news': [{ url: '/news', status: 200, cacheControl: CACHE_CONTROL.NEWS }],
  '/news/image': [
    {
      url: '/news/image?url=https://cdn.runescape.com/news.png',
      status: 200,
      cacheControl: CACHE_CONTROL.NEWS_IMAGE,
    },
  ],
};

/** `CACHE_CONTROL` values only the POST lookup sends, which this spec doesn't request. */
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

/** Records every method called on any collection, and answers reads with `fakes.docs` (or `LAYOUT`). */
const fakeDb = {
  collection: (name: string) =>
    new Proxy(
      {},
      {
        get: (_target, method: string) => (): unknown => {
          collectionCalls.push(`${name}.${method}`);
          const docs = name === HISCORE_LAYOUTS_COLLECTION ? [LAYOUT] : (fakes.docs ?? []);
          if (method === 'findOne') return Promise.resolve(docs[0] ?? null);
          if (method === 'find' || method === 'aggregate') return cursor(docs);
          return Promise.resolve({ acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 });
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

let png: Buffer;

/** Fake Jagex: the news feed, the CDN and the hiscores. Anything else fails, so the test never reaches the network. */
async function fakeJagex(url: string): Promise<Response> {
  if (url.startsWith('https://secure.runescape.com/m=news/latest_news.rss')) return new Response(RSS);
  if (url.startsWith('https://cdn.runescape.com/'))
    return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } });
  if (url.startsWith('https://secure.runescape.com/m=hiscore_oldschool') && url.includes('/index_lite.json'))
    return fakes.hiscores === 'found' ? Response.json(HISCORE) : new Response('', { status: 503 });
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

  it.each(cases)('$title', async ({ url, status, cacheControl, docs, hiscores }) => {
    fakes = { docs, hiscores };

    const response = await fetch(baseUrl + url);

    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe(cacheControl);
    expect(collectionCalls.filter((call) => !READ_METHODS.has(call.split('.')[1]))).toEqual([]);
  });

  describe('POST /players/:username/lookup', () => {
    const lookup = (userAgent?: string) =>
      fetch(`${baseUrl}/players/toxsick/lookup?scrapingOffset=-12`, {
        method: 'POST',
        headers: userAgent ? { 'User-Agent': userAgent } : {},
      });

    it('records nothing for a bot', async () => {
      fakes = { docs: [storedPlayer] };

      const response = await lookup('Googlebot/2.1 (+http://www.google.com/bot.html)');

      expect(response.status).toBe(204);
      expect(collectionCalls).toEqual([]);
    });

    it("records a visitor's lookup of a stored player", async () => {
      fakes = { docs: [{ ...storedPlayer, scrapingOffsets: [-12] }] };

      const response = await lookup('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/140.0');

      expect(response.status).toBe(200);
      expect(collectionCalls).toContain('players.updateOne');
    });
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
