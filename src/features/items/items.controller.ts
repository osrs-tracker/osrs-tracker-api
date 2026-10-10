import {
  BadRequestException,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { isBotRequest } from '../../common/bot/is-bot-request';
import { CACHE_CONTROL } from '../../common/http/cache-control';
import { ParseIntRangeOptions, ParseIntRangePipe } from '../../common/pipes/parse-int-range.pipe';
import { ItemsService } from './items.service';

const ITEM_ID_PIPE = new ParseIntRangePipe({ min: 1, message: (id) => `Invalid item ID "${id}"` });
const LIMIT: ParseIntRangeOptions = { min: 1, max: 50, default: 5 };

@Controller('items')
export class ItemsController {
  constructor(private readonly itemsService: ItemsService) {}

  /**
   * The most recently looked up items, newest first. 400 when `limit` is out of range. `REVALIDATE` on every response.
   */
  @Get()
  @Header('Cache-Control', CACHE_CONTROL.REVALIDATE)
  getRecentItems(@Query('limit', new ParseIntRangePipe(LIMIT)) limit: number) {
    return this.itemsService.getLastFetchedItems(limit);
  }

  /** The item; 400 for an invalid ID, 404 when there's no such item. `REVALIDATE` on every response. */
  @Get(':id')
  @Header('Cache-Control', CACHE_CONTROL.REVALIDATE)
  async getById(@Param('id', ITEM_ID_PIPE) id: number) {
    const item = await this.itemsService.getItem(id);

    if (!item) throw new NotFoundException(`Item with ID "${id}" not found`);

    return item;
  }

  /** Records a visitor's lookup (ignored for bots); 204 either way, 400 for an invalid ID. */
  @Post(':id/lookup')
  @HttpCode(HttpStatus.NO_CONTENT)
  async recordLookup(@Req() request: Request, @Param('id', ITEM_ID_PIPE) id: number) {
    if (isBotRequest(request)) return;

    await this.itemsService.recordLookup(id);
  }

  /**
   * Up to 20 items whose name has a word starting with each word of the query, best match first, with only `id`,
   * `icon`, `name` and the search `score`; `[]` when none match. 400 for a query over 64 characters. `ITEM_SEARCH` on
   * every response.
   */
  @Get('search/:query')
  @Header('Cache-Control', CACHE_CONTROL.ITEM_SEARCH)
  async searchItems(@Param('query') query: string) {
    if (!query) throw new BadRequestException('No search query provided');
    if (query.length > 64) throw new BadRequestException('Search query must be 64 characters or less');

    return this.itemsService.searchItems(query);
  }
}
