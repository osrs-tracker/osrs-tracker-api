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
import {
  ApiBadRequestResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { isBotRequest } from '../../common/bot/is-bot-request';
import { CACHE_CONTROL } from '../../common/http/cache-control';
import { ParseIntRangeOptions, ParseIntRangePipe } from '../../common/pipes/parse-int-range.pipe';
import { ApiIntRangeQuery } from '../../common/swagger/api-int-range-query';
import { ItemsService } from './items.service';

const ITEM_ID: ParseIntRangeOptions = { min: 1, message: (id) => `Invalid item ID "${id}"` };
const ITEM_ID_PIPE = new ParseIntRangePipe(ITEM_ID);
const ITEM_ID_PARAM = ApiParam({
  name: 'id',
  description: 'Item ID',
  schema: { type: 'integer', minimum: ITEM_ID.min },
});
const LIMIT: ParseIntRangeOptions = { min: 1, max: 50, default: 5 };

@ApiTags('items')
@Controller('items')
export class ItemsController {
  constructor(private readonly itemsService: ItemsService) {}

  @Get()
  @Header('Cache-Control', CACHE_CONTROL.REVALIDATE)
  @ApiOperation({ summary: 'Get the last fetched items' })
  @ApiIntRangeQuery('limit', LIMIT)
  @ApiOkResponse({
    description: `The most recently looked up \`Item\`s, newest first. \`Cache-Control: ${CACHE_CONTROL.REVALIDATE}\` on every response.`,
  })
  @ApiBadRequestResponse({ description: '`limit` out of range.' })
  getRecentItems(@Query('limit', new ParseIntRangePipe(LIMIT)) limit: number) {
    return this.itemsService.getLastFetchedItems(limit);
  }

  @Get(':id')
  @Header('Cache-Control', CACHE_CONTROL.REVALIDATE)
  @ApiOperation({ summary: 'Get an item by ID' })
  @ITEM_ID_PARAM
  @ApiOkResponse({
    description: `The \`Item\`. \`Cache-Control: ${CACHE_CONTROL.REVALIDATE}\` on every response.`,
  })
  @ApiBadRequestResponse({ description: 'Invalid item ID.' })
  @ApiNotFoundResponse({ description: 'No item with this ID.' })
  async getById(@Param('id', ITEM_ID_PIPE) id: number) {
    const item = await this.itemsService.getItem(id);

    if (!item) throw new NotFoundException(`Item with ID "${id}" not found`);

    return item;
  }

  @Post(':id/lookup')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Record a visitor's lookup of an item (ignored for bots)" })
  @ITEM_ID_PARAM
  @ApiNoContentResponse({ description: 'Recorded, or ignored for a bot.' })
  @ApiBadRequestResponse({ description: 'Invalid item ID.' })
  async recordLookup(@Req() request: Request, @Param('id', ITEM_ID_PIPE) id: number) {
    if (isBotRequest(request)) return;

    await this.itemsService.recordLookup(id);
  }

  @Get('search/:query')
  @Header('Cache-Control', CACHE_CONTROL.ITEM_SEARCH)
  @ApiOperation({ summary: 'Search for items by name' })
  @ApiParam({ name: 'query', description: 'Search query, at most 64 characters' })
  @ApiOkResponse({
    description:
      'Up to 20 matching `Item`s, best match first, with only `id`, `icon`, `name` and the text `score`; `[]` when ' +
      'none match. ' +
      `\`Cache-Control: ${CACHE_CONTROL.ITEM_SEARCH}\` on every response.`,
  })
  @ApiBadRequestResponse({ description: 'Query longer than 64 characters.' })
  async searchItems(@Param('query') query: string) {
    if (!query) throw new BadRequestException('No search query provided');
    if (query.length > 64) throw new BadRequestException('Search query must be at 64 characters or less');

    return this.itemsService.searchItems(query);
  }
}
