import { afterEach, beforeEach, describe, expect, it, MockInstance, vi } from 'vitest';
import { JsonLogger } from './json-logger';

describe('JsonLogger', () => {
  let stdout: MockInstance<typeof process.stdout.write>;
  let stderr: MockInstance<typeof process.stderr.write>;
  const logger = new JsonLogger();

  beforeEach(() => {
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Everything written to stdout and stderr, as one parsed object per line (Loki reads both streams). */
  function lines(): Record<string, unknown>[] {
    const written = [...stdout.mock.calls, ...stderr.mock.calls].map(([chunk]) => String(chunk)).join('');
    expect(written.endsWith('\n')).toBe(true);
    return written
      .slice(0, -1)
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  function line(): Record<string, unknown> {
    const all = lines();
    expect(all).toHaveLength(1);
    return all[0];
  }

  it("writes log as level info, never Nest's log", () => {
    logger.log('Nest application successfully started', 'NestApplication');

    expect(line()).toMatchObject({
      level: 'info',
      message: 'Nest application successfully started',
      context: 'NestApplication',
    });
  });

  it('writes warn as level warn', () => {
    logger.warn('Hiscores unavailable', 'PlayersService');

    expect(line()).toMatchObject({ level: 'warn', message: 'Hiscores unavailable', context: 'PlayersService' });
  });

  it('writes error(message) as level error', () => {
    logger.error('Something failed');

    expect(line()).toMatchObject({ level: 'error', message: 'Something failed' });
  });

  it("writes Nest's error(message, stack, context) with the stack and the context", () => {
    const { stack } = new Error('boom');

    logger.error('Unhandled exception', stack, 'ExceptionsHandler');

    expect(line()).toEqual(
      expect.objectContaining({ level: 'error', message: 'Unhandled exception', stack, context: 'ExceptionsHandler' }),
    );
  });

  it('writes error(new Error()) with the error and its stack as a structured field', () => {
    const error = new TypeError('fetch failed');

    logger.error(error);

    expect(line()).toMatchObject({
      level: 'error',
      message: 'fetch failed',
      error: { name: 'TypeError', message: 'fetch failed', stack: error.stack },
    });
  });

  it('writes nothing for debug and verbose', () => {
    logger.debug('debug');
    logger.verbose('verbose');

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });
});
