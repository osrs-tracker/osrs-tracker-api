import { Inject, Injectable, Logger } from '@nestjs/common';
import { OsrsNewsItem } from '@osrs-tracker/models';
import { XMLParser } from 'fast-xml-parser';
import { Agent } from 'https';
import fetch from 'node-fetch';
import * as sharp from 'sharp';

@Injectable()
export class NewsService {
  private readonly logger = new Logger(NewsService.name);
  private imageCache = new Map<string, Buffer>();

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
    if (this.imageCache.has(url)) return this.imageCache.get(url)!;

    // Fetch the image if not in cache
    this.logger.log(`Fetching image from URL: ${url}`);
    const response = await fetch(url, { agent: this.agent });

    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
    }

    // Get image buffer
    const imageBuffer = Buffer.from(await response.arrayBuffer());

    // Convert to WebP
    const webpBuffer = await sharp(imageBuffer).webp({ quality: 80 }).toBuffer();

    // Store in cache
    this.imageCache.set(url, webpBuffer);

    return webpBuffer;
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
