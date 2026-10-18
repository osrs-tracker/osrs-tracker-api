import { RouteConflictPolicy, SecurityHeadersOptions } from '@nestjs/common';

/**
 * Fail startup on a route that duplicates or shadows another (e.g. `/items/recent` declared after `/items/:id`): Express
 * matches in declaration order, so the later one would silently never answer. Used by `main.ts` and the e2e spec.
 */
export const ROUTE_CONFLICT_POLICY: RouteConflictPolicy = { duplicate: 'error', shadow: 'error' };

/**
 * Nest's helmet-style defaults (`nosniff`, HSTS, a CSP, ...), except `Cross-Origin-Resource-Policy`: its default
 * `same-origin` would stop the web app, on another origin, from showing `/news/image` images. Used by `main.ts` and the
 * e2e spec.
 */
export const SECURITY_HEADERS: SecurityHeadersOptions = { crossOriginResourcePolicy: { policy: 'cross-origin' } };
