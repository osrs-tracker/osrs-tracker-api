import { Controller, Get, Header, Query } from '@nestjs/common';
import { CACHE_CONTROL } from '../../common/http/cache-control';
import { ParseIntRangePipe } from '../../common/pipes/parse-int-range.pipe';
import { ItemsService } from './items.service';

/** Not under `/items`: `/items/:id` would shadow `/items/new`, which the route conflict policy rejects. */
@Controller('new-items')
export class NewItemsController {
  constructor(private readonly itemsService: ItemsService) {}

  /**
   * The items the ingester added, newest first, with only `id`, `icon`, `name` and `addedAt`. Items stored before
   * `addedAt` existed have none and are never listed, so it's `[]` until a game update adds one. 400 when `limit` is out
   * of range. `NEW_ITEMS` on every response.
   */
  @Get()
  @Header('Cache-Control', CACHE_CONTROL.NEW_ITEMS)
  getNewItems(@Query('limit', new ParseIntRangePipe({ min: 1, max: 100, default: 25 })) limit: number) {
    return this.itemsService.getNewItems(limit);
  }
}
