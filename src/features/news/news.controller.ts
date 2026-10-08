import {
  BadRequestException,
  Controller,
  DefaultValuePipe,
  Get,
  Header,
  ParseIntPipe,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { NewsService } from './news.service';

@ApiTags('news')
@Controller('news')
export class NewsController {
  constructor(private readonly newsService: NewsService) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=300')
  @ApiOperation({ summary: 'Get recent news articles' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getRecentNews(@Query('limit', new DefaultValuePipe(4), ParseIntPipe) limit: number) {
    if (limit < 1 || limit > 50) throw new BadRequestException('Limit must be between 1 and 50.');

    return this.newsService.getRecentNews(limit);
  }

  @Get('image')
  @ApiOperation({ summary: 'Get image as WebP' })
  @ApiQuery({ name: 'url', required: true, type: String })
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
    res.setHeader('Cache-Control', 'max-age=604800');
    res.setHeader('Content-Type', 'image/webp');
    return res.send(webp);
  }
}
