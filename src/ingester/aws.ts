import { ConfigService } from '@nestjs/config';
import { IngesterEnv } from '../config/env';

/** The region and credentials every AWS SDK client of the ingester uses: the IAM user `osrs-tracker_ingester`'s key. */
export function awsClientConfig(config: ConfigService<IngesterEnv, true>) {
  return {
    region: config.get('AWS_REGION', { infer: true }),
    credentials: {
      accessKeyId: config.get('AWS_ACCESS_KEY_ID', { infer: true }),
      secretAccessKey: config.get('AWS_SECRET_ACCESS_KEY', { infer: true }),
    },
  };
}
