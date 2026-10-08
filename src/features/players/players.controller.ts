import {
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
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Player } from '@osrs-tracker/models';
import { Request, Response } from 'express';
import { isBotRequest } from '../../common/bot/is-bot-request';
import { CACHE_CONTROL } from '../../common/http/cache-control';
import { ParseIntRangeOptions, ParseIntRangePipe } from '../../common/pipes/parse-int-range.pipe';
import { ApiIntRangeQuery } from '../../common/swagger/api-int-range-query';
import { ApiScrapingOffsetQuery, ParseScrapingOffsetPipe } from './parse-scraping-offset.pipe';
import { ParseUsernamePipe } from './parse-username.pipe';
import { needsRefresh, PLAYER_MAX_AGE_SECONDS, playerMaxAgeSeconds } from './player.policy';
import { PlayersService } from './players.service';

const LIMIT: ParseIntRangeOptions = { min: 1, max: 50, default: 5 };
const SIZE: ParseIntRangeOptions = { min: 1, max: 100, default: 7 };
const SKIP: ParseIntRangeOptions = { min: 0, default: 0 };

const USERNAME_PARAM = ApiParam({ name: 'username', description: 'OSRS display name, case-insensitive' });
const INCLUDE_LATEST_HISCORE_ENTRY_QUERY = ApiQuery({
  name: 'includeLatestHiscoreEntry',
  required: false,
  type: Boolean,
  description: 'Include `hiscoreEntries` with the newest entry for `scrapingOffset` (empty when there is none).',
});
const BAD_REQUEST = ApiBadRequestResponse({ description: 'Invalid username or query param.' });

@ApiTags('players')
@Controller('players')
export class PlayersController {
  private readonly logger = new Logger(PlayersController.name);

  constructor(private readonly playersService: PlayersService) {}

  @Get('')
  @Header('Cache-Control', CACHE_CONTROL.REVALIDATE)
  @ApiOperation({ summary: 'Get the last fetched players' })
  @ApiIntRangeQuery('limit', LIMIT)
  @ApiScrapingOffsetQuery({ optional: true })
  @ApiOkResponse({
    description:
      'The most recently looked up `Player`s, newest first, each with `hiscoreEntries` holding at most its newest ' +
      `entry (for \`scrapingOffset\` when given). \`Cache-Control: ${CACHE_CONTROL.REVALIDATE}\` on every response.`,
  })
  @ApiBadRequestResponse({ description: '`limit` or `scrapingOffset` out of range.' })
  getRecentPlayers(
    @Query('limit', new ParseIntRangePipe(LIMIT)) limit: number,
    @Query('scrapingOffset', new ParseScrapingOffsetPipe({ optional: true })) scrapingOffset?: number,
  ) {
    return this.playersService.getLastFetchedPlayers(limit, scrapingOffset);
  }

  @Get(':username')
  @ApiOperation({
    summary: 'Get a player by username',
    description: 'Read-only: never refreshes or stores the player (the browser does that with `POST .../lookup`).',
  })
  @USERNAME_PARAM
  @ApiScrapingOffsetQuery()
  @INCLUDE_LATEST_HISCORE_ENTRY_QUERY
  @ApiQuery({
    name: 'skipRefresh',
    required: false,
    type: Boolean,
    description: "Answer 404 for a player that isn't stored instead of previewing it from the hiscores.",
  })
  @ApiOkResponse({
    description:
      'A stored `Player` as stored (stale or not), with `trackedSince` (date of its oldest entry for ' +
      '`scrapingOffset`, or `null`), and `Cache-Control: max-age=N` with N from 0 to ' +
      `${PLAYER_MAX_AGE_SECONDS}: the time left until it may be refreshed. A player that isn't stored is a live preview ` +
      'from the hiscores, not stored: `scrapingOffsets: []`, `trackedSince: null`, and ' +
      `\`Cache-Control: ${CACHE_CONTROL.REVALIDATE}\`.`,
  })
  @BAD_REQUEST
  @ApiNotFoundResponse({
    description: `Not stored and not on the hiscores (or \`skipRefresh\`). \`Cache-Control: ${CACHE_CONTROL.REVALIDATE}\`.`,
  })
  @ApiServiceUnavailableResponse({
    description: `Not stored and the hiscores can't be reached. \`Cache-Control: ${CACHE_CONTROL.REVALIDATE}\`.`,
  })
  async getByUsername(
    @Res({ passthrough: true }) response: Response,
    @Param('username', ParseUsernamePipe) username: string,
    @Query('scrapingOffset', new ParseScrapingOffsetPipe()) scrapingOffset: number,
    @Query('includeLatestHiscoreEntry', new DefaultValuePipe(false), ParseBoolPipe) includeLatestHiscoreEntry: boolean,
    @Query('skipRefresh', new DefaultValuePipe(false), ParseBoolPipe) skipRefresh: boolean,
  ) {
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
  @USERNAME_PARAM
  @ApiScrapingOffsetQuery()
  @INCLUDE_LATEST_HISCORE_ENTRY_QUERY
  @ApiOkResponse({
    description:
      'The `Player`, refreshed first when unknown, not tracked for `scrapingOffset` yet or stale ' +
      `(then \`Cache-Control: ${CACHE_CONTROL.PLAYER_REFRESHED}\`). When a stored player couldn't be refreshed: the ` +
      `stored player with \`refreshFailed: true\` and \`Cache-Control: ${CACHE_CONTROL.PLAYER_REFRESH_FAILED}\`.`,
  })
  @ApiNoContentResponse({ description: 'A bot: nothing is looked up or recorded.' })
  @BAD_REQUEST
  @ApiNotFoundResponse({ description: 'Not on the hiscores.' })
  @ApiServiceUnavailableResponse({
    description: `Not stored and the hiscores can't be reached. \`Cache-Control: ${CACHE_CONTROL.REVALIDATE}\`.`,
  })
  async recordLookup(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('username', ParseUsernamePipe) username: string,
    @Query('scrapingOffset', new ParseScrapingOffsetPipe()) scrapingOffset: number,
    @Query('includeLatestHiscoreEntry', new DefaultValuePipe(false), ParseBoolPipe) includeLatestHiscoreEntry: boolean,
  ) {
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
  @USERNAME_PARAM
  @ApiScrapingOffsetQuery()
  @ApiIntRangeQuery('size', SIZE, 'Page size.')
  @ApiIntRangeQuery('skip', SKIP, 'Entries to skip.')
  @ApiOkResponse({
    description:
      "A page of the player's `HiscoreEntry`s for `scrapingOffset`, newest first; an empty body for a player that " +
      `isn't stored. \`Cache-Control: ${CACHE_CONTROL.REVALIDATE}\` on every response.`,
  })
  @BAD_REQUEST
  getHiscoresByUsername(
    @Param('username', ParseUsernamePipe) username: string,
    @Query('scrapingOffset', new ParseScrapingOffsetPipe()) scrapingOffset: number,
    @Query('size', new ParseIntRangePipe(SIZE)) size: number,
    @Query('skip', new ParseIntRangePipe(SKIP)) skip: number,
  ) {
    return this.playersService.getPlayerHiscores(username, scrapingOffset, size, skip);
  }
}
