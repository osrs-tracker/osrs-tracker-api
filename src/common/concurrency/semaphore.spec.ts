import { describe, expect, it } from 'vitest';
import { Semaphore } from './semaphore';

describe('Semaphore', () => {
  it('runs at most `limit` tasks at once, in order, and frees the slot of a task that throws', async () => {
    const semaphore = new Semaphore(2);
    let running = 0;
    let maxRunning = 0;
    const started: number[] = [];

    const tasks = Array.from({ length: 6 }, (_, i) =>
      semaphore.run(async () => {
        started.push(i);
        maxRunning = Math.max(maxRunning, ++running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running--;
        if (i === 0) throw new Error('boom');
        return i;
      }),
    );

    const results = await Promise.allSettled(tasks);

    expect(maxRunning).toBe(2);
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
    expect(results.map((result) => result.status)).toEqual(['rejected', ...Array(5).fill('fulfilled')]);
  });
});
