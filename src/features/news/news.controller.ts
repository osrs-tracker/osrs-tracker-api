import { Controller, Get, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { CACHE_CONTROL } from '../../common/http/cache-control';
import { ParseIntRangeOptions, ParseIntRangePipe } from '../../common/pipes/parse-int-range.pipe';
import { NewsArchiveCursor } from './news-archive';
import { NewsService } from './news.service';
import { ParseNewsCategoryPipe } from './parse-news-category.pipe';
import { ParseNewsCursorPipe } from './parse-news-cursor.pipe';
import { ParseNewsImageUrlPipe } from './parse-news-image-url.pipe';

const LIMIT: ParseIntRangeOptions = { min: 1, max: 50, default: 4 };
const ARCHIVE_LIMIT: ParseIntRangeOptions = { min: 1, max: 50, default: 20 };

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
   * A page of every stored post (feed and backfilled), newest first with ties on `pubDate` broken by `link`, as
   * `{ posts, next }`: `limit` posts (1 to 50, default 20) after the `before` cursor (the previous page's `next`; none
   * for the first page) in `category` when given (Jagex's name, e.g. `Game Updates`; an unknown one matches nothing).
   * `next` is `null` on the last page. The first page refreshes the feed first but answers from the stored posts when
   * Jagex fails. `NEWS_ARCHIVE`; 400 for an invalid `before`, `limit` or `category`. Errors have no `Cache-Control`.
   */
  @Get('archive')
  async getNewsArchive(
    @Res({ passthrough: true }) res: Response,
    @Query('limit', new ParseIntRangePipe(ARCHIVE_LIMIT)) limit: number,
    @Query('before', ParseNewsCursorPipe) cursor: NewsArchiveCursor | undefined,
    @Query('category', ParseNewsCategoryPipe) category: string | undefined,
  ) {
    const page = await this.newsService.getNewsArchive(limit, cursor, category);

    // Set only on success (not with @Header), so caches don't keep a failed read for 5 minutes
    res.setHeader('Cache-Control', CACHE_CONTROL.NEWS_ARCHIVE);
    return page;
  }

  /**
   * The image at `url` (a plain `https://cdn.runescape.com/` URL of at most 512 characters: no credentials, query or
   * hash; `ParseNewsImageUrlPipe`) as WebP, with `NEWS_IMAGE`. 400 for a missing, too long or other URL, 404 when the
   * CDN has no such image, 502 when it answers another error or something that isn't an image or the image can't be
   * converted, 503 when it can't be reached, times out, redirects or sends an image that's too large, or too many
   * images are being converted. Errors have no `Cache-Control`.
   */
  @Get('image')
  async getImageAsWebp(@Res() res: Response, @Query('url', ParseNewsImageUrlPipe) url: string) {
    const webp = await this.newsService.getImageAsWebp(url);

    // Set only on success (not with @Header), so browsers don't cache a rejected URL or failed fetch for a week
    res.setHeader('Cache-Control', CACHE_CONTROL.NEWS_IMAGE);
    res.setHeader('Content-Type', 'image/webp');
    return res.send(webp);
  }
}
