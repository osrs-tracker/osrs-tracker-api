import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/**
 * `localhost:4200` is allowed in production on purpose: osrs-tracker-web's dev server runs there against the live API.
 * Responses carry no credentials and only public data, so a page on that port can read nothing that isn't public.
 */
export function corsOptions(corsOrigins: string[]): CorsOptions {
  return { origin: [...corsOrigins, 'http://localhost:4200'] };
}
