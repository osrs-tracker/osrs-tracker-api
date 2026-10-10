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
  ParseEnumPipe,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Player } from '@osrs-tracker/models';
import { Request, Response } from 'express';
import { isBotRequest } from '../../common/bot/is-bot-request';
import { CACHE_CONTROL } from '../../common/http/cache-control';
import { ParseIntRangeOptions, ParseIntRangePipe } from '../../common/pipes/parse-int-range.pipe';
import { ParseScrapingOffsetPipe } from './parse-scraping-offset.pipe';
import { ParseUsernamePipe } from './parse-username.pipe';
import { needsRefresh, playerMaxAgeSeconds } from './player.policy';
import { PlayersService, RECENT_PLAYERS_ENTRY, type RecentPlayersEntry } from './players.service';

const LIMIT: ParseIntRangeOptions = { min: 1, max: 50, default: 5 };
const SIZE: ParseIntRangeOptions = { min: 1, max: 100, default: 7 };
// A cap far above a player's entries per offset (clean-hiscores keeps 60 days), and within the 32 bits `$slice` takes
const SKIP: ParseIntRangeOptions = { min: 0, max: 10_000, default: 0 };
const ENTRY = new ParseEnumPipe(RECENT_PLAYERS_ENTRY, {
  optional: true,
  exceptionFactory: () => new BadRequestException(`Entry must be 'overall'.`),
});

@Controller('players')
export class PlayersController {
  private readonly logger = new Logger(PlayersController.name);

  constructor(private readonly playersService: PlayersService) {}

  /**
   * The most recently looked up players, newest first, each with `hiscoreEntries` holding at most its newest entry (for
   * `scrapingOffset` when given; any offset when absent). `entry=overall` cuts that entry to its `date`,
   * `scrapingOffset` and `skills.Overall`, with `activities: {}` (the web's recent players rows); without it, the entry
   * is whole. 400 when a param is out of range or `entry` isn't `overall`. `REVALIDATE` on every response.
   */
  @Get('')
  @Header('Cache-Control', CACHE_CONTROL.REVALIDATE)
  getRecentPlayers(
    @Query('limit', new ParseIntRangePipe(LIMIT)) limit: number,
    @Query('scrapingOffset', new ParseScrapingOffsetPipe({ optional: true })) scrapingOffset?: number,
    @Query('entry', ENTRY) entry?: RecentPlayersEntry,
  ) {
    return this.playersService.getLastFetchedPlayers(limit, scrapingOffset, entry);
  }

  /**
   * Read-only: never refreshes or stores the player (the browser's `POST .../lookup` does). The username is
   * matched like Jagex does: case-insensitive, `_` and `-` as spaces, leading and trailing ones ignored. A stored player as stored (stale or not), with `trackedSince` (its oldest entry for
   * `scrapingOffset`, or `null`) and a `max-age` of the time left until it may be refreshed (0 to
   * `PLAYER_MAX_AGE_SECONDS`, `playerMaxAgeSeconds`). An unknown player is a live preview from the hiscores, not stored
   * (`scrapingOffsets: []`, `trackedSince: null`); 404 when not on the hiscores (or with `skipRefresh`, which skips the
   * preview), 503 when they can't be reached; all three `REVALIDATE`. `includeLatestHiscoreEntry` adds `hiscoreEntries`
   * with the newest entry for `scrapingOffset` (empty when there is none). 400 for an invalid username or param.
   */
  @Get(':username')
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

  /**
   * Records a visitor's lookup; 204 for a bot, which looks up and records nothing. Returns the player, refreshed (or
   * started to track) first when unknown, not tracked for `scrapingOffset` yet or stale (then `PLAYER_REFRESHED`). A
   * stored player that couldn't be refreshed comes back with `refreshFailed: true` and `PLAYER_REFRESH_FAILED`. 404
   * when not on the hiscores, 503 (`REVALIDATE`) when they can't be reached for a player that isn't stored, 400 for an
   * invalid username or param. Username and `includeLatestHiscoreEntry` as for `GET :username`.
   */
  @Post(':username/lookup')
  @HttpCode(HttpStatus.OK)
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

    await this.playersService.recordLookup(username, scrapingOffset); // Only reached when the player is stored

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

      const result = await this.playersService.refreshPlayerInfo(username, scrapingOffset);
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

  /**
   * A page (`size`, `skip`) of the player's hiscore entries for `scrapingOffset`, newest first; an empty body for a
   * player that isn't stored. 400 for an invalid username or param. `REVALIDATE` on every response.
   */
  @Get(':username/hiscores')
  @Header('Cache-Control', CACHE_CONTROL.REVALIDATE)
  getHiscoresByUsername(
    @Param('username', ParseUsernamePipe) username: string,
    @Query('scrapingOffset', new ParseScrapingOffsetPipe()) scrapingOffset: number,
    @Query('size', new ParseIntRangePipe(SIZE)) size: number,
    @Query('skip', new ParseIntRangePipe(SKIP)) skip: number,
  ) {
    return this.playersService.getPlayerHiscores(username, scrapingOffset, size, skip);
  }
}
