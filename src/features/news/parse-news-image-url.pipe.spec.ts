import { describe, expect, it } from 'vitest';
import { ParseNewsImageUrlPipe } from './parse-news-image-url.pipe';

describe('ParseNewsImageUrlPipe', () => {
  const pipe = new ParseNewsImageUrlPipe();
  const CDN = 'https://cdn.runescape.com/';

  it('accepts a plain CDN URL', () => {
    expect(pipe.transform(`${CDN}assets/img/news.png`)).toBe(`${CDN}assets/img/news.png`);
  });

  it.each([undefined, ''])('rejects a missing URL: %j', (value) => {
    expect(() => pipe.transform(value)).toThrow('No URL provided');
  });

  it('accepts 512 characters and rejects 513', () => {
    const url = (length: number) => CDN + 'a'.repeat(length - CDN.length);

    expect(pipe.transform(url(512))).toBe(url(512));
    expect(() => pipe.transform(url(513))).toThrow('URL must be 512 characters or less');
  });

  it.each([
    'https://example.com/news.png',
    'https://cdn.runescape.com.evil.example/news.png',
    'http://cdn.runescape.com/news.png',
    'https://user:pass@cdn.runescape.com/news.png',
    'https://user@cdn.runescape.com/news.png',
    'cdn.runescape.com/news.png',
    'not a url',
  ])('rejects another origin or credentials: %s', (value) => {
    expect(() => pipe.transform(value)).toThrow('URL must start with "https://cdn.runescape.com/"');
  });

  it.each([`${CDN}news.png?size=1`, `${CDN}news.png#top`])('rejects a query or hash: %s', (value) => {
    expect(() => pipe.transform(value)).toThrow('URL must not contain a query or hash');
  });
});
