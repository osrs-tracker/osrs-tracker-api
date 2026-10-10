import { HiscoreEntry, PlayerStatus, PlayerType, SkillEnum } from '@osrs-tracker/models';
import { describe, expect, it } from 'vitest';
import { NOT_ON_TABLE_XP, PlayerUtils } from './player.utils';

type Skills = HiscoreEntry['skills'];
type Level = number | null;

/** Overall with `overallXp`, then attack, defence, strength, hitpoints, ranged, prayer, magic levels; null is "not ranked". */
const skills = (overallXp: number, ...levels: Level[]): Skills => {
  const names = [
    SkillEnum.Attack,
    SkillEnum.Defence,
    SkillEnum.Strength,
    SkillEnum.Hitpoints,
    SkillEnum.Ranged,
    SkillEnum.Prayer,
    SkillEnum.Magic,
  ];
  return {
    [SkillEnum.Overall]: { rank: 1, level: 1000, xp: overallXp },
    ...Object.fromEntries(levels.map((level, i) => [names[i], level === null ? null : { rank: 1, level, xp: 0 }])),
  };
};

const entry = (overallXp: number): Pick<HiscoreEntry, 'skills'> => ({ skills: skills(overallXp) });

describe('PlayerUtils.getCombatLevel', () => {
  it('computes melee, ranged and magic builds', () => {
    expect(PlayerUtils.getCombatLevel(skills(0, 99, 99, 99, 99, 99, 99, 99))).toBe(126);
    expect(PlayerUtils.getCombatLevel(skills(0, 1, 1, 1, 10, 1, 1, 1))).toBe(3);
    expect(PlayerUtils.getCombatLevel(skills(0, 1, 1, 1, 10, 99, 1, 1))).toBe(50);
    expect(PlayerUtils.getCombatLevel(skills(0, 1, 1, 1, 10, 1, 1, 99))).toBe(50);
  });

  it('counts unranked (null) and missing skills as level 1', () => {
    expect(PlayerUtils.getCombatLevel(skills(0, null, null, null, 10, null, null, null))).toBe(3);
    expect(PlayerUtils.getCombatLevel(skills(0, 1, 1, 1, 10))).toBe(3);
  });

  it('ignores skills it does not know', () => {
    const withExtra: Skills = { ...skills(0, 1, 1, 1, 10, 1, 1, 1), Necromancy: { rank: 1, level: 99, xp: 5 } };
    expect(PlayerUtils.getCombatLevel(withExtra)).toBe(3);
  });
});

describe('PlayerUtils.hasCombatSkills', () => {
  it('needs overall and the seven combat skills, each null or with a numeric level', () => {
    expect(PlayerUtils.hasCombatSkills(skills(0, 1, 1, 1, 10, 1, 1, 1))).toBe(true);
    expect(PlayerUtils.hasCombatSkills({ ...skills(0, 1, 1, 1, 10, 1, 1, 1), Necromancy: null })).toBe(true);
  });

  it('accepts a null (unranked) combat skill', () => {
    expect(PlayerUtils.hasCombatSkills(skills(0, null, null, null, 10, null, null, null))).toBe(true);
  });

  it('rejects a missing key', () => {
    expect(PlayerUtils.hasCombatSkills(skills(0, 1, 1, 1, 10, 1, 1))).toBe(false);
    expect(PlayerUtils.hasCombatSkills({})).toBe(false);
  });

  it('rejects a value without a numeric level', () => {
    const noLevel = skills(0, 1, 1, 1, 10, 1, 1, 1);
    noLevel[SkillEnum.Magic] = { rank: 1, xp: 0 } as unknown as Skills[string];
    expect(PlayerUtils.hasCombatSkills(noLevel)).toBe(false);
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
  it("is NOT_ON_TABLE_XP when the player isn't on the table, so it never compares as less", () => {
    expect(PlayerUtils.getTotalXp(null)).toBe(NOT_ON_TABLE_XP);
    expect(PlayerUtils.getTotalXp(entry(1234))).toBe(1234);
  });
});
