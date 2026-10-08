import { Injectable, LoggerService } from '@nestjs/common';

@Injectable()
export class JSONLogger implements LoggerService {
  /**
   * Write a 'info' level log.
   */
  log(message: unknown, ...optionalParams: unknown[]) {
    this.writeLog('info', message, optionalParams);
  }

  /**
   * Write an 'error' level log. Accepts an `Error`, or Nest's `(message, stack?, context?)`: Nest's `Logger` always
   * passes a stack slot (possibly `undefined`) before the context, and a lone param is only a stack if it looks like one.
   */
  error(message: unknown, ...optionalParams: unknown[]) {
    const [first, ...rest] = optionalParams;
    const hasStackSlot = optionalParams.length >= 2 || this.isStack(first);
    const context = hasStackSlot ? rest : optionalParams;

    if (message instanceof Error) {
      this.writeLog('error', `${message.name}: ${message.message}`, context, message.stack);
    } else {
      this.writeLog('error', String(message), context, hasStackSlot && typeof first === 'string' ? first : undefined);
    }
  }

  /**
   * Write a 'warn' level log.
   */
  warn(message: unknown, ...optionalParams: unknown[]) {
    this.writeLog('warn', message, optionalParams);
  }

  private isStack(value: unknown): value is string {
    return typeof value === 'string' && /^(.)+\n\s+at .+:\d+:\d+/.test(value);
  }

  private writeLog(
    level: 'info' | 'error' | 'warn',
    message: unknown,
    optionalParams: unknown[],
    stack?: string,
  ): void {
    console.log(
      JSON.stringify({
        level,
        time: new Date().toISOString(),
        message,
        context: optionalParams,
        stack,
      }),
    );
  }
}
