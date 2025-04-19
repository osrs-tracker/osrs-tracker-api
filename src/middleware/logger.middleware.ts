import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import * as morgan from 'morgan';

@Injectable()
export class LoggerMiddleware implements NestMiddleware {
  private morganMiddleware = morgan((tokens, req, res) =>
    JSON.stringify({
      level: Number(tokens['status'](req, res) ?? 500) >= 500 ? 'error' : 'log',
      time: tokens['date'](req, res, 'iso'),
      status: tokens['status'](req, res),
      method: tokens['method'](req, res),
      host: tokens['req'](req, res, 'host'),
      url: tokens['url'](req, res),
      responseTime: tokens['response-time'](req, res) + 'ms',
      userAgent: tokens['user-agent'](req, res),
    }),
  );

  use(req: Request, res: Response, next: NextFunction) {
    this.morganMiddleware(req, res, next);
  }
}
