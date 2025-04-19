import { DynamicModule, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AgentModule } from './common/agent/agent.module';
import { MongoModule } from './common/mongo/mongo.module';
import { ItemsModule } from './features/items/items.module';
import { NewsModule } from './features/news/news.module';
import { PlayersModule } from './features/players/players.module';
import { LoggerMiddleware } from './middleware/logger.middleware';

interface AppModuleOptions {
  metricsApp?: boolean;
}

@Module({
  imports: [ConfigModule.forRoot(), AgentModule, MongoModule, PlayersModule, NewsModule, ItemsModule],
})
export class AppModule implements NestModule {
  private options: AppModuleOptions;

  static forRoot(): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigModule.forRoot(), AgentModule, MongoModule, PlayersModule, NewsModule, ItemsModule],
    };
  }

  configure(consumer: MiddlewareConsumer) {
    consumer.apply(LoggerMiddleware).forRoutes('*');
  }
}
