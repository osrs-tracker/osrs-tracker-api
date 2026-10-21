import { DynamicModule, Global, Inject, Logger, Module, OnApplicationShutdown, Provider } from '@nestjs/common';
import { MongoClient } from 'mongodb';
import { setTimeout } from 'node:timers/promises';
import { MONGO_LOG_CONTEXT } from '../logger/nest-logger';
import {
  ingesterMongoClientProvider,
  ingesterMongoDBProvider,
  MONGO_CLIENT,
  mongoClientProvider,
  MONGODB_DATABASE,
  mongoDBProvider,
} from './mongo.provider';

/** Bounds closing the client on shutdown, so an unreachable Atlas can't keep a terminating pod alive. */
const CLOSE_TIMEOUT_MS = 5_000;

/** `MONGO_CLIENT` and `MONGODB_DATABASE` for every module, closing the client on shutdown. */
@Global()
@Module({})
export class MongoModule implements OnApplicationShutdown {
  private readonly logger = new Logger(MONGO_LOG_CONTEXT);

  constructor(@Inject(MONGO_CLIENT) private readonly client: MongoClient) {}

  /** The API's: connected at startup, with the indexes ensured. */
  static forApi(): DynamicModule {
    return MongoModule.with(mongoClientProvider, mongoDBProvider);
  }

  /** The ingester's: connected by its poll loop, without indexes. */
  static forIngester(): DynamicModule {
    return MongoModule.with(ingesterMongoClientProvider, ingesterMongoDBProvider);
  }

  private static with(...providers: Provider[]): DynamicModule {
    return { module: MongoModule, providers, exports: [MONGO_CLIENT, MONGODB_DATABASE] };
  }

  /**
   * Runs after the HTTP server has finished its requests, so none is cut off mid-query. Doesn't throw: Nest exits the
   * process right after the shutdown hooks either way.
   */
  async onApplicationShutdown(): Promise<void> {
    const timedOut = Symbol('timedOut');
    try {
      const result = await Promise.race([this.client.close(), setTimeout(CLOSE_TIMEOUT_MS, timedOut, { ref: false })]);
      if (result === timedOut) this.logger.warn(`MongoDB client not closed within ${CLOSE_TIMEOUT_MS}ms`);
    } catch (error) {
      this.logger.warn(`MongoDB client failed to close: ${error}`);
    }
  }
}
