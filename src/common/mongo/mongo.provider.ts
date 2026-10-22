import { FactoryProvider, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RetryPolicy } from '@nestjs/resilience';
import { MongoClient, ServerApiVersion } from 'mongodb';
import { MongoEnv } from '../../config/env';
import { ITEMS_COLLECTION, NEWS_COLLECTION, PLAYERS_COLLECTION } from './collections';
import { MONGO_LOG_CONTEXT } from '../logger/nest-logger';

export const MONGO_CLIENT = 'MONGO_CLIENT';
export const MONGODB_DATABASE = 'MONGODB_DATABASE';

const logger = new Logger(MONGO_LOG_CONTEXT);

export const MAX_CONNECT_ATTEMPTS = 6;
export const RETRY_DELAY_MS = 10_000;
/**
 * How long a query waits for a server, and so bounds each connect attempt: long enough to ride out a restart of the
 * single-member replica set (14 to 30s, e.g. a MongoDB upgrade), during which there is no server. A read or write the
 * restart cuts off is retried once (the driver's `retryReads`/`retryWrites`), with the same wait. The driver's default,
 * set here so the connect retry below is sized against it.
 */
const SERVER_SELECTION_TIMEOUT_MS = 30_000;

/**
 * Retries the initial connect, so the API survives cluster DNS not being ready yet (e.g. right after a node reboot)
 * instead of crash-looping. Worst case 6 attempts of up to 30s with 10s between them: 230s, which the `startupProbe` in
 * osrs-tracker-api.yaml allows for: raising either means raising its `failureThreshold`. A standalone `RetryPolicy` (the
 * provider runs before any service): a backoff function gives a constant delay without jitter, and its events don't
 * reach `ResilienceEventsListener`, so the warn line is the record.
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
      // A failing close mustn't replace the connect error (logged and, after the last attempt, thrown)
      await client.close().catch(() => undefined);
      if (attempt < MAX_CONNECT_ATTEMPTS) {
        logger.warn(`MongoDB connect attempt ${attempt}/${MAX_CONNECT_ATTEMPTS} failed, retrying: ${error}`);
      }
      throw error;
    }
  });
}

/**
 * The collation of the `{ name: 1 }` index on items (case-insensitive, accents count). Item browse
 * (`buildItemBrowseFilter`) queries and sorts with it: the index is only used by queries with the same collation.
 */
export const ITEM_NAME_COLLATION = { locale: 'en', strength: 2 } as const;

/** A client for the configured database, not connected yet. */
function createMongoClient(config: ConfigService<MongoEnv, true>): MongoClient {
  return new MongoClient(config.get('MONGODB_URI', { infer: true }), {
    auth: {
      username: config.get('MONGODB_USERNAME', { infer: true }),
      password: config.get('MONGODB_PASSWORD', { infer: true }),
    },
    serverApi: { version: ServerApiVersion.v1, deprecationErrors: true },
    serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
  });
}

/** The API's client: connected before the app starts, retrying (`connectWithRetry`). */
export const mongoClientProvider: FactoryProvider = {
  provide: MONGO_CLIENT,
  useFactory: (config: ConfigService<MongoEnv, true>) => connectWithRetry(() => createMongoClient(config)),
  inject: [ConfigService],
};

/** The API's database, once its indexes are ensured. */
export const mongoDBProvider: FactoryProvider = {
  provide: MONGODB_DATABASE,
  useFactory: async (mongoClient: MongoClient, config: ConfigService<MongoEnv, true>) => {
    const db = mongoClient.db(config.get('MONGODB_DATABASE', { infer: true }));

    // Ensure player indexes are created
    await db.collection(PLAYERS_COLLECTION).createIndex({ username: 1 }, { unique: true });
    await db
      .collection(PLAYERS_COLLECTION)
      .createIndex({ lastHiscoreFetch: -1 }, { partialFilterExpression: { lastHiscoreFetch: { $exists: true } } });

    // Ensure item indexes are created
    await db.collection(ITEMS_COLLECTION).createIndex({ id: 1 }, { unique: true });
    await db
      .collection(ITEMS_COLLECTION)
      .createIndex({ lastFetch: -1 }, { partialFilterExpression: { lastFetch: { $exists: true } } });
    await db.collection(ITEMS_COLLECTION).createIndex({ name: 1 }, { collation: ITEM_NAME_COLLATION });

    // Ensure news indexes are created: the feed upserts on `link`, `/news/since/:date` reads by `pubDate`
    await db.collection(NEWS_COLLECTION).createIndex({ link: 1 }, { unique: true });
    await db.collection(NEWS_COLLECTION).createIndex({ pubDate: -1 });

    return db;
  },
  inject: [MONGO_CLIENT, ConfigService],
};

/**
 * The ingester's client, not connected at startup, so the ingester starts during a Mongo outage. Its poll loop connects
 * it before each receive (`IngesterService`), and `JobRunsService` before each job: a failed connect leaves the client
 * closed, and only an explicit
 * `connect()` opens it again, not the driver's connect on first use.
 */
export const ingesterMongoClientProvider: FactoryProvider = {
  provide: MONGO_CLIENT,
  useFactory: createMongoClient,
  inject: [ConfigService],
};

/**
 * The ingester's database. Creates no indexes here, since the client isn't connected yet: the poll loop creates the
 * ingester's own (`ScrapeResultsService.ensureIndexes`) once Mongo answers, and the API owns the rest.
 */
export const ingesterMongoDBProvider: FactoryProvider = {
  provide: MONGODB_DATABASE,
  useFactory: (mongoClient: MongoClient, config: ConfigService<MongoEnv, true>) =>
    mongoClient.db(config.get('MONGODB_DATABASE', { infer: true })),
  inject: [MONGO_CLIENT, ConfigService],
};
