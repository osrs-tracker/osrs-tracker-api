import { Request, Response } from 'express';
import { ClsModuleOptions } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A request context (`AsyncLocalStorage`) per request, holding its ID: the request log line and every app line logged
 * while handling it carry it as `requestId`, and the response sends it back as `X-Request-Id`. The module is global, so
 * Nest applies its middleware before `AppModule`'s `LoggerMiddleware`, which reads the ID when the request starts.
 */
export const CLS_OPTIONS: ClsModuleOptions = {
  global: true,
  middleware: {
    mount: true,
    generateId: true,
    idGenerator: requestId,
    setup: (cls, _req, res: Response) => {
      res.setHeader('X-Request-Id', cls.getId());
    },
  },
};

/** An incoming `X-Request-Id` only when it's a UUID (clients send what they like; Traefik sets none), else a new one. */
export function requestId(req: Request): string {
  const incoming = req.get('x-request-id');
  return incoming && UUID.test(incoming) ? incoming : randomUUID();
}
