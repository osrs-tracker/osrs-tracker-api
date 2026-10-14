import { describe, expect, it } from 'vitest';
import { ParseItemSearchQueryPipe } from './parse-item-search-query.pipe';

describe('ParseItemSearchQueryPipe', () => {
  const pipe = new ParseItemSearchQueryPipe();

  it('accepts up to 64 characters', () => {
    expect(pipe.transform('whip')).toBe('whip');
    expect(pipe.transform('a'.repeat(64))).toBe('a'.repeat(64));
  });

  it('rejects an empty query', () => {
    expect(() => pipe.transform('')).toThrow('No search query provided');
  });

  it('rejects 65 characters', () => {
    expect(() => pipe.transform('a'.repeat(65))).toThrow('Search query must be 64 characters or less');
  });
});
