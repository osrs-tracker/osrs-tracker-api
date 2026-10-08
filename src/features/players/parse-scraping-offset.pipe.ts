import { Injectable } from '@nestjs/common';
import { ParseIntRangePipe } from '../../common/pipes/parse-int-range.pipe';

/**
 * Parses the `scrapingOffset` query param: an hour offset from −12 to 11, 0 when absent (or `undefined` when
 * `optional`).
 */
@Injectable()
export class ParseScrapingOffsetPipe extends ParseIntRangePipe {
  constructor({ optional = false }: { optional?: boolean } = {}) {
    super({ min: -12, max: 11, default: optional ? undefined : 0, optional, message: 'ScrapingOffset < -12 or > 11.' });
  }
}
