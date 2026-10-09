import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ParseUsernamePipe } from './parse-username.pipe';

describe('ParseUsernamePipe', () => {
  const pipe = new ParseUsernamePipe();

  it('normalizes valid names to trimmed lowercase', () => {
    expect(pipe.transform(' ToxSick ')).toBe('toxsick');
  });

  it('normalizes underscores and hyphens to spaces, like Jagex, so one player is stored once', () => {
    expect(pipe.transform('Iron Man_1-X')).toBe('iron man 1 x');
    expect(pipe.transform('_Lynx-Titan-')).toBe('lynx titan');
    expect(pipe.transform('lynx__titan')).toBe('lynx  titan'); // Jagex doesn't collapse them either
    expect(() => pipe.transform('_-_')).toThrow('No username provided');
  });

  it('rejects empty names', () => {
    expect(() => pipe.transform('')).toThrow(BadRequestException);
    expect(() => pipe.transform('   ')).toThrow('No username provided');
  });

  it('rejects names longer than 12 characters', () => {
    expect(() => pipe.transform('a'.repeat(13))).toThrow(BadRequestException);
  });

  it('rejects double-encoded names that still contain %', () => {
    expect(() => pipe.transform('toxsick%20')).toThrow(BadRequestException);
  });
});
