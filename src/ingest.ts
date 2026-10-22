import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { metricsMiddleware } from '@osrs-tracker/express-metrics';
import { NestLogger } from './common/logger/nest-logger';
import { logger } from './common/logger/logger';
import { IngesterEnv } from './config/env';
import { IngesterModule } from './ingester/ingester.module';

/**
 * The ingester (`node ingest`, the Deployment `osrs-tracker-ingester`): applies the scraping Lambdas' results from SQS to
 * MongoDB (`IngesterService`), and runs the scheduled jobs (`JobRunsService`). Same image as the API, without its HTTP
 * server: it listens only on `METRICS_PORT`.
 *
 * No `logOutgoingRequests`: it logs every `fetch` URL in full, and the Discord webhook's holds the webhook's token. The
 * AWS SDK doesn't use `fetch`.
 */
async function bootstrap() {
  const app = await NestFactory.create(IngesterModule, { logger: new NestLogger(logger) });
  // Before `listen` runs the modules' init, where IngesterMetrics registers its metrics: it clears the default registry.
  // Its request timing middleware isn't used: the only requests are the probes and the metrics scrapes
  metricsMiddleware({ metricsApp: app.getHttpAdapter().getInstance(), normalizePath: (req) => req.path });
  // Exit with process.exit() once closed: by default Nest re-sends the signal to itself, which the kernel ignores for
  // PID 1 (node in the container), so the pod would hang until the kubelet SIGKILLs it at the grace period
  app.enableShutdownHooks(undefined, { useProcessExit: true });

  const config = app.get<ConfigService<IngesterEnv, true>>(ConfigService);
  await app.listen(config.get('METRICS_PORT', { infer: true }));
}

void bootstrap();
