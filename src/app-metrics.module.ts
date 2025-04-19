import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppMetricsController } from './app-metrics.controller';

@Module({
  imports: [ConfigModule.forRoot()],
  controllers: [AppMetricsController],
})
export class AppMetricsModule {}
