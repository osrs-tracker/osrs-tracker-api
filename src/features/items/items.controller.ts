import {
  BadRequestException,
  Controller,
  DefaultValuePipe,
  Get,
  Header,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { isBotRequest } from '../../common/bot/is-bot-request';
import { ItemsService } from './items.service';

@ApiTags('items')
@Controller('items')
export class ItemsController {
  constructor(private readonly itemsService: ItemsService) {}

  @Get()
  @Header('Cache-Control', 'max-age=0, must-revalidate')
  @ApiOperation({ summary: 'Get the last fetched items' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getRecentItems(@Query('limit', new DefaultValuePipe(5), ParseIntPipe) limit: number) {
    if (limit < 1 || limit > 50) throw new BadRequestException('Limit must be between 1 and 50.');

    return this.itemsService.getLastFetchedItems(limit);
  }

  @Get(':id')
  @Header('Cache-Control', 'max-age=0, must-revalidate')
  @ApiOperation({ summary: 'Get an item by ID' })
  @ApiParam({ name: 'id', description: 'Item ID' })
  async getById(@Param('id', new DefaultValuePipe(0), ParseIntPipe) id: number) {
    if (isNaN(id) || id <= 0) throw new BadRequestException(`Invalid item ID "${id}"`);

    const item = await this.itemsService.getItem(id);

    if (!item) throw new NotFoundException(`Item with ID "${id}" not found`);

    return item;
  }

  @Post(':id/lookup')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Record a visitor's lookup of an item (ignored for bots)" })
  @ApiParam({ name: 'id', description: 'Item ID' })
  async recordLookup(@Req() request: Request, @Param('id', new DefaultValuePipe(0), ParseIntPipe) id: number) {
    if (isNaN(id) || id <= 0) throw new BadRequestException(`Invalid item ID "${id}"`);

    if (isBotRequest(request)) return;

    await this.itemsService.recordLookup(id);
  }

  @Get('search/:query')
  @Header('Cache-Control', 'public, max-age=3600')
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
