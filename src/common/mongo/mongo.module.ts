import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { MongoClient } from 'mongodb';
import { setTimeout } from 'node:timers/promises';
import { MONGO_CLIENT, mongoClientProvider, mongoDBProvider } from './mongo.provider';

/** Bounds closing the client on shutdown, so an unreachable Atlas can't keep a terminating pod alive. */
const CLOSE_TIMEOUT_MS = 5_000;

@Global()
@Module({
  providers: [mongoClientProvider, mongoDBProvider],
  exports: [mongoClientProvider, mongoDBProvider],
})
export class MongoModule implements OnApplicationShutdown {
  private readonly logger = new Logger(MongoModule.name);

  constructor(@Inject(MONGO_CLIENT) private readonly client: MongoClient) {}

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
