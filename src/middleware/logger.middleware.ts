import { requestLogger } from '@osrs-tracker/logger';
import { logger } from '../common/logger/logger';
import { routeLabel } from '../common/route/route-label';

/**
 * The request log (`type: 'incoming'`), one line per request once it has finished: 5xx `error`, 4xx `warn`, else
 * `info`, and a client that disconnected before the response a `warn` with `aborted: true` and no `status`. It reads the
 * `requestId` when the request starts, so the CLS middleware (`request-id.ts`) must run first: it does, because
 * `ClsModule` is global and Nest applies global modules' middleware first.
 */
export const requestLog = requestLogger({ logger, route: (req) => routeLabel(req) });
