import { ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ParseIntRangePipe } from './parse-int-range.pipe';

const query = (name: string): ArgumentMetadata => ({ type: 'query', data: name });

describe('ParseIntRangePipe', () => {
  const limit = new ParseIntRangePipe({ min: 1, max: 50, default: 5 });

  it('parses integers within the range, bounds included', () => {
    expect(limit.transform('1', query('limit'))).toBe(1);
    expect(limit.transform('50', query('limit'))).toBe(50);
  });

  it('uses the default when absent', () => {
    expect(limit.transform(undefined, query('limit'))).toBe(5);
  });

  it('rejects out-of-range values with a message named after the param', () => {
    expect(() => limit.transform('0', query('limit'))).toThrow('Limit must be between 1 and 50.');
    expect(() => limit.transform('51', query('limit'))).toThrow(BadRequestException);
    expect(() => new ParseIntRangePipe({ min: 0 }).transform('-1', query('skip'))).toThrow(
      'Skip must be 0 or greater.',
    );
  });

  it("rejects non-integers like Nest's ParseIntPipe", () => {
    for (const value of ['', 'abc', '1.5', '1e3', ' 1', '0x10', '9'.repeat(400)]) {
      expect(() => limit.transform(value, query('limit'))).toThrow('Validation failed (numeric string is expected)');
    }
  });

  it('returns undefined when absent and optional, and rejects absent values otherwise', () => {
    expect(new ParseIntRangePipe({ min: 0, optional: true }).transform(undefined)).toBeUndefined();
    expect(() => new ParseIntRangePipe({ min: 0 }).transform(undefined)).toThrow(BadRequestException);
  });

  it('uses a custom message', () => {
    const id = new ParseIntRangePipe({ min: 1, message: (value) => `Invalid item ID "${value}"` });

    expect(() => id.transform('0')).toThrow('Invalid item ID "0"');
    expect(() => id.transform('-3')).toThrow('Invalid item ID "-3"');
  });
});
