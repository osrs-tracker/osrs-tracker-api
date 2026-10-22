import { BeforeApplicationShutdown, Inject, Injectable, Logger } from '@nestjs/common';
import { Collection, Db, MongoClient } from 'mongodb';
import { JOB_RUNS_COLLECTION } from '../common/mongo/collections';
import { MONGO_CLIENT, MONGODB_DATABASE } from '../common/mongo/mongo.provider';
import { IngesterJob, IngesterMetrics } from './ingester-metrics';

/** A `jobRuns` document. */
interface JobRun {
  _id: IngesterJob;
  lastSuccess: Date;
}

/** A job's work. It stops (rejects) once `signal` aborts, on shutdown. */
export type JobTask = (signal: AbortSignal) => Promise<void>;

/**
 * Runs the ingester's scheduled jobs (`@Cron` handlers in its root module only, never the API's): one run per job at a
 * time, each success stored in `jobRuns` and set on `ingester_job_last_success_timestamp_seconds`. Nest doesn't replay
 * runs missed while the pod was down, so each job also calls `catchUp` on boot. Our own rather than Agenda (a MongoDB
 * job scheduler) for now: its handlers get no `AbortSignal` and its `start()` needs Mongo up, so most of this would stay
 * as glue; osrs-tracker/osrs-tracker-api#210 weighs the switch.
 */
@Injectable()
export class JobRunsService implements BeforeApplicationShutdown {
  private readonly logger = new Logger('Jobs');
  private readonly runs: Collection<JobRun>;
  private readonly running = new Map<IngesterJob, Promise<void>>();
  private readonly stopping = new AbortController();

  constructor(
    @Inject(MONGO_CLIENT) private readonly client: MongoClient,
    @Inject(MONGODB_DATABASE) db: Db,
    private readonly metrics: IngesterMetrics,
  ) {
    this.runs = db.collection<JobRun>(JOB_RUNS_COLLECTION);
  }

  /** Stops the jobs running, at their next abort check, before `MongoModule` closes the client. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping.abort();
    await Promise.all(this.running.values());
  }

  /**
   * Runs `task`, or joins the run in progress (the catch-up and a cron tick can meet). Connects the Mongo client first
   * (the ingester's isn't connected at startup), and stores the success. Never rejects: a failed run is logged, and the
   * next one starts over.
   */
  run(job: IngesterJob, task: JobTask): Promise<void> {
    const running = this.running.get(job);
    if (running) return running;
    if (this.stopping.signal.aborted) return Promise.resolve();

    const run = this.execute(job, task).finally(() => this.running.delete(job));
    this.running.set(job, run);
    return run;
  }

  /**
   * On boot: sets the metric from the stored last success, and runs the job when that's over `intervalMs` ago or
   * missing. When Mongo can't be read, the next scheduled run does the work.
   */
  async catchUp(job: IngesterJob, intervalMs: number, task: JobTask): Promise<void> {
    let lastSuccess: Date | undefined;
    try {
      await this.client.connect();
      lastSuccess = (await this.runs.findOne({ _id: job }))?.lastSuccess;
    } catch (error) {
      this.logger.warn(`Last run of job ${job} not read, leaving it to its schedule: ${error}`);
      return;
    }
    if (lastSuccess) this.metrics.jobSucceeded(job, lastSuccess);
    if (lastSuccess && Date.now() - lastSuccess.getTime() <= intervalMs) return;

    this.logger.log(`Job ${job} overdue (last success ${lastSuccess?.toISOString() ?? 'never'}), running it now`);
    await this.run(job, task);
  }

  private async execute(job: IngesterJob, task: JobTask): Promise<void> {
    const { signal } = this.stopping;
    try {
      await this.client.connect();
      signal.throwIfAborted();
      await task(signal);
      const lastSuccess = new Date();
      await this.runs.updateOne({ _id: job }, { $set: { lastSuccess } }, { upsert: true });
      this.metrics.jobSucceeded(job, lastSuccess);
    } catch (error) {
      if (signal.aborted) this.logger.warn(`Job ${job} stopped by the shutdown`);
      else this.logger.error(`Job ${job} failed: ${error}`, error instanceof Error ? error.stack : undefined);
    }
  }
}
