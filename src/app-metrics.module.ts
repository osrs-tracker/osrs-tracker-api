import { Module } from '@nestjs/common';
import { AppMetricsController } from './app-metrics.controller';

@Module({
  controllers: [AppMetricsController],
})
export class AppMetricsModule {}
