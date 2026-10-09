import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { metricsMiddleware } from '@osrs-tracker/express-metrics';
import { Request } from 'express';
import { AppMetricsModule } from './app-metrics.module';
import { AppModule } from './app.module';
import { JsonLogger } from './common/logger/json-logger';
import { routeLabel } from './common/route/route-label';
import { ROUTE_CONFLICT_POLICY } from './config/app-options';
import { corsOptions } from './config/cors';
import { Env } from './config/env';

async function bootstrap() {
  // No shutdown hooks here: /healthy keeps answering until the main app has drained and Nest exits the process, so the
  // kubelet's probes don't get `connection refused` (Unhealthy events) while a terminating pod shuts down
  const appMetrics = await NestFactory.create(AppMetricsModule, { logger: new JsonLogger() });
  // Created before AppModule: it clears the default registry, which ResilienceEventsListener registers its metrics on
  const metrics = metricsMiddleware({
    metricsApp: appMetrics.getHttpAdapter().getInstance(),
    normalizePath: (req) => routeLabel(req as Request),
  });

  const app = await NestFactory.create(AppModule, {
    logger: new JsonLogger(),
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
}

void bootstrap();
