import { Filter } from 'mongodb';
import { Item } from '@osrs-tracker/models';

/** The letters `GET /items/browse/:letter` takes: `a` to `z`, and `0` for names that don't start with a letter. */
export const BROWSE_LETTERS = [...'abcdefghijklmnopqrstuvwxyz0'];

/**
 * The items whose name starts with `letter`, as a range on `name` rather than an anchored regex: with
 * `ITEM_NAME_COLLATION` (case-insensitive) it's a bounded scan of the `{ name: 1 }` index, which a regex can't use with
 * a collation. In that collation digits and punctuation sort before `a`, so `0` is everything below it, and accented
 * letters sort with their base letter (`É` under `e`). `z` has no upper bound (only other scripts sort after it).
 */
export function buildItemBrowseFilter(letter: string): Filter<Item> {
  if (letter === '0') return { name: { $lt: 'a' } };
  if (letter === 'z') return { name: { $gte: 'z' } };

  return { name: { $gte: letter, $lt: String.fromCharCode(letter.charCodeAt(0) + 1) } };
}
