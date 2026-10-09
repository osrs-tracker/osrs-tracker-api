import { HiscoreTable } from '@osrs-tracker/hiscores';
import { HiscoreEntry, HiscoreSkill, PlayerStatus, PlayerType } from '@osrs-tracker/models';

/**
 * Total xp of a player who isn't on a table: higher than any real total, so a missing table never compares as less.
 * `determineStatus` (de-ironed, de-ultimated) and `diedAsHardcore` rely on that to only compare tables the player is on.
 */
export const NOT_ON_TABLE_XP = Number.MAX_SAFE_INTEGER;

/** Overall plus the seven combat skills `getCombatLevel` reads by position. */
export const MIN_HISCORE_SKILLS = 8;

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
  static getCombatLevel(skills: HiscoreSkill[]): number {
    // default to level 1 when not found (-1)
    const attack = Math.max(1, skills[1].level);
    const defence = Math.max(1, skills[2].level);
    const strength = Math.max(1, skills[3].level);
    const hitpoints = Math.max(1, skills[4].level);
    const ranged = Math.max(1, skills[5].level);
    const prayer = Math.max(1, skills[6].level);
    const magic = Math.max(1, skills[7].level);

    const base = 0.25 * (defence + hitpoints + Math.floor(prayer / 2));
    const melee = 0.325 * (attack + strength);
    const range = 0.325 * (Math.floor(ranged / 2) + ranged);
    const mage = 0.325 * (Math.floor(magic / 2) + magic);

    return Math.floor(base + Math.max(melee, range, mage));
  }

  /** Whether a hiscore has overall and the combat skills with a numeric level, as `getCombatLevel` reads them. */
  static hasCombatSkills(skills: Pick<HiscoreSkill, 'level'>[]): boolean {
    return (
      skills.length >= MIN_HISCORE_SKILLS &&
      skills.slice(0, MIN_HISCORE_SKILLS).every((skill) => typeof skill?.level === 'number')
    );
  }

  /** Determines the original playerType from the tables the player is on. Only works when the player has enough xp to appear in the hiscores. */
  static determineType(
    ironman: Partial<HiscoreEntry> | null,
    ultimate: Partial<HiscoreEntry> | null,
    hardcore: Partial<HiscoreEntry> | null,
  ): PlayerType {
    if (ultimate) return PlayerType.Ultimate;
    if (hardcore) return PlayerType.Hardcore;
    if (ironman) return PlayerType.Ironman;
    return PlayerType.Normal;
  }

  /** Determines the current playerStatus by comparing total xp across tables. Only works when the player has enough xp to appear in the hiscores. */
  static determineStatus(
    normal: Partial<HiscoreEntry> | null,
    ironman: Partial<HiscoreEntry> | null,
    ultimate: Partial<HiscoreEntry> | null,
  ): PlayerStatus {
    if (PlayerUtils.getTotalXp(ironman) < PlayerUtils.getTotalXp(normal)) return PlayerStatus.DeIroned;
    if (PlayerUtils.getTotalXp(ultimate) < PlayerUtils.getTotalXp(ironman)) return PlayerStatus.DeUltimated;
    return PlayerStatus.Default;
  }

  /** Total xp of a hiscore entry, so we can compare hiscores; `NOT_ON_TABLE_XP` when the player isn't on the table. */
  static getTotalXp(hiscoreEntry: Partial<HiscoreEntry> | null): number {
    return hiscoreEntry?.skills?.[0]?.xp ?? NOT_ON_TABLE_XP;
  }
}
