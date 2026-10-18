import { Controller, Get, Header, NotFoundException, Query, Res } from '@nestjs/common';
import type { PlayerCountRange } from '@osrs-tracker/models';
import { Response } from 'express';
import { CACHE_CONTROL } from '../../common/http/cache-control';
import { ParsePlayerCountRangePipe } from './parse-player-count-range.pipe';
import { PlayerCountsService } from './player-counts.service';

@Controller('player-counts')
export class PlayerCountsController {
  constructor(private readonly playerCountsService: PlayerCountsService) {}

  /**
   * The players online over `range` (`24h` when absent; see `buildPlayerCountHistoryPipeline`), oldest first; `[]`
   * before the first sample. 400 for any other `range`. `PLAYER_COUNT` on every response.
   */
  @Get()
  @Header('Cache-Control', CACHE_CONTROL.PLAYER_COUNT)
  getHistory(@Query('range', ParsePlayerCountRangePipe) range: PlayerCountRange) {
    return this.playerCountsService.getHistory(range);
  }

  /** The newest sample of the players online (sampled every 10 minutes); 404 before the first one. `PLAYER_COUNT` on every response. */
  @Get('latest')
  @Header('Cache-Control', CACHE_CONTROL.PLAYER_COUNT)
  async getLatest() {
    const latest = await this.playerCountsService.getLatest();

    if (!latest) throw new NotFoundException('No player count recorded yet');

    return latest;
  }

  /**
   * The players online now, from Jagex's world list (fetched at most once a minute per pod; `date` is when), not a
   * stored sample. `PLAYER_COUNT_LIVE`; 502 with `REVALIDATE` when the world list can't be fetched or parsed.
   */
  @Get('live')
  async getLive(@Res({ passthrough: true }) res: Response) {
    // Until the count is read, so a 502 isn't cached for a minute
    res.setHeader('Cache-Control', CACHE_CONTROL.REVALIDATE);
    const live = await this.playerCountsService.getLive();

    res.setHeader('Cache-Control', CACHE_CONTROL.PLAYER_COUNT_LIVE);
    return live;
  }
}
