import {
  BadRequestException,
  Controller,
  DefaultValuePipe,
  Get,
  Header,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ItemsService } from './items.service';

@ApiTags('items')
@Controller('items')
export class ItemsController {
  constructor(private readonly itemsService: ItemsService) {}

  @Get()
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  @ApiOperation({ summary: 'Get the last fetched items' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getRecentItems(@Query('limit', new DefaultValuePipe(5), ParseIntPipe) limit: number) {
    return this.itemsService.getLastFetchedItems(limit);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  @ApiOperation({ summary: 'Get an item by ID' })
  @ApiParam({ name: 'id', description: 'Item ID' })
  async getById(@Param('id', new DefaultValuePipe(0), ParseIntPipe) id: number) {
    if (isNaN(id) || id <= 0) throw new BadRequestException(`Invalid item ID "${id}"`);

    const item = await this.itemsService.getItem(id);

    if (!item) throw new NotFoundException(`Item with ID "${id}" not found`);

    return item;
  }

  @Get('search/:query')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
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
