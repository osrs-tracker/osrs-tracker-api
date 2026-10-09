import { FactoryProvider } from '@nestjs/common';
import { Agent } from 'undici';

export const AGENT = 'AGENT';
export const IMAGE_AGENT = 'IMAGE_AGENT';

/** The image body size limit: undici aborts a response once more than this has been read, whatever `content-length` says. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

/** The `dispatcher` for every outgoing `fetch` except news images: keep-alive, at most 50 connections per origin. */
export const agentProvider: FactoryProvider = {
  provide: AGENT,
  useFactory: () =>
    new Agent({
      connections: 50,
      keepAliveTimeout: 10_000,
    }),
};

/**
 * The `dispatcher` for news images (one CDN origin): like `AGENT` with fewer connections, plus the body size limit,
 * which `AGENT` mustn't have (hiscore and RSS responses aren't capped).
 */
export const imageAgentProvider: FactoryProvider = {
  provide: IMAGE_AGENT,
  useFactory: () =>
    new Agent({
      connections: 10,
      keepAliveTimeout: 10_000,
      maxResponseSize: MAX_IMAGE_BYTES,
    }),
};
