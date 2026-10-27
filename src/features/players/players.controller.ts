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
import { Player } from '@osrs-tracker/models';
import { Request, Response } from 'express';
import { isBotRequest } from '../../common/bot/is-bot-request';
import { CACHE_CONTROL } from '../../common/http/cache-control';
import { ParseIntRangeOptions, ParseIntRangePipe } from '../../common/pipes/parse-int-range.pipe';
import { ParseScrapingOffsetPipe } from './parse-scraping-offset.pipe';
import { ParseUsernamePipe } from './parse-username.pipe';
import { needsRefresh, playerMaxAgeSeconds } from './player.policy';
import { ParsePlayerListQueryPipe, type PlayerListQuery } from './parse-player-list-query.pipe';
import { PlayersService } from './players.service';

const LIMIT: ParseIntRangeOptions = { min: 1, max: 100, default: 7 };
// A cap far above a player's entries per offset (clean-hiscores keeps 60 days), and within the 32 bits `$slice` takes
const SKIP: ParseIntRangeOptions = { min: 0, max: 10_000, default: 0 };

@Controller('players')
export class PlayersController {
  private readonly logger = new Logger(PlayersController.name);

  constructor(private readonly playersService: PlayersService) {}

  /**
   * The players, by `sort` (`ParsePlayerListQueryPipe`; 400 for any other `sort` or an invalid param):
   * - `lookedUp` (the default): the `limit` (1 to 50, default 5) most recently looked up players, newest first, each
   *   with `hiscoreEntries` holding at most its newest entry (for `scrapingOffset` when given; any offset when absent).
   *   `entry=overall` cuts that entry to its `date`, `scrapingOffset` and `skills.Overall`, with `activities: {}` (the
   *   web's recent players rows); without it, the entry is whole. 400 when `entry` isn't `overall`. `REVALIDATE`.
   * - `gain`: the `limit` (1 to `MAX_TOP_GAINERS`, default 5) tracked players with the largest Overall XP gain
   *   between the previous and the newest day's hiscore entries for offset 0,
   *   `[{ username, type, status, diedAsHardcore, gain, date }]` by `gain`, largest first, with `date` the newer
   *   entry's and the player fields as stored (the web's account avatar): only players whose newest entry is from the newest offset-0 slot
   *   (its previous slot until an hour after it starts, `topGainersSlot`) and the one before it from the slot before,
   *   still scraped and without a not-found streak; none who gained nothing. Read from stored entries only.
   *   `TOP_GAINERS`.
   *
   * Each sort's `Cache-Control` is on every response of that sort; a 400 gets `REVALIDATE`.
   */
  @Get('')
  @Header('Cache-Control', CACHE_CONTROL.REVALIDATE) // Before the pipe runs, so it's also a 400's
  listPlayers(@Res({ passthrough: true }) res: Response, @Query(ParsePlayerListQueryPipe) query: PlayerListQuery) {
    if (query.sort === 'gain') {
      res.setHeader('Cache-Control', CACHE_CONTROL.TOP_GAINERS);
      return this.playersService.getTopGainers(query.limit, new Date());
    }

    return this.playersService.getLastFetchedPlayers(query.limit, query.scrapingOffset, query.entry);
  }

  /**
   * Read-only: never refreshes or stores the player (the browser's `POST .../lookup` does). The username is matched
   * like Jagex does: case-insensitive, `_` and `-` as spaces, leading and trailing ones ignored.
   *
   * A stored player as stored (stale or not), with `trackedSince` (its oldest entry for `scrapingOffset`, or `null`)
   * and a `max-age` of the time left until it may be refreshed (0 to `PLAYER_MAX_AGE_SECONDS`, `playerMaxAgeSeconds`).
   * An unknown player is a live preview from the hiscores, not stored (`scrapingOffsets: []`, `trackedSince: null`);
   * 404 when not on the hiscores (or with `preview=false`, which skips the preview), 503 when they can't be reached;
   * all three `REVALIDATE`. `includeLatestHiscoreEntry` adds `hiscoreEntries` with the newest entry for `scrapingOffset`
   * (empty when there is none). 400 for an invalid username or param.
   */
  @Get(':username')
  async getByUsername(
    @Res({ passthrough: true }) response: Response,
    @Param('username', ParseUsernamePipe) username: string,
    @Query('scrapingOffset', new ParseScrapingOffsetPipe()) scrapingOffset: number,
    @Query('includeLatestHiscoreEntry', new DefaultValuePipe(false), ParseBoolPipe) includeLatestHiscoreEntry: boolean,
    @Query('preview', new DefaultValuePipe(true), ParseBoolPipe) allowPreview: boolean,
  ) {
    // Read-only: refreshing, starting to track and recording the lookup happen in the browser's POST lookup.
    const player = await this.playersService.getPlayer(username, scrapingOffset, includeLatestHiscoreEntry);

    if (player) {
      response.setHeader('Cache-Control', `max-age=${playerMaxAgeSeconds(player.lastModified, new Date())}`);
      return player;
    }

    // Not stored: preview the player live from the hiscores, without storing it.
    response.setHeader('Cache-Control', CACHE_CONTROL.REVALIDATE);

    if (!allowPreview) throw new NotFoundException(`Player '${username}' not found`);

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
      return this.playersService.getPlayer(username, scrapingOffset, includeLatestHiscoreEntry); // Read it again, refreshed
    }

    return player;
  }

  /**
   * A page (`limit` 1 to 100, default 7; `skip`) of the player's hiscore entries for `scrapingOffset`, newest first; an
   * empty body for a player that isn't stored. 400 for an invalid username or
   * param. `REVALIDATE` on every response.
   */
  @Get(':username/hiscores')
  @Header('Cache-Control', CACHE_CONTROL.REVALIDATE)
  getHiscoresByUsername(
    @Param('username', ParseUsernamePipe) username: string,
    @Query('scrapingOffset', new ParseScrapingOffsetPipe()) scrapingOffset: number,
    @Query('limit', new ParseIntRangePipe(LIMIT)) limit: number,
    @Query('skip', new ParseIntRangePipe(SKIP)) skip: number,
  ) {
    return this.playersService.getPlayerHiscores(username, scrapingOffset, limit, skip);
  }
}
