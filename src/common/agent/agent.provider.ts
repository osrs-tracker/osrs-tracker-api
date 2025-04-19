import { FactoryProvider } from '@nestjs/common';
import { Agent } from 'https';

export const agentProvider: FactoryProvider = {
  provide: 'AGENT',
  useFactory: () =>
    new Agent({
      keepAlive: true,
      maxFreeSockets: 10,
      maxSockets: 50,
      timeout: 10000,
    }),
};
