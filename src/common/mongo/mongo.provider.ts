import { FactoryProvider, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { setTimeout } from 'node:timers/promises';
import { MongoClient, ServerApiVersion } from 'mongodb';
import { Env } from '../../config/env';

const logger = new Logger('MongoProvider');

const MAX_CONNECT_ATTEMPTS = 12;
const RETRY_DELAY_MS = 10_000;
/**
 * Bounds each connect attempt (the driver's default is 30s), and how long a query waits for a server: long enough to
 * ride out an Atlas primary election, which usually takes a few seconds.
 */
const SERVER_SELECTION_TIMEOUT_MS = 10_000;

/**
 * Retries the initial connect, so the API survives cluster DNS not being ready yet (e.g. right after a node reboot)
 * instead of crash-looping. Worst case 12 attempts of up to 10s with 10s between them: 230s, which the `startupProbe` in
 * osrs-tracker-api.yaml allows for.
 */
async function connectWithRetry(config: ConfigService<Env, true>): Promise<MongoClient> {
  for (let attempt = 1; ; attempt++) {
    const client = new MongoClient(config.get('MONGODB_URI', { infer: true }), {
      auth: {
        username: config.get('MONGODB_USERNAME', { infer: true }),
        password: config.get('MONGODB_PASSWORD', { infer: true }),
      },
      serverApi: { version: ServerApiVersion.v1, deprecationErrors: true },
      serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
    });

    try {
      return await client.connect();
    } catch (error) {
      await client.close();
      if (attempt === MAX_CONNECT_ATTEMPTS) throw error;

      logger.warn(`MongoDB connect attempt ${attempt}/${MAX_CONNECT_ATTEMPTS} failed, retrying: ${error}`);
      await setTimeout(RETRY_DELAY_MS);
    }
  }
}

export const mongoClientProvider: FactoryProvider = {
  provide: 'MONGO_CLIENT',
  useFactory: connectWithRetry,
  inject: [ConfigService],
};

export const mongoDBProvider: FactoryProvider = {
  provide: 'MONGODB_DATABASE',
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
  inject: ['MONGO_CLIENT', ConfigService],
};
