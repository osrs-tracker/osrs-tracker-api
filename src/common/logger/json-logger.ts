import { ConsoleLogger } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';

/**
 * Nest's JSON logger with Loki's level names: one JSON object per line, with `level` `info` (Nest's `log`), `warn` or
 * `error`. Loki keeps a level it doesn't know as is, so `log` would get its own `detected_level` instead of `info`.
 * `debug` and `verbose` are off (Nest always keeps `fatal` on, which Loki knows). A line logged while handling a request
 * carries its `requestId` (`request-id.ts`); other lines (startup, shutdown, background work) have none.
 */
export class JsonLogger extends ConsoleLogger {
  constructor() {
    super({ json: true, logLevels: ['log', 'warn', 'error'] });
  }

  protected override stringifyJsonLogObject(logObject: Record<string, unknown>): string {
    // Typed `string`, but undefined outside a request's context: JSON.stringify then leaves the field out
    const requestId = ClsServiceManager.getClsService().getId() as string | undefined;
    const level = logObject.level === 'log' ? 'info' : logObject.level;
    return super.stringifyJsonLogObject({ ...logObject, level, requestId });
  }
}
