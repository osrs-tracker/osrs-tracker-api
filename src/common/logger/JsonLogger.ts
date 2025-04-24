import { Injectable, LoggerService } from '@nestjs/common';

@Injectable()
export class JSONLogger implements LoggerService {
  /**
   * Write a 'info' level log.
   */
  log(message: any, ...optionalParams: any[]) {
    this.writeLog('info', message, optionalParams);
  }

  /**
   * Write an 'error' level log.
   */
  error(message: Error, ...optionalParams: any[]) {
    process.stderr.write(message.stack!);
    process.stdout.write('\n');

    this.writeLog('error', `${message.name}: ${message.message}`, optionalParams);
  }

  /**
   * Write a 'warn' level log.
   */
  warn(message: any, ...optionalParams: any[]) {
    this.writeLog('warn', message, optionalParams);
  }

  private writeLog(level: 'info' | 'error' | 'warn', message: any, _optionalParams: any[]): void {
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
