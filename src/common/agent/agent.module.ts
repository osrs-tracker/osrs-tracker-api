import { Global, Module } from '@nestjs/common';
import { agentProvider, imageAgentProvider } from './agent.provider';

@Global()
@Module({
  providers: [agentProvider, imageAgentProvider],
  exports: [agentProvider, imageAgentProvider],
})
export class AgentModule {}
