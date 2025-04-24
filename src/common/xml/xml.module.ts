import { Global, Module } from '@nestjs/common';
import { XMLParserProvider } from './xml.provider';

@Global()
@Module({
  providers: [XMLParserProvider],
  exports: [XMLParserProvider],
})
export class XMLModule {}
