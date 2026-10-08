import { HiscoreEntry, HiscoreSkill, PlayerStatus, PlayerType } from '@osrs-tracker/models';

export class PlayerUtils {
  /** OSRS display names: 1-12 letters, numbers, spaces, hyphens and underscores (after normalizing to lowercase). */
  private static readonly USERNAME_REGEX = /^[a-z0-9 _-]{1,12}$/;

  static normalizeUsername(username: string): string {
    return username.trim().toLowerCase();
  }

  static isValidUsername(username: string): boolean {
    return PlayerUtils.USERNAME_REGEX.test(username);
  }

  /** Resolve correct hiscore table for `PlayerType`. */
  static getHiscoreTable(type: PlayerType): string {
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

  /** Calculates the combat level from the skills. */
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

  /** Total xp of a hiscore entry, so we can compare hiscores. */
  static getTotalXp(hiscoreEntry: Partial<HiscoreEntry> | null): number {
    return hiscoreEntry?.skills?.[0]?.xp ?? Number.MAX_SAFE_INTEGER;
  }
}
