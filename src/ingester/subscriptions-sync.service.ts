import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, paginateScan, PutCommand } from '@aws-sdk/lib-dynamodb';
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PlayerSubscription, StoredPlayer } from '@osrs-tracker/models';
import { Collection, Db } from 'mongodb';
import { setTimeout as sleep } from 'node:timers/promises';
import { PLAYERS_COLLECTION } from '../common/mongo/collections';
import { MONGODB_DATABASE } from '../common/mongo/mongo.provider';
import { IngesterEnv } from '../config/env';
import { awsClientConfig } from './aws';
import { DiscordAlerts } from './discord-alerts';
import {
  DYNAMODB_REQUEST_TIMEOUT_MS,
  SUBSCRIPTION_WRITE_GAP_MS,
  SUBSCRIPTIONS_SYNC_CRON,
  SUBSCRIPTIONS_SYNC_INTERVAL_MS,
} from './ingester.config';
import { JobRunsService } from './job-runs.service';
import { deleteGuard, diffSubscriptions, SUBSCRIPTIONS_TABLE } from './subscriptions';

/**
 * Keeps the DynamoDB table `osrs-tracker_subscriptions` a copy of `players.scrapingOffsets`, every 15 minutes: queue-players
 * reads it (osrs-tracker/osrs-tracker-aws#164), so scraping goes on from the last copy while the cluster is down. The
 * table's only writer. Each run writes whole items, never deltas, so it repairs whatever the last one missed.
 */
@Injectable()
export class SubscriptionsSyncService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Subscriptions');
  private readonly players: Collection<StoredPlayer>;
  private readonly dynamo: DynamoDBDocumentClient;

  constructor(
    config: ConfigService<IngesterEnv, true>,
    @Inject(MONGODB_DATABASE) db: Db,
    private readonly jobs: JobRunsService,
    private readonly alerts: DiscordAlerts,
  ) {
    this.players = db.collection<StoredPlayer>(PLAYERS_COLLECTION);
    this.dynamo = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        ...awsClientConfig(config),
        requestHandler: { connectionTimeout: 5_000, requestTimeout: DYNAMODB_REQUEST_TIMEOUT_MS },
      }),
    );
  }

  onApplicationBootstrap(): void {
    void this.jobs.catchUp('subscriptions', SUBSCRIPTIONS_SYNC_INTERVAL_MS, (signal) => this.sync(signal));
  }

  /** After `JobRunsService` waited for a run in progress. */
  onApplicationShutdown(): void {
    this.dynamo.destroy();
  }

  @Cron(SUBSCRIPTIONS_SYNC_CRON, { name: 'subscriptions', timeZone: 'UTC', waitForCompletion: true })
  scheduled(): Promise<void> {
    return this.jobs.run('subscriptions', (signal) => this.sync(signal));
  }

  /**
   * Reads every player to scrape and the whole table before writing anything, then puts the items that differ or are
   * missing and deletes the ones without a player to scrape, paced (`SUBSCRIPTION_WRITE_GAP_MS`). The deletes are
   * skipped, with an alert, when `deleteGuard` says so; the puts still go.
   */
  private async sync(signal: AbortSignal): Promise<void> {
    const players = await this.players
      .find({ 'scrapingOffsets.0': { $exists: true } }, { projection: { _id: 0, username: 1, scrapingOffsets: 1 } })
      .toArray();
    const items: PlayerSubscription[] = [];
    for await (const page of paginateScan({ client: this.dynamo }, { TableName: SUBSCRIPTIONS_TABLE }))
      items.push(...((page.Items ?? []) as PlayerSubscription[]));

    const { puts, deletes } = diffSubscriptions(players, items);
    const skipDeletes = deleteGuard(players.length, items.length, deletes.length);

    for (const item of puts) {
      await this.dynamo.send(new PutCommand({ TableName: SUBSCRIPTIONS_TABLE, Item: item }));
      await sleep(SUBSCRIPTION_WRITE_GAP_MS, undefined, { signal });
    }
    if (!skipDeletes) {
      for (const username of deletes) {
        await this.dynamo.send(new DeleteCommand({ TableName: SUBSCRIPTIONS_TABLE, Key: { username } }));
        await sleep(SUBSCRIPTION_WRITE_GAP_MS, undefined, { signal });
      }
    }

    const fields = { players: players.length, items: items.length, puts: puts.length };
    if (skipDeletes) {
      this.logger.warn(`Subscriptions synced without deleting: ${skipDeletes}`, {
        ...fields,
        deletesSkipped: deletes.length,
      });
      await this.alerts.send('Subscription deletes skipped', `${skipDeletes}. Kept the subscriptions of`, deletes);
    } else {
      this.logger.log(`Subscriptions synced: ${puts.length} put, ${deletes.length} deleted`, {
        ...fields,
        deleted: deletes,
      });
    }
  }
}
