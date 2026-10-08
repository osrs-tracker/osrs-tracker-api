import {
  BadRequestException,
  Controller,
  DefaultValuePipe,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  ParseBoolPipe,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Player } from '@osrs-tracker/models';
import { Request, Response } from 'express';
import { isBotRequest } from '../../common/bot/is-bot-request';
import { CACHE_CONTROL } from '../../common/http/cache-control';
import { ParseUsernamePipe } from './parse-username.pipe';
import { needsRefresh, playerMaxAgeSeconds } from './player.policy';
import { PlayersService } from './players.service';

@ApiTags('players')
@Controller('players')
export class PlayersController {
  private readonly logger = new Logger(PlayersController.name);

  constructor(private readonly playersService: PlayersService) {}

  @Get('')
  @Header('Cache-Control', CACHE_CONTROL.REVALIDATE)
  @ApiOperation({ summary: 'Get the last fetched players' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'scrapingOffset', required: false, type: Number })
  getRecentPlayers(
    @Query('limit', new DefaultValuePipe(5), ParseIntPipe) limit: number,
    @Query('scrapingOffset', new ParseIntPipe({ optional: true })) scrapingOffset?: number,
  ) {
    if (limit < 1 || limit > 50) throw new BadRequestException('Limit must be between 1 and 50.');
    if (scrapingOffset !== undefined && (scrapingOffset < -12 || scrapingOffset > 11))
      throw new BadRequestException('ScrapingOffset < -12 or > 11.');

    return this.playersService.getLastFetchedPlayers(limit, scrapingOffset);
  }

  @Get(':username')
  @ApiOperation({ summary: 'Get a player by username' })
  @ApiParam({ name: 'username' })
  @ApiQuery({ name: 'scrapingOffset', required: false, type: Number })
  @ApiQuery({ name: 'includeLatestHiscoreEntry', required: false, type: Boolean })
  @ApiQuery({ name: 'skipRefresh', required: false, type: Boolean })
  async getByUsername(
    @Res({ passthrough: true }) response: Response,
    @Param('username', ParseUsernamePipe) username: string,
    @Query('scrapingOffset', new DefaultValuePipe(0), ParseIntPipe) scrapingOffset: number,
    @Query('includeLatestHiscoreEntry', new DefaultValuePipe(false), ParseBoolPipe) includeLatestHiscoreEntry: boolean,
    @Query('skipRefresh', new DefaultValuePipe(false), ParseBoolPipe) skipRefresh: boolean,
  ) {
    if (isNaN(scrapingOffset)) throw new BadRequestException('Invalid scraping offset');
    if (scrapingOffset < -12 || scrapingOffset > 11) throw new BadRequestException('ScrapingOffset < -12 or > 11.');

    // Read-only: refreshing, starting to track and recording the lookup happen in the browser's POST lookup.
    const player = await this.playersService.getPlayer(username, scrapingOffset, includeLatestHiscoreEntry);

    if (player) {
      response.setHeader('Cache-Control', `max-age=${playerMaxAgeSeconds(player.lastModified, new Date())}`);
      return player;
    }

    // Not stored: preview the player live from the hiscores, without storing it.
    response.setHeader('Cache-Control', CACHE_CONTROL.REVALIDATE);

    if (skipRefresh) throw new NotFoundException(`Player '${username}' not found`);

    const preview = await this.playersService.previewPlayer(username, scrapingOffset, includeLatestHiscoreEntry);
    if (preview.status === 'notFound') throw new NotFoundException(`Player '${username}' not found`);
    if (preview.status !== 'found')
      throw new ServiceUnavailableException(`The hiscores can't be reached, try again later.`);

    return preview.player;
  }

  @Post(':username/lookup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Record a visitor's lookup of a player, refreshing (or starting to track) them first if needed (ignored for bots)",
  })
  @ApiParam({ name: 'username' })
  @ApiQuery({ name: 'scrapingOffset', required: false, type: Number })
  @ApiQuery({ name: 'includeLatestHiscoreEntry', required: false, type: Boolean })
  async recordLookup(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('username', ParseUsernamePipe) username: string,
    @Query('scrapingOffset', new DefaultValuePipe(0), ParseIntPipe) scrapingOffset: number,
    @Query('includeLatestHiscoreEntry', new DefaultValuePipe(false), ParseBoolPipe) includeLatestHiscoreEntry: boolean,
  ) {
    if (isNaN(scrapingOffset)) throw new BadRequestException('Invalid scraping offset');
    if (scrapingOffset < -12 || scrapingOffset > 11) throw new BadRequestException('ScrapingOffset < -12 or > 11.');

    if (isBotRequest(request)) {
      response.status(HttpStatus.NO_CONTENT);
      return;
    }

    const player = await this.playersService.getPlayer(username, scrapingOffset, includeLatestHiscoreEntry);
    const result = await this.refreshIfNeeded(response, username, scrapingOffset, includeLatestHiscoreEntry, player);

    await this.playersService.recordLookup(username); // Only reached when the player is stored

    return result;
  }

  /**
   * Refreshes the player when it's unknown, lacks `scrapingOffset` or is stale, and returns it. Throws 404 when the
   * player isn't on the hiscores, and 503 when the hiscores can't be reached for an unknown player.
   */
  private async refreshIfNeeded(
    response: Response,
    username: string,
    scrapingOffset: number,
    includeLatestHiscoreEntry: boolean,
    player: Player | null,
  ) {
    if (needsRefresh(player, scrapingOffset, new Date())) {
      this.logger.log(`Player '${username}' not found for offset '${scrapingOffset}' or outdated. Refreshing...`);

      const result = await this.playersService.refreshPlayerInfo(
        username,
        scrapingOffset,
        !player?.scrapingOffsets?.includes(scrapingOffset), // Start tracking this offset with an initial entry
      );
      if (result === 'notFound') throw new NotFoundException(`Player '${username}' not found`);

      if (result === 'failed') {
        if (!player) {
          response.setHeader('Cache-Control', CACHE_CONTROL.REVALIDATE); // Don't cache the outage
          throw new ServiceUnavailableException(`The hiscores can't be reached, try again later.`);
        }

        this.logger.warn(`Couldn't refresh player '${username}', returning the stored player.`);
        response.setHeader('Cache-Control', CACHE_CONTROL.PLAYER_REFRESH_FAILED);
        return { ...player, refreshFailed: true };
      }

      this.logger.log(`Player '${username}' refreshed successfully.`);

      response.setHeader('Cache-Control', CACHE_CONTROL.PLAYER_REFRESHED);
      return this.playersService.getPlayer(username, scrapingOffset, includeLatestHiscoreEntry); // Retry fetching the player
    }

    return player;
  }

  @Get(':username/hiscores')
  @Header('Cache-Control', CACHE_CONTROL.REVALIDATE)
  @ApiOperation({ summary: "Get a player's hiscores by username" })
  @ApiParam({ name: 'username' })
  @ApiQuery({ name: 'scrapingOffset', required: false, type: Number })
  @ApiQuery({ name: 'size', required: false, type: Number })
  @ApiQuery({ name: 'skip', required: false, type: Number })
  getHiscoresByUsername(
    @Param('username', ParseUsernamePipe) username: string,
    @Query('scrapingOffset', new DefaultValuePipe(0), ParseIntPipe) scrapingOffset: number,
    @Query('size', new DefaultValuePipe(7), ParseIntPipe) size: number,
    @Query('skip', new DefaultValuePipe(0), ParseIntPipe) skip: number,
  ) {
    if (isNaN(scrapingOffset)) throw new BadRequestException('Invalid scraping offset');
    if (scrapingOffset < -12 || scrapingOffset > 11) throw new BadRequestException('ScrapingOffset < -12 or > 11.');
    if (size < 1 || size > 100) throw new BadRequestException('Size must be between 1 and 100.');
    if (skip < 0) throw new BadRequestException('Skip must be 0 or greater.');

    return this.playersService.getPlayerHiscores(username, scrapingOffset, size, skip);
  }
}
