import { describe, expect, it } from 'vitest';
import { ItemSearchIndex, searchWords } from './item-search';

const NAMES = [
  'Abyssal whip',
  'Frozen whip mix',
  'Dragon scimitar',
  'Dragon scimitar ornament kit',
  'Ring of the gods',
  'Godsword shard 1',
  'Shark',
  'Shark paint',
  'Raw shark',
  'Prayer potion(3)',
  'Prayer potion(4)',
  'Prayer regeneration potion(4)',
  'A powdered wig',
  'Imperial rosé',
  "Ahrim's hood",
  'Zul-andra teleport',
  'Twisted bow',
  'Magic shortbow',
  'Death rune',
  'Rune battleaxe',
  'Saradomin brew(4)',
  'Saradomin mitre',
  'White partyhat',
  'Steel hasta',
];
const index = new ItemSearchIndex(NAMES.map((name, i) => ({ id: i + 1, icon: `${name}.png`, name })));
const search = (query: string) => index.search(query).map(({ name }) => name);

describe('searchWords', () => {
  it('lowercases, folds diacritics, drops apostrophes and splits on other punctuation', () => {
    expect(searchWords("Imperial Rosé Ahrim's Zul-andra potion(4)")).toEqual([
      'imperial',
      'rose',
      'ahrims',
      'zul',
      'andra',
      'potion',
      '4',
    ]);
  });
});

describe('ItemSearchIndex', () => {
  it('requires every word to start a word of the name, in any order', () => {
    expect(search('drag scim')).toEqual(['Dragon scimitar', 'Dragon scimitar ornament kit']);
    expect(search('scim drag')).toEqual(['Dragon scimitar', 'Dragon scimitar ornament kit']);
    expect(search('drag whip')).toEqual([]);
  });

  it('matches prefixes from two characters, and shorter words only as whole words', () => {
    expect(search('zu')).toEqual(['Zul-andra teleport']);
    expect(search('z')).toEqual([]);
    expect(search('a')).toEqual(['A powdered wig']);
  });

  it("doesn't require words shorter than a prefix match when the query has longer ones", () => {
    expect(search('a shark')).toEqual(['Shark', 'Shark paint', 'Raw shark']);
  });

  it('folds diacritics and ignores case and apostrophes', () => {
    expect(search('ROSE')).toEqual(['Imperial rosé']);
    expect(search('ahrims')).toEqual(["Ahrim's hood"]);
    expect(search("ahrim's")).toEqual(["Ahrim's hood"]);
  });

  it('matches inside a word from three characters', () => {
    expect(search('axe')).toEqual(['Rune battleaxe']);
    expect(search('ax')).toEqual([]);
  });

  it('matches the starts of consecutive words, ranked above matches inside a word', () => {
    expect(search('tbow')).toEqual(['Twisted bow', 'Magic shortbow']);
    expect(search('deathrune')).toEqual(['Death rune']);
    expect(search('deathru')).toEqual(['Death rune']);
  });

  it("doesn't match across words a word that starts a word, or that ends in one letter", () => {
    expect(search('whip')).toEqual(['Abyssal whip', 'Frozen whip mix']); // not Whi(te) p(artyhat)
    expect(search('wpa')).toEqual(['White partyhat']);
    expect(search('whp')).toEqual([]);
    expect(search('sha')).not.toContain('Steel hasta');
  });

  it('matches one typo, two from eight characters, only when no word contains the query word', () => {
    expect(search('abysal whip')).toEqual(['Abyssal whip']);
    expect(search('saradomim brew')).toEqual(['Saradomin brew(4)']);
    expect(search('sarradomim brew')).toEqual(['Saradomin brew(4)']);
    expect(search('shrak')).toEqual(['Shark', 'Shark paint', 'Raw shark']);
    expect(search('shrk')).toEqual(['Shark', 'Shark paint', 'Raw shark']);
    expect(search('wnip')).toEqual(['Abyssal whip', 'Frozen whip mix']);
    expect(search('whit')).toEqual(['White partyhat']); // not a typo of whip: it starts White
    expect(search('abc')).toEqual([]); // a typo needs four characters: not Abyssal whip
  });

  it('ranks whole-word matches above prefix matches', () => {
    expect(search('gods')).toEqual(['Ring of the gods', 'Godsword shard 1']);
  });

  it('counts short words towards the ranking', () => {
    expect(search('prayer potion(4)')).toEqual([
      'Prayer potion(4)',
      'Prayer regeneration potion(4)',
      'Prayer potion(3)',
    ]);
  });

  it('ranks shorter names, then names whose first word matches, first', () => {
    expect(search('whip')).toEqual(['Abyssal whip', 'Frozen whip mix']);
    expect(search('shark')).toEqual(['Shark', 'Shark paint', 'Raw shark']);
  });

  it('returns at most 20 items, with only id, icon and name', () => {
    const many = new ItemSearchIndex(
      Array.from({ length: 25 }, (_, i) => ({ id: i, icon: 'rune.png', name: `Rune item ${i}`, extra: true })),
    );

    expect(many.search('rune')).toHaveLength(20);
    expect(many.search('rune')[0]).toEqual({ id: 0, icon: 'rune.png', name: 'Rune item 0' });
  });
});
