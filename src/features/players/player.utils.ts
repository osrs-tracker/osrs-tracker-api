import { PlayerStatus, PlayerType } from '@osrs-tracker/models';

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
  static getCombatLevel(sourceString: string): number {
    const hiscoreLines = sourceString.split('\n');

    // default to level 1 when not found (-1)
    const attack = Math.max(1, parseInt(hiscoreLines[1].split(',')[1]));
    const defence = Math.max(1, parseInt(hiscoreLines[2].split(',')[1]));
    const strength = Math.max(1, parseInt(hiscoreLines[3].split(',')[1]));
    const hitpoints = Math.max(1, parseInt(hiscoreLines[4].split(',')[1]));
    const ranged = Math.max(1, parseInt(hiscoreLines[5].split(',')[1]));
    const prayer = Math.max(1, parseInt(hiscoreLines[6].split(',')[1]));
    const magic = Math.max(1, parseInt(hiscoreLines[7].split(',')[1]));

    const base = 0.25 * (defence + hitpoints + Math.floor(prayer / 2));
    const melee = 0.325 * (attack + strength);
    const range = 0.325 * (Math.floor(ranged / 2) + ranged);
    const mage = 0.325 * (Math.floor(magic / 2) + magic);

    return Math.floor(base + Math.max(melee, range, mage));
  }

  /** Analyses sourceString to determine original playerType. Only works when the player has enough xp to appear in the hiscores. */
  static determineType(ironman: string | null, ultimate: string | null, hardcore: string | null): PlayerType {
    if (ultimate) return PlayerType.Ultimate;
    if (hardcore) return PlayerType.Hardcore;
    if (ironman) return PlayerType.Ironman;
    return PlayerType.Normal;
  }

  /** Analyses sourceString to determine current playerStatus. Only works when the player has enough xp to appear in the hiscores. */
  static determineStatus(normal: string | null, ironman: string | null, ultimate: string | null): PlayerStatus {
    if (PlayerUtils.getTotalXp(ironman) < PlayerUtils.getTotalXp(normal)) return PlayerStatus.DeIroned;
    if (PlayerUtils.getTotalXp(ultimate) < PlayerUtils.getTotalXp(ironman)) return PlayerStatus.DeUltimated;
    return PlayerStatus.Default;
  }

  /** Transforms sourceString into totalXp, so we can use it to compare hiscores. */
  static getTotalXp(hiscoreLines: string | null): number {
    if (!hiscoreLines) return Number.MAX_SAFE_INTEGER;

    return Number(hiscoreLines.split('\n')[0].split(',')[2]);
  }
}
