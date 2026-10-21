import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Counter, Gauge, register } from '@osrs-tracker/express-metrics';

/** The ingester's jobs: `ingest` is the poll loop. */
export type IngesterJob = 'ingest';

/** A message's `type`, `unknown` when it couldn't be parsed. */
export type MessageType = 'hiscores' | 'playerCount' | 'unknown';

const METRICS = {
  jobLastSuccess: 'ingester_job_last_success_timestamp_seconds',
  messages: 'ingester_messages_total',
} as const;

/** The ingester's Prometheus metrics, on the default registry (`/metrics` on `METRICS_PORT`). */
@Injectable()
export class IngesterMetrics implements OnModuleInit, OnApplicationShutdown {
  private jobLastSuccess?: Gauge<'job'>;
  private messages?: Counter<'type' | 'result'>;

  onModuleInit(): void {
    this.jobLastSuccess = new Gauge({
      name: METRICS.jobLastSuccess,
      help: 'When an ingester job last completed, in Unix seconds: for ingest, a poll cycle, empty or not',
      labelNames: ['job'],
    });
    this.messages = new Counter({
      name: METRICS.messages,
      help: 'Scrape result messages by type and result: applied, stale (already stored) or failed (left on the queue)',
      labelNames: ['type', 'result'],
    });
  }

  onApplicationShutdown(): void {
    for (const name of Object.values(METRICS)) register.removeSingleMetric(name);
  }

  jobSucceeded(job: IngesterJob): void {
    this.jobLastSuccess?.set({ job }, Date.now() / 1000);
  }

  message(type: MessageType, result: 'applied' | 'stale' | 'failed'): void {
    this.messages?.inc({ type, result });
  }
}
