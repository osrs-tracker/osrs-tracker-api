import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppMetricsController {
  @Get('healthy')
  isHealthy() {
    return 'OK';
  }
}
