import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { CLS_ID, ClsServiceManager } from 'nestjs-cls';
import { NestLogger } from './nest-logger';
import { createApiLogger } from './logger';

describe('NestLogger', () => {
  let written: string[];
  let logger: NestLogger;

  beforeEach(() => {
    written = [];
    logger = new NestLogger(createApiLogger({ write: (line: string) => written.push(line) }));
  });

  /** Everything written, as one parsed object per line. */
  function lines(): Record<string, unknown>[] {
    return written.map((line) => {
      expect(line.endsWith('\n')).toBe(true);
      expect(line.slice(0, -1)).not.toContain('\n');
      return JSON.parse(line) as Record<string, unknown>;
    });
  }

  function line(): Record<string, unknown> {
    const all = lines();
    expect(all).toHaveLength(1);
    return all[0];
  }

  it("writes Nest's startup lines as level info and type lifecycle, never Nest's log", () => {
    logger.log('Nest application successfully started', 'NestApplication');

    expect(line()).toEqual({
      level: 'info',
      time: expect.any(String),
      type: 'lifecycle',
      context: 'NestApplication',
      message: 'Nest application successfully started',
    });
  });

  it("writes the services' lines as type app", () => {
    logger.warn('Hiscores unavailable', 'PlayersService');

    expect(line()).toMatchObject({
      level: 'warn',
      type: 'app',
      message: 'Hiscores unavailable',
      context: 'PlayersService',
    });
  });

  it('writes error(message) as level error', () => {
    logger.error('Something failed');

    expect(line()).toMatchObject({ level: 'error', type: 'app', message: 'Something failed' });
  });

  it("writes Nest's error(message, stack, context) with the stack under error and type uncaught", () => {
    const { stack } = new Error('boom');

    logger.error('Unhandled exception', stack, 'ExceptionsHandler');

    expect(line()).toMatchObject({
      level: 'error',
      type: 'uncaught',
      message: 'Unhandled exception',
      error: stack,
      context: 'ExceptionsHandler',
    });
  });

  it('writes error(message, stack) with the stack under error, not as the context', () => {
    const { stack } = new Error('boom');

    logger.error('Unhandled exception', stack);

    const logged = line();
    expect(logged).toMatchObject({ level: 'error', type: 'app', error: stack });
    expect(logged).not.toHaveProperty('context');
  });

  it("writes a Nest Logger's error(message) with its context and no error", () => {
    Logger.overrideLogger(logger);
    new Logger('PlayersService').error('Something failed');
    Logger.overrideLogger(false);

    const logged = line();
    expect(logged).toMatchObject({ level: 'error', type: 'app', context: 'PlayersService' });
    expect(logged).not.toHaveProperty('error');
  });

  it('writes error(new Error()) with its message and its stack as one string', () => {
    const error = new TypeError('fetch failed');

    logger.error(error);

    expect(line()).toMatchObject({ level: 'error', message: 'fetch failed', error: error.stack });
  });

  it("writes the request's ID inside its context, and none outside", () => {
    const cls = ClsServiceManager.getClsService();

    cls.run(() => {
      cls.set(CLS_ID, 'request-1');
      logger.warn('Hiscores unavailable', 'PlayersService');
    });
    logger.log('Nest application successfully started', 'NestApplication');

    const [inside, outside] = lines();
    expect(inside).toMatchObject({ level: 'warn', requestId: 'request-1' });
    expect(outside).not.toHaveProperty('requestId');
  });

  it('writes nothing for debug and verbose', () => {
    logger.debug('debug', 'PlayersService');
    logger.verbose('verbose', 'PlayersService');

    expect(written).toEqual([]);
  });
});
