import { describe, expect, it } from 'vitest';
import { ParseSinceDatePipe } from './parse-since-date.pipe';

describe('ParseSinceDatePipe', () => {
  const pipe = new ParseSinceDatePipe();

  it('accepts a date as midnight UTC', () => {
    expect(pipe.transform('2026-10-13')).toEqual(new Date('2026-10-13T00:00:00Z'));
  });

  it('accepts a date and time with a zone', () => {
    expect(pipe.transform('2026-10-13T12:30Z')).toEqual(new Date('2026-10-13T12:30:00Z'));
    expect(pipe.transform('2026-10-13T12:30:15.250+02:00')).toEqual(new Date('2026-10-13T10:30:15.250Z'));
  });

  it.each(['2026-02-31', '2026-13-01', '2026-10-13T25:00Z'])('rejects a date that does not exist: %s', (value) => {
    expect(() => pipe.transform(value)).toThrow('Date must be an ISO 8601 date');
  });

  it.each(['', 'yesterday', '1760313600', '13-10-2026', '2026-10-13T12:00', '2026-10-13 12:00Z'])(
    'rejects anything else: %s',
    (value) => {
      expect(() => pipe.transform(value)).toThrow('Date must be an ISO 8601 date');
    },
  );
});
