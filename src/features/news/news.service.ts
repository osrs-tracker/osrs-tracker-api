import {
  BadGatewayException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BulkheadFullError, ResiliencePolicy, ResilienceService } from '@nestjs/resilience';
import { NewsArchivePage, OsrsNewsItem, StoredNewsItem } from '@osrs-tracker/models';
import { XMLParser } from 'fast-xml-parser';
import { LRUCache } from 'lru-cache';
import { AnyBulkWriteOperation, Collection, Db } from 'mongodb';
import sharp from 'sharp';
import { Agent, errors, fetch } from 'undici';
import { AGENT, IMAGE_AGENT, MAX_IMAGE_BYTES, USER_AGENT } from '../../common/agent/agent.provider';
import { ThrottledWarning } from '../../common/logger/throttled-warning';
import { NEWS_COLLECTION } from '../../common/mongo/collections';
import { MONGODB_DATABASE } from '../../common/mongo/mongo.provider';
import { XML_PARSER } from '../../common/xml/xml.provider';
import { Env } from '../../config/env';
import { buildNewsArchiveFilter, encodeNewsCursor, NEWS_ARCHIVE_SORT, NewsArchiveCursor } from './news-archive';
import { MAX_IMAGE_PIXELS, NEWS_IMAGES } from './news.config';

/** The most posts `getNewsSince` returns. */
export const MAX_NEWS_SINCE = 200;

/** A category of the stored posts and how many posts it has, for the archive's filter. */
export interface NewsCategory {
  category: string;
  count: number;
}

@Injectable()
export class NewsService {
  private readonly logger = new Logger(NewsService.name);

  private readonly NEWS_FETCH_TIMEOUT_MS = 10_000;
  private readonly NEWS_CACHE_TTL_MS = 300_000; // matches the `/news` Cache-Control max-age
  private readonly NEWS_RETRY_MS = 60_000; // after a failed refresh, serve the stale copy this long before retrying

  private readonly IMAGE_FETCH_TIMEOUT_MS = 20_000; // covers the body too, which can be up to MAX_IMAGE_BYTES

  private readonly IMAGE_CACHE_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
  private readonly evictionWarning = new ThrottledWarning();

  private readonly imagesPolicy: ResiliencePolicy;
  /**
   * The stored posts. The Wiki's older posts were backfilled once, then Jagex's teasers and images; both backfill
   * scripts were removed (`CHANGELOG.md`, 2026-10-13 and 2026-10-14).
   */
  private readonly news: Collection<StoredNewsItem>;

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
   * conversion per URL between concurrent requests, so they take one `NEWS_IMAGES` slot (a cache hit takes none); a
   * failure rejects every waiting request and isn't cached.
   */
  private readonly imageCache = new LRUCache<string, Buffer>({
    maxSize: this.IMAGE_CACHE_MAX_BYTES,
    sizeCalculation: (webp) => webp.length,
    dispose: (_webp, url, reason) => {
      if (reason === 'evict') this.warnImageCacheEviction(url);
    },
    fetchMethod: (url) => this.convertImage(url),
    // An eviction aborts a conversion in flight: finish it for the waiting requests instead of answering them nothing
    ignoreFetchAbort: true,
  });

  constructor(
    @Inject(AGENT) private readonly agent: Agent,
    @Inject(IMAGE_AGENT) private readonly imageAgent: Agent,
    @Inject(XML_PARSER) private readonly xmlParser: XMLParser,
    @Inject(MONGODB_DATABASE) db: Db,
    private readonly config: ConfigService<Env, true>,
    resilience: ResilienceService,
  ) {
    this.imagesPolicy = resilience.preset(NEWS_IMAGES);
    this.news = db.collection(NEWS_COLLECTION);
  }

  async getRecentNews(limit: number): Promise<OsrsNewsItem[]> {
    const osrsNewsItems = await this.newsCache.forceFetch('news');

    return osrsNewsItems.slice(0, limit);
  }

  /**
   * The stored posts published after `since`, newest first, at most `MAX_NEWS_SINCE`. Refreshes the feed first (stored
   * by `fetchNews`), so they're as fresh as `/news`; when Jagex fails, the stored posts are served as they are.
   */
  async getNewsSince(since: Date): Promise<StoredNewsItem[]> {
    await this.newsCache.forceFetch('news').catch(() => undefined); // `fetchNews` logged the failure

    return this.news
      .find({ pubDate: { $gt: since } }, { sort: { pubDate: -1 }, limit: MAX_NEWS_SINCE, projection: { _id: 0 } })
      .toArray();
  }

  /**
   * A page of the stored posts in `NEWS_ARCHIVE_SORT` order, after `cursor` and in `category` when given. The first page
   * refreshes the feed first, like `getNewsSince` (and answers from the stored posts when Jagex fails); later pages only
   * hold older posts, so they don't.
   */
  async getNewsArchive(limit: number, cursor?: NewsArchiveCursor, category?: string): Promise<NewsArchivePage> {
    if (!cursor) await this.newsCache.forceFetch('news').catch(() => undefined); // `fetchNews` logged the failure

    // One more than the page, to know whether another page follows without counting
    const posts = await this.news
      .find(buildNewsArchiveFilter(cursor, category), {
        sort: NEWS_ARCHIVE_SORT,
        limit: limit + 1,
        projection: { _id: 0 },
      })
      .toArray();

    if (posts.length <= limit) return { posts, next: null };

    const page = posts.slice(0, limit);
    return { posts: page, next: encodeNewsCursor(page[limit - 1]) };
  }

  /** The stored posts' categories by name, with their post counts. */
  getNewsCategories(): Promise<NewsCategory[]> {
    return this.news
      .aggregate<NewsCategory>([
        { $match: { category: { $type: 'string' } } },
        { $group: { _id: '$category', count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
        { $project: { _id: 0, category: '$_id', count: 1 } },
      ])
      .toArray();
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
          headers: { 'user-agent': USER_AGENT },
          signal: AbortSignal.timeout(this.NEWS_FETCH_TIMEOUT_MS),
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const items = this.parseOSRSNewsRSS(await response.text());
      await this.storeNews(items);
      return items;
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

  /**
   * Upserts the feed's posts keyed on `link`, so they're kept after they leave the feed (it holds the newest 15). Once
   * per feed refresh, whoever's request triggered it: the one write a GET can cause. A failure is logged, not thrown,
   * so `/news` still answers.
   */
  private async storeNews(items: OsrsNewsItem[]): Promise<void> {
    if (!items.length) return;

    const upserts: AnyBulkWriteOperation<StoredNewsItem>[] = items.map((item) => ({
      updateOne: { filter: { link: item.link }, update: { $set: item }, upsert: true },
    }));
    try {
      await this.news.bulkWrite(upserts, { ordered: false });
    } catch (error) {
      this.logger.warn(`Storing the news feed failed: ${(error as Error).message}`);
    }
  }

  /**
   * The image cache's `fetchMethod`: fetches and converts in a `NEWS_IMAGES` slot, so only a few images are in memory at
   * once. A conversion that gets no slot (queue full or waited too long) answers 503 without fetching; it isn't logged
   * per URL (`ResilienceEventsListener` logs rejections, throttled, and counts them).
   */
  private async convertImage(url: string): Promise<Buffer> {
    try {
      return await this.imagesPolicy.execute(({ signal }) => this.fetchImageAsWebp(url, signal));
    } catch (error) {
      if (error instanceof BulkheadFullError) throw new ServiceUnavailableException('Failed to fetch image');
      throw error;
    }
  }

  private async fetchImageAsWebp(url: string, signal: AbortSignal): Promise<Buffer> {
    // Redirects are refused so the request can't leave the CDN. `IMAGE_AGENT` caps the body at `MAX_IMAGE_BYTES` as
    // read off the wire, so `identity` keeps a compressed body from decompressing past it.
    this.logger.log(`Fetching image from URL: ${url}`);
    let imageBuffer: Buffer;
    try {
      const response = await fetch(url, {
        dispatcher: this.imageAgent,
        headers: { 'accept-encoding': 'identity', 'user-agent': USER_AGENT },
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.IMAGE_FETCH_TIMEOUT_MS)]),
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
      // Refused before downloading when the CDN says it's too large; `maxResponseSize` covers a missing or wrong length
      if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
        await response.body?.cancel();
        throw new ImageTooLargeError();
      }

      imageBuffer = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof BadGatewayException) throw error;

      // Network errors, timeouts, redirects and bodies over the size limit (a `terminated` TypeError from the body read)
      const reason =
        error instanceof ImageTooLargeError || (error as Error).cause instanceof errors.ResponseExceededMaxSizeError
          ? `Body larger than ${MAX_IMAGE_BYTES} bytes`
          : (error as Error).message;
      this.logger.warn(`Image request failed for ${url}: ${reason}`);
      throw new ServiceUnavailableException('Failed to fetch image');
    }

    // Convert to WebP
    let webpBuffer: Buffer;
    try {
      webpBuffer = await sharp(imageBuffer, { limitInputPixels: MAX_IMAGE_PIXELS }).webp({ quality: 80 }).toBuffer();
    } catch (error) {
      this.logger.warn(`Image conversion failed for ${url}: ${(error as Error).message}`);
      throw new BadGatewayException('Failed to convert image');
    }

    return webpBuffer;
  }

  /**
   * Real news images need only a fraction of the cache, so evictions point at unusual traffic (e.g. someone
   * requesting many large CDN images). Throttled, so a flood of requests can't flood the logs too.
   */
  private warnImageCacheEviction(url: string): void {
    const evictions = this.evictionWarning.hit();
    if (evictions === undefined) return;

    const cacheMb = (this.imageCache.calculatedSize / 1024 / 1024).toFixed(1);
    const maxMb = this.IMAGE_CACHE_MAX_BYTES / 1024 / 1024;
    this.logger.warn(
      `Image cache full (${cacheMb}/${maxMb} MB, ${this.imageCache.size} images), evicted ${evictions} image(s) ` +
        `since the last warning, last evicted: ${url}`,
    );
  }

  /** Throws when the feed isn't RSS (e.g. an error page), so the caller can fall back to the cached copy. */
  private parseOSRSNewsRSS(rss: string): OsrsNewsItem[] {
    const channel = this.xmlParser.parse(rss)?.rss?.channel;
    if (!channel || typeof channel !== 'object') throw new Error('Unexpected news feed: no RSS channel');

    // An array even for a single item (`XML_PARSER`'s `isArray`), and nothing for none
    const items: RssItem[] = channel.item ?? [];

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

/** An image whose `content-length` is over `MAX_IMAGE_BYTES`, refused before its body is read. */
class ImageTooLargeError extends Error {}

/** An `<item>` as fast-xml-parser parses it: `pubDate` is still a string. */
type RssItem = Omit<OsrsNewsItem, 'pubDate'> & { pubDate: string };
