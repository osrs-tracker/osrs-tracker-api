import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AgentModule } from './common/agent/agent.module';
import { MongoModule } from './common/mongo/mongo.module';
import { XMLModule } from './common/xml/xml.module';
import { ItemsModule } from './features/items/items.module';
import { NewsModule } from './features/news/news.module';
import { PlayersModule } from './features/players/players.module';
import { LoggerMiddleware } from './middleware/logger.middleware';
import { NoIndexMiddleware } from './middleware/robots.middleware';

@Module({
  imports: [ConfigModule.forRoot(), AgentModule, MongoModule, XMLModule, PlayersModule, NewsModule, ItemsModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(LoggerMiddleware, NoIndexMiddleware).forRoutes('*');
  }
}
