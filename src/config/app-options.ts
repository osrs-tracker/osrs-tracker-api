import { RouteConflictPolicy } from '@nestjs/common';

/**
 * Fail startup on a route that duplicates or shadows another (e.g. `/items/recent` declared after `/items/:id`): Express
 * matches in declaration order, so the later one would silently never answer. Used by `main.ts` and the e2e spec.
 */
export const ROUTE_CONFLICT_POLICY: RouteConflictPolicy = { duplicate: 'error', shadow: 'error' };
