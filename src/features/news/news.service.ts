import {
  BadGatewayException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OsrsNewsItem } from '@osrs-tracker/models';
import { XMLParser } from 'fast-xml-parser';
import { LRUCache } from 'lru-cache';
import sharp from 'sharp';
import { Agent, fetch, Response } from 'undici';
import { AGENT } from '../../common/agent/agent.provider';
import { XML_PARSER } from '../../common/xml/xml.provider';
import { Env } from '../../config/env';

@Injectable()
export class NewsService {
  private readonly logger = new Logger(NewsService.name);

  private readonly NEWS_FETCH_TIMEOUT_MS = 10_000;
  private readonly NEWS_CACHE_TTL_MS = 300_000; // matches the `/news` Cache-Control max-age
  private readonly NEWS_RETRY_MS = 60_000; // after a failed refresh, serve the stale copy this long before retrying

  private readonly IMAGE_FETCH_TIMEOUT_MS = 20_000; // covers the body too, which can be up to MAX_IMAGE_BYTES
  private readonly MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
  private readonly MAX_IMAGE_PIXELS = 25_000_000; // e.g. 5000x5000

  private readonly IMAGE_CACHE_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
  private readonly EVICTION_WARNING_INTERVAL_MS = 60_000; // at most one warning per minute

  private evictionsSinceWarning = 0;
  private lastEvictionWarning = 0;

  /**
   * The parsed feed, so `/news` doesn't fetch Jagex on every request (SSR calls the API directly, not via a cache).
   * `fetch` shares one refresh between concurrent requests; `fetchNews` keeps the stale copy when Jagex fails.
   */
  private readonly newsCache = new LRUCache<'news', OsrsNewsItem[]>({
    max: 1,
    ttl: this.NEWS_CACHE_TTL_MS,
    fetchMethod: (_key, staleItems, { options }) => this.fetchNews(staleItems, options),
  });

  /**
   * WebP images by URL, capped by total size so memory stays bounded whatever images are requested. `fetch` shares one
   * conversion per URL between concurrent requests; a failure rejects every waiting request and isn't cached.
   */
  private readonly imageCache = new LRUCache<string, Buffer>({
    maxSize: this.IMAGE_CACHE_MAX_BYTES,
    sizeCalculation: (webp) => webp.length,
    dispose: (_webp, url, reason) => {
      if (reason === 'evict') this.warnImageCacheEviction(url);
    },
    fetchMethod: (url) => this.fetchImageAsWebp(url),
    // An eviction aborts a conversion in flight: finish it for the waiting requests instead of answering them nothing
    ignoreFetchAbort: true,
  });

  constructor(
    @Inject(AGENT) private readonly agent: Agent,
    @Inject(XML_PARSER) private readonly xmlParser: XMLParser,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async getRecentNews(limit: number): Promise<OsrsNewsItem[]> {
    const osrsNewsItems = await this.newsCache.forceFetch('news');

    return osrsNewsItems.slice(0, limit);
  }

  /**
   * Fetches an image from URL or cache and converts it to WebP format
   * @param url Image URL to fetch
   * @returns WebP image as Buffer
   */
  getImageAsWebp(url: string): Promise<Buffer> {
    return this.imageCache.forceFetch(url);
  }

  /**
   * The feed cache's `fetchMethod`. When Jagex fails, serves the stale copy for `NEWS_RETRY_MS` if there is one, else
   * answers 503 (a rejection isn't cached, so the next request retries).
   */
  private async fetchNews(
    staleItems: OsrsNewsItem[] | undefined,
    options: LRUCache.FetcherFetchOptions<'news', OsrsNewsItem[]>,
  ): Promise<OsrsNewsItem[]> {
    try {
      const response = await fetch(
        this.config.get('OSRS_API_BASE_URL', { infer: true }) + '/m=news/latest_news.rss?oldschool=true',
        {
          dispatcher: this.agent,
          signal: AbortSignal.timeout(this.NEWS_FETCH_TIMEOUT_MS),
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      return this.parseOSRSNewsRSS(await response.text());
    } catch (error) {
      const message = (error as Error).message;
      if (!staleItems) {
        this.logger.warn(`News feed request failed: ${message}`);
        throw new ServiceUnavailableException('OSRS news is unavailable, try again later.');
      }

      this.logger.warn(`News feed request failed, serving the cached copy: ${message}`);
      options.ttl = this.NEWS_RETRY_MS; // the stale copy is stored again with this ttl, so it's retried sooner
      return staleItems;
    }
  }

  private async fetchImageAsWebp(url: string): Promise<Buffer> {
    // Redirects are refused so the request can't leave the CDN.
    this.logger.log(`Fetching image from URL: ${url}`);
    let imageBuffer: Buffer;
    try {
      const response = await fetch(url, {
        dispatcher: this.agent,
        redirect: 'error',
        signal: AbortSignal.timeout(this.IMAGE_FETCH_TIMEOUT_MS),
      });

      if (response.status === 404) throw new NotFoundException('Image not found');
      if (!response.ok) {
        this.logger.warn(`Image request returned HTTP ${response.status} for ${url}`);
        throw new BadGatewayException('Failed to fetch image');
      }
      if (!response.headers.get('content-type')?.startsWith('image/')) {
        this.logger.warn(`Image request returned content-type ${response.headers.get('content-type')} for ${url}`);
        throw new BadGatewayException('Failed to fetch image');
      }

      imageBuffer = await this.readBody(response, this.MAX_IMAGE_BYTES);
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof BadGatewayException) throw error;

      // Network errors, timeouts, redirects and bodies over the size limit
      this.logger.warn(`Image request failed for ${url}: ${(error as Error).message}`);
      throw new ServiceUnavailableException('Failed to fetch image');
    }

    // Convert to WebP
    let webpBuffer: Buffer;
    try {
      webpBuffer = await sharp(imageBuffer, { limitInputPixels: this.MAX_IMAGE_PIXELS })
        .webp({ quality: 80 })
        .toBuffer();
    } catch (error) {
      this.logger.warn(`Image conversion failed for ${url}: ${(error as Error).message}`);
      throw new BadGatewayException('Failed to convert image');
    }

    return webpBuffer;
  }

  /** Reads the body, rejecting it as soon as it's larger than `maxBytes` (whatever `content-length` says). */
  private async readBody(response: Response, maxBytes: number): Promise<Buffer> {
    const tooLarge = () => new Error(`Body larger than ${maxBytes} bytes`);
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel();
      throw tooLarge();
    }

    if (!response.body) return Buffer.alloc(0);

    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > maxBytes) throw tooLarge(); // leaving the loop cancels the stream
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  }

  /**
   * Real news images need only a fraction of the cache, so evictions point at unusual traffic (e.g. someone
   * requesting many large CDN images). Throttled, so a flood of requests can't flood the logs too.
   */
  private warnImageCacheEviction(url: string): void {
    this.evictionsSinceWarning++;

    const now = Date.now();
    if (now - this.lastEvictionWarning < this.EVICTION_WARNING_INTERVAL_MS) return;

    const cacheMb = (this.imageCache.calculatedSize / 1024 / 1024).toFixed(1);
    const maxMb = this.IMAGE_CACHE_MAX_BYTES / 1024 / 1024;
    this.logger.warn(
      `Image cache full (${cacheMb}/${maxMb} MB, ${this.imageCache.size} images), evicted ${this.evictionsSinceWarning} ` +
        `image(s) since the last warning, last evicted: ${url}`,
    );

    this.evictionsSinceWarning = 0;
    this.lastEvictionWarning = now;
  }

  /** Throws when the feed isn't RSS (e.g. an error page), so the caller can fall back to the cached copy. */
  private parseOSRSNewsRSS(rss: string): OsrsNewsItem[] {
    const channel = this.xmlParser.parse(rss)?.rss?.channel;
    if (!channel || typeof channel !== 'object') throw new Error('Unexpected news feed: no RSS channel');

    // fast-xml-parser gives an object instead of an array for a single item, and nothing for none
    const items: RssItem[] = channel.item === undefined ? [] : [channel.item].flat();

    return items
      .filter((val) => val?.title && val.link && val.enclosure?.url)
      .map((val) => ({
        title: val.title,
        pubDate: new Date(val.pubDate),
        category: val.category,
        link: val.link,
        description: val.description,
        enclosure: {
          url: val.enclosure.url,
          type: val.enclosure.type,
        },
      }));
  }
}

/** An `<item>` as fast-xml-parser parses it: `pubDate` is still a string. */
type RssItem = Omit<OsrsNewsItem, 'pubDate'> & { pubDate: string };
