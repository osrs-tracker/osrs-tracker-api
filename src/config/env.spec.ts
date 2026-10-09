import { describe, expect, it } from 'vitest';
import { validateEnv } from './env';

const VALID = {
  MONGODB_URI: 'mongodb+srv://cluster.example.net',
  MONGODB_USERNAME: 'user',
  MONGODB_PASSWORD: 'secret',
  MONGODB_DATABASE: 'osrs-tracker',
  OSRS_API_BASE_URL: 'https://runescape-api.freekmencke.com/rs',
};

describe('validateEnv', () => {
  it('applies the defaults and treats empty optional values as unset', () => {
    expect(validateEnv({ ...VALID, CORS_ORIGIN: '', PORT: '' })).toEqual({
      ...VALID,
      CORS_ORIGIN: undefined,
      PORT: 3000,
      METRICS_PORT: 9090,
    });
  });

  it('parses the optional values', () => {
    expect(
      validateEnv({
        ...VALID,
        CORS_ORIGIN: 'https://osrs-tracker.freekmencke.com',
        PORT: '8080',
        METRICS_PORT: '9091',
      }),
    ).toMatchObject({ CORS_ORIGIN: 'https://osrs-tracker.freekmencke.com', PORT: 8080, METRICS_PORT: 9091 });
  });

  it.each(Object.keys(VALID))('throws when %s is missing or blank', (name) => {
    expect(() => validateEnv({ ...VALID, [name]: undefined })).toThrow(`- ${name} is required.`);
    expect(() => validateEnv({ ...VALID, [name]: ' ' })).toThrow(`- ${name} is required.`);
  });

  it('lists every problem at once', () => {
    expect(() => validateEnv({ MONGODB_URI: 'localhost:27017', PORT: '3000abc', METRICS_PORT: '70000' })).toThrow(
      [
        'Invalid environment (see .env.example):',
        '- MONGODB_URI must start with mongodb:// or mongodb+srv://.',
        '- MONGODB_USERNAME is required.',
        '- MONGODB_PASSWORD is required.',
        '- MONGODB_DATABASE is required.',
        '- OSRS_API_BASE_URL is required.',
        '- PORT must be a port (1-65535).',
        '- METRICS_PORT must be a port (1-65535).',
      ].join('\n'),
    );
  });

  it('rejects a base URL without a protocol', () => {
    expect(() => validateEnv({ ...VALID, OSRS_API_BASE_URL: 'runescape-api.freekmencke.com/rs' })).toThrow(
      'OSRS_API_BASE_URL must start with https:// or http://.',
    );
  });
});
