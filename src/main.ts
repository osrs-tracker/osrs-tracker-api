import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import promBundle from 'express-prom-bundle';
import UrlValueParser from 'url-value-parser';
import { AppMetricsModule } from './app-metrics.module';
import { AppModule } from './app.module';
import { JSONLogger } from './common/logger/JsonLogger';
import { CORS_CONFIG } from './config/cors';
import { SWAGGER_CONFIG } from './config/swagger';

const urlValueParser = new UrlValueParser();

/**
 * Same path label as promBundle's default normalizePath, but parsed with the WHATWG URL API.
 * The default uses `url.parse()`, which logs a DEP0169 deprecation warning on Node 24.
 */
const normalizePath: promBundle.NormalizePathFn = (req) => {
  // Prefixed instead of passed as a base, so a path like `//foo` isn't read as a host
  const { pathname } = new URL(`http://localhost${req.originalUrl || req.url}`);
  return urlValueParser.replacePathValues(pathname, '#val');
};

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: CORS_CONFIG, logger: new JSONLogger() });
  app.enableShutdownHooks();
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  // Traefik is the only hop in front of the API and overwrites any client-sent X-Forwarded-For, so req.ip is the client
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  const appMetrics = await NestFactory.create(AppMetricsModule);
  appMetrics.enableShutdownHooks();

  app.use(
    promBundle({
      includeMethod: true,
      includePath: true,
      normalizePath,
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
