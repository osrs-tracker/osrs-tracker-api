import {
  BadRequestException,
  Controller,
  DefaultValuePipe,
  Get,
  Header,
  Logger,
  NotFoundException,
  Param,
  ParseBoolPipe,
  ParseIntPipe,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { addHours, differenceInHours, differenceInSeconds } from 'date-fns';
import { Response } from 'express';
import { PLAYER_CONFIG } from './player.config';
import { PlayersService } from './players.service';

@ApiTags('players')
@Controller('players')
export class PlayersController {
  private readonly logger = new Logger(PlayersController.name);

  constructor(private readonly playersService: PlayersService) {}

  @Get('')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  @ApiOperation({ summary: 'Get the last fetched players' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getRecentPlayers(@Query('limit', new DefaultValuePipe(5), ParseIntPipe) limit: number) {
    return this.playersService.getLastFetchedPlayers(limit);
  }

  @Get(':username')
  @ApiOperation({ summary: 'Get a player by username' })
  @ApiParam({ name: 'username' })
  @ApiQuery({ name: 'scrapingOffset', required: false, type: Number })
  @ApiQuery({ name: 'includeLatestHiscoreEntry', required: false, type: Boolean })
  @ApiQuery({ name: 'skipRefresh', required: false, type: Boolean })
  async getByUsername(
    @Res({ passthrough: true }) response: Response,
    @Param('username') username: string,
    @Query('scrapingOffset', new DefaultValuePipe(0), ParseIntPipe) scrapingOffset: number,
    @Query('includeLatestHiscoreEntry', new DefaultValuePipe(false), ParseBoolPipe) includeLatestHiscoreEntry: boolean,
    @Query('skipRefresh', new DefaultValuePipe(false), ParseBoolPipe) skipRefresh: boolean,
  ) {
    if (!username) return new BadRequestException('No username provided');
    if (username.length > 12) return new BadRequestException('Usernames must be between 1 and 12 characters long.');

    if (isNaN(scrapingOffset)) return new BadRequestException('Invalid scraping offset');
    if (scrapingOffset < -12 || scrapingOffset > 11) return new BadRequestException('ScrapingOffset < -12 or > 11.');

    const player = await this.playersService.getPlayer(username, scrapingOffset, includeLatestHiscoreEntry);
    const playerHasOffset = player?.scrapingOffsets?.includes(scrapingOffset);

    response.setHeader(
      'Cache-Control', // Set cache control to 15 minutes (900 seconds) or time until the minimum refresh time has passed
      `max-age=${Math.min(900, differenceInSeconds(addHours(player?.lastModified ?? new Date(), PLAYER_CONFIG.minPlayerRefreshTime), new Date()))}`,
    );

    if (skipRefresh) return player; // Skip refresh if requested

    if (
      !player || // Player does not exist
      !playerHasOffset || // Player does not have the requested scraping offset
      differenceInHours(new Date(), player.lastModified) >= PLAYER_CONFIG.minPlayerRefreshTime // Player is older than the refresh time
    ) {
      this.logger.log(`Player '${username} not found for offset '${scrapingOffset}' or outdated. Refreshing...`);

      const refreshed = await this.playersService.refreshPlayerInfo(username, scrapingOffset, !playerHasOffset);
      if (!refreshed) throw new NotFoundException(`Player '${username}' not found`);
      else this.logger.log(`Player '${username}' refreshed successfully.`);

      response.setHeader('Cache-Control', 'max-age=900'); // Set cache control to 900 seconds (15 minutes)
      return this.playersService.getPlayer(username, scrapingOffset, includeLatestHiscoreEntry); // Retry fetching the player
    }

    return player;
  }

  @Get(':username/hiscores')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  @ApiOperation({ summary: "Get a player's hiscores by username" })
  @ApiParam({ name: 'username' })
  @ApiQuery({ name: 'scrapingOffset', required: false, type: Number })
  @ApiQuery({ name: 'size', required: false, type: Number })
  @ApiQuery({ name: 'skip', required: false, type: Number })
  getHiscoresByUsername(
    @Param('username') username: string,
    @Query('scrapingOffset', new DefaultValuePipe(0), ParseIntPipe) scrapingOffset: number,
    @Query('size', new DefaultValuePipe(7), ParseIntPipe) size: number,
    @Query('skip', new DefaultValuePipe(0), ParseIntPipe) skip: number,
  ) {
    if (!username) return new BadRequestException('No username provided');
    if (username.length > 12) return new BadRequestException('Usernames must be between 1 and 12 characters long.');

    if (isNaN(scrapingOffset)) return new BadRequestException('Invalid scraping offset');
    if (scrapingOffset < -12 || scrapingOffset > 11) return new BadRequestException('ScrapingOffset < -12 or > 11.');

    return this.playersService.getPlayerHiscores(username, scrapingOffset, size, skip);
  }
}
