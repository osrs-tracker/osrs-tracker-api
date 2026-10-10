import { Controller, Get, Header } from '@nestjs/common';
import { CACHE_CONTROL } from '../../common/http/cache-control';
import { PlayersService } from './players.service';

/** Under `/sitemap`, not `/players`: `/players/sitemap` is also a player's page (`sitemap` is a valid name). */
@Controller('sitemap')
export class PlayerSitemapController {
  constructor(private readonly playersService: PlayersService) {}

  /**
   * The tracked players for the web app's sitemap, `[{ username, lastEntry }]` by username, with `lastEntry` the date of
   * the newest hiscore entry: players still scraped (not paused), without a not-found streak, and with an entry in the
   * last `SITEMAP_PLAYER_DAYS`. `PLAYER_SITEMAP` on every response.
   */
  @Get('players')
  @Header('Cache-Control', CACHE_CONTROL.PLAYER_SITEMAP)
  getSitemapPlayers() {
    return this.playersService.getSitemapPlayers(new Date());
  }
}
