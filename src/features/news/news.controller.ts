import { BadRequestException, Controller, Get, Query, Res } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { CACHE_CONTROL } from '../../common/http/cache-control';
import { ParseIntRangeOptions, ParseIntRangePipe } from '../../common/pipes/parse-int-range.pipe';
import { ApiIntRangeQuery } from '../../common/swagger/api-int-range-query';
import { NewsService } from './news.service';

const LIMIT: ParseIntRangeOptions = { min: 1, max: 50, default: 4 };

@ApiTags('news')
@Controller('news')
export class NewsController {
  constructor(private readonly newsService: NewsService) {}

  @Get()
  @ApiOperation({ summary: 'Get recent news articles' })
  @ApiIntRangeQuery('limit', LIMIT)
  @ApiOkResponse({
    description:
      "The newest `OsrsNewsItem`s from Jagex's RSS feed (cached for 5 minutes, served stale while Jagex fails). " +
      `\`Cache-Control: ${CACHE_CONTROL.NEWS}\`.`,
  })
  @ApiBadRequestResponse({ description: '`limit` out of range.' })
  @ApiServiceUnavailableResponse({
    description: "Jagex's feed can't be fetched and nothing is cached. No `Cache-Control`.",
  })
  async getRecentNews(
    @Res({ passthrough: true }) res: Response,
    @Query('limit', new ParseIntRangePipe(LIMIT)) limit: number,
  ) {
    const news = await this.newsService.getRecentNews(limit);

    // Set only on success (not with @Header), so caches don't keep a 503 for 5 minutes while Jagex is down
    res.setHeader('Cache-Control', CACHE_CONTROL.NEWS);
    return news;
  }

  @Get('image')
  @ApiOperation({ summary: 'Get image as WebP' })
  @ApiQuery({
    name: 'url',
    required: true,
    type: String,
    description: 'Image URL on `https://cdn.runescape.com/`, no query or hash',
  })
  @ApiProduces('image/webp')
  @ApiOkResponse({
    description: `The image converted to WebP. \`Cache-Control: ${CACHE_CONTROL.NEWS_IMAGE}\`.`,
    schema: { type: 'string', format: 'binary' },
  })
  @ApiBadRequestResponse({ description: 'Missing, too long (over 512 characters) or not a plain CDN URL.' })
  @ApiNotFoundResponse({ description: 'The CDN has no such image.' })
  @ApiBadGatewayResponse({
    description: "The CDN answers another error or something that isn't an image, or the image can't be converted.",
  })
  @ApiServiceUnavailableResponse({
    description:
      "The CDN can't be reached, times out, redirects or sends an image that's too large. Errors have no `Cache-Control`.",
  })
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
