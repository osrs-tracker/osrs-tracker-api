import { FactoryProvider } from '@nestjs/common';
import { MongoClient, ServerApiVersion } from 'mongodb';

export const mongoClientProvider: FactoryProvider = {
  provide: 'MONGO_CLIENT',
  useFactory: async () =>
    new MongoClient(process.env.MONGODB_URI!, {
      auth: { username: process.env.MONGODB_USERNAME, password: process.env.MONGODB_PASSWORD },
      serverApi: { version: ServerApiVersion.v1, deprecationErrors: true },
    }).connect(),
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
