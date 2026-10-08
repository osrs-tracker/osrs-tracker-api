import {
  BadRequestException,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { isBotRequest } from '../../common/bot/is-bot-request';
import { CACHE_CONTROL } from '../../common/http/cache-control';
import { ParseIntRangePipe } from '../../common/pipes/parse-int-range.pipe';
import { ItemsService } from './items.service';

const ITEM_ID_PIPE = new ParseIntRangePipe({ min: 1, message: (id) => `Invalid item ID "${id}"` });

@ApiTags('items')
@Controller('items')
export class ItemsController {
  constructor(private readonly itemsService: ItemsService) {}

  @Get()
  @Header('Cache-Control', CACHE_CONTROL.REVALIDATE)
  @ApiOperation({ summary: 'Get the last fetched items' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getRecentItems(@Query('limit', new ParseIntRangePipe({ min: 1, max: 50, default: 5 })) limit: number) {
    return this.itemsService.getLastFetchedItems(limit);
  }

  @Get(':id')
  @Header('Cache-Control', CACHE_CONTROL.REVALIDATE)
  @ApiOperation({ summary: 'Get an item by ID' })
  @ApiParam({ name: 'id', description: 'Item ID' })
  async getById(@Param('id', ITEM_ID_PIPE) id: number) {
    const item = await this.itemsService.getItem(id);

    if (!item) throw new NotFoundException(`Item with ID "${id}" not found`);

    return item;
  }

  @Post(':id/lookup')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Record a visitor's lookup of an item (ignored for bots)" })
  @ApiParam({ name: 'id', description: 'Item ID' })
  async recordLookup(@Req() request: Request, @Param('id', ITEM_ID_PIPE) id: number) {
    if (isBotRequest(request)) return;

    await this.itemsService.recordLookup(id);
  }

  @Get('search/:query')
  @Header('Cache-Control', CACHE_CONTROL.ITEM_SEARCH)
  @ApiOperation({ summary: 'Search for items by name' })
  @ApiParam({ name: 'query', description: 'Search query' })
  async searchItems(@Param('query') query: string) {
    if (!query) throw new BadRequestException('No search query provided');
    if (query.length > 64) throw new BadRequestException('Search query must be at 64 characters or less');

    const items = await this.itemsService.searchItems(query);

    if (items.length === 0) throw new HttpException(`No items found for query "${query}"`, HttpStatus.NO_CONTENT);

    return items;
  }
}
