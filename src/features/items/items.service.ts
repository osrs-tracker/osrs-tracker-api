import { Inject, Injectable } from '@nestjs/common';
import { Item } from '@osrs-tracker/models';
import { Collection, Db } from 'mongodb';

@Injectable()
export class ItemsService {
  private readonly COLLECTION_NAME = 'items';

  get collection(): Collection<Item> {
    return this.db.collection(this.COLLECTION_NAME);
  }

  constructor(@Inject('MONGODB_DATABASE') private readonly db: Db) {}

  getLastFetchedItems(limit: number): Promise<Item[]> {
    return this.collection
      .find<Item>(
        {
          lastFetch: { $exists: true }, // Ensure lastFetch exists
        },
        {
          hint: { lastFetch: -1 }, // Use the index on lastFetch
          projection: { _id: 0, id: 1, icon: 1, name: 1, lastFetch: 1 }, // Include lastFetch in the projection
        },
      )
      .sort({ lastFetch: -1 }) // Sort by lastFetch in descending order
      .limit(limit)
      .toArray();
  }

  getItem(id: number): Promise<Item | null> {
    return this.collection.findOneAndUpdate(
      { id: id },
      { $set: { lastFetch: new Date() } },
      {
        hint: { id: 1 },
        projection: { _id: 0 },
        returnDocument: 'after', // Important: returns the document after the update
      },
    ) as Promise<Item | null>;
  }

  searchItems(query: string): Promise<Item[]> {
    return this.collection
      .find<Item>(
        { $text: { $search: query } },
        { projection: { _id: 0, id: 1, icon: 1, name: 1, score: { $meta: 'textScore' } } },
      )
      .sort({ score: { $meta: 'textScore' } })
      .limit(20)
      .toArray();
  }
}
