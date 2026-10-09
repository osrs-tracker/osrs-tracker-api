import { Response } from 'express';
import { ClsModuleOptions } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';

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
    // Always a new one: nothing upstream sends an ID (Traefik sets none, the web's SSR forwards none), and a client's
    // own would let it give unrelated requests the same `requestId`
    idGenerator: () => randomUUID(),
    setup: (cls, _req, res: Response) => {
      res.setHeader('X-Request-Id', cls.getId());
    },
  },
};
