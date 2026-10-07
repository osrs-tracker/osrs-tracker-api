import { Request } from 'express';
import { isbot } from 'isbot';

/** True for crawlers and for requests without a user agent, which shouldn't count as a visitor's lookup. */
export function isBotRequest(request: Request): boolean {
  const userAgent = request.headers['user-agent'];
  return !userAgent || isbot(userAgent);
}
