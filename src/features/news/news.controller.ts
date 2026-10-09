import { BadRequestException, Controller, Get, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { CACHE_CONTROL } from '../../common/http/cache-control';
import { ParseIntRangeOptions, ParseIntRangePipe } from '../../common/pipes/parse-int-range.pipe';
import { NewsService } from './news.service';

const LIMIT: ParseIntRangeOptions = { min: 1, max: 50, default: 4 };

@Controller('news')
export class NewsController {
  constructor(private readonly newsService: NewsService) {}

  /**
   * The newest items from Jagex's RSS feed (cached for 5 minutes, served stale while Jagex fails), with `NEWS`. 400
   * when `limit` is out of range, 503 when the feed can't be fetched and nothing is cached; errors have no
   * `Cache-Control`.
   */
  @Get()
  async getRecentNews(
    @Res({ passthrough: true }) res: Response,
    @Query('limit', new ParseIntRangePipe(LIMIT)) limit: number,
  ) {
    const news = await this.newsService.getRecentNews(limit);

    // Set only on success (not with @Header), so caches don't keep a 503 for 5 minutes while Jagex is down
    res.setHeader('Cache-Control', CACHE_CONTROL.NEWS);
    return news;
  }

  /**
   * The image at `url` (a plain `https://cdn.runescape.com/` URL of at most 512 characters: no credentials, query or
   * hash) as WebP, with `NEWS_IMAGE`. 400 for a missing, too long or other URL, 404 when the CDN has no such image, 502
   * when it answers another error or something that isn't an image or the image can't be converted, 503 when it can't
   * be reached, times out, redirects or sends an image that's too large. Errors have no `Cache-Control`.
   */
  @Get('image')
  async getImageAsWebp(@Res() res: Response, @Query('url') url: string) {
    const OSRS_CDN_ORIGIN = 'https://cdn.runescape.com';

    if (!url) throw new BadRequestException('No URL provided');
    if (url.length > 512) throw new BadRequestException('URL must be 512 characters or less');

    const parsedUrl = URL.parse(url);
    // Only plain CDN paths: a query string or hash would let every request create a new image cache entry.
    if (parsedUrl?.origin !== OSRS_CDN_ORIGIN || parsedUrl.username || parsedUrl.password) {
      throw new BadRequestException(`URL must start with "${OSRS_CDN_ORIGIN}/"`);
    }
    if (parsedUrl.search || parsedUrl.hash) throw new BadRequestException('URL must not contain a query or hash');

    const webp = await this.newsService.getImageAsWebp(parsedUrl.href);

    // Set only on success (not with @Header), so browsers don't cache a rejected URL or failed fetch for a week
    res.setHeader('Cache-Control', CACHE_CONTROL.NEWS_IMAGE);
    res.setHeader('Content-Type', 'image/webp');
    return res.send(webp);
  }
}
