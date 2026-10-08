import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

export interface ParseIntRangeOptions {
  min: number;
  max?: number;
  /** Used when the value is absent. */
  default?: number;
  /** Without a `default`, an absent value is `undefined` instead of a 400. */
  optional?: boolean;
  /** The 400 for an out-of-range value; defaults to `<Name> must be between <min> and <max>.` (or `<min> or greater`). */
  message?: string | ((value: number) => string);
}

/**
 * Parses an integer query or route param like Nest's `ParseIntPipe` (same 400 for non-integers) and rejects values
 * outside `[min, max]`.
 */
@Injectable()
export class ParseIntRangePipe implements PipeTransform<string | undefined, number | undefined> {
  constructor(private readonly options: ParseIntRangeOptions) {}

  transform(value: string | undefined, metadata?: ArgumentMetadata): number | undefined {
    const { min, max, message } = this.options;

    if (value === undefined || value === null) {
      if (this.options.default !== undefined) return this.options.default;
      if (this.options.optional) return undefined;
    }
    if (typeof value !== 'string' || !/^-?\d+$/.test(value) || !isFinite(Number(value))) {
      throw new BadRequestException('Validation failed (numeric string is expected)');
    }

    const number = parseInt(value, 10);

    if (number < min || (max !== undefined && number > max)) {
      if (typeof message === 'function') throw new BadRequestException(message(number));
      throw new BadRequestException(message ?? this.defaultMessage(metadata?.data));
    }

    return number;
  }

  private defaultMessage(name = 'Value'): string {
    const { min, max } = this.options;
    const label = name.charAt(0).toUpperCase() + name.slice(1);

    return max === undefined ? `${label} must be ${min} or greater.` : `${label} must be between ${min} and ${max}.`;
  }
}
