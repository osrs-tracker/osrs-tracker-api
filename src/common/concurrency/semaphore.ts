/** Runs at most `limit` tasks at once; the others wait their turn, first come first served. */
export class Semaphore {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running < this.limit) this.running++;
    else await new Promise<void>((resolve) => this.waiting.push(resolve)); // Takes over the slot of the task it waited on

    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }
}
