import { describe, expect, it } from 'vitest';
import { ITEM_SEARCH_INDEX } from '../../common/mongo/mongo.provider';
import { buildItemSearchPipeline } from './item-search';

/** `$search` doesn't run on a plain `mongod`, so this checks the pipeline rather than its results. */
describe('buildItemSearchPipeline', () => {
  const compoundOf = (query: string) => buildItemSearchPipeline(query)[0].$search.compound;

  it('searches the item search index', () => {
    expect(buildItemSearchPipeline('whip')[0].$search.index).toBe(ITEM_SEARCH_INDEX);
  });

  it('requires a prefix match for every word, in any order', () => {
    expect(compoundOf('dragon  scim').must).toEqual([
      { autocomplete: { query: 'dragon', path: 'name', tokenOrder: 'any' } },
      { autocomplete: { query: 'scim', path: 'name', tokenOrder: 'any' } },
    ]);
  });

  it('leaves words shorter than the shortest prefix the index matches out of the prefix matches', () => {
    expect(compoundOf('bee on a stick').must).toEqual(
      ['bee', 'on', 'stick'].map((word) => ({ autocomplete: { query: word, path: 'name', tokenOrder: 'any' } })),
    );
  });

  it('matches whole words alone when no word is long enough for a prefix match', () => {
    expect(compoundOf('a').must).toBeUndefined();
    expect(compoundOf('a').should).toHaveLength(1);
  });

  it('boosts whole-word matches of the whole query', () => {
    expect(compoundOf('abyssal whip').should).toEqual([
      { text: { query: 'abyssal whip', path: 'name', score: { boost: { value: 2 } } } },
    ]);
  });

  it('returns at most 20 items with only id, icon, name and the search score', () => {
    expect(buildItemSearchPipeline('whip').slice(1)).toEqual([
      { $limit: 20 },
      { $project: { _id: 0, id: 1, icon: 1, name: 1, score: { $meta: 'searchScore' } } },
    ]);
  });
});
