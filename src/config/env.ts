/** The MongoDB connection, which the API and the ingester share (`mongo.provider.ts`). */
export interface MongoEnv {
  MONGODB_URI: string;
  MONGODB_USERNAME: string;
  MONGODB_PASSWORD: string;
  MONGODB_DATABASE: string;
}

/** The environment the API runs with, validated once at startup by `validateEnv`. Read it with `ConfigService<Env, true>`. */
export interface Env extends MongoEnv {
  /** Prefix of every Jagex URL (hiscores, news feed), e.g. the API Gateway proxy in front of secure.runescape.com. */
  OSRS_API_BASE_URL: string;
  /** Allowed besides `http://localhost:4200`. */
  CORS_ORIGIN?: string;
  PORT: number;
  METRICS_PORT: number;
}

/**
 * The environment the ingester (`ingest.ts`) runs with, validated by `validateIngesterEnv`. The AWS key belongs to the
 * IAM user `osrs-tracker_ingester`, which only works from the server's IP.
 */
export interface IngesterEnv extends MongoEnv {
  AWS_REGION: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  /** The SQS FIFO queue `osrs-tracker_scrape-results.fifo`, which the scraping Lambdas send their results to. */
  SCRAPE_RESULTS_QUEUE_URL: string;
  /** The Discord webhook for alerts such as "Paused scraping". Holds its token: never log it. */
  WEBHOOK_URL: string;
  METRICS_PORT: number;
}

/**
 * `ConfigModule`'s `validate` for the API: checks `.env` merged with `process.env` and throws one error listing every
 * problem, so a missing variable stops the API at startup instead of surfacing later as failing hiscore fetches or Mongo
 * retries. Empty values count as unset (`.env.example` leaves the optional ones empty).
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const read = envReader(raw);
  return read.done({
    ...mongoEnv(read),
    OSRS_API_BASE_URL: read.url('OSRS_API_BASE_URL', read.required('OSRS_API_BASE_URL'), ['https://', 'http://']),
    CORS_ORIGIN: read.url('CORS_ORIGIN', read.optional('CORS_ORIGIN'), ['https://', 'http://']),
    PORT: read.port('PORT', 3000),
    METRICS_PORT: read.port('METRICS_PORT', 9090),
  });
}

/** `validateEnv` for the ingester. */
export function validateIngesterEnv(raw: Record<string, unknown>): IngesterEnv {
  const read = envReader(raw);
  return read.done({
    ...mongoEnv(read),
    AWS_REGION: read.required('AWS_REGION'),
    AWS_ACCESS_KEY_ID: read.required('AWS_ACCESS_KEY_ID'),
    AWS_SECRET_ACCESS_KEY: read.required('AWS_SECRET_ACCESS_KEY'),
    SCRAPE_RESULTS_QUEUE_URL: read.url('SCRAPE_RESULTS_QUEUE_URL', read.required('SCRAPE_RESULTS_QUEUE_URL'), [
      'https://',
    ]),
    WEBHOOK_URL: read.url('WEBHOOK_URL', read.required('WEBHOOK_URL'), ['https://']),
    METRICS_PORT: read.port('METRICS_PORT', 9090),
  });
}

type EnvReader = ReturnType<typeof envReader>;

function mongoEnv(read: EnvReader): MongoEnv {
  return {
    MONGODB_URI: read.url('MONGODB_URI', read.required('MONGODB_URI'), ['mongodb://', 'mongodb+srv://']),
    MONGODB_USERNAME: read.required('MONGODB_USERNAME'),
    MONGODB_PASSWORD: read.required('MONGODB_PASSWORD'),
    MONGODB_DATABASE: read.required('MONGODB_DATABASE'),
  };
}

/** Reads and checks variables from `raw`, collecting every problem; `done` throws them as one error. */
function envReader(raw: Record<string, unknown>) {
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
  const done = <T>(env: T): T => {
    if (errors.length) throw new Error(`Invalid environment (see .env.example):\n- ${errors.join('\n- ')}`);
    return env;
  };

  return { optional, required, url, port, done };
}
