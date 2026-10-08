/** The environment the API runs with, validated once at startup by `validateEnv`. Read it with `ConfigService<Env, true>`. */
export interface Env {
  MONGODB_URI: string;
  MONGODB_USERNAME: string;
  MONGODB_PASSWORD: string;
  MONGODB_DATABASE: string;
  /** Prefix of every Jagex URL (hiscores, news feed), e.g. the API Gateway proxy in front of secure.runescape.com. */
  OSRS_API_BASE_URL: string;
  /** Allowed besides `http://localhost:4200`. */
  CORS_ORIGIN?: string;
  PORT: number;
  METRICS_PORT: number;
  NODE_ENV?: 'production' | 'development' | 'test';
}

const NODE_ENVS: readonly NonNullable<Env['NODE_ENV']>[] = ['production', 'development', 'test'];

/**
 * `ConfigModule`'s `validate`: checks `.env` merged with `process.env` and throws one error listing every problem, so a
 * missing variable stops the API at startup instead of surfacing later as failing hiscore fetches or Mongo retries.
 * Empty values count as unset (`.env.example` leaves the optional ones empty).
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const errors: string[] = [];

  const optional = (name: string): string | undefined => {
    const value = raw[name];
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  };
  const required = (name: string): string => {
    const value = optional(name);
    if (value === undefined) errors.push(`${name} is required.`);
    return value ?? '';
  };
  const url = <T extends string | undefined>(name: string, value: T, protocols: string[]): T => {
    if (value && !protocols.some((protocol) => value.startsWith(protocol)))
      errors.push(`${name} must start with ${protocols.join(' or ')}.`);
    return value;
  };
  const port = (name: string, fallback: number): number => {
    const value = optional(name);
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!/^\d+$/.test(value) || parsed < 1 || parsed > 65535) errors.push(`${name} must be a port (1-65535).`);
    return parsed;
  };
  const nodeEnv = (): Env['NODE_ENV'] => {
    const value = optional('NODE_ENV');
    if (value !== undefined && !NODE_ENVS.includes(value as never))
      errors.push(`NODE_ENV must be one of ${NODE_ENVS.join(', ')}.`);
    return value as Env['NODE_ENV'];
  };

  const env: Env = {
    MONGODB_URI: url('MONGODB_URI', required('MONGODB_URI'), ['mongodb://', 'mongodb+srv://']),
    MONGODB_USERNAME: required('MONGODB_USERNAME'),
    MONGODB_PASSWORD: required('MONGODB_PASSWORD'),
    MONGODB_DATABASE: required('MONGODB_DATABASE'),
    OSRS_API_BASE_URL: url('OSRS_API_BASE_URL', required('OSRS_API_BASE_URL'), ['https://', 'http://']),
    CORS_ORIGIN: url('CORS_ORIGIN', optional('CORS_ORIGIN'), ['https://', 'http://']),
    PORT: port('PORT', 3000),
    METRICS_PORT: port('METRICS_PORT', 9090),
    NODE_ENV: nodeEnv(),
  };

  if (errors.length) throw new Error(`Invalid environment (see .env.example):\n- ${errors.join('\n- ')}`);
  return env;
}
