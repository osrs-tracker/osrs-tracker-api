import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import * as promBundle from 'express-prom-bundle';
import { AppMetricsModule } from './app-metrics.module';
import { AppModule } from './app.module';
import { JSONLogger } from './common/logger/JsonLogger';
import { CORS_CONFIG } from './config/cors';
import { SWAGGER_CONFIG } from './config/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: CORS_CONFIG, logger: new JSONLogger() });
  app.enableShutdownHooks();
  app.getHttpAdapter().getInstance().disable('x-powered-by');

  const appMetrics = await NestFactory.create(AppMetricsModule);
  appMetrics.enableShutdownHooks();

  app.use(
    promBundle({
      includeMethod: true,
      includePath: true,
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
