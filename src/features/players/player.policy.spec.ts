import {
  hiscoreEntriesWriteExpression,
  Player,
  PlayerStatus,
  PlayerType,
  StoredHiscoreEntry,
} from '@osrs-tracker/models';
import { describe, expect, it } from 'vitest';
import { buildRefreshUpdate, needsRefresh, playerMaxAgeSeconds } from './player.policy';

const NOW = new Date('2026-10-08T12:00:00Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

const player = (overrides: Partial<Player> = {}): Player => ({
  username: 'toxsick',
  combatLevel: 3,
  type: PlayerType.Normal,
  status: PlayerStatus.Default,
  diedAsHardcore: false,
  lastModified: minutesAgo(10),
  scrapingOffsets: [0],
  ...overrides,
});

describe('playerMaxAgeSeconds', () => {
  it('caps a fresh player at 15 minutes', () => {
    expect(playerMaxAgeSeconds(NOW, NOW)).toBe(900);
  });

  it('stops at the start of the refresh window', () => {
    expect(playerMaxAgeSeconds(minutesAgo(115), NOW)).toBe(300);
  });

  it('is 0 for a stale player', () => {
    expect(playerMaxAgeSeconds(minutesAgo(120), NOW)).toBe(0);
    expect(playerMaxAgeSeconds(minutesAgo(600), NOW)).toBe(0);
  });

  it('caps a lastModified in the future (clock skew) at 15 minutes', () => {
    expect(playerMaxAgeSeconds(minutesAgo(-60), NOW)).toBe(900);
  });
});

describe('needsRefresh', () => {
  it('refreshes an unknown player', () => {
    expect(needsRefresh(null, 0, NOW)).toBe(true);
  });

  it('refreshes a player not tracked for the offset', () => {
    expect(needsRefresh(player({ scrapingOffsets: undefined }), 0, NOW)).toBe(true);
    expect(needsRefresh(player({ scrapingOffsets: [1] }), 0, NOW)).toBe(true);
  });

  it('refreshes a player once the refresh window starts', () => {
    expect(needsRefresh(player({ lastModified: minutesAgo(119) }), 0, NOW)).toBe(false);
    expect(needsRefresh(player({ lastModified: minutesAgo(120) }), 0, NOW)).toBe(true);
  });

  it("doesn't refresh a fresh, tracked player", () => {
    expect(needsRefresh(player({ scrapingOffsets: [-5, 0] }), 0, NOW)).toBe(false);
  });
});

describe('buildRefreshUpdate', () => {
  const entry: StoredHiscoreEntry = { d: NOW, o: 0, l: 1, s: [], a: [] };

  it('resumes a paused player, adds the offset and writes the compact initial entry when the offset is new', () => {
    const refreshed = player({ username: 'toxsick', lastModified: NOW });

    expect(buildRefreshUpdate(refreshed, entry, 3)).toEqual([
      {
        $set: {
          username: { $literal: 'toxsick' },
          combatLevel: { $literal: 3 },
          type: { $literal: PlayerType.Normal },
          status: { $literal: PlayerStatus.Default },
          diedAsHardcore: { $literal: false },
          lastModified: { $literal: NOW },
          scrapingOffsets: {
            $setUnion: [{ $ifNull: ['$scrapingOffsets', []] }, { $ifNull: ['$pausedScrapingOffsets', []] }, [3]],
          },
          hiscoreEntries: {
            $cond: [
              { $in: [3, { $ifNull: ['$scrapingOffsets', []] }] },
              '$hiscoreEntries',
              hiscoreEntriesWriteExpression(entry),
            ],
          },
        },
      },
      { $unset: ['pausedScrapingOffsets', 'hiscoreNotFoundSince', 'hiscoreNotFoundCount'] },
    ]);
  });

  it('always unsets the pause fields', () => {
    const [{ $set }, unset] = buildRefreshUpdate(player(), entry, 0);

    expect($set.scrapingOffsets.$setUnion).toContainEqual({ $ifNull: ['$pausedScrapingOffsets', []] });
    expect(unset).toEqual({ $unset: ['pausedScrapingOffsets', 'hiscoreNotFoundSince', 'hiscoreNotFoundCount'] });
  });

  it("wraps every player value in $literal, so '$' strings aren't read as field paths", () => {
    const [{ $set }] = buildRefreshUpdate(player({ username: '$hiscoreEntries' }), entry, 0);

    expect($set.username).toEqual({ $literal: '$hiscoreEntries' });
  });
});
