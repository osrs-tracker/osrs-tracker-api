import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

/**
 * Middleware that adds the X-Robots-Tag header with 'noindex' value
 * to prevent search engines from indexing API endpoints
 */
@Injectable()
export class NoIndexMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    // Add the X-Robots-Tag header to tell search engines not to index this content
    res.setHeader('X-Robots-Tag', 'noindex');
    next();
  }
}
