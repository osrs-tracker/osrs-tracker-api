import { Injectable } from '@nestjs/common';
import { ParseIntRangeOptions, ParseIntRangePipe } from '../../common/pipes/parse-int-range.pipe';
import { ApiIntRangeQuery } from '../../common/swagger/api-int-range-query';

function scrapingOffsetOptions(optional: boolean): ParseIntRangeOptions {
  return { min: -12, max: 11, default: optional ? undefined : 0, optional, message: 'ScrapingOffset < -12 or > 11.' };
}

/**
 * Parses the `scrapingOffset` query param: an hour offset from −12 to 11, 0 when absent (or `undefined` when
 * `optional`).
 */
@Injectable()
export class ParseScrapingOffsetPipe extends ParseIntRangePipe {
  constructor({ optional = false }: { optional?: boolean } = {}) {
    super(scrapingOffsetOptions(optional));
  }
}

/** Documents the `scrapingOffset` query param as `ParseScrapingOffsetPipe` parses it (pass the same `optional`). */
export function ApiScrapingOffsetQuery({ optional = false }: { optional?: boolean } = {}) {
  return ApiIntRangeQuery(
    'scrapingOffset',
    scrapingOffsetOptions(optional),
    optional ? 'Hour offset of the hiscore entries; any offset when absent.' : 'Hour offset of the hiscore entries.',
  );
}
