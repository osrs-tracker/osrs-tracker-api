/** How `applyInOrder` ended: how many messages it applied and deleted, and the one that failed, if any. */
export interface BatchOutcome<T> {
  done: number;
  failed?: { message: T; error: unknown };
}

/**
 * Applies a batch's messages one at a time, in receive order, deleting each right after its write, and stops at the
 * first that fails (its apply or its delete). That one and the rest stay unacknowledged: their visibility timeout runs
 * out and they come back in order, each receive counting towards the dead-letter limit. Never in parallel and never
 * past a failure: a later entry stored first makes the slot guard drop the earlier one for good.
 */
export async function applyInOrder<T>(
  messages: readonly T[],
  apply: (message: T) => Promise<void>,
  remove: (message: T) => Promise<void>,
): Promise<BatchOutcome<T>> {
  let done = 0;
  for (const message of messages) {
    try {
      await apply(message);
      await remove(message);
    } catch (error) {
      return { done, failed: { message, error } };
    }
    done++;
  }
  return { done };
}
