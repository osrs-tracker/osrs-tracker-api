import { BadGatewayException, Inject, Injectable, Logger } from '@nestjs/common';
import { fetchWorldList, parseWorldList } from '@osrs-tracker/hiscores';
import { PlayerCount, PlayerCountDay, PlayerCountPoint, PlayerCountRange } from '@osrs-tracker/models';
import { LRUCache } from 'lru-cache';
import { Collection, Db } from 'mongodb';
import { Agent, fetch } from 'undici';
import { AGENT, USER_AGENT } from '../../common/agent/agent.provider';
import { PLAYER_COUNTS_COLLECTION, PLAYER_COUNTS_DAILY_COLLECTION } from '../../common/mongo/collections';
import { MONGODB_DATABASE } from '../../common/mongo/mongo.provider';
import { buildPlayerCountHistoryPipeline, readsDailyAverages } from './player-count-history';

/** How long a live count (or a failure to get one) is kept: Jagex asks for at most one world list poll a minute. */
export const LIVE_PLAYER_COUNT_TTL_MS = 60_000;

@Injectable()
export class PlayerCountsService {
  private readonly logger = new Logger(PlayerCountsService.name);

  /**
   * The live count, or `'failed'` when Jagex failed, so an outage doesn't turn every request into a poll either.
   * `forceFetch` shares one world list request between concurrent requests.
   */
  private readonly liveCache = new LRUCache<'live', PlayerCount | 'failed'>({
    max: 1,
    ttl: LIVE_PLAYER_COUNT_TTL_MS,
    fetchMethod: () => this.fetchLive(),
  });

  private readonly collection: Collection<PlayerCount>;
  private readonly daily: Collection<PlayerCountDay>;

  constructor(
    @Inject(MONGODB_DATABASE) db: Db,
    @Inject(AGENT) private readonly agent: Agent,
  ) {
    this.collection = db.collection(PLAYER_COUNTS_COLLECTION);
    this.daily = db.collection(PLAYER_COUNTS_DAILY_COLLECTION);
  }

  /** The newest sample, or `null` before the first one. */
  getLatest(): Promise<PlayerCount | null> {
    return this.collection.findOne<PlayerCount>(
      {},
      { sort: { date: -1 }, hint: { date: 1 }, projection: { _id: 0 } }, // `{ date: 1 }`: the ingester's index
    );
  }

  getHistory(range: PlayerCountRange): Promise<PlayerCountPoint[]> {
    const pipeline = buildPlayerCountHistoryPipeline(range);
    const options = { hint: { date: 1 } }; // the ingester's index, on both collections

    return (
      readsDailyAverages(range)
        ? this.daily.aggregate<PlayerCountPoint>(pipeline, options)
        : this.collection.aggregate<PlayerCountPoint>(pipeline, options)
    ).toArray();
  }

  /**
   * The players online now, from Jagex's world list, at most `LIVE_PLAYER_COUNT_TTL_MS` old; never stored (the
   * ingester owns `playerCounts`). A 502 when Jagex fails, answered for `LIVE_PLAYER_COUNT_TTL_MS`
   * without asking again.
   */
  async getLive(): Promise<PlayerCount> {
    const live = await this.liveCache.forceFetch('live');
    if (live === 'failed') throw new BadGatewayException(`The world list can't be reached, try again later.`);

    return live;
  }

  /** The live cache's `fetchMethod`: like the Lambda, 0 worlds or 0 players is a failure, not a count. */
  private async fetchLive(): Promise<PlayerCount | 'failed'> {
    const date = new Date();
    try {
      const counts = parseWorldList(
        await fetchWorldList({
          userAgent: USER_AGENT,
          fetch: (url, init) => fetch(url, { ...init, dispatcher: this.agent }),
        }),
      );
      if (!counts.worlds || !counts.total) throw new Error(`${counts.worlds} worlds with ${counts.total} players`);

      return { date, ...counts };
    } catch (error) {
      this.logger.warn(`World list request failed: ${(error as Error).message}`);
      return 'failed';
    }
  }
}
