import { Db, MongoClient } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';
import { IngesterMetrics } from './ingester-metrics';
import { JobRunsService } from './job-runs.service';

const MINUTE = 60_000;

/** A service on a fake `jobRuns` holding `lastSuccess`, with the metric and the stored success recorded. */
function setup(lastSuccess?: Date) {
  const runs = {
    findOne: vi.fn(async () => (lastSuccess ? { _id: 'subscriptions', lastSuccess } : null)),
    updateOne: vi.fn(async () => ({})),
  };
  const client = { connect: vi.fn(async () => undefined) } as unknown as MongoClient;
  const db = { collection: () => runs } as unknown as Db;
  const metrics = { jobSucceeded: vi.fn() } as unknown as IngesterMetrics;
  return { service: new JobRunsService(client, db, metrics), runs, metrics };
}

describe('JobRunsService', () => {
  it('stores and reports a success, and nothing for a failed run', async () => {
    const { service, runs, metrics } = setup();
    await service.run('subscriptions', async () => undefined);
    expect(runs.updateOne).toHaveBeenCalledWith(
      { _id: 'subscriptions' },
      { $set: { lastSuccess: expect.any(Date) } },
      { upsert: true },
    );
    expect(metrics.jobSucceeded).toHaveBeenCalledOnce();

    await expect(service.run('subscriptions', () => Promise.reject(new Error('down')))).resolves.toBeUndefined();
    expect(runs.updateOne).toHaveBeenCalledOnce();
  });

  it('joins the run in progress instead of starting a second', async () => {
    const { service } = setup();
    let finish!: () => void;
    const task = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const first = service.run('subscriptions', task);
    const second = service.run('subscriptions', task);
    await vi.waitFor(() => expect(task).toHaveBeenCalled());
    finish();
    await Promise.all([first, second]);
    expect(task).toHaveBeenCalledOnce();
  });

  it('catches up on boot when the last success is over the interval ago or missing', async () => {
    for (const lastSuccess of [new Date(Date.now() - 16 * MINUTE), undefined]) {
      const task = vi.fn(async () => undefined);
      await setup(lastSuccess).service.catchUp('subscriptions', 15 * MINUTE, task);
      expect(task).toHaveBeenCalledOnce();
    }
  });

  it('leaves a recent run to the schedule, reporting its stored success', async () => {
    const lastSuccess = new Date(Date.now() - 5 * MINUTE);
    const { service, metrics } = setup(lastSuccess);
    const task = vi.fn(async () => undefined);
    await service.catchUp('subscriptions', 15 * MINUTE, task);
    expect(task).not.toHaveBeenCalled();
    expect(metrics.jobSucceeded).toHaveBeenCalledWith('subscriptions', lastSuccess);
  });

  it('aborts a running task on shutdown and waits for it, without storing a success', async () => {
    const { service, runs } = setup();
    const task = vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
    );
    const run = service.run('subscriptions', task);
    await vi.waitFor(() => expect(task).toHaveBeenCalled());
    await service.beforeApplicationShutdown();
    await run;
    expect(runs.updateOne).not.toHaveBeenCalled();
  });
});
