import { createLogger, type CreateLoggerOptions, type Logger, type LogType } from '@osrs-tracker/logger';
import { ClsServiceManager } from 'nestjs-cls';

/** The package's types (`incoming`, `outgoing`, `lifecycle`, `uncaught`) plus `app`, the services' own lines. */
export type ApiLogType = LogType<'app'>;

/**
 * The shared log format (`@osrs-tracker/logger`), with the request's `requestId` (`request-id.ts`) on every line logged
 * while handling one; lines outside a request (startup, shutdown, background work) have none. `info` and up: `debug`
 * and `verbose` stay off. Specs pass their own `destination` to read the lines.
 */
export function createApiLogger(destination?: CreateLoggerOptions['destination']): Logger {
  return createLogger({
    // Typed `string`, but undefined outside a request's context: the field is then left out
    context: () => ({ requestId: ClsServiceManager.getClsService().getId() as string | undefined }),
    destination,
  });
}

/** The process's logger: Nest's and the app's lines (`NestLogger`), the request log and outgoing requests. */
export const logger = createApiLogger();
