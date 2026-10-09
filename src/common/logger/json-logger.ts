import { ConsoleLogger } from '@nestjs/common';

/**
 * Nest's JSON logger with Loki's level names: one JSON object per line, with `level` `info` (Nest's `log`), `warn` or
 * `error`. Loki keeps a level it doesn't know as is, so `log` would get its own `detected_level` instead of `info`.
 * `debug` and `verbose` are off (Nest always keeps `fatal` on, which Loki knows).
 */
export class JsonLogger extends ConsoleLogger {
  constructor() {
    super({ json: true, logLevels: ['log', 'warn', 'error'] });
  }

  protected override stringifyJsonLogObject(logObject: Record<string, unknown>): string {
    return super.stringifyJsonLogObject(logObject.level === 'log' ? { ...logObject, level: 'info' } : logObject);
  }
}
