import { describe, expect, it } from 'vitest';
import { ParsePlayerListQueryPipe } from './parse-player-list-query.pipe';

describe('ParsePlayerListQueryPipe', () => {
  const pipe = new ParsePlayerListQueryPipe();

  it('sorts by lookedUp by default, with its optional scrapingOffset and entry', async () => {
    expect(await pipe.transform({})).toEqual({ sort: 'lookedUp', limit: 5 });
    expect(await pipe.transform({ limit: '50', scrapingOffset: '-3', entry: 'overall' })).toEqual({
      sort: 'lookedUp',
      limit: 50,
      scrapingOffset: -3,
      entry: 'overall',
    });
    await expect(pipe.transform({ entry: 'all' })).rejects.toThrow(`Entry must be 'overall'.`);
  });

  it('reads gain with its own limit range, ignoring the lookedUp params', async () => {
    expect(await pipe.transform({ sort: 'gain', entry: 'all' })).toEqual({ sort: 'gain', limit: 10 });
    await expect(pipe.transform({ sort: 'gain', limit: '51' })).rejects.toThrow('Limit must be between 1 and 50.');
  });

  it('rejects an unknown sort and a repeated param', async () => {
    await expect(pipe.transform({ sort: 'xp' })).rejects.toThrow('Sort must be one of lookedUp, gain.');
    await expect(pipe.transform({ limit: ['1', '2'] })).rejects.toThrow('Give limit at most once.');
  });
});
