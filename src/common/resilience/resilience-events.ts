import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { CircuitState, ResilienceEvent, ResilienceEvents, ResilienceService } from '@nestjs/resilience';
import { Counter, Gauge, register } from 'prom-client';
import { Subscription } from 'rxjs';
import { ThrottledWarning } from '../logger/throttled-warning';

const CIRCUIT_STATE_VALUES: Record<CircuitState, number> = { 'closed': 0, 'half-open': 1, 'open': 2 };

const METRICS = {
  bulkheadActive: 'resilience_bulkhead_active',
  bulkheadQueued: 'resilience_bulkhead_queued',
  circuitState: 'resilience_circuit_state',
  rejections: 'resilience_rejections_total',
} as const;

/**
 * Logs the `@nestjs/resilience` policies' state changes and rejections, and exposes their load and state as Prometheus
 * metrics on the default registry (served by `/metrics` on `METRICS_PORT`).
 */
@Injectable()
export class ResilienceEventsListener implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Resilience');

  /** At most one warning per bulkhead and minute, counting the rejections in between. */
  private readonly rejectionWarning = new ThrottledWarning();

  private subscription?: Subscription;
  private rejections?: Counter<'policy' | 'reason'>;

  constructor(
    private readonly events: ResilienceEvents,
    private readonly resilience: ResilienceService,
  ) {}

  onModuleInit(): void {
    this.registerMetrics();
    this.subscription = this.events.events$.subscribe((event) => this.handle(event));
  }

  onApplicationShutdown(): void {
    this.subscription?.unsubscribe();
    // Unregistered, so an app created again in the same process (tests) can register them anew
    for (const name of Object.values(METRICS)) register.removeSingleMetric(name);
  }

  private handle(event: ResilienceEvent): void {
    switch (event.type) {
      case 'circuit-open':
        return this.warnCircuitOpen(event.policy, event.from);
      case 'circuit-half-open':
        return this.logger.log(`Circuit "${event.policy}" half-open: letting a probe call through`);
      case 'circuit-closed':
        return this.logger.log(`Circuit "${event.policy}" closed`);
      case 'circuit-rejected':
        this.rejections?.inc({ policy: event.policy, reason: 'circuit-open' });
        return;
      case 'bulkhead-rejected':
        this.rejections?.inc({ policy: event.policy, reason: event.reason });
        return this.warnBulkheadRejected(event.policy, event.reason, event.active, event.queued);
    }
  }

  private warnCircuitOpen(name: string, from: CircuitState): void {
    if (from === 'half-open') {
      this.logger.warn(`Circuit "${name}" opened again: the probe call failed`);
      return;
    }
    // The event is emitted synchronously on opening, so the window still holds the calls that opened it
    const { total, failureRate } = this.resilience.circuitBreaker(name).stats;
    this.logger.warn(`Circuit "${name}" opened: ${Math.round(failureRate)}% of the last ${total} calls failed`);
  }

  private warnBulkheadRejected(name: string, reason: string, active: number, queued: number): void {
    const rejections = this.rejectionWarning.hit(name);
    if (rejections === undefined) return;

    this.logger.warn(
      `Bulkhead "${name}" rejected ${rejections} call(s) since the last warning, last: ${reason} ` +
        `(${active} active, ${queued} queued)`,
    );
  }

  private registerMetrics(): void {
    const resilience = this.resilience;

    new Gauge({
      name: METRICS.bulkheadActive,
      help: 'Calls running in a @nestjs/resilience bulkhead',
      labelNames: ['bulkhead'],
      collect() {
        for (const bulkhead of resilience.bulkheads()) this.set({ bulkhead: bulkhead.name }, bulkhead.active);
      },
    });
    new Gauge({
      name: METRICS.bulkheadQueued,
      help: 'Calls waiting for a slot in a @nestjs/resilience bulkhead',
      labelNames: ['bulkhead'],
      collect() {
        for (const bulkhead of resilience.bulkheads()) this.set({ bulkhead: bulkhead.name }, bulkhead.queued);
      },
    });
    new Gauge({
      name: METRICS.circuitState,
      help: 'State of a @nestjs/resilience circuit breaker: 0 closed, 1 half-open, 2 open',
      labelNames: ['circuit'],
      collect() {
        for (const breaker of resilience.circuitBreakers()) {
          this.set({ circuit: breaker.name }, CIRCUIT_STATE_VALUES[breaker.state]);
        }
      },
    });
    this.rejections = new Counter({
      name: METRICS.rejections,
      help: 'Calls a @nestjs/resilience policy refused: reason full or queue-timeout (bulkhead), or circuit-open',
      labelNames: ['policy', 'reason'],
    });
  }
}
