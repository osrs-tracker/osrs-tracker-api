import { Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ResilienceModule, ResilienceService } from '@nestjs/resilience';
import { Test } from '@nestjs/testing';
import { XMLParser } from 'fast-xml-parser';
import { createServer, IncomingHttpHeaders, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { Agent, fetch, Response } from 'undici';
import { afterEach, beforeEach, describe, expect, it, MockInstance, vi } from 'vitest';
import { AGENT, IMAGE_AGENT, imageAgentProvider, MAX_IMAGE_BYTES } from '../../common/agent/agent.provider';
import { XML_PARSER, XMLParserProvider } from '../../common/xml/xml.provider';
import { Env } from '../../config/env';
import {
  IMAGE_QUEUE_TIMEOUT_MS,
  MAX_CONCURRENT_IMAGE_CONVERSIONS,
  MAX_QUEUED_IMAGE_CONVERSIONS,
  NEWS_IMAGES,
  NEWS_IMAGES_PRESET,
} from './news.config';
import { NewsService } from './news.service';

vi.mock('undici', async (importOriginal) => ({ ...(await importOriginal<typeof import('undici')>()), fetch: vi.fn() }));

const mockFetch = vi.mocked(fetch);

const RSS =
  '<rss><channel><item><title>Patch notes</title><link>https://secure.runescape.com/m=news/patch-notes</link>' +
  '<pubDate>Thu, 08 Oct 2026 12:00:00 GMT</pubDate><category>Game Updates</category><description>Notes</description>' +
  '<enclosure url="https://cdn.runescape.com/news/patch.png" type="image/png"/></item></channel></rss>';
const IMAGE_URL = 'https://cdn.runescape.com/news/patch.png';

/** Answers every request with a new response from `respond` after a few milliseconds (a body can be read once). */
function answerWith(respond: () => Response) {
  mockFetch.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return respond();
  });
}

/** A `NewsService` with the same resilience module options and preset as AppModule, so the limits tested are production's. */
async function createNewsService(
  imageAgent: Agent | undefined,
  xmlParser: XMLParser,
  config: ConfigService<Env, true>,
): Promise<{ service: NewsService; resilience: ResilienceService }> {
  const moduleRef = await Test.createTestingModule({
    imports: [ResilienceModule.forRoot({ mapErrors: false, presets: { [NEWS_IMAGES]: NEWS_IMAGES_PRESET } })],
    providers: [
      NewsService,
      { provide: AGENT, useValue: {} },
      { provide: IMAGE_AGENT, useValue: imageAgent ?? {} },
      { provide: XML_PARSER, useValue: xmlParser },
      { provide: ConfigService, useValue: config },
    ],
  }).compile();
  return { service: moduleRef.get(NewsService), resilience: moduleRef.get(ResilienceService) };
}

/** A 2x2 PNG. */
function createPng(): Promise<Buffer> {
  return sharp({ create: { width: 2, height: 2, channels: 3, background: '#f00' } })
    .png()
    .toBuffer();
}

describe('NewsService caches', () => {
  let service: NewsService;
  let resilience: ResilienceService;
  let warn: MockInstance<Logger['warn']>;
  let now: number;

  /** Moves lru-cache's clock (`performance.now`), then waits out its 1ms `ttlResolution`, which caches the time. */
  async function advance(ms: number) {
    now += ms;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  beforeEach(async () => {
    mockFetch.mockReset();
    now = 1_000_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const config = { get: () => 'https://secure.runescape.com' } as unknown as ConfigService<Env, true>;
    const xmlParser = XMLParserProvider.useFactory() as XMLParser;
    ({ service, resilience } = await createNewsService(undefined, xmlParser, config));
  });

  afterEach(() => vi.restoreAllMocks());

  describe('getRecentNews', () => {
    it('shares one feed request between concurrent requests and caches it', async () => {
      answerWith(() => new Response(RSS));
      const results = await Promise.all([1, 2, 3].map(() => service.getRecentNews(4)));
      expect(results.map((items) => items[0].title)).toEqual(['Patch notes', 'Patch notes', 'Patch notes']);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      await advance(299_000);
      await service.getRecentNews(4);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('serves the stale feed when a refresh fails and retries only after 60 seconds', async () => {
      answerWith(() => new Response(RSS));
      await service.getRecentNews(4);

      await advance(300_001);
      answerWith(() => new Response('Bad gateway', { status: 502 }));
      const results = await Promise.all([1, 2, 3].map(() => service.getRecentNews(4)));
      expect(results.map((items) => items[0].title)).toEqual(['Patch notes', 'Patch notes', 'Patch notes']);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(1); // once per failure, not per waiting request
      expect(warn).toHaveBeenCalledWith('News feed request failed, serving the cached copy: HTTP 502');

      await advance(59_000);
      expect((await service.getRecentNews(4))[0].title).toBe('Patch notes');
      expect(mockFetch).toHaveBeenCalledTimes(2);

      await advance(2_000);
      answerWith(() => new Response(RSS));
      await service.getRecentNews(4);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('answers 503 when the feed fails and nothing is cached, and retries on the next request', async () => {
      answerWith(() => new Response('Bad gateway', { status: 502 }));
      const results = await Promise.allSettled([1, 2, 3].map(() => service.getRecentNews(4)));
      for (const result of results) {
        expect(result.status).toBe('rejected');
        expect((result as PromiseRejectedResult).reason).toBeInstanceOf(ServiceUnavailableException);
      }
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('News feed request failed: HTTP 502');

      answerWith(() => new Response(RSS));
      expect((await service.getRecentNews(4))[0].title).toBe('Patch notes');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('getImageAsWebp', () => {
    it('fetches and converts an image once for concurrent requests and caches it', async () => {
      const png = await createPng();
      answerWith(() => new Response(png, { headers: { 'content-type': 'image/png' } }));

      const results = await Promise.all([1, 2, 3].map(() => service.getImageAsWebp(IMAGE_URL)));
      expect((await sharp(results[0]).metadata()).format).toBe('webp');
      expect(results[1]).toBe(results[0]);
      expect(results[2]).toBe(results[0]);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      expect(await service.getImageAsWebp(IMAGE_URL)).toBe(results[0]);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("passes a 404 to every waiting request and doesn't cache it", async () => {
      answerWith(() => new Response('Not found', { status: 404 }));
      const results = await Promise.allSettled([1, 2].map(() => service.getImageAsWebp(IMAGE_URL)));
      for (const result of results) {
        expect((result as PromiseRejectedResult).reason).toBeInstanceOf(NotFoundException);
      }
      expect(mockFetch).toHaveBeenCalledTimes(1);

      await expect(service.getImageAsWebp(IMAGE_URL)).rejects.toBeInstanceOf(NotFoundException);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('refuses an image whose content-length is over the limit without reading its body', async () => {
      let pulled = false;
      // highWaterMark 0: nothing is pulled until the body is read
      const body = new ReadableStream(
        {
          pull(controller) {
            pulled = true;
            controller.enqueue(new Uint8Array(1024));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      answerWith(
        () =>
          new Response(body, {
            headers: { 'content-type': 'image/png', 'content-length': String(MAX_IMAGE_BYTES + 1) },
          }),
      );

      const error = await service.getImageAsWebp(IMAGE_URL).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        `Image request failed for ${IMAGE_URL}: Body larger than ${MAX_IMAGE_BYTES} bytes`,
      );
      expect(pulled).toBe(false);
    });
  });

  describe('getImageAsWebp conversion limit', () => {
    let png: Buffer;
    let held: { url: string; answer: () => void }[];

    const imageUrl = (i: number) => `https://cdn.runescape.com/news/${i}.png`;

    beforeEach(async () => {
      png = await createPng();
      held = [];
      // Holds every image request open until the test answers it
      mockFetch.mockImplementation(
        (url) =>
          new Promise((resolve) =>
            held.push({
              url: String(url),
              answer: () => resolve(new Response(png, { headers: { 'content-type': 'image/png' } })),
            }),
          ),
      );
    });

    it('converts a few distinct images at once, queues some and answers 503 to the rest without fetching', async () => {
      const max = MAX_CONCURRENT_IMAGE_CONVERSIONS + MAX_QUEUED_IMAGE_CONVERSIONS;
      const requests = Array.from({ length: max }, (_, i) => service.getImageAsWebp(imageUrl(i)));
      await vi.waitFor(() => expect(held).toHaveLength(MAX_CONCURRENT_IMAGE_CONVERSIONS));
      expect(resilience.bulkhead(NEWS_IMAGES)).toMatchObject({
        active: MAX_CONCURRENT_IMAGE_CONVERSIONS,
        queued: MAX_QUEUED_IMAGE_CONVERSIONS,
      });

      const error = await service.getImageAsWebp(imageUrl(max)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as ServiceUnavailableException).message).toBe('Failed to fetch image');
      expect(warn).not.toHaveBeenCalled(); // ResilienceEventsListener logs rejections, throttled
      expect(mockFetch).toHaveBeenCalledTimes(MAX_CONCURRENT_IMAGE_CONVERSIONS);

      // A finished conversion lets the next queued one fetch
      held[0].answer();
      await vi.waitFor(() => expect(held).toHaveLength(MAX_CONCURRENT_IMAGE_CONVERSIONS + 1));
      expect(held.at(-1)?.url).toBe(imageUrl(MAX_CONCURRENT_IMAGE_CONVERSIONS));

      for (let i = 1; i < max; i++) {
        await vi.waitFor(() => expect(held.length).toBeGreaterThan(i));
        held[i].answer();
      }
      await Promise.all(requests);
      expect(resilience.bulkhead(NEWS_IMAGES)).toMatchObject({ active: 0, queued: 0 });
    });

    it('answers 503 to a conversion that waits longer than the queue timeout for a slot', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const active = Array.from({ length: MAX_CONCURRENT_IMAGE_CONVERSIONS }, (_, i) =>
          service.getImageAsWebp(imageUrl(i)),
        );
        await vi.waitFor(() => expect(held).toHaveLength(MAX_CONCURRENT_IMAGE_CONVERSIONS));
        const queued = service.getImageAsWebp(imageUrl(MAX_CONCURRENT_IMAGE_CONVERSIONS)).catch((e: unknown) => e);

        await vi.advanceTimersByTimeAsync(IMAGE_QUEUE_TIMEOUT_MS);
        expect(await queued).toBeInstanceOf(ServiceUnavailableException);
        expect(mockFetch).toHaveBeenCalledTimes(MAX_CONCURRENT_IMAGE_CONVERSIONS);

        for (const request of held) request.answer();
        await Promise.all(active);
      } finally {
        vi.useRealTimers();
      }
    });

    it('takes one slot for concurrent requests for one image, and none for a cached one', async () => {
      const requests = [1, 2, 3].map(() => service.getImageAsWebp(imageUrl(0)));
      await vi.waitFor(() => expect(held).toHaveLength(1));
      expect(resilience.bulkhead(NEWS_IMAGES)).toMatchObject({ active: 1, queued: 0 });

      held[0].answer();
      await Promise.all(requests);
      expect(resilience.bulkhead(NEWS_IMAGES)).toMatchObject({ active: 0, queued: 0 });

      // Cache hits don't wait for a slot, even with every slot taken
      const others = Array.from({ length: MAX_CONCURRENT_IMAGE_CONVERSIONS }, (_, i) =>
        service.getImageAsWebp(imageUrl(i + 1)),
      );
      await vi.waitFor(() => expect(held).toHaveLength(1 + MAX_CONCURRENT_IMAGE_CONVERSIONS));
      await service.getImageAsWebp(imageUrl(0));
      expect(mockFetch).toHaveBeenCalledTimes(1 + MAX_CONCURRENT_IMAGE_CONVERSIONS);

      for (const request of held.slice(1)) request.answer();
      await Promise.all(others);
    });
  });

  describe('getImageAsWebp size limit', () => {
    let server: Server;
    let imageAgent: Agent;
    let requests: IncomingHttpHeaders[];

    /** A local server answering every request with an image body one byte over the limit. */
    function serveOversizedImage(withContentLength: boolean): Promise<void> {
      server = createServer((req, res) => {
        requests.push(req.headers);
        res.setHeader('content-type', 'image/png');
        const body = Buffer.alloc(MAX_IMAGE_BYTES + 1);
        if (withContentLength) return void res.end(body); // sets content-length
        res.write(body); // chunked, no content-length
        res.end();
      });
      return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    }

    beforeEach(async () => {
      const undici = await vi.importActual<typeof import('undici')>('undici');
      mockFetch.mockImplementation(undici.fetch);
      requests = [];
      imageAgent = imageAgentProvider.useFactory() as Agent;
      const config = { get: () => '' } as unknown as ConfigService<Env, true>;
      ({ service } = await createNewsService(imageAgent, {} as XMLParser, config));
    });

    afterEach(async () => {
      await imageAgent.close();
      await new Promise((resolve) => server.close(resolve));
    });

    it.each([
      ['with', true],
      ['without', false],
    ])("answers 503 for a body over the limit %s content-length, logs why and doesn't cache it", async (_, cl) => {
      await serveOversizedImage(cl);
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/news/big.png`;

      const error = await service.getImageAsWebp(url).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as ServiceUnavailableException).message).toBe('Failed to fetch image');
      expect(warn).toHaveBeenCalledExactlyOnceWith(`Image request failed for ${url}: Body larger than 10485760 bytes`);
      // The limit counts bytes off the wire, so a compressed body mustn't be asked for
      expect(requests[0]['accept-encoding']).toBe('identity');

      await expect(service.getImageAsWebp(url)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(requests).toHaveLength(2);
    });
  });
});
