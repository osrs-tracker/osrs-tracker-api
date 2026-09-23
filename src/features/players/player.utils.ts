import { HiscoreEntry, HiscoreSkill, PlayerStatus, PlayerType } from '@osrs-tracker/models';

export class PlayerUtils {
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

  /** Transforms sourceString into combatLevel. */
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

  /** Analyses sourceString to determine original playerType. Only works when the player has enough xp to appear in the hiscores. */
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

  /** Analyses sourceString to determine current playerStatus. Only works when the player has enough xp to appear in the hiscores. */
  static determineStatus(
    normal: Partial<HiscoreEntry> | null,
    ironman: Partial<HiscoreEntry> | null,
    ultimate: Partial<HiscoreEntry> | null,
  ): PlayerStatus {
    if (PlayerUtils.getTotalXp(ironman) < PlayerUtils.getTotalXp(normal)) return PlayerStatus.DeIroned;
    if (PlayerUtils.getTotalXp(ultimate) < PlayerUtils.getTotalXp(ironman)) return PlayerStatus.DeUltimated;
    return PlayerStatus.Default;
  }

  /** Transforms sourceString into totalXp, so we can use it to compare hiscores. */
  static getTotalXp(hiscoreEntry: Partial<HiscoreEntry> | null): number {
    console.log(hiscoreEntry?.skills?.[0]?.xp);
    return hiscoreEntry?.skills?.[0]?.xp ?? Number.MAX_SAFE_INTEGER;
  }
}
