import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Request } from 'express';
import promBundle from 'express-prom-bundle';
import { AppMetricsModule } from './app-metrics.module';
import { AppModule } from './app.module';
import { JsonLogger } from './common/logger/json-logger';
import { routeLabel } from './common/route/route-label';
import { ROUTE_CONFLICT_POLICY } from './config/app-options';
import { corsOptions } from './config/cors';
import { Env } from './config/env';

async function bootstrap() {
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

  // No shutdown hooks here: /healthy keeps answering until the main app has drained and Nest exits the process, so the
  // kubelet's probes don't get `connection refused` (Unhealthy events) while a terminating pod shuts down
  const appMetrics = await NestFactory.create(AppMetricsModule);

  app.use(
    promBundle({
      includeMethod: true,
      includePath: true,
      normalizePath: (req) => routeLabel(req as Request),
      includeStatusCode: true,
      metricsApp: appMetrics.getHttpAdapter().getInstance(),
      autoregister: false,
    }),
  );

  await Promise.all([
    app.listen(config.get('PORT', { infer: true })),
    appMetrics.listen(config.get('METRICS_PORT', { infer: true })),
  ]);
}

void bootstrap();
