import { Module } from '@nestjs/common';
import { HiscoreLayoutsService } from './hiscore-layouts.service';
import { PlayerSitemapController } from './player-sitemap.controller';
import { PlayersController } from './players.controller';
import { PlayersService } from './players.service';

@Module({
  controllers: [PlayersController, PlayerSitemapController],
  providers: [PlayersService, HiscoreLayoutsService],
  exports: [PlayersService],
})
export class PlayersModule {}
