import { Controller, Get, Header, NotFoundException, Query } from '@nestjs/common';
import { CACHE_CONTROL } from '../../common/http/cache-control';
import { ParsePlayerCountRangePipe } from './parse-player-count-range.pipe';
import type { PlayerCountRange } from './player-count-history';
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
}
