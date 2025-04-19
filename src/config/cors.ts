import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

export const CORS_CONFIG: CorsOptions = {
  origin: [process.env.CORS_ORIGIN, 'http://localhost:4200'].filter((v): v is string => !!v),
};
