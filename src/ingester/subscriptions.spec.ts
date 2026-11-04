import { marshall } from '@aws-sdk/util-dynamodb';
import { PlayerSubscription, PlayerType } from '@osrs-tracker/models';
import { describe, expect, it } from 'vitest';
import { deleteGuard, diffSubscriptions, subscriptionOf } from './subscriptions';

const item = (username: string, ...offsets: number[]): PlayerSubscription => ({
  username,
  scrapingOffsets: new Set(offsets),
});

const hardcoreMainItem = (username: string, ...offsets: number[]): PlayerSubscription => ({
  ...item(username, ...offsets),
  table: 'hiscore_oldschool_hardcore_mains',
});

const player = (username: string, scrapingOffsets: number[], type = PlayerType.Normal) => ({
  username,
  scrapingOffsets,
  type,
});

describe('subscriptionOf', () => {
  it('stores the offsets as a Set, which the document client writes as a Number Set', () => {
    const subscription = subscriptionOf(player('toxsick', [0, -3]))!;
    expect(subscription).toEqual(item('toxsick', 0, -3));
    expect(marshall(subscription).scrapingOffsets).toEqual({ NS: ['0', '-3'] });
  });

  it('gives no item without offsets: a Number Set cannot be empty', () => {
    expect(subscriptionOf(player('toxsick', []))).toBeUndefined();
    expect(subscriptionOf(player('toxsick', undefined!))).toBeUndefined();
  });

  it('leaves out offset 12, which queue-players queues with -12', () => {
    expect(subscriptionOf(player('toxsick', [12, 0]))).toEqual(item('toxsick', 0));
    expect(subscriptionOf(player('toxsick', [12]))).toBeUndefined();
  });

  it("names Hardcore Worlds' table for a Hardcore main, and no table (the main one) for anyone else", () => {
    const subscription = subscriptionOf(player('hcmain', [0], PlayerType.HardcoreMain))!;
    expect(subscription).toEqual(hardcoreMainItem('hcmain', 0));
    expect(marshall(subscription).table).toEqual({ S: 'hiscore_oldschool_hardcore_mains' });

    const ironman = subscriptionOf(player('iron', [0], PlayerType.Ironman))!;
    expect(ironman).not.toHaveProperty('table');
    expect(() => marshall(ironman)).not.toThrow();
  });
});

describe('diffSubscriptions', () => {
  it('puts the missing items and the ones whose offsets differ, not the ones that match in any order', () => {
    const { puts, deletes } = diffSubscriptions(
      [player('new', [0]), player('changed', [0, 1]), player('same', [1, 0, 0])],
      [item('changed', 0), item('same', 0, 1)],
    );
    expect(puts).toEqual([item('new', 0), item('changed', 0, 1)]);
    expect(deletes).toEqual([]);
  });

  it('puts the items whose table differs, either way', () => {
    const { puts, deletes } = diffSubscriptions(
      [
        player('became', [0], PlayerType.HardcoreMain),
        player('left', [0]),
        player('same', [0], PlayerType.HardcoreMain),
      ],
      [item('became', 0), hardcoreMainItem('left', 0), hardcoreMainItem('same', 0)],
    );
    expect(puts).toEqual([hardcoreMainItem('became', 0), item('left', 0)]);
    expect(deletes).toEqual([]);
  });

  it('deletes the items of players gone or without offsets (a paused one has none)', () => {
    const { puts, deletes } = diffSubscriptions(
      [player('kept', [0]), player('paused', [])],
      [item('kept', 0), item('paused', 0), item('gone', 3)],
    );
    expect(puts).toEqual([]);
    expect(deletes).toEqual(['paused', 'gone']);
  });
});

describe('deleteGuard', () => {
  it('lets the deletes go up to 10% of the items', () => {
    expect(deleteGuard(500, 520, 52)).toBeUndefined();
    expect(deleteGuard(0, 0, 0)).toBeUndefined();
  });

  it('skips them when MongoDB returned no players, so an empty database never empties the table', () => {
    expect(deleteGuard(0, 520, 520)).toBe('MongoDB returned no players with scraping offsets');
  });

  it('skips them when over 10% of the items would go', () => {
    expect(deleteGuard(460, 520, 53)).toBe('53 of 520 subscriptions would be deleted, over 10%');
  });
});
