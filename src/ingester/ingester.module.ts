import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AgentModule } from '../common/agent/agent.module';
import { MongoModule } from '../common/mongo/mongo.module';
import { validateIngesterEnv } from '../config/env';
import { HiscoreLayoutsService } from '../features/players/hiscore-layouts.service';
import { DiscordAlerts } from './discord-alerts';
import { IngesterHealthController } from './ingester-health.controller';
import { IngesterMetrics } from './ingester-metrics';
import { IngesterService } from './ingester.service';
import { ScrapeResultsService } from './scrape-results.service';

/**
 * The ingester's root module (`ingest.ts`). Its only routes are `/healthy` and `/metrics`, on `METRICS_PORT`. Never
 * import it into `AppModule`, nor scheduled jobs into the API: the API runs 2 replicas, and each would run them.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateIngesterEnv }),
    AgentModule,
    MongoModule.forIngester(),
  ],
  controllers: [IngesterHealthController],
  providers: [IngesterMetrics, DiscordAlerts, HiscoreLayoutsService, ScrapeResultsService, IngesterService],
})
export class IngesterModule {}
