import { ApiQuery } from '@nestjs/swagger';
import { ParseIntRangeOptions } from '../pipes/parse-int-range.pipe';

/**
 * Documents an integer query param from the options of the `ParseIntRangePipe` that parses it, so the documented range
 * and default can't drift from the validation. Pass the same options object to both.
 */
export function ApiIntRangeQuery(name: string, options: ParseIntRangeOptions, description?: string) {
  const { min, max, default: defaultValue, optional } = options;

  return ApiQuery({
    name,
    description,
    required: defaultValue === undefined && !optional,
    type: 'integer',
    minimum: min,
    maximum: max,
    default: defaultValue,
  });
}
