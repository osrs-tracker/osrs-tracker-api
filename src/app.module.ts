import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ResilienceModule } from '@nestjs/resilience';
import { ClsModule } from 'nestjs-cls';
import { AgentModule } from './common/agent/agent.module';
import { CLS_OPTIONS } from './common/logger/request-id';
import { MongoModule } from './common/mongo/mongo.module';
import { ResilienceEventsListener } from './common/resilience/resilience-events';
import { XMLModule } from './common/xml/xml.module';
import { ItemsModule } from './features/items/items.module';
import { NEWS_IMAGES, NEWS_IMAGES_PRESET } from './features/news/news.config';
import { NewsModule } from './features/news/news.module';
import { JAGEX_HISCORES, JAGEX_HISCORES_PRESET } from './features/players/player.config';
import { PlayersModule } from './features/players/players.module';
import { validateEnv } from './config/env';
import { requestLog } from './middleware/logger.middleware';
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
    consumer.apply(requestLog, NoIndexMiddleware).forRoutes('*');
  }
}
