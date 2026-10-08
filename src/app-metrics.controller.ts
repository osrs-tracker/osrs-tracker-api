import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppMetricsController {
  /**
   * Liveness only: answers once the API listens, which is after Mongo connected (`listen` waits for the providers), and
   * until the process exits. Deliberately doesn't check Mongo: an Atlas blip would get every pod restarted at once,
   * which doesn't fix Atlas and turns the cached and Jagex-only routes into errors too.
   */
  @Get('healthy')
  isHealthy() {
    return 'OK';
  }
}
