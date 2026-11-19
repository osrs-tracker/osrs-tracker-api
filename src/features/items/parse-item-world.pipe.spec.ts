import { describe, expect, it } from 'vitest';
import { ParseItemWorldPipe } from './parse-item-world.pipe';

describe('ParseItemWorldPipe', () => {
  const pipe = new ParseItemWorldPipe();

  it('is main when absent', () => {
    expect(pipe.transform(undefined)).toBe('main');
  });

  it('accepts main and hardcore', () => {
    expect(pipe.transform('main')).toBe('main');
    expect(pipe.transform('hardcore')).toBe('hardcore');
  });

  it('rejects any other value and a repeated param', () => {
    expect(() => pipe.transform('')).toThrow('World must be one of main, hardcore.');
    expect(() => pipe.transform('Hardcore')).toThrow('World must be one of main, hardcore.');
    expect(() => pipe.transform(['main', 'hardcore'])).toThrow('Give world at most once.');
  });
});
