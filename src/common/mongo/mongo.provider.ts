import { FactoryProvider, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RetryPolicy } from '@nestjs/resilience';
import { MongoClient, ServerApiVersion } from 'mongodb';
import { Env } from '../../config/env';

export const MONGO_CLIENT = 'MONGO_CLIENT';
export const MONGODB_DATABASE = 'MONGODB_DATABASE';

const logger = new Logger('MongoProvider');

export const MAX_CONNECT_ATTEMPTS = 12;
export const RETRY_DELAY_MS = 10_000;
/**
 * Bounds each connect attempt (the driver's default is 30s), and how long a query waits for a server: long enough to
 * ride out an Atlas primary election, which usually takes a few seconds.
 */
const SERVER_SELECTION_TIMEOUT_MS = 10_000;

/**
 * Retries the initial connect, so the API survives cluster DNS not being ready yet (e.g. right after a node reboot)
 * instead of crash-looping. Worst case 12 attempts of up to 10s with 10s between them: 230s, which the `startupProbe` in
 * osrs-tracker-api.yaml allows for. A standalone `RetryPolicy` (the provider runs before any service): a backoff
 * function gives a constant delay without jitter, and its events don't reach `ResilienceEventsListener`, so the warn
 * line is the record.
 */
export function connectWithRetry(createClient: () => MongoClient): Promise<MongoClient> {
  const retry = new RetryPolicy({
    name: 'mongo-connect',
    attempts: MAX_CONNECT_ATTEMPTS,
    backoff: () => RETRY_DELAY_MS,
    retryIf: () => true,
  });

  return retry.execute(async ({ attempt }) => {
    const client = createClient();
    try {
      return await client.connect();
    } catch (error) {
      await client.close();
      if (attempt < MAX_CONNECT_ATTEMPTS) {
        logger.warn(`MongoDB connect attempt ${attempt}/${MAX_CONNECT_ATTEMPTS} failed, retrying: ${error}`);
      }
      throw error;
    }
  });
}

export const mongoClientProvider: FactoryProvider = {
  provide: MONGO_CLIENT,
  useFactory: (config: ConfigService<Env, true>) =>
    connectWithRetry(
      () =>
        new MongoClient(config.get('MONGODB_URI', { infer: true }), {
          auth: {
            username: config.get('MONGODB_USERNAME', { infer: true }),
            password: config.get('MONGODB_PASSWORD', { infer: true }),
          },
          serverApi: { version: ServerApiVersion.v1, deprecationErrors: true },
          serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
        }),
    ),
  inject: [ConfigService],
};

export const mongoDBProvider: FactoryProvider = {
  provide: MONGODB_DATABASE,
  useFactory: async (mongoClient: MongoClient, config: ConfigService<Env, true>) => {
    const db = mongoClient.db(config.get('MONGODB_DATABASE', { infer: true }));

    // Ensure player indexes are created
    await db.collection('players').createIndex({ username: 1 }, { unique: true });
    await db
      .collection('players')
      .createIndex({ lastHiscoreFetch: -1 }, { partialFilterExpression: { lastHiscoreFetch: { $exists: true } } });

    // Ensure item indexes are created
    await db.collection('items').createIndex({ name: 'text' });
    await db.collection('items').createIndex({ id: 1 }, { unique: true });
    await db
      .collection('items')
      .createIndex({ lastFetch: -1 }, { partialFilterExpression: { lastFetch: { $exists: true } } });

    return db;
  },
  inject: [MONGO_CLIENT, ConfigService],
};
