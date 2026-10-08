import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from './app.module';
import { CACHE_CONTROL } from './common/http/cache-control';

/**
 * Boots the whole app against a fake database and a fake Jagex, and checks the skill's Cache-Control rules for every
 * GET route: each sends a deliberate `Cache-Control` without `no-store`, `no-cache` or `private` (the web app's SSR
 * transfer cache drops those), and never writes to the database.
 */

const { fakeFetch } = vi.hoisted(() => ({ fakeFetch: vi.fn<(url: string) => Promise<Response>>() }));
vi.mock('node-fetch', () => ({ default: fakeFetch }));
// No request log lines in the test output
vi.mock('morgan', () => ({ default: () => (_req: unknown, _res: unknown, next: () => void) => next() }));

/** Collection methods that only read. Anything else a GET calls counts as a write, so new write methods fail too. */
const READ_METHODS = new Set(['find', 'findOne', 'aggregate', 'countDocuments', 'estimatedDocumentCount', 'distinct']);

/** What the fake database and fake Jagex answer for one request. */
interface Fakes {
  /** Documents every `find`, `findOne` and `aggregate` returns, whatever the collection or query. */
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
      docs: [{ hiscoreEntries: [] }],
      status: 200,
      cacheControl: CACHE_CONTROL.REVALIDATE,
    },
  ],
  '/items': [{ url: '/items', status: 200, cacheControl: CACHE_CONTROL.REVALIDATE }],
  '/items/:id': [{ url: '/items/4151', docs: [item], status: 200, cacheControl: CACHE_CONTROL.REVALIDATE }],
  '/items/search/:query': [
    { url: '/items/search/whip', docs: [item], status: 200, cacheControl: CACHE_CONTROL.ITEM_SEARCH },
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

/** Records every method called on any collection, and answers reads with `fakes.docs`. */
const fakeDb = {
  collection: (name: string) =>
    new Proxy(
      {},
      {
        get: (_target, method: string) => (): unknown => {
          collectionCalls.push(`${name}.${method}`);
          const docs = fakes.docs ?? [];
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
  skills: Array.from({ length: 24 }, (_, id) => ({ id, name: `Skill ${id}`, rank: 1, level: 10, xp: 1000 })),
  activities: [],
};

let png: Buffer;

/** Fake Jagex: the news feed, the CDN and the hiscores. Anything else fails, so the test never reaches the network. */
async function fakeJagex(url: string): Promise<Response> {
  if (url.includes('/m=news/latest_news.rss')) return new Response(RSS);
  if (url.startsWith('https://cdn.runescape.com/'))
    return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } });
  if (url.includes('/index_lite.json'))
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
      .overrideProvider('MONGO_CLIENT')
      .useValue({})
      .overrideProvider('MONGODB_DATABASE')
      .useValue(fakeDb)
      .overrideProvider('AGENT')
      .useValue(undefined)
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
  });

  afterAll(() => app?.close());

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
});
