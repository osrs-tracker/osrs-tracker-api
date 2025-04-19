import { Injectable, LoggerService } from '@nestjs/common';

@Injectable()
export class JSONLogger implements LoggerService {
  /**
   * Write a 'log' level log.
   */
  log(message: any, ...optionalParams: any[]) {
    this.writeLog('log', message, optionalParams);
  }

  /**
   * Write an 'error' level log.
   */
  error(message: any, ...optionalParams: any[]) {
    this.writeLog('error', message, optionalParams);
  }

  /**
   * Write a 'warn' level log.
   */
  warn(message: any, ...optionalParams: any[]) {
    this.writeLog('warn', message, optionalParams);
  }

  private writeLog(level: 'log' | 'error' | 'warn', message: any, _optionalParams: any[]): void {
    console.log(
      JSON.stringify({
        level,
        time: new Date().toISOString(),
        message,
        context: _optionalParams,
      }),
    );
  }
}
