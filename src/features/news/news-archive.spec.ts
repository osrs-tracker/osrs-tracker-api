import { describe, expect, it } from 'vitest';
import { buildNewsArchiveFilter, decodeNewsCursor, encodeNewsCursor } from './news-archive';
import { ParseNewsCategoryPipe } from './parse-news-category.pipe';
import { ParseNewsCursorPipe } from './parse-news-cursor.pipe';

const cursor = { pubDate: new Date('2026-10-13T00:00:00Z'), link: 'https://secure.runescape.com/m=news/a?oldschool=1' };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('news archive cursor', () => {
  it('decodes what it encodes', () => {
    expect(decodeNewsCursor(encodeNewsCursor(cursor))).toEqual(cursor);
  });

  it.each([
    ['not base64url JSON', 'nope'],
    ['an object', encode({ pubDate: '2026-10-13T00:00:00.000Z', link: 'x' })],
    ['a missing link', encode(['2026-10-13T00:00:00.000Z'])],
    ['an empty link', encode(['2026-10-13T00:00:00.000Z', ''])],
    ['a link that is not a string', encode(['2026-10-13T00:00:00.000Z', 1])],
    ['a date that is not ISO', encode(['2026-10-13', 'x'])],
    ['a date that does not exist', encode(['2026-02-31T00:00:00.000Z', 'x'])],
  ])('rejects %s', (_name, value) => {
    expect(decodeNewsCursor(value)).toBeUndefined();
  });
});

describe('buildNewsArchiveFilter', () => {
  it('matches everything without a cursor or category', () => {
    expect(buildNewsArchiveFilter()).toEqual({});
  });

  it('starts after the cursor, breaking a tie on pubDate by link', () => {
    expect(buildNewsArchiveFilter(cursor, 'Game Updates')).toEqual({
      category: 'Game Updates',
      $or: [{ pubDate: { $lt: cursor.pubDate } }, { pubDate: cursor.pubDate, link: { $lt: cursor.link } }],
    });
  });
});

describe('ParseNewsCursorPipe', () => {
  const pipe = new ParseNewsCursorPipe();

  it('accepts no cursor or a cursor from a page', () => {
    expect(pipe.transform(undefined)).toBeUndefined();
    expect(pipe.transform(encodeNewsCursor(cursor))).toEqual(cursor);
  });

  it.each([['nope'], [['a', 'b']], ['a'.repeat(1025)], ['']])('rejects anything else: %j', (value) => {
    expect(() => pipe.transform(value)).toThrow('Before must be a next cursor from an earlier page.');
  });
});

describe('ParseNewsCategoryPipe', () => {
  const pipe = new ParseNewsCategoryPipe();

  it('accepts no category or one name', () => {
    expect(pipe.transform(undefined)).toBeUndefined();
    expect(pipe.transform('Game Updates')).toBe('Game Updates');
  });

  it.each([[''], [['Game Updates', 'Community']], ['a'.repeat(65)]])('rejects anything else: %j', (value) => {
    expect(() => pipe.transform(value)).toThrow('Category must be a single category name');
  });
});
