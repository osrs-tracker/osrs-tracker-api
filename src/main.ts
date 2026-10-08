import { NestFactory } from '@nestjs/core';
import { Request } from 'express';
import { SwaggerModule } from '@nestjs/swagger';
import promBundle from 'express-prom-bundle';
import { AppMetricsModule } from './app-metrics.module';
import { AppModule } from './app.module';
import { JSONLogger } from './common/logger/JsonLogger';
import { routeLabel } from './common/route/route-label';
import { CORS_CONFIG } from './config/cors';
import { SWAGGER_CONFIG } from './config/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: CORS_CONFIG, logger: new JSONLogger() });
  app.enableShutdownHooks();
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

  if (process.env.NODE_ENV !== 'production') {
    SwaggerModule.setup('swagger', app, () => SwaggerModule.createDocument(app, SWAGGER_CONFIG));
  }

  await Promise.all([app.listen(process.env.PORT || 3000), appMetrics.listen(process.env.METRICS_PORT || 9090)]);
}

void bootstrap();
