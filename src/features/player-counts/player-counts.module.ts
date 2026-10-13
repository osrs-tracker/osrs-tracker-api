import { Module } from '@nestjs/common';
import { PlayerCountsController } from './player-counts.controller';
import { PlayerCountsService } from './player-counts.service';

@Module({
  controllers: [PlayerCountsController],
  providers: [PlayerCountsService],
})
export class PlayerCountsModule {}
