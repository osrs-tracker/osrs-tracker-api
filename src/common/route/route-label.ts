import { Request } from 'express';

/**
 * The route template a request matched (e.g. `/players/:username`), or `#unmatched`. Used as the Prometheus `path`
 * label, so every player name or scanner URL doesn't become its own time series, and as the `route` field in the
 * request logs, which also have the full `url`.
 */
export function routeLabel(req: Request): string {
  const routePath: unknown = req.route?.path;
  return typeof routePath === 'string' ? req.baseUrl + routePath : '#unmatched';
}
