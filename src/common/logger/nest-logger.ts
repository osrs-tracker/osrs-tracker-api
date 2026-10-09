import { ConsoleLogger, LogLevel } from '@nestjs/common';
import { type Logger } from '@osrs-tracker/logger';
import { ApiLogType } from './logger';

/** Contexts whose lines are about startup and shutdown: Nest's own, and the Mongo connect and close. */
const LIFECYCLE_CONTEXTS = new Set([
  'NestFactory',
  'InstanceLoader',
  'RoutesResolver',
  'RouterExplorer',
  'NestApplication',
  'NestApplicationContext',
  'MongoProvider',
  'MongoModule',
]);

/** Nest's levels as pino names them (`debug` and `verbose` are off, see the constructor). */
const LEVELS = { log: 'info', warn: 'warn', error: 'error', fatal: 'fatal', debug: 'debug', verbose: 'trace' } as const;

type NestLogType = Extract<ApiLogType, 'lifecycle' | 'uncaught' | 'app'>;

/**
 * Nest's and the app's lines (`new Logger(...)`) in the shared log format (`logger.ts`). Nest's `ConsoleLogger` still
 * splits the arguments into message, context and stack and filters the levels; only the printing is replaced. `log` is
 * written as `info`, the logger's context (the class name) as `context`, an error's stack under `error` as one string,
 * and `type` comes from the context: `lifecycle` for startup and shutdown, `uncaught` for Nest's `ExceptionsHandler`,
 * else `app`.
 */
export class NestLogger extends ConsoleLogger {
  private readonly children: Record<NestLogType, Logger>;

  constructor(logger: Logger) {
    super({ logLevels: ['log', 'warn', 'error', 'fatal'] });
    this.children = {
      lifecycle: logger.child({ type: 'lifecycle' }),
      uncaught: logger.child({ type: 'uncaught' }),
      app: logger.child({ type: 'app' }),
    };
  }

  protected override printMessages(
    messages: unknown[],
    context?: string,
    logLevel: LogLevel = 'log',
    _writeStreamType?: 'stdout' | 'stderr',
    errorStack?: unknown,
  ) {
    const line = this.children[logType(context)];
    for (const message of messages) {
      const error = message instanceof Error ? message : errorStack;
      const text = message instanceof Error ? message.message : String(message);
      line[LEVELS[logLevel]]({ context: context || undefined, error }, text);
    }
  }
}

function logType(context: string | undefined): NestLogType {
  if (context === 'ExceptionsHandler') return 'uncaught';
  return context && LIFECYCLE_CONTEXTS.has(context) ? 'lifecycle' : 'app';
}
