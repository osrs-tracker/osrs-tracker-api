import { FactoryProvider } from '@nestjs/common';
import { Agent } from 'undici';

export const AGENT = 'AGENT';

/** The `dispatcher` for every outgoing `fetch`: keep-alive, at most 50 connections per origin. */
export const agentProvider: FactoryProvider = {
  provide: AGENT,
  useFactory: () =>
    new Agent({
      connections: 50,
      keepAliveTimeout: 10_000,
    }),
};
