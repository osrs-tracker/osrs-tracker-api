import { FactoryProvider, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RetryPolicy } from '@nestjs/resilience';
import { Db, MongoClient, ServerApiVersion } from 'mongodb';
import { Env } from '../../config/env';
import { MONGO_LOG_CONTEXT } from '../logger/nest-logger';

export const MONGO_CLIENT = 'MONGO_CLIENT';
export const MONGODB_DATABASE = 'MONGODB_DATABASE';

const logger = new Logger(MONGO_LOG_CONTEXT);

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
      // A failing close mustn't replace the connect error (logged and, after the last attempt, thrown)
      await client.close().catch(() => undefined);
      if (attempt < MAX_CONNECT_ATTEMPTS) {
        logger.warn(`MongoDB connect attempt ${attempt}/${MAX_CONNECT_ATTEMPTS} failed, retrying: ${error}`);
      }
      throw error;
    }
  });
}

/** The Atlas Search index item search runs on (`buildItemSearchPipeline`). */
export const ITEM_SEARCH_INDEX = 'name_autocomplete';
/** The shortest word prefix the index matches. */
export const ITEM_SEARCH_MIN_GRAMS = 2;

/**
 * Creates the item search index when it's missing. Unlike `createIndex`, `createSearchIndex` fails when the name exists,
 * and it doesn't change an existing index: a changed definition has to be applied by hand (`updateSearchIndex` or the
 * Atlas UI). Atlas builds it in the background; until it's ready, item search returns nothing. A failure is logged
 * rather than thrown, so search alone breaks instead of the whole API.
 */
async function ensureItemSearchIndex(db: Db): Promise<void> {
  const items = db.collection('items');
  try {
    if ((await items.listSearchIndexes(ITEM_SEARCH_INDEX).toArray()).length) return;

    await items.createSearchIndex({
      name: ITEM_SEARCH_INDEX,
      definition: {
        mappings: {
          dynamic: false,
          fields: {
            name: [
              // maxGrams 15 covers the longest word in an item name (Superantipoison)
              {
                type: 'autocomplete',
                tokenization: 'edgeGram',
                minGrams: ITEM_SEARCH_MIN_GRAMS,
                maxGrams: 15,
                foldDiacritics: true,
              },
              { type: 'string' },
            ],
          },
        },
      },
    });
    logger.log(`Created the ${ITEM_SEARCH_INDEX} search index on items`);
  } catch (error) {
    logger.error(`Couldn't ensure the ${ITEM_SEARCH_INDEX} search index on items: ${error}`);
  }
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
    await db.collection('items').createIndex({ id: 1 }, { unique: true });
    await db
      .collection('items')
      .createIndex({ lastFetch: -1 }, { partialFilterExpression: { lastFetch: { $exists: true } } });
    await ensureItemSearchIndex(db);

    return db;
  },
  inject: [MONGO_CLIENT, ConfigService],
};
