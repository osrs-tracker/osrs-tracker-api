import { HiscoreTable } from '@osrs-tracker/hiscores';
import { HiscoreEntry, PlayerStatus, PlayerType, SkillEnum } from '@osrs-tracker/models';

/**
 * Total xp of a player who isn't on a table: higher than any real total, so a missing table never compares as less.
 * `determineStatus` (de-ironed, de-ultimated) and `diedAsHardcore` rely on that to only compare tables the player is on.
 */
export const NOT_ON_TABLE_XP = Number.MAX_SAFE_INTEGER;

/** Overall and the seven combat skills: a hiscore without one of these keys is truncated (counts as failed). */
export const COMBAT_SKILLS = [
  SkillEnum.Overall,
  SkillEnum.Attack,
  SkillEnum.Defence,
  SkillEnum.Strength,
  SkillEnum.Hitpoints,
  SkillEnum.Ranged,
  SkillEnum.Prayer,
  SkillEnum.Magic,
] as const;

export class PlayerUtils {
  /** OSRS display names: 1-12 letters, numbers, spaces, hyphens and underscores (`normalizeUsername` leaves no `_-`). */
  private static readonly USERNAME_REGEX = /^[a-z0-9 _-]{1,12}$/;

  /**
   * Jagex's own matching: case-insensitive, `_` and `-` are a space, and leading or trailing separators are ignored
   * (`_Lynx-Titan` is `lynx titan`). Repeated separators aren't collapsed: Jagex doesn't match `lynx  titan` either.
   */
  static normalizeUsername(username: string): string {
    return username.toLowerCase().replace(/[_-]/g, ' ').trim();
  }

  static isValidUsername(username: string): boolean {
    return PlayerUtils.USERNAME_REGEX.test(username);
  }

  /** Resolve correct hiscore table for `PlayerType`. */
  static getHiscoreTable(type: PlayerType): HiscoreTable {
    switch (type) {
      case PlayerType.Normal:
        return 'hiscore_oldschool';
      case PlayerType.Ironman:
        return 'hiscore_oldschool_ironman';
      case PlayerType.Ultimate:
        return 'hiscore_oldschool_ultimate';
      case PlayerType.Hardcore:
        return 'hiscore_oldschool_hardcore_ironman';
    }
  }

  /** Calculates the combat level from the skills (`hasCombatSkills` must hold). */
  static getCombatLevel(skills: HiscoreEntry['skills']): number {
    // a skill without xp (null) or missing counts as level 1
    const levelOf = (name: SkillEnum): number => Math.max(1, skills[name]?.level ?? 1);
    const attack = levelOf(SkillEnum.Attack);
    const defence = levelOf(SkillEnum.Defence);
    const strength = levelOf(SkillEnum.Strength);
    const hitpoints = levelOf(SkillEnum.Hitpoints);
    const ranged = levelOf(SkillEnum.Ranged);
    const prayer = levelOf(SkillEnum.Prayer);
    const magic = levelOf(SkillEnum.Magic);

    const base = 0.25 * (defence + hitpoints + Math.floor(prayer / 2));
    const melee = 0.325 * (attack + strength);
    const range = 0.325 * (Math.floor(ranged / 2) + ranged);
    const mage = 0.325 * (Math.floor(magic / 2) + magic);

    return Math.floor(base + Math.max(melee, range, mage));
  }

  /** Whether a hiscore has every `COMBAT_SKILLS` key, each null (no xp) or with a numeric level. */
  static hasCombatSkills(skills: HiscoreEntry['skills']): boolean {
    return COMBAT_SKILLS.every(
      (name) => name in skills && (skills[name] === null || typeof skills[name]?.level === 'number'),
    );
  }

  /** Determines the original playerType from the tables the player is on. Only works when the player has enough xp to appear in the hiscores. */
  static determineType(
    ironman: Pick<HiscoreEntry, 'skills'> | null,
    ultimate: Pick<HiscoreEntry, 'skills'> | null,
    hardcore: Pick<HiscoreEntry, 'skills'> | null,
  ): PlayerType {
    if (ultimate) return PlayerType.Ultimate;
    if (hardcore) return PlayerType.Hardcore;
    if (ironman) return PlayerType.Ironman;
    return PlayerType.Normal;
  }

  /** Determines the current playerStatus by comparing total xp across tables. Only works when the player has enough xp to appear in the hiscores. */
  static determineStatus(
    normal: Pick<HiscoreEntry, 'skills'> | null,
    ironman: Pick<HiscoreEntry, 'skills'> | null,
    ultimate: Pick<HiscoreEntry, 'skills'> | null,
  ): PlayerStatus {
    if (PlayerUtils.getTotalXp(ironman) < PlayerUtils.getTotalXp(normal)) return PlayerStatus.DeIroned;
    if (PlayerUtils.getTotalXp(ultimate) < PlayerUtils.getTotalXp(ironman)) return PlayerStatus.DeUltimated;
    return PlayerStatus.Default;
  }

  /** Total xp of a hiscore entry, so we can compare hiscores; `NOT_ON_TABLE_XP` when the player isn't on the table. */
  static getTotalXp(hiscore: Pick<HiscoreEntry, 'skills'> | null): number {
    return hiscore ? hiscore.skills[SkillEnum.Overall]!.xp : NOT_ON_TABLE_XP;
  }
}
