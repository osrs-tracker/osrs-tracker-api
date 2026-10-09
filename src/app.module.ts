import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ResilienceModule } from '@nestjs/resilience';
import { requestLogger } from '@osrs-tracker/logger';
import { ClsModule } from 'nestjs-cls';
import { AgentModule } from './common/agent/agent.module';
import { logger } from './common/logger/logger';
import { CLS_OPTIONS } from './common/logger/request-id';
import { MongoModule } from './common/mongo/mongo.module';
import { ResilienceEventsListener } from './common/resilience/resilience-events';
import { routeLabel } from './common/route/route-label';
import { XMLModule } from './common/xml/xml.module';
import { ItemsModule } from './features/items/items.module';
import { NEWS_IMAGES, NEWS_IMAGES_PRESET } from './features/news/news.config';
import { NewsModule } from './features/news/news.module';
import { JAGEX_HISCORES, JAGEX_HISCORES_PRESET } from './features/players/player.config';
import { PlayersModule } from './features/players/players.module';
import { validateEnv } from './config/env';
import { NoIndexMiddleware } from './middleware/robots.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    // mapErrors: false keeps its global interceptor from turning resilience errors into 503/504s: the services map them
    // to their own statuses and messages
    ResilienceModule.forRoot({
      mapErrors: false,
      presets: { [JAGEX_HISCORES]: JAGEX_HISCORES_PRESET, [NEWS_IMAGES]: NEWS_IMAGES_PRESET },
    }),
    ClsModule.forRoot(CLS_OPTIONS),
    AgentModule,
    MongoModule,
    XMLModule,
    PlayersModule,
    NewsModule,
    ItemsModule,
  ],
  providers: [ResilienceEventsListener],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // The request log (`type: 'incoming'`) reads the `requestId` when the request starts, so the CLS middleware must run
    // first: it does, because `ClsModule` is global and Nest applies global modules' middleware first
    consumer.apply(requestLogger({ logger, route: (req) => routeLabel(req) }), NoIndexMiddleware).forRoutes('*');
  }
}
