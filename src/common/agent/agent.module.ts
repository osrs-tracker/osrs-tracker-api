import { Global, Module } from '@nestjs/common';
import { agentProvider } from './agent.provider';

@Global()
@Module({
  providers: [agentProvider],
  exports: [agentProvider],
})
export class AgentModule {}
