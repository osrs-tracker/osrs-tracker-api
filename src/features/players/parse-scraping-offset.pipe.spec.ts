import { describe, expect, it } from 'vitest';
import { ParseScrapingOffsetPipe } from './parse-scraping-offset.pipe';

describe('ParseScrapingOffsetPipe', () => {
  const pipe = new ParseScrapingOffsetPipe();

  it('accepts offsets from -12 to 11', () => {
    expect(pipe.transform('-12')).toBe(-12);
    expect(pipe.transform('11')).toBe(11);
  });

  it('defaults to 0, or to undefined when optional', () => {
    expect(pipe.transform(undefined)).toBe(0);
    expect(new ParseScrapingOffsetPipe({ optional: true }).transform(undefined)).toBeUndefined();
  });

  it('rejects offsets outside -12 to 11', () => {
    expect(() => pipe.transform('-13')).toThrow('ScrapingOffset < -12 or > 11.');
    expect(() => pipe.transform('12')).toThrow('ScrapingOffset < -12 or > 11.');
    expect(() => new ParseScrapingOffsetPipe({ optional: true }).transform('12')).toThrow('ScrapingOffset');
  });

  it('rejects non-integers', () => {
    expect(() => pipe.transform('abc')).toThrow('Validation failed (numeric string is expected)');
  });
});
