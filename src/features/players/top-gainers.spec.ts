import { HiscoreEntry, PlayerStatus, PlayerType, SkillEnum } from '@osrs-tracker/models';
import { describe, expect, it } from 'vitest';
import { MAX_TOP_GAINERS, rankTopGainers, topGainersSlot } from './top-gainers';

const SLOT = new Date('2026-10-25T00:00:00Z');
const TODAY = new Date('2026-10-25T00:05:00Z');
const YESTERDAY = new Date('2026-10-24T00:05:00Z');

const entry = (date: Date, xp: number): HiscoreEntry => ({
  date,
  scrapingOffset: 0,
  skills: { [SkillEnum.Overall]: { rank: 1000, level: 1500, xp } },
  activities: {},
});

const avatar = (username: string) => ({
  username,
  type: PlayerType.Ironman,
  status: PlayerStatus.Default,
  diedAsHardcore: false,
});

const player = (username: string, gain: number, newest = TODAY) => ({
  ...avatar(username),
  entries: [entry(newest, 1_000_000 + gain), entry(YESTERDAY, 1_000_000)],
});

describe('topGainersSlot', () => {
  it('is the previous slot until an hour after 00:00 UTC', () => {
    expect(topGainersSlot(new Date('2026-10-25T00:30:00Z'))).toEqual(new Date('2026-10-24T00:00:00Z'));
  });

  it('is the new slot from an hour after it starts', () => {
    expect(topGainersSlot(new Date('2026-10-25T01:00:00Z'))).toEqual(SLOT);
    expect(topGainersSlot(new Date('2026-10-25T23:59:00Z'))).toEqual(SLOT);
  });
});

describe('rankTopGainers', () => {
  it('ranks by Overall XP gained between the two newest entries, largest first, with the avatar fields', () => {
    expect(rankTopGainers([player('b', 500), player('a', 2000), player('c', 1000)], SLOT)).toEqual([
      { ...avatar('a'), gain: 2000, date: TODAY },
      { ...avatar('c'), gain: 1000, date: TODAY },
      { ...avatar('b'), gain: 500, date: TODAY },
    ]);
  });

  it('orders equal gains by username', () => {
    expect(rankTopGainers([player('b', 100), player('a', 100)], SLOT).map((g) => g.username)).toEqual(['a', 'b']);
  });

  it("leaves out a player whose newest entry isn't from the slot's day", () => {
    const stale = player('stale', 5000, YESTERDAY);
    const nextDay = player('next', 5000, new Date('2026-10-26T00:05:00Z'));
    expect(rankTopGainers([stale, nextDay, player('fresh', 10)], SLOT).map((g) => g.username)).toEqual(['fresh']);
  });

  it('leaves out a player whose previous entry is older than the previous slot', () => {
    const resumed = {
      ...avatar('resumed'),
      entries: [entry(TODAY, 1_005_000), entry(new Date('2026-10-23T00:05:00Z'), 1_000_000)],
    };
    const firstLookup = {
      ...avatar('looked-up'),
      entries: [entry(TODAY, 1_000_010), entry(new Date('2026-10-24T00:00:00Z'), 1_000_000)],
    };
    expect(rankTopGainers([resumed, firstLookup], SLOT).map((g) => g.username)).toEqual(['looked-up']);
  });

  it('leaves out a player with only one entry', () => {
    expect(rankTopGainers([{ ...avatar('new'), entries: [entry(TODAY, 1_000_000)] }], SLOT)).toEqual([]);
  });

  it('leaves out a player who gained nothing', () => {
    expect(rankTopGainers([player('idle', 0), player('busy', 1)], SLOT).map((g) => g.username)).toEqual(['busy']);
  });

  it(`keeps at most ${MAX_TOP_GAINERS}`, () => {
    const players = Array.from({ length: MAX_TOP_GAINERS + 5 }, (_, i) => player(`p${i}`, i + 1));
    expect(rankTopGainers(players, SLOT)).toHaveLength(MAX_TOP_GAINERS);
  });
});
