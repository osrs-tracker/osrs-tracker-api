import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThrottledWarning } from './throttled-warning';

describe('ThrottledWarning', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lets the first hit through, then one per interval with the count since the last', () => {
    const warning = new ThrottledWarning(60_000);

    expect(warning.hit()).toBe(1);
    expect(warning.hit()).toBeUndefined();
    expect(warning.hit()).toBeUndefined();

    vi.advanceTimersByTime(60_000);
    expect(warning.hit()).toBe(3);
    expect(warning.hit()).toBeUndefined();
  });

  it('throttles each key on its own', () => {
    const warning = new ThrottledWarning(60_000);

    expect(warning.hit('a')).toBe(1);
    expect(warning.hit('b')).toBe(1);
    expect(warning.hit('a')).toBeUndefined();
  });
});
