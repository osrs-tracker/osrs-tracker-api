import { FactoryProvider, Logger } from '@nestjs/common';
import { setTimeout } from 'node:timers/promises';
import { MongoClient, ServerApiVersion } from 'mongodb';

const logger = new Logger('MongoProvider');

const MAX_CONNECT_ATTEMPTS = 12;
const RETRY_DELAY_MS = 10_000;

/**
 * Retries the initial connect, so the API survives cluster DNS not being ready yet (e.g. right after a node reboot)
 * instead of crash-looping. The `startupProbe` in osrs-tracker-api.yaml allows for this.
 */
async function connectWithRetry(): Promise<MongoClient> {
  for (let attempt = 1; ; attempt++) {
    const client = new MongoClient(process.env.MONGODB_URI!, {
      auth: { username: process.env.MONGODB_USERNAME, password: process.env.MONGODB_PASSWORD },
      serverApi: { version: ServerApiVersion.v1, deprecationErrors: true },
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
};

export const mongoDBProvider: FactoryProvider = {
  provide: 'MONGODB_DATABASE',
  useFactory: async (mongoClient: MongoClient) => {
    const db = mongoClient.db(process.env.MONGODB_DATABASE);

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
  inject: ['MONGO_CLIENT'],
};
