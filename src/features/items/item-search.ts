import { Item } from '@osrs-tracker/models';
import leven from 'leven';

/** The shortest query word that matches the start of a word; shorter ones only match whole words. */
export const MIN_PREFIX_LENGTH = 2;
/** The shortest query word that matches inside a word (`axe` in Battleaxe) or across words (`tbow`). */
export const MIN_INNER_LENGTH = 3;
/** The shortest query word matched with a typo; from `MIN_TWO_TYPOS_LENGTH` with two. */
export const MIN_TYPO_LENGTH = 4;
const MIN_TWO_TYPOS_LENGTH = 8;
export const MAX_SEARCH_RESULTS = 20;

/** Points per query word by how it matches a name, best first; an item scores the sum. */
const SCORE = { whole: 4, prefix: 3, across: 2, inner: 1, typo: 1 } as const;

export type ItemSearchResult = Pick<Item, 'id' | 'icon' | 'name'>;

/**
 * Lowercase words without diacritics (`rosé` is `rose`) or apostrophes (`Ahrim's` is `ahrims`), split on anything else
 * that isn't a letter or digit (`Zul-andra`, `potion(4)`).
 */
export function searchWords(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Whether `rest` splits into the starts of at least two consecutive words from `words[i]` on (`tbow`: Twisted bow), the
 * last of at least `MIN_PREFIX_LENGTH` characters (else `saradomim` would match Saradomin mitre).
 */
function spansWords(rest: string, words: string[], i: number, joined = false): boolean {
  const word = words[i] ?? '';
  for (let length = 1; length <= rest.length && word[length - 1] === rest[length - 1]; length++) {
    const tail = rest.slice(length);
    if (tail ? spansWords(tail, words, i + 1, true) : joined && length >= MIN_PREFIX_LENGTH) return true;
  }
  return false;
}

/**
 * Whether `queryWord` is a typo of the start of `word`: one wrong, missing, extra or swapped letter (`shrak`), two in
 * long words (Levenshtein counts a swap as two, so swaps are checked apart).
 */
function isTypo(queryWord: string, word: string): boolean {
  for (let i = 0; i + 1 < queryWord.length; i++) {
    if (word.startsWith(queryWord.slice(0, i) + queryWord[i + 1] + queryWord[i] + queryWord.slice(i + 2))) return true;
  }

  const typos = queryWord.length >= MIN_TWO_TYPOS_LENGTH ? 2 : 1;
  for (let length = queryWord.length - typos; length <= Math.min(word.length, queryWord.length + typos); length++) {
    if (leven(queryWord, word.slice(0, length), { maxDistance: typos + 1 }) <= typos) return true;
  }
  return false;
}

/** How a query word may match besides as typed: across words and with typos (`ItemSearchIndex`). */
interface QueryWord {
  queryWord: string;
  required: boolean;
  across: boolean;
  /** The words of any name it's a typo of, when it may match with typos. */
  typos?: Set<string>;
}

/** The points a query word scores against a name's `words`, 0 when it doesn't match. */
function matchScore({ queryWord, across, typos }: QueryWord, words: string[]): number {
  if (queryWord.length < MIN_PREFIX_LENGTH) return words.includes(queryWord) ? SCORE.whole : 0;

  let score = 0;
  for (const word of words) {
    if (word === queryWord) return SCORE.whole;
    if (word.startsWith(queryWord)) score = SCORE.prefix;
    else if (queryWord.length >= MIN_INNER_LENGTH && word.includes(queryWord)) score = Math.max(score, SCORE.inner);
    else if (typos?.has(word)) score = Math.max(score, SCORE.typo);
  }
  if (across && score < SCORE.across && words.some((_, i) => spansWords(queryWord, words, i))) score = SCORE.across;
  return score;
}

/**
 * Item search for `GET /items/search/:query`, in memory. Every query word of at least `MIN_PREFIX_LENGTH` characters
 * has to match the name, in any order, scoring by how (`SCORE`):
 *
 * - a whole word, or the start of one (`drag scim` finds Dragon scimitar);
 * - from `MIN_INNER_LENGTH` characters, inside a word (`axe` finds Rune battleaxe), or, when no word of any name starts
 *   with it, the starts of consecutive words (`tbow` finds Twisted bow, `deathrune` Death rune), so `whip` doesn't
 *   find White partyhat;
 * - from `MIN_TYPO_LENGTH` characters, with a typo (`abysal` finds Abyssal whip), only when no word of any name
 *   contains it, so a correct word doesn't also match every word one letter off.
 *
 * Shorter words only score as whole words, and only a query of nothing else needs one to match (`a` finds A powdered
 * wig). Ranked by score (`gods` puts Ring of the gods above Godsword shard 1, `prayer potion(4)` Prayer potion(4) above
 * Prayer potion(3)), then shorter names, then names whose first word matches a query word (Shark paint above Raw
 * shark), then by name.
 *
 * Our own rather than a search package (MiniSearch, FlexSearch, Fuse.js): they require every query word or any one,
 * where this requires the long words and ranks with the short ones, and none matches across words.
 */
export class ItemSearchIndex {
  private readonly entries: { item: ItemSearchResult; words: string[] }[];
  /** Every word of every name: query words are checked against these once, rather than per name. */
  private readonly vocabulary: string[];

  constructor(items: ItemSearchResult[]) {
    this.entries = items.map(({ id, icon, name }) => ({ item: { id, icon, name }, words: searchWords(name) }));
    this.vocabulary = [...new Set(this.entries.flatMap(({ words }) => words))];
  }

  search(query: string): ItemSearchResult[] {
    const queryWords = [...new Set(searchWords(query))].map((queryWord): QueryWord => ({
      queryWord,
      required: queryWord.length >= MIN_PREFIX_LENGTH,
      across: queryWord.length >= MIN_INNER_LENGTH && !this.vocabulary.some((word) => word.startsWith(queryWord)),
      typos:
        queryWord.length >= MIN_TYPO_LENGTH && !this.vocabulary.some((word) => word.includes(queryWord))
          ? new Set(this.vocabulary.filter((word) => isTypo(queryWord, word)))
          : undefined,
    }));

    const ranked = [];
    for (const { item, words } of this.entries) {
      let score = 0;
      let matched = true;
      for (const queryWord of queryWords) {
        const points = matchScore(queryWord, words);
        if (queryWord.required && !points) matched = false;
        score += points;
      }
      if (!matched || !score) continue;

      const firstWord = queryWords.some((queryWord) => matchScore(queryWord, words.slice(0, 1)));
      ranked.push({ item, score, length: words.length, firstWord: firstWord ? 1 : 0 });
    }

    return ranked
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.length - b.length ||
          b.firstWord - a.firstWord ||
          a.item.name.localeCompare(b.item.name),
      )
      .slice(0, MAX_SEARCH_RESULTS)
      .map(({ item }) => item);
  }
}
