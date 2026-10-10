import { Document } from 'mongodb';
import { ITEM_SEARCH_INDEX, ITEM_SEARCH_MIN_GRAMS } from '../../common/mongo/mongo.provider';

/** Whole-word matches outrank items that only match the start of a word (`whip` puts Abyssal whip above Whip mix). */
const WHOLE_WORD_BOOST = 2;

/**
 * The `$search` pipeline for `GET /items/search/:query`, on the `ITEM_SEARCH_INDEX` Atlas Search index: every word of
 * the query has to start a word of the name, in any order (`drag scim` finds Dragon scimitar), and whole words score
 * higher. Words shorter than the index's `minGrams` can't match a prefix, so they only count towards the score.
 */
export function buildItemSearchPipeline(query: string): Document[] {
  const words = query.split(/\s+/).filter((word) => word.length >= ITEM_SEARCH_MIN_GRAMS);

  return [
    {
      $search: {
        index: ITEM_SEARCH_INDEX,
        compound: {
          must: words.map((word) => ({ autocomplete: { query: word, path: 'name', tokenOrder: 'any' } })),
          should: [{ text: { query, path: 'name', score: { boost: { value: WHOLE_WORD_BOOST } } } }],
        },
      },
    },
    { $limit: 20 },
    { $project: { _id: 0, id: 1, icon: 1, name: 1, score: { $meta: 'searchScore' } } },
  ];
}
