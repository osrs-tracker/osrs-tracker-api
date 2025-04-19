import { Global, Module } from '@nestjs/common';
import { mongoClientProvider, mongoDBProvider } from './mongo.provider';

@Global()
@Module({
  providers: [mongoClientProvider, mongoDBProvider],
  exports: [mongoClientProvider, mongoDBProvider],
})
export class MongoModule {}
