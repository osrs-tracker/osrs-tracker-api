import { ConsoleLogger, LogLevel } from '@nestjs/common';
import { type Logger } from '@osrs-tracker/logger';
import { inspect } from 'node:util';
import { ApiLogType } from './logger';

/** The context of the Mongo connect and close lines (`mongo.provider.ts`, `mongo.module.ts`), tagged `lifecycle`. */
export const MONGO_LOG_CONTEXT = 'MongoDB';

/** Contexts whose lines are about startup and shutdown: Nest's own, and the Mongo connect and close. */
const LIFECYCLE_CONTEXTS = new Set([
  'NestFactory',
  'InstanceLoader',
  'RoutesResolver',
  'RouterExplorer',
  'NestApplication',
  'NestApplicationContext',
  MONGO_LOG_CONTEXT,
]);

/** Nest's levels as pino names them (`debug` and `verbose` are off, see the constructor). */
const LEVELS = { log: 'info', warn: 'warn', error: 'error', fatal: 'fatal', debug: 'debug', verbose: 'trace' } as const;

type NestLogType = Extract<ApiLogType, 'lifecycle' | 'uncaught' | 'app'>;

/**
 * Nest's and the app's lines (`new Logger(...)`) in the shared log format (`logger.ts`). Nest's `ConsoleLogger` still
 * splits the arguments into message, context, stack and structured params (plain objects after the message) and
 * filters the levels; only the printing is replaced. `log` is written as `info`, the logger's context (the class name)
 * as `context`, the params as fields, an error's stack under `error` as one string, and `type` comes from the context:
 * `lifecycle` for startup and shutdown, `uncaught` for Nest's `ExceptionsHandler`, else `app`.
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
    params?: Record<string, unknown>,
  ) {
    const line = this.children[logType(context)];
    messages.forEach((message, index) => {
      // The stack belongs to the first line only, as in Nest's own JSON output
      const error = message instanceof Error ? message : index === 0 ? errorStack : undefined;
      line[LEVELS[logLevel]]({ ...fields(params), context: context || undefined, error }, messageText(message));
    });
  }

  protected override printStackTrace() {
    // Off: outside JSON mode Nest writes the stack to stderr as plain lines; it's already in the line's `error`
  }
}

/** Fields the format sets, which params can't overwrite (a `level` param would become the line's level in Loki). */
const RESERVED = new Set(['level', 'time', 'type', 'message', 'requestId']);

function fields(params: Record<string, unknown> | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params ?? {}).filter(([key]) => !RESERVED.has(key)));
}

function messageText(message: unknown): string {
  if (typeof message === 'string') return message;
  if (message instanceof Error) return message.message;
  // One line, readable for objects (`String` would give `[object Object]`)
  return inspect(message, { breakLength: Infinity, depth: 4 });
}

function logType(context: string | undefined): NestLogType {
  if (context === 'ExceptionsHandler') return 'uncaught';
  return context && LIFECYCLE_CONTEXTS.has(context) ? 'lifecycle' : 'app';
}
