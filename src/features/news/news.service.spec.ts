import { Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { XMLParser } from 'fast-xml-parser';
import sharp from 'sharp';
import { Agent, fetch, Response } from 'undici';
import { afterEach, beforeEach, describe, expect, it, MockInstance, vi } from 'vitest';
import { XMLParserProvider } from '../../common/xml/xml.provider';
import { Env } from '../../config/env';
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

describe('NewsService caches', () => {
  let service: NewsService;
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
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const config = { get: () => 'https://secure.runescape.com' } as unknown as ConfigService<Env, true>;
    const xmlParser = XMLParserProvider.useFactory() as XMLParser;
    service = new NewsService(undefined as unknown as Agent, xmlParser, config);
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
      const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#f00' } })
        .png()
        .toBuffer();
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
  });
});
