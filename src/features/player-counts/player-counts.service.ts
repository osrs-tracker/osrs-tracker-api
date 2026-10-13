import { Inject, Injectable } from '@nestjs/common';
import { PlayerCount } from '@osrs-tracker/models';
import { Collection, Db } from 'mongodb';
import { MONGODB_DATABASE } from '../../common/mongo/mongo.provider';
import { buildPlayerCountHistoryPipeline, PlayerCountPoint, PlayerCountRange } from './player-count-history';

@Injectable()
export class PlayerCountsService {
  private readonly COLLECTION_NAME = 'playerCounts';

  get collection(): Collection<PlayerCount> {
    return this.db.collection(this.COLLECTION_NAME);
  }

  constructor(@Inject(MONGODB_DATABASE) private readonly db: Db) {}

  /** The newest sample, or `null` before the first one. */
  getLatest(): Promise<PlayerCount | null> {
    return this.collection.findOne<PlayerCount>(
      {},
      { sort: { date: -1 }, hint: { date: 1 }, projection: { _id: 0 } }, // `{ date: 1 }`: record-player-count's index
    );
  }

  getHistory(range: PlayerCountRange): Promise<PlayerCountPoint[]> {
    return this.collection
      .aggregate<PlayerCountPoint>(buildPlayerCountHistoryPipeline(range), { hint: { date: 1 } })
      .toArray();
  }
}
