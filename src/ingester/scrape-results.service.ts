import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  encodeHiscoreEntry,
  HiscoresResultMessage,
  PlayerCount,
  PlayerCountDay,
  PlayerCountResultMessage,
  ScrapeResultMessage,
  StoredPlayer,
} from '@osrs-tracker/models';
import { AnyBulkWriteOperation, Collection, Db } from 'mongodb';
import {
  PLAYER_COUNTS_COLLECTION,
  PLAYER_COUNTS_DAILY_COLLECTION,
  PLAYERS_COLLECTION,
} from '../common/mongo/collections';
import { MONGODB_DATABASE } from '../common/mongo/mongo.provider';
import { HiscoreLayoutsService } from '../features/players/hiscore-layouts.service';
import { PlayerUtils } from '../features/players/player.utils';
import { DiscordAlerts } from './discord-alerts';
import {
  HISCORE_NOT_FOUND_PAUSE_DAYS,
  hiscoreEntryUpdate,
  hiscoreNotFoundPipeline,
  pausedByNotFound,
  playerCountDaysPipeline,
  playerCountUpsert,
  startOfUTCDay,
} from './scrape-results';

/** `applied` when the message wrote something, `stale` when everything in it was already stored. */
export type ApplyResult = 'applied' | 'stale';

/**
 * Writes the scraping Lambdas' results to MongoDB, as process-players and record-player-count did (osrs-tracker-aws).
 * A message whose write failed halfway is applied again whole when it comes back, so the writes must survive a repeat:
 * the slot guard skips stored entries and `$setOnInsert` stored samples. A repeated not-found only counts the player
 * once more (`hiscoreNotFoundCount` is only read as "more than 0"; pausing goes by `hiscoreNotFoundSince`, which a
 * repeat keeps), though a pause recorded before a failure in the same message gets no alert on the retry.
 */
@Injectable()
export class ScrapeResultsService {
  private readonly logger = new Logger(ScrapeResultsService.name);
  private readonly players: Collection<StoredPlayer>;
  private readonly playerCounts: Collection<PlayerCount>;
  private readonly playerCountsDaily: Collection<PlayerCountDay>;

  constructor(
    @Inject(MONGODB_DATABASE) db: Db,
    private readonly layouts: HiscoreLayoutsService,
    private readonly alerts: DiscordAlerts,
  ) {
    this.players = db.collection<StoredPlayer>(PLAYERS_COLLECTION);
    this.playerCounts = db.collection<PlayerCount>(PLAYER_COUNTS_COLLECTION);
    this.playerCountsDaily = db.collection<PlayerCountDay>(PLAYER_COUNTS_DAILY_COLLECTION);
  }

  /**
   * Creates the indexes the ingester owns (`DATA-MODEL.md`): `{ date: 1 }`, unique, on both player count collections.
   * The upsert on `date` relies on `playerCounts`', the `$merge` (its `on`) on `playerCountsDaily`'. A no-op when they
   * exist; throws when one exists with other options.
   */
  async ensureIndexes(): Promise<void> {
    await this.playerCounts.createIndex({ date: 1 }, { unique: true });
    await this.playerCountsDaily.createIndex({ date: 1 }, { unique: true });
  }

  /** Applies one message, from `parseScrapeResult`. Throws when a write fails. */
  apply(message: ScrapeResultMessage): Promise<ApplyResult> {
    return message.type === 'hiscores' ? this.applyHiscores(message) : this.applyPlayerCount(message);
  }

  /**
   * Prepends a hiscore entry per found player (`hiscoreEntryUpdate`, which skips stale ones), then records the players
   * not found, and alerts on the ones that got paused.
   */
  private async applyHiscores({ scrapedAt, scrapingOffset, found, notFound }: HiscoresResultMessage) {
    const date = new Date(scrapedAt);
    const recorded: string[] = [];
    const paused: string[] = [];

    const writes: AnyBulkWriteOperation<StoredPlayer>[] = [];
    for (const { username, hiscore, layout } of found) {
      // Every layout is stored before the entries that refer to it (`ensure` caches the ones it stored)
      const entry = encodeHiscoreEntry({ date, scrapingOffset, ...hiscore }, await this.layouts.ensure(layout, date));
      const { filter, update } = hiscoreEntryUpdate(PlayerUtils.normalizeUsername(username), entry);
      writes.push({ updateOne: { filter, update, hint: { username: 1 } } });
    }
    // Not `modifiedCount`: the guard decides in the filter, so a stale entry matches nothing. A write that fails halfway
    // is retried whole: the guard skips the entries it stored
    const applied = writes.length ? (await this.players.bulkWrite(writes)).matchedCount : 0;

    for (const username of notFound) {
      const before = await this.players.findOneAndUpdate(
        { username: PlayerUtils.normalizeUsername(username) },
        hiscoreNotFoundPipeline(date),
        {
          hint: { username: 1 },
          projection: { _id: 0, scrapingOffsets: 1, hiscoreNotFoundSince: 1 },
          returnDocument: 'before',
        },
      );
      if (!before) continue;
      recorded.push(username);
      if (pausedByNotFound(before, date)) paused.push(username);
    }

    // `stale` also counts players that are no longer stored
    const result: ApplyResult = applied || recorded.length ? 'applied' : 'stale';
    this.logger.log(`Hiscores of offset ${scrapingOffset} scraped at ${scrapedAt}: ${result}`, {
      scrapingOffset,
      scrapedAt,
      applied,
      stale: found.length - applied,
      notFound: recorded,
      paused,
    });

    if (paused.length) {
      const summary = `Not on the hiscores for ${HISCORE_NOT_FOUND_PAUSE_DAYS} days, paused scraping for`;
      await this.alerts.send('Paused scraping', summary, paused);
    }
    return result;
  }

  /**
   * Stores the sample unless it's stored already, then recomputes the daily averages from the start of its UTC day, so
   * a late sample reaches its day. The recompute runs for a stored sample too: a retry after a failed recompute finds
   * the sample already there.
   */
  private async applyPlayerCount({ playerCount }: PlayerCountResultMessage) {
    const sample: PlayerCount = { ...playerCount, date: new Date(playerCount.date) };
    const { filter, update } = playerCountUpsert(sample);
    const { upsertedCount } = await this.playerCounts.updateOne(filter, update, { upsert: true });

    // `$merge` writes as the cursor is read, and returns no documents. Its `on` needs the unique `{ date: 1 }` index on
    // `playerCountsDaily` (`ensureIndexes`)
    await this.playerCounts
      .aggregate<PlayerCountDay>([
        ...playerCountDaysPipeline(startOfUTCDay(sample.date)),
        {
          $merge: {
            into: PLAYER_COUNTS_DAILY_COLLECTION,
            on: 'date',
            whenMatched: 'replace',
            whenNotMatched: 'insert',
          },
        },
      ])
      .toArray();

    const result: ApplyResult = upsertedCount ? 'applied' : 'stale';
    this.logger.log(`Player count of ${playerCount.date}: ${result}`, { date: playerCount.date, total: sample.total });
    return result;
  }
}
