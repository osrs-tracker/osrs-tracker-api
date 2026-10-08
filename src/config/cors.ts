import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

export function corsOptions(corsOrigin: string | undefined): CorsOptions {
  return { origin: [corsOrigin, 'http://localhost:4200'].filter((v): v is string => !!v) };
}
