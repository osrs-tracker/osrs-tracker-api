import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { metricsMiddleware } from '@osrs-tracker/express-metrics';
import { logOutgoingRequests } from '@osrs-tracker/logger';
import { Request } from 'express';
import { AppMetricsModule } from './app-metrics.module';
import { AppModule } from './app.module';
import { NestLogger } from './common/logger/nest-logger';
import { logger } from './common/logger/logger';
import { routeLabel } from './common/route/route-label';
import { ROUTE_CONFLICT_POLICY } from './config/app-options';
import { corsOptions } from './config/cors';
import { Env } from './config/env';

async function bootstrap() {
  // The hiscores, news feed and image fetches, as `type: 'outgoing'` with the `requestId` of the request that made them
  logOutgoingRequests({ logger });

  // No shutdown hooks here: /healthy keeps answering until the main app has drained and Nest exits the process, so the
  // kubelet's probes don't get `connection refused` (Unhealthy events) while a terminating pod shuts down
  const appMetrics = await NestFactory.create(AppMetricsModule, { logger: new NestLogger(logger) });
  // Created before AppModule: it clears the default registry, which ResilienceEventsListener registers its metrics on
  const metrics = metricsMiddleware({
    metricsApp: appMetrics.getHttpAdapter().getInstance(),
    normalizePath: (req) => routeLabel(req as Request),
  });

  const app = await NestFactory.create(AppModule, {
    logger: new NestLogger(logger),
    routeConflictPolicy: ROUTE_CONFLICT_POLICY,
  });
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  app.enableCors(corsOptions(config.get('CORS_ORIGIN', { infer: true })));
  // Exit with process.exit() once closed: by default Nest re-sends the signal to itself, which the kernel ignores for
  // PID 1 (node in the container), so the pod would hang until the kubelet SIGKILLs it at the grace period
  app.enableShutdownHooks(undefined, { useProcessExit: true });
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  // Traefik is the only hop in front of the API and overwrites any client-sent X-Forwarded-For, so req.ip is the client
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.use(metrics);

  await Promise.all([
    app.listen(config.get('PORT', { infer: true })),
    appMetrics.listen(config.get('METRICS_PORT', { infer: true })),
  ]);
  // Traefik reuses idle backend connections for up to 90s; with Node's 5s default it could send a request on a
  // connection Node is just closing, a 502. Not on the metrics app: the kubelet's probes don't reuse connections.
  app.getHttpServer().keepAliveTimeout = 95_000;
}

void bootstrap();
