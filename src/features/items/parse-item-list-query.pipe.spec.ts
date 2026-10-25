import { describe, expect, it } from 'vitest';
import { ParseItemListQueryPipe } from './parse-item-list-query.pipe';

describe('ParseItemListQueryPipe', () => {
  const pipe = new ParseItemListQueryPipe();

  it('reads search and letter with their own checks', () => {
    expect(pipe.transform({ search: 'whip' })).toEqual({ search: 'whip' });
    expect(pipe.transform({ letter: 'a' })).toEqual({ letter: 'a' });
    expect(() => pipe.transform({ search: '' })).toThrow('No search query provided');
    expect(() => pipe.transform({ letter: 'A' })).toThrow('Invalid letter "A"');
  });

  it('ignores limit with search or letter', () => {
    expect(pipe.transform({ search: 'whip', limit: '999' })).toEqual({ search: 'whip' });
  });

  it('sorts by lookedUp by default, with each sort its own limit range', () => {
    expect(pipe.transform({})).toEqual({ sort: 'lookedUp', limit: 5 });
    expect(pipe.transform({ sort: 'added' })).toEqual({ sort: 'added', limit: 25 });
    expect(pipe.transform({ sort: 'added', limit: '100' })).toEqual({ sort: 'added', limit: 100 });
    expect(() => pipe.transform({ limit: '51' })).toThrow('Limit must be between 1 and 50.');
  });

  it('rejects more than one mode', () => {
    expect(() => pipe.transform({ search: 'whip', letter: 'a' })).toThrow('Use only one of search, letter or sort.');
    expect(() => pipe.transform({ letter: 'a', sort: 'added' })).toThrow('Use only one of search, letter or sort.');
  });

  it('rejects an unknown sort and a repeated param', () => {
    expect(() => pipe.transform({ sort: 'name' })).toThrow('Sort must be one of lookedUp, added.');
    expect(() => pipe.transform({ search: ['a', 'b'] })).toThrow('Give search at most once.');
  });
});
