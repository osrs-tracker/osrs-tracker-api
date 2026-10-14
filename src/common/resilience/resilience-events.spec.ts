import { Logger } from '@nestjs/common';
import { ResilienceEvent, ResilienceEvents, ResilienceService } from '@nestjs/resilience';
import { register } from '@osrs-tracker/express-metrics';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, MockInstance, vi } from 'vitest';
import { ResilienceEventsListener } from './resilience-events';

/**
 * Hiscore and image refusals aren't logged per call: this listener's throttled bulkhead warning and circuit lines are
 * the only log record of a Jagex outage, and its metrics the only count.
 */
describe('ResilienceEventsListener', () => {
  let events$: Subject<ResilienceEvent>;
  let listener: ResilienceEventsListener;
  let warn: MockInstance<Logger['warn']>;

  const resilience = {
    circuitBreaker: () => ({ stats: { total: 20, failureRate: 55 } }),
    circuitBreakers: () => [{ name: 'jagex-hiscores', state: 'open' }],
    bulkheads: () => [{ name: 'news-images', active: 2, queued: 3 }],
  };

  const bulkheadRejected = (policy = 'jagex-hiscores'): ResilienceEvent => ({
    type: 'bulkhead-rejected',
    policy,
    reason: 'full',
    active: 8,
    queued: 32,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    events$ = new Subject();
    listener = new ResilienceEventsListener(
      { events$ } as unknown as ResilienceEvents,
      resilience as unknown as ResilienceService,
    );
    listener.onModuleInit();
  });

  afterEach(() => {
    listener.onApplicationShutdown();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('warns once a minute per bulkhead about a burst of rejections, with the count since the last warning', () => {
    for (let i = 0; i < 5; i++) events$.next(bulkheadRejected());
    events$.next(bulkheadRejected('news-images'));

    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      'Bulkhead "jagex-hiscores" rejected 1 call(s) since the last warning, last: full (8 active, 32 queued)',
      'Bulkhead "news-images" rejected 1 call(s) since the last warning, last: full (8 active, 32 queued)',
    ]);

    vi.advanceTimersByTime(60_000);
    events$.next(bulkheadRejected());

    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenLastCalledWith(
      'Bulkhead "jagex-hiscores" rejected 5 call(s) since the last warning, last: full (8 active, 32 queued)',
    );
  });

  it('warns when a circuit opens, with the failure rate that opened it, and when a probe fails', () => {
    events$.next({ type: 'circuit-open', policy: 'jagex-hiscores', from: 'closed', to: 'open' });
    events$.next({ type: 'circuit-open', policy: 'jagex-hiscores', from: 'half-open', to: 'open' });

    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      'Circuit "jagex-hiscores" opened: 55% of the last 20 calls failed',
      'Circuit "jagex-hiscores" opened again: the probe call failed',
    ]);
  });

  it('counts rejections by policy and reason, without a warning per circuit rejection', async () => {
    events$.next(bulkheadRejected());
    events$.next(bulkheadRejected());
    events$.next({ type: 'bulkhead-rejected', policy: 'news-images', reason: 'queue-timeout', active: 2, queued: 0 });
    events$.next({ type: 'circuit-rejected', policy: 'jagex-hiscores', retryAfterMs: 30_000 });

    const { values } = await register.getSingleMetric('resilience_rejections_total')!.get();
    expect(values.map(({ labels, value }) => ({ ...labels, value }))).toEqual([
      { policy: 'jagex-hiscores', reason: 'full', value: 2 },
      { policy: 'news-images', reason: 'queue-timeout', value: 1 },
      { policy: 'jagex-hiscores', reason: 'circuit-open', value: 1 },
    ]);
    expect(warn).toHaveBeenCalledTimes(2); // The two bulkheads' first rejections only
  });

  it('serves the bulkheads and circuits as gauges', async () => {
    const metrics = await register.metrics();

    expect(metrics).toContain('resilience_bulkhead_active{bulkhead="news-images"} 2');
    expect(metrics).toContain('resilience_bulkhead_queued{bulkhead="news-images"} 3');
    expect(metrics).toContain('resilience_circuit_state{circuit="jagex-hiscores"} 2');
  });

  it('removes its metrics and stops listening on shutdown', () => {
    listener.onApplicationShutdown();
    events$.next(bulkheadRejected());

    expect(register.getSingleMetric('resilience_rejections_total')).toBeUndefined();
    expect(register.getSingleMetric('resilience_bulkhead_active')).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
