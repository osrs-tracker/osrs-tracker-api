import { Inject, Injectable, Logger } from '@nestjs/common';
import { OsrsNewsItem } from '@osrs-tracker/models';
import { XMLParser } from 'fast-xml-parser';
import { Agent } from 'https';
import { LRUCache } from 'lru-cache';
import fetch from 'node-fetch';
import sharp from 'sharp';

@Injectable()
export class NewsService {
  private readonly logger = new Logger(NewsService.name);

  private readonly MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
  private readonly MAX_IMAGE_PIXELS = 25_000_000; // e.g. 5000x5000

  private readonly IMAGE_CACHE_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
  private readonly EVICTION_WARNING_INTERVAL_MS = 60_000; // at most one warning per minute

  private evictionsSinceWarning = 0;
  private lastEvictionWarning = 0;

  /** WebP images by URL, capped by total size so memory stays bounded whatever images are requested. */
  private readonly imageCache = new LRUCache<string, Buffer>({
    maxSize: this.IMAGE_CACHE_MAX_BYTES,
    sizeCalculation: (webp) => webp.length,
    dispose: (_webp, url, reason) => {
      if (reason === 'evict') this.warnImageCacheEviction(url);
    },
  });

  constructor(
    @Inject('AGENT') private readonly agent: Agent,
    @Inject('XML_PARSER') private readonly xmlParser: XMLParser,
  ) {}

  async getRecentNews(limit: number) {
    const rss = await fetch(process.env.OSRS_API_BASE_URL + '/m=news/latest_news.rss?oldschool=true', {
      agent: this.agent,
    }).then((res) => res.text());

    const osrsNewsItems = this.parseOSRSNewsRSS(rss);

    return osrsNewsItems.slice(0, limit);
  }

  /**
   * Fetches an image from URL or cache and converts it to WebP format
   * @param url Image URL to fetch
   * @returns WebP image as Buffer
   */
  async getImageAsWebp(url: string): Promise<Buffer> {
    // Check if image is in cache
    const cached = this.imageCache.get(url);
    if (cached) return cached;

    // Fetch the image if not in cache. Redirects are refused so the request can't leave the CDN.
    this.logger.log(`Fetching image from URL: ${url}`);
    const response = await fetch(url, { agent: this.agent, redirect: 'error', size: this.MAX_IMAGE_BYTES });

    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
    }
    if (!response.headers.get('content-type')?.startsWith('image/')) {
      throw new Error(`Failed to fetch image: unexpected content-type ${response.headers.get('content-type')}`);
    }

    // Get image buffer, node-fetch rejects bodies larger than `size`
    const imageBuffer = Buffer.from(await response.arrayBuffer());

    // Convert to WebP
    const webpBuffer = await sharp(imageBuffer, { limitInputPixels: this.MAX_IMAGE_PIXELS })
      .webp({ quality: 80 })
      .toBuffer();

    // Store in cache, evicting the least recently used images when full
    this.imageCache.set(url, webpBuffer);

    return webpBuffer;
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

  private parseOSRSNewsRSS(rss: string) {
    const parsedRss = this.xmlParser.parse(rss);

    const osrsNewsItems = parsedRss.rss.channel.item.map((val: OsrsNewsItem) => ({
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

    return osrsNewsItems;
  }
}
