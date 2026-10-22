import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { HiscoreLayout, StoredPlayer } from '@osrs-tracker/models';
import { subDays } from 'date-fns';
import { Collection, Db } from 'mongodb';
import { HISCORE_LAYOUTS_COLLECTION, PLAYERS_COLLECTION } from '../common/mongo/collections';
import { MONGODB_DATABASE } from '../common/mongo/mongo.provider';
import {
  DROP_PIPELINE_FIELDS,
  dropUnusedScrapingOffsetsPipeline,
  HAS_NO_HISCORE_ENTRIES,
  HAS_SCRAPING_OFFSETS,
} from './clean-hiscores';
import { DiscordAlerts } from './discord-alerts';
import {
  CLEAN_HISCORES_CRON,
  CLEAN_HISCORES_INTERVAL_MS,
  MAX_AGE_IN_DAYS,
  MAX_DAYS_WITHOUT_SCRAPES,
  UNUSED_SCRAPING_OFFSET_DAYS,
} from './ingester.config';
import { JobRunsService } from './job-runs.service';
import { startOfUTCDay } from './scrape-results';

/**
 * Cleans `players` and `hiscoreLayouts` every night: unused scraping offsets, old hiscore entries, unused layouts and
 * players left without entries, then alerts when scraping stopped. Ported from osrs-tracker-aws's clean-hiscores Lambda.
 */
@Injectable()
export class CleanHiscoresService implements OnApplicationBootstrap {
  private readonly logger = new Logger('CleanHiscores');
  private readonly players: Collection<StoredPlayer>;
  private readonly layouts: Collection<HiscoreLayout>;

  constructor(
    @Inject(MONGODB_DATABASE) db: Db,
    private readonly jobs: JobRunsService,
    private readonly alerts: DiscordAlerts,
  ) {
    this.players = db.collection<StoredPlayer>(PLAYERS_COLLECTION);
    this.layouts = db.collection<HiscoreLayout>(HISCORE_LAYOUTS_COLLECTION);
  }

  onApplicationBootstrap(): void {
    void this.jobs.catchUp('clean', CLEAN_HISCORES_INTERVAL_MS, (signal) => this.clean(signal));
  }

  @Cron(CLEAN_HISCORES_CRON, { name: 'clean', timeZone: 'UTC', waitForCompletion: true })
  scheduled(): Promise<void> {
    return this.jobs.run('clean', (signal) => this.clean(signal));
  }

  /**
   * In this order, each step seeing what the one before removed: drops unused scraping offsets with their entries,
   * pulls entries older than `MAX_AGE_IN_DAYS` (from the start of the UTC day), deletes unused layouts, then the players
   * left without entries. Last, alerts and throws (so the run counts as failed) when no player has an entry from the
   * last `MAX_DAYS_WITHOUT_SCRAPES` days: every hour scrapes some players, so scraping stopped.
   */
  async clean(signal: AbortSignal): Promise<void> {
    const now = new Date();

    const dropped = await this.dropUnusedScrapingOffsets(subDays(now, UNUSED_SCRAPING_OFFSET_DAYS), now);
    this.logger.log(
      `Dropped scraping offsets not looked up for ${UNUSED_SCRAPING_OFFSET_DAYS} days from ${dropped.length} players`,
      { dropped },
    );
    signal.throwIfAborted();

    // The whole collection without an index: seconds, within the Deployment's 60 s grace period
    const { modifiedCount } = await this.players.updateMany(
      {},
      { $pull: { hiscoreEntries: { d: { $lt: subDays(startOfUTCDay(now), MAX_AGE_IN_DAYS) } } } },
    );
    this.logger.log(`Cleaned hiscores older than ${MAX_AGE_IN_DAYS} days for ${modifiedCount} players`);
    signal.throwIfAborted();

    // after the pull, since only pulled entries can leave a layout unused. Layouts from the last day are kept: a writer
    // stores a layout before the first entry that uses it
    const used = await this.players.distinct('hiscoreEntries.l');
    const layouts = await this.layouts.deleteMany({ _id: { $nin: used }, since: { $lt: subDays(now, 1) } });
    this.logger.log(`Deleted ${layouts.deletedCount} unused hiscore layouts`);
    signal.throwIfAborted();

    // a player whose last entry was just pulled hasn't been scraped or looked up for MAX_AGE_IN_DAYS; a lookup through
    // the API creates it again
    const players = await this.players.deleteMany(HAS_NO_HISCORE_ENTRIES);
    this.logger.log(`Deleted ${players.deletedCount} players without hiscore entries`);

    // Not "nothing was pulled": that's also expected for MAX_AGE_IN_DAYS nights after a raise of it
    const scraped = await this.players.findOne(
      { 'hiscoreEntries.d': { $gte: subDays(now, MAX_DAYS_WITHOUT_SCRAPES) } },
      { projection: { _id: 1 } },
    );
    if (!scraped) {
      const message = `No hiscores were scraped in the last ${MAX_DAYS_WITHOUT_SCRAPES} days.`;
      await this.alerts.sendText('No hiscores scraped', message);
      throw new Error(message);
    }
  }

  /** Returns the players that lost offsets, read before the update with the same pipeline. */
  private async dropUnusedScrapingOffsets(cutoff: Date, now: Date): Promise<{ username: string; dropped: number[] }[]> {
    const pipeline = dropUnusedScrapingOffsetsPipeline(cutoff, now);
    const dropped = await this.players
      .aggregate<{ username: string; dropped: number[] }>([
        { $match: HAS_SCRAPING_OFFSETS },
        ...pipeline,
        { $match: { '_dropped.0': { $exists: true } } },
        { $project: { _id: 0, username: 1, dropped: '$_dropped' } },
      ])
      .toArray();

    await this.players.updateMany(HAS_SCRAPING_OFFSETS, [...pipeline, { $unset: DROP_PIPELINE_FIELDS }]);
    return dropped;
  }
}
