import { FactoryProvider } from '@nestjs/common';
import { XMLParser } from 'fast-xml-parser';

export const XMLParserProvider: FactoryProvider = {
  provide: 'XML_PARSER',
  useFactory: () =>
    new XMLParser({
      attributeNamePrefix: '',
      textNodeName: '$text',
      ignoreAttributes: false,
    }),
};
