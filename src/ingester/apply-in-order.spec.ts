import { describe, expect, it } from 'vitest';
import { applyInOrder } from './apply-in-order';

/** Records the calls in order; `fail` names the steps that reject. */
function recorder(fail: string[] = []) {
  const calls: string[] = [];
  const step = (name: string) => async (message: string) => {
    calls.push(`${name} ${message}`);
    if (fail.includes(`${name} ${message}`)) throw new Error(`${name} ${message} failed`);
  };
  return { calls, apply: step('apply'), remove: step('delete') };
}

describe('applyInOrder', () => {
  it('applies the messages in receive order, deleting each right after its write', async () => {
    const { calls, apply, remove } = recorder();

    await expect(applyInOrder(['a', 'b', 'c'], apply, remove)).resolves.toEqual({ done: 3 });
    expect(calls).toEqual(['apply a', 'delete a', 'apply b', 'delete b', 'apply c', 'delete c']);
  });

  it('stops at the first message that fails, leaving it and the rest undeleted', async () => {
    const { calls, apply, remove } = recorder(['apply b']);

    const outcome = await applyInOrder(['a', 'b', 'c'], apply, remove);

    expect(outcome).toEqual({ done: 1, failed: { message: 'b', error: new Error('apply b failed') } });
    expect(calls).toEqual(['apply a', 'delete a', 'apply b']);
  });

  it('stops when a delete fails too', async () => {
    const { calls, apply, remove } = recorder(['delete a']);

    await expect(applyInOrder(['a', 'b'], apply, remove)).resolves.toMatchObject({ done: 0, failed: { message: 'a' } });
    expect(calls).toEqual(['apply a', 'delete a']);
  });

  it("doesn't start the next message before the previous one is deleted", async () => {
    const calls: string[] = [];
    let deleteA!: () => void;
    const remove = (message: string) =>
      new Promise<void>((resolve) => {
        calls.push(`delete ${message}`);
        if (message === 'a') deleteA = resolve;
        else resolve();
      });

    const applying = applyInOrder(['a', 'b'], async (message) => void calls.push(`apply ${message}`), remove);
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual(['apply a', 'delete a']);

    deleteA();
    await applying;
    expect(calls).toEqual(['apply a', 'delete a', 'apply b', 'delete b']);
  });
});
