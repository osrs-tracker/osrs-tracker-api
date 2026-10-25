import { Controller, Get, Header, Query } from '@nestjs/common';
import { CACHE_CONTROL } from '../../common/http/cache-control';
import { ParseIntRangePipe } from '../../common/pipes/parse-int-range.pipe';
import { PlayersService } from './players.service';
import { MAX_TOP_GAINERS } from './top-gainers';

/** Not under `/players`: `/players/top-gainers` is also a player's page (`top-gainers` is a valid name). */
@Controller('top-gainers')
export class TopGainersController {
  constructor(private readonly playersService: PlayersService) {}

  /**
   * The tracked players with the largest Overall XP gain between their two newest hiscore entries for offset 0,
   * `[{ username, gain, date }]` by `gain`, largest first, with `date` the newer entry's: only players whose newest
   * entry is from the newest offset-0 slot (its previous slot until an hour after it starts, `topGainersSlot`), still
   * scraped and without a not-found streak; none who gained nothing. Read from stored entries only. 400 when `limit`
   * is out of range. `TOP_GAINERS` on every response.
   */
  @Get()
  @Header('Cache-Control', CACHE_CONTROL.TOP_GAINERS)
  getTopGainers(@Query('limit', new ParseIntRangePipe({ min: 1, max: MAX_TOP_GAINERS, default: 5 })) limit: number) {
    return this.playersService.getTopGainers(limit, new Date());
  }
}
