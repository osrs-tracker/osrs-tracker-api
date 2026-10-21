import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { IngesterService } from './ingester.service';

@Controller()
export class IngesterHealthController {
  constructor(private readonly ingester: IngesterService) {}

  /**
   * Liveness: 200 while the poll loop makes progress, 503 once it hasn't for 5 minutes (`HEARTBEAT_MAX_AGE_MS`).
   * Deliberately doesn't check Mongo or SQS: the loop waits out their outages, and a restart wouldn't fix them.
   */
  @Get('healthy')
  isHealthy() {
    if (!this.ingester.isAlive()) throw new ServiceUnavailableException('The poll loop is stuck');
    return 'OK';
  }
}
