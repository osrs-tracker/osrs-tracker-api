import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import morgan from 'morgan';
import { routeLabel } from '../common/route/route-label';

@Injectable()
export class LoggerMiddleware implements NestMiddleware {
  private startTimes = new WeakMap<object, bigint>();

  private morganMiddleware = morgan((tokens, req, res) => {
    // The client disconnected before headers were sent: there's no status, and nothing failed on our side. Log it as a
    // warning (many aborts on one route mean it's slow), timed until the connection closed. Morgan's `response-time`
    // and `total-time` tokens both need the headers to have been sent, so time it here.
    const aborted = !res.headersSent;
    const startTime = this.startTimes.get(req);
    const status = Number(tokens['status'](req, res));

    return JSON.stringify({
      level: aborted ? 'warn' : status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
      time: tokens['date'](req, res, 'iso'),
      status: tokens['status'](req, res),
      aborted: aborted || undefined,
      method: tokens['method'](req, res),
      host: tokens['req'](req, res, 'host'),
      route: routeLabel(req as Request),
      url: tokens['url'](req, res),
      responseTime:
        (aborted && startTime !== undefined
          ? (Number(process.hrtime.bigint() - startTime) / 1e6).toFixed(3)
          : tokens['response-time'](req, res)) + 'ms',
      userAgent: tokens['user-agent'](req, res),
      clientIp: tokens['remote-addr'](req, res),
      referer: tokens['referrer'](req, res),
      contentLength: tokens['res'](req, res, 'content-length'),
    });
  });

  use(req: Request, res: Response, next: NextFunction) {
    this.startTimes.set(req, process.hrtime.bigint());
    this.morganMiddleware(req, res, next);
  }
}
