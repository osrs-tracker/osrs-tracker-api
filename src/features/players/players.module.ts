import { Module } from '@nestjs/common';
import { HiscoreLayoutsService } from './hiscore-layouts.service';
import { PlayerSitemapController } from './player-sitemap.controller';
import { PlayersController } from './players.controller';
import { PlayersService } from './players.service';
import { TopGainersController } from './top-gainers.controller';

@Module({
  controllers: [PlayersController, PlayerSitemapController, TopGainersController],
  providers: [PlayersService, HiscoreLayoutsService],
  exports: [PlayersService],
})
export class PlayersModule {}
