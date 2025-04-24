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
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  @ApiOperation({ summary: 'Get recent news articles' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getRecentNews(@Query('limit', new DefaultValuePipe(4), ParseIntPipe) limit: number) {
    return this.newsService.getRecentNews(limit);
  }

  @Get('image')
  @Header('Cache-Control', 'max-age=604800')
  @Header('Content-Type', 'image/webp')
  @ApiOperation({ summary: 'Get image as WebP' })
  @ApiQuery({ name: 'url', required: true, type: String })
  async getImageAsWebp(@Res() res: Response, @Query('url') url: string) {
    const OSRS_CDN_ORIGIN = 'https://cdn.runescape.com/';

    if (!url) throw new BadRequestException('No URL provided');
    if (url.length > 512) throw new BadRequestException('URL must be 256 characters or less');
    if (!url.startsWith(OSRS_CDN_ORIGIN)) throw new BadRequestException(`URL must start with "${OSRS_CDN_ORIGIN}"`);

    return res.send(await this.newsService.getImageAsWebp(url));
  }
}
