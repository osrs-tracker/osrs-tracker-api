import { Module } from '@nestjs/common';
import { HiscoreLayoutsService } from './hiscore-layouts.service';
import { PlayersController } from './players.controller';
import { PlayersService } from './players.service';

@Module({
  controllers: [PlayersController],
  providers: [PlayersService, HiscoreLayoutsService],
  exports: [PlayersService],
})
export class PlayersModule {}
