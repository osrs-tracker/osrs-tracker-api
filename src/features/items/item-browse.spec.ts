import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { buildItemBrowseFilter } from './item-browse';
import { ParseBrowseLetterPipe } from './parse-browse-letter.pipe';

/** The ranges only select the right items with `ITEM_NAME_COLLATION`, which a plain comparison can't check. */
describe('buildItemBrowseFilter', () => {
  it('selects names from the letter up to the next one', () => {
    expect(buildItemBrowseFilter('a')).toEqual({ name: { $gte: 'a', $lt: 'b' } });
    expect(buildItemBrowseFilter('y')).toEqual({ name: { $gte: 'y', $lt: 'z' } });
  });

  it('leaves z without an upper bound', () => {
    expect(buildItemBrowseFilter('z')).toEqual({ name: { $gte: 'z' } });
  });

  it('selects everything before a for 0: digits and other characters', () => {
    expect(buildItemBrowseFilter('0')).toEqual({ name: { $lt: 'a' } });
  });
});

describe('ParseBrowseLetterPipe', () => {
  const pipe = new ParseBrowseLetterPipe();

  it('accepts a to z and 0', () => {
    expect(pipe.transform('a')).toBe('a');
    expect(pipe.transform('z')).toBe('z');
    expect(pipe.transform('0')).toBe('0');
  });

  it('rejects anything else, uppercase and other digits included', () => {
    for (const value of ['A', '1', '9', 'ab', '', '%', 'é']) {
      expect(() => pipe.transform(value)).toThrow(BadRequestException);
    }
  });
});
