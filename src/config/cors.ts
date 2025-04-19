import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

export const CORS_CONFIG: CorsOptions = {
  origin: [process.env.ORIGIN, 'http://localhost:4200'].filter((v): v is string => !!v),
};
