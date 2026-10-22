import { DeleteMessageCommand, Message, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { BeforeApplicationShutdown, Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Db, MongoClient } from 'mongodb';
import { setTimeout as sleep } from 'node:timers/promises';
import { MONGO_CLIENT, MONGODB_DATABASE } from '../common/mongo/mongo.provider';
import { IngesterEnv } from '../config/env';
import { applyInOrder } from './apply-in-order';
import { awsClientConfig } from './aws';
import {
  HEARTBEAT_MAX_AGE_MS,
  MAX_MESSAGES,
  POLL_INTERVAL_MS,
  SQS_REQUEST_TIMEOUT_MS,
  WAIT_TIME_SECONDS,
} from './ingester.config';
import { IngesterMetrics, MessageType } from './ingester-metrics';
import { parseScrapeResult } from './scrape-results';
import { ScrapeResultsService } from './scrape-results.service';

/**
 * The poll loop: receives the scraping Lambdas' results from the SQS FIFO queue `osrs-tracker_scrape-results.fifo` and
 * applies them in order (`applyInOrder`). Runs in the ingester's one replica only (`Recreate`), so there is never a
 * second consumer.
 */
@Injectable()
export class IngesterService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('Ingester');
  private readonly sqs: SQSClient;
  private readonly queueUrl: string;
  /** Aborts the long poll and the wait between polls on shutdown. */
  private readonly stopping = new AbortController();
  private loop?: Promise<void>;
  /** When the loop last finished a cycle or a message (`isAlive`). */
  private lastProgress = Date.now();
  private mongoDown = false;
  /** Whether `ensureIndexes` succeeded since startup: it's tried after each successful ping until then. */
  private indexesEnsured = false;

  constructor(
    config: ConfigService<IngesterEnv, true>,
    @Inject(MONGO_CLIENT) private readonly client: MongoClient,
    @Inject(MONGODB_DATABASE) private readonly db: Db,
    private readonly results: ScrapeResultsService,
    private readonly metrics: IngesterMetrics,
  ) {
    this.queueUrl = config.get('SCRAPE_RESULTS_QUEUE_URL', { infer: true });
    this.sqs = new SQSClient({
      ...awsClientConfig(config),
      requestHandler: { connectionTimeout: 5_000, requestTimeout: SQS_REQUEST_TIMEOUT_MS },
    });
  }

  onApplicationBootstrap(): void {
    this.loop = this.run();
  }

  /**
   * Stops the loop before `MongoModule` closes the client: aborts the long poll or the wait, and lets a batch being
   * applied finish (seconds; the Deployment's grace period is 60 s). A message the aborted poll had received comes back
   * once its visibility timeout runs out.
   */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping.abort();
    await this.loop;
    this.sqs.destroy();
  }

  /** The liveness probe's answer: whether the loop made progress within `HEARTBEAT_MAX_AGE_MS`. */
  isAlive(now = Date.now()): boolean {
    return now - this.lastProgress < HEARTBEAT_MAX_AGE_MS;
  }

  private async run(): Promise<void> {
    const { signal } = this.stopping;
    while (!signal.aborted) {
      const started = Date.now();
      const more = await this.cycle();
      this.lastProgress = Date.now();
      // Never negative (a cycle can take longer than the interval): Node warns about that, outside the log format
      const wait = Math.max(0, POLL_INTERVAL_MS - (Date.now() - started));
      if (!more) await sleep(wait, undefined, { signal }).catch(() => undefined);
    }
  }

  /**
   * One poll: pings Mongo (and receives nothing while that fails, since every receive counts towards the dead-letter
   * limit), receives a batch and applies it. Returns whether to receive again at once: the batch had messages and all
   * were applied. Never rejects.
   */
  private async cycle(): Promise<boolean> {
    if (!(await this.pingMongo())) return false;
    if (!this.indexesEnsured) await this.ensureIndexes();

    let messages: Message[];
    try {
      const received = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: this.queueUrl,
          MaxNumberOfMessages: MAX_MESSAGES,
          WaitTimeSeconds: WAIT_TIME_SECONDS,
          MessageSystemAttributeNames: ['MessageGroupId', 'ApproximateReceiveCount'],
        }),
        { abortSignal: this.stopping.signal },
      );
      messages = received.Messages ?? [];
    } catch (error) {
      if (!this.stopping.signal.aborted) this.logger.error(`Receiving scrape results failed: ${error}`);
      return false;
    }

    if (!messages.length) {
      this.logger.log('No scrape results on the queue');
      this.metrics.jobSucceeded('ingest');
      return false;
    }

    const { done, failed } = await applyInOrder(
      messages,
      (message) => this.apply(message),
      (message) => this.delete(message),
    );
    if (failed) {
      const { error, message } = failed;
      this.logger.error(
        `Scrape result not applied, left on the queue with the ${messages.length - done - 1} received after it: ${error}`,
        {
          messageId: message.MessageId,
          messageGroupId: message.Attributes?.MessageGroupId,
          receiveCount: message.Attributes?.ApproximateReceiveCount,
        },
        error instanceof Error ? error.stack : undefined,
      );
      return false;
    }

    this.metrics.jobSucceeded('ingest');
    return true;
  }

  /** Parses and applies one message, counting it. Throws for one it can't apply, which is then never deleted. */
  private async apply(message: Message): Promise<void> {
    let type: MessageType = 'unknown';
    try {
      const result = parseScrapeResult(message.Body);
      type = result.type;
      this.metrics.message(type, await this.results.apply(result));
    } catch (error) {
      this.metrics.message(type, 'failed');
      throw error;
    }
    this.lastProgress = Date.now();
  }

  private async delete({ ReceiptHandle }: Message): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle }));
  }

  /**
   * Creates the ingester's indexes once Mongo answers (it isn't connected at startup), retrying each cycle until that
   * succeeds. Receiving goes on meanwhile: the indexes already exist in every database but a new one.
   */
  private async ensureIndexes(): Promise<void> {
    try {
      await this.results.ensureIndexes();
      this.indexesEnsured = true;
    } catch (error) {
      this.logger.error(`Creating the ingester's indexes failed: ${error}`);
    }
  }

  /**
   * Whether Mongo answers a ping. Connects the client first: the ingester's isn't connected at startup, and a failed
   * connect leaves it closed until `connect()` is called again (`ingesterMongoClientProvider`). Once connected, the
   * driver itself rides out an outage. Logs the outage on every failed ping (one a minute) and the recovery once.
   */
  private async pingMongo(): Promise<boolean> {
    try {
      await this.client.connect();
      await this.db.command({ ping: 1 });
    } catch (error) {
      this.logger.warn(`MongoDB unreachable, not receiving: ${error}`);
      this.mongoDown = true;
      return false;
    }
    if (this.mongoDown) this.logger.log('MongoDB reachable again, receiving');
    this.mongoDown = false;
    return true;
  }
}
