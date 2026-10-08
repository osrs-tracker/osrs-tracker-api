import { HiscoreEntry, HiscoreSkill, PlayerStatus, PlayerType } from '@osrs-tracker/models';
import { describe, expect, it } from 'vitest';
import { PlayerUtils } from './player.utils';

/** Overall, then attack, defence, strength, hitpoints, ranged, prayer, magic; -1 is "not ranked". */
const skills = (overallXp: number, ...levels: number[]): HiscoreSkill[] => [
  { id: 0, name: 'Overall', rank: 1, level: -1, xp: overallXp },
  ...levels.map((level, i) => ({ id: i + 1, name: `Skill ${i + 1}`, rank: 1, level, xp: 0 })),
];

const entry = (overallXp: number): Partial<HiscoreEntry> => ({ skills: skills(overallXp) });

describe('PlayerUtils.getCombatLevel', () => {
  it('computes melee, ranged and magic builds', () => {
    expect(PlayerUtils.getCombatLevel(skills(0, 99, 99, 99, 99, 99, 99, 99))).toBe(126);
    expect(PlayerUtils.getCombatLevel(skills(0, 1, 1, 1, 10, 1, 1, 1))).toBe(3);
    expect(PlayerUtils.getCombatLevel(skills(0, 1, 1, 1, 10, 99, 1, 1))).toBe(50);
    expect(PlayerUtils.getCombatLevel(skills(0, 1, 1, 1, 10, 1, 1, 99))).toBe(50);
  });

  it('counts unranked skills (-1) as level 1', () => {
    expect(PlayerUtils.getCombatLevel(skills(0, -1, -1, -1, 10, -1, -1, -1))).toBe(3);
  });
});

describe('PlayerUtils.determineType', () => {
  it('picks the most restrictive table the player is on', () => {
    expect(PlayerUtils.determineType(entry(10), entry(10), null)).toBe(PlayerType.Ultimate);
    expect(PlayerUtils.determineType(entry(10), null, entry(10))).toBe(PlayerType.Hardcore);
    expect(PlayerUtils.determineType(entry(10), null, null)).toBe(PlayerType.Ironman);
    expect(PlayerUtils.determineType(null, null, null)).toBe(PlayerType.Normal);
  });
});

describe('PlayerUtils.determineStatus', () => {
  it('is de-ironed when the ironman table has less xp than the normal one', () => {
    expect(PlayerUtils.determineStatus(entry(200), entry(100), null)).toBe(PlayerStatus.DeIroned);
  });

  it('is de-ultimated when the ultimate table has less xp than the ironman one', () => {
    expect(PlayerUtils.determineStatus(entry(200), entry(200), entry(100))).toBe(PlayerStatus.DeUltimated);
  });

  it('is default when the xp matches or the player is not on a table', () => {
    expect(PlayerUtils.determineStatus(entry(200), entry(200), entry(200))).toBe(PlayerStatus.Default);
    expect(PlayerUtils.determineStatus(entry(200), entry(200), null)).toBe(PlayerStatus.Default);
    expect(PlayerUtils.determineStatus(entry(200), null, null)).toBe(PlayerStatus.Default);
  });
});

describe('PlayerUtils.getTotalXp', () => {
  it("is MAX_SAFE_INTEGER when the player isn't on the table, so it never compares as less", () => {
    expect(PlayerUtils.getTotalXp(null)).toBe(Number.MAX_SAFE_INTEGER);
    expect(PlayerUtils.getTotalXp({})).toBe(Number.MAX_SAFE_INTEGER);
    expect(PlayerUtils.getTotalXp(entry(1234))).toBe(1234);
  });
});
