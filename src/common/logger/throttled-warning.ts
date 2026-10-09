/**
 * Counts occurrences per key and lets one warning through per key and interval, so a flood of events can't flood the
 * logs too. `hit` returns how many occurred since the last warning when one is due, else `undefined`.
 */
export class ThrottledWarning {
  private readonly counts = new Map<string, number>();
  private readonly lastWarnings = new Map<string, number>();

  constructor(private readonly intervalMs = 60_000) {}

  hit(key = ''): number | undefined {
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);

    const now = Date.now();
    if (now - (this.lastWarnings.get(key) ?? -Infinity) < this.intervalMs) return undefined;

    this.counts.set(key, 0);
    this.lastWarnings.set(key, now);
    return count;
  }
}
