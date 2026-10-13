import { FactoryProvider } from '@nestjs/common';
import { XMLParser } from 'fast-xml-parser';

export const XML_PARSER = 'XML_PARSER';

export const XMLParserProvider: FactoryProvider = {
  provide: XML_PARSER,
  useFactory: () =>
    new XMLParser({
      attributeNamePrefix: '',
      textNodeName: '$text',
      ignoreAttributes: false,
      // The news feed's items, which would otherwise be an object when the feed holds one
      isArray: (_tagName, jPath) => jPath === 'rss.channel.item',
    }),
};
