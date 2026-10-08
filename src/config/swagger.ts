import { DocumentBuilder } from '@nestjs/swagger';

export const SWAGGER_CONFIG = new DocumentBuilder()
  .setTitle('osrs-tracker-api')
  .setDescription(
    'The API for the OSRS Tracker web application. Response bodies are the `@osrs-tracker/models` types named in each ' +
      "response's description. Errors are Nest's default JSON body: `{ statusCode, message, error }`.",
  )
  .setVersion('0.1')
  .build();
