import { DocumentBuilder } from '@nestjs/swagger';

export const SWAGGER_CONFIG = new DocumentBuilder()
  .setTitle('osrs-tracker-api')
  .setDescription('The API for the OSRS Tracker web application.')
  .setVersion('0.1')
  .build();
