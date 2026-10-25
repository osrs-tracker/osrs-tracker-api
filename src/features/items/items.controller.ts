import {
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
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { isBotRequest } from '../../common/bot/is-bot-request';
import { CACHE_CONTROL } from '../../common/http/cache-control';
import { ParseIntRangePipe } from '../../common/pipes/parse-int-range.pipe';
import { ItemsService } from './items.service';
import { type ItemListQuery, ParseItemListQueryPipe } from './parse-item-list-query.pipe';

const ITEM_ID_PIPE = new ParseIntRangePipe({ min: 1, message: (id) => `Invalid item ID "${id}"` });

@Controller('items')
export class ItemsController {
  constructor(private readonly itemsService: ItemsService) {}

  /**
   * The items, in one of these modes (`ParseItemListQueryPipe`; 400 for more than one, or an invalid value):
   * - `search`: up to 20 items whose name matches every word of the query: as the start of a word, across words
   *   (`tbow`), inside a word or with a typo (`ItemSearchIndex`). Best match first, with only `id`, `icon` and `name`;
   *   `[]` when none match. 400 for a query over 64 characters. `ITEM_SEARCH`.
   * - `letter`: every item whose name starts with it (`a` to `z`, case-insensitive, accents ignored; `0` for names
   *   starting with a digit or other character), sorted by name case-insensitively, with only `id`, `icon`, `name` and
   *   `updatedAt` (when the ingester last changed it; absent on items it hasn't written since storing dates); `[]` when
   *   none match. The largest letter is about 600 items (40 KB, up to 60 KB once most carry `updatedAt`). 400 for any
   *   other `letter`, uppercase included. `ITEM_BROWSE`.
   * - `sort=lookedUp` (the default): the `limit` (1 to 50, default 5) most recently looked up items, newest first.
   *   `REVALIDATE`.
   * - `sort=added`: the `limit` (1 to 100, default 25) newest items by `addedAt` (when the ingester stored the item,
   *   or its release day from before then; see `DATA-MODEL.md`), with only `id`, `icon`, `name` and `addedAt`.
   *   `NEW_ITEMS`.
   *
   * Each mode's `Cache-Control` is on every response of that mode; a 400 gets `REVALIDATE`.
   */
  @Get()
  @Header('Cache-Control', CACHE_CONTROL.REVALIDATE) // Before the pipe runs, so it's also a 400's
  listItems(@Res({ passthrough: true }) res: Response, @Query(ParseItemListQueryPipe) query: ItemListQuery) {
    if ('search' in query) {
      res.setHeader('Cache-Control', CACHE_CONTROL.ITEM_SEARCH);
      return this.itemsService.searchItems(query.search);
    }
    if ('letter' in query) {
      res.setHeader('Cache-Control', CACHE_CONTROL.ITEM_BROWSE);
      return this.itemsService.browseItems(query.letter);
    }
    if (query.sort === 'added') {
      res.setHeader('Cache-Control', CACHE_CONTROL.NEW_ITEMS);
      return this.itemsService.getNewItems(query.limit);
    }

    return this.itemsService.getLastFetchedItems(query.limit);
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
}
