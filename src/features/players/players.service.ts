import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BulkheadFullError, CircuitOpenError, ResiliencePolicy, ResilienceService } from '@nestjs/resilience';
import { getHiscore, HiscoreResult } from '@osrs-tracker/hiscores';
import {
  encodeHiscoreEntry,
  HiscoreEntry,
  HiscoreLayoutNames,
  Player,
  PlayerType,
  StoredPlayer,
} from '@osrs-tracker/models';
import { LRUCache } from 'lru-cache';
import { Collection, Db } from 'mongodb';
import { Agent, fetch } from 'undici';
import { AGENT } from '../../common/agent/agent.provider';
import { MONGODB_DATABASE } from '../../common/mongo/mongo.provider';
import { Env } from '../../config/env';
import { HiscoreLayoutsService } from './hiscore-layouts.service';
import { JAGEX_HISCORES, NOT_FOUND_CACHE_MAX, NOT_FOUND_CACHE_TTL_MS } from './player.config';
import { buildLookupUpdate, buildRefreshUpdate } from './player.policy';
import { PlayerUtils } from './player.utils';

type PartialHiscoreEntry = Pick<HiscoreEntry, 'skills' | 'activities'>;

/** A hiscore request that answered `failed`, thrown inside the policy so its circuit breaker counts it. */
class HiscoreFailedError extends Error {}

export type RefreshResult = 'refreshed' | 'notFound' | 'failed';

type PlayerStatusAndType =
  | { status: 'found'; player: Player; partialHiscoreEntry: PartialHiscoreEntry; layout: HiscoreLayoutNames }
  | { status: 'notFound' | 'failed' };

/** Usernames passed in are expected normalized, as `ParseUsernamePipe` returns them. */
@Injectable()
export class PlayersService {
  private readonly COLLECTION_NAME = 'players';
  private readonly logger = new Logger(PlayersService.name);

  /**
   * Caps the requests to Jagex, so a burst of lookups can't get the proxy (shared with process-players) throttled, and
   * stops asking while Jagex is down (`JAGEX_HISCORES_PRESET`).
   */
  private readonly hiscoresPolicy: ResiliencePolicy;
  /** Hiscore lookups in flight by username, shared by concurrent previews and refreshes of one name. */
  private readonly pendingLookups = new Map<string, Promise<PlayerStatusAndType>>();
  /** Names recently not on the hiscores, so repeated previews (crawlers, SSR) don't ask Jagex again. */
  private readonly notFoundNames = new LRUCache<string, true>({
    max: NOT_FOUND_CACHE_MAX,
    ttl: NOT_FOUND_CACHE_TTL_MS,
  });

  get collection(): Collection<StoredPlayer> {
    return this.db.collection(this.COLLECTION_NAME);
  }

  constructor(
    @Inject(AGENT) private readonly agent: Agent,
    @Inject(MONGODB_DATABASE) private readonly db: Db,
    private readonly config: ConfigService<Env, true>,
    private readonly layouts: HiscoreLayoutsService,
    resilience: ResilienceService,
  ) {
    this.hiscoresPolicy = resilience.preset(JAGEX_HISCORES);
  }

  async getPlayer(
    username: string,
    scrapingOffset: number,
    includeLatestHiscoreEntry: boolean,
  ): Promise<Player | null> {
    const player = await this.collection.findOne<StoredPlayer>(
      { username: username },
      {
        hint: { username: 1 },
        projection: {
          _id: 0,
          username: 1,
          combatLevel: 1,
          diedAsHardcore: 1,
          lastModified: 1,
          status: 1,
          type: 1,
          scrapingOffsets: 1,
          pausedScrapingOffsets: 1, // Still tracked (they have a history), resumed by the next successful refresh
          ...(includeLatestHiscoreEntry ? { hiscoreEntries: { $elemMatch: { o: scrapingOffset } } } : {}),
          // Date of the oldest stored entry for this offset (entries are stored newest first). The clean-hiscores Lambda
          // removes entries older than MAX_AGE_IN_DAYS, so this is where the history starts, not when tracking started.
          trackedSince: {
            $ifNull: [
              {
                $getField: {
                  field: 'd',
                  input: {
                    $last: {
                      $filter: {
                        input: { $ifNull: ['$hiscoreEntries', []] },
                        as: 'entry',
                        cond: { $eq: ['$$entry.o', scrapingOffset] },
                      },
                    },
                  },
                },
              },
              null,
            ],
          },
        },
      },
    );

    if (!player) return null;

    const { hiscoreEntries, ...rest } = player;
    // The newest entry for an offset is always stored in full, so it decodes on its own
    return includeLatestHiscoreEntry
      ? { ...rest, hiscoreEntries: await this.layouts.decode(hiscoreEntries ?? []) }
      : rest;
  }

  async getPlayerHiscores(
    username: string,
    scrapingOffset: number,
    size: number,
    skip: number,
  ): Promise<HiscoreEntry[] | null> {
    const player = await this.collection
      .aggregate<StoredPlayer>(
        [
          { $match: { username: username } },
          {
            $project: {
              _id: 0,
              username: 1,
              hiscoreEntries: {
                $slice: [
                  {
                    $filter: {
                      input: '$hiscoreEntries',
                      as: 'entry',
                      cond: { $eq: ['$$entry.o', scrapingOffset] },
                    },
                  },
                  // From the newest: an unchanged value is stored as a bare rank, resolved from a newer entry
                  0,
                  skip + size,
                ],
              },
            },
          },
        ],
        { hint: { username: 1 } },
      )
      .next();

    if (!player?.hiscoreEntries) return null;

    return (await this.layouts.decode(player.hiscoreEntries)).slice(skip);
  }

  /**
   * Records a visitor's lookup for the recent players list and for `scrapingOffset` (`buildLookupUpdate`). Doesn't
   * create unknown players.
   */
  async recordLookup(username: string, scrapingOffset: number): Promise<void> {
    await this.collection.updateOne({ username: username }, buildLookupUpdate(scrapingOffset, new Date()), {
      hint: { username: 1 },
    });
  }

  /**
   * Returns the most recently looked up players with their newest hiscore entry, for `scrapingOffset` when given or for
   * any offset otherwise.
   */
  async getLastFetchedPlayers(limit: number, scrapingOffset?: number): Promise<Player[]> {
    const players = await this.collection
      .aggregate<StoredPlayer>(
        [
          { $match: { lastHiscoreFetch: { $exists: true } } }, // Ensure lastHiscoreFetch exists
          { $sort: { lastHiscoreFetch: -1 } }, // Sort by lastHiscoreFetch in descending order
          { $limit: limit },
          {
            $project: {
              _id: 0,
              username: 1,
              combatLevel: 1,
              diedAsHardcore: 1,
              lastModified: 1,
              status: 1,
              type: 1,
              scrapingOffsets: 1,
              hiscoreEntries: {
                $slice: [
                  scrapingOffset === undefined
                    ? { $ifNull: ['$hiscoreEntries', []] }
                    : {
                        $filter: {
                          input: { $ifNull: ['$hiscoreEntries', []] },
                          as: 'entry',
                          cond: { $eq: ['$$entry.o', scrapingOffset] },
                        },
                      },
                  1,
                ],
              },
            },
          },
        ],
        { hint: { lastHiscoreFetch: -1 } }, // Use the index on lastHiscoreFetch
      )
      .toArray();

    // Each player's first entry is the newest for its offset, so always stored in full
    return Promise.all(
      players.map(async (player) => ({
        ...player,
        hiscoreEntries: await this.layouts.decode(player.hiscoreEntries ?? []),
      })),
    );
  }

  /**
   * Builds a live preview of a player that isn't stored, straight from the hiscores, without storing anything. Shaped
   * like `getPlayer`, with no `scrapingOffsets` and no `trackedSince`.
   *
   * @returns `notFound` when the player isn't on the normal hiscores, `failed` when the hiscores couldn't be reached.
   */
  async previewPlayer(
    username: string,
    scrapingOffset: number,
    includeLatestHiscoreEntry: boolean,
  ): Promise<{ status: 'found'; player: Player } | { status: 'notFound' | 'failed' }> {
    if (this.notFoundNames.has(username)) return { status: 'notFound' };

    const result = await this.determinePlayerStatusAndType(username);

    if (result.status === 'notFound') this.notFoundNames.set(username, true);
    if (result.status !== 'found') return result;

    const { player, partialHiscoreEntry } = result;

    return {
      status: 'found',
      player: {
        ...player,
        scrapingOffsets: [],
        trackedSince: null,
        ...(includeLatestHiscoreEntry
          ? {
              hiscoreEntries: [{ scrapingOffset, date: player.lastModified, ...partialHiscoreEntry }],
            }
          : {}),
      },
    };
  }

  /**
   * Refreshes the player info for the given `username`.
   *
   * Pause/resume contract with the `process-players` Lambda (osrs-tracker-aws): the Lambda owns the not-found
   * bookkeeping (`hiscoreNotFoundCount`, `hiscoreNotFoundSince`) and, after 7 days of 404s, moves `scrapingOffsets`
   * into `pausedScrapingOffsets` so the player is no longer queued. A successful refresh here resumes tracking by
   * merging the paused offsets back and removing the pause fields. A refresh that isn't `refreshed` writes nothing and
   * leaves them untouched: the Lambda does the 404 counting.
   *
   * @param scrapingOffset Added to the player's `scrapingOffsets` if not already present, with an initial `hiscoreEntry`.
   * @returns `notFound` when the player isn't on the normal hiscores, `failed` when the hiscores couldn't be reached.
   */
  async refreshPlayerInfo(username: string, scrapingOffset: number): Promise<RefreshResult> {
    // Never upsert a name that isn't a valid OSRS name (e.g. a double URL-encoded one that the hiscores still resolve).
    if (!PlayerUtils.isValidUsername(username)) throw new Error(`Refusing to store invalid username '${username}'`);

    const result = await this.determinePlayerStatusAndType(username);

    if (result.status !== 'found') return result.status;

    const { player, partialHiscoreEntry, layout } = result;

    const hiscoreEntry: HiscoreEntry = {
      scrapingOffset,
      date: new Date(),
      ...partialHiscoreEntry,
    };
    // Stores the layout before the entry that refers to it
    const storedEntry = encodeHiscoreEntry(hiscoreEntry, await this.layouts.ensure(layout));

    const { upsertedCount, matchedCount } = await this.collection.updateOne(
      { username: player.username },
      buildRefreshUpdate(player, storedEntry, scrapingOffset),
      {
        upsert: true,
        hint: { username: 1 },
      },
    );

    // Not `modifiedCount`: concurrent lookups share one hiscore result, so the second update can change nothing
    if (!upsertedCount && !matchedCount) throw new Error('Player failed to be upserted');

    return 'refreshed';
  }

  /** Shares the lookup of `username` with any already in flight, so concurrent requests for one name ask Jagex once. */
  private determinePlayerStatusAndType(username: string): Promise<PlayerStatusAndType> {
    let pending = this.pendingLookups.get(username);
    if (!pending) {
      pending = this.fetchPlayerStatusAndType(username).finally(() => this.pendingLookups.delete(username));
      this.pendingLookups.set(username, pending);
    }
    return pending;
  }

  /**
   * Determines the player's type and status from the four hiscore tables: the normal table first, which settles
   * `notFound` and `failed` in one request, then the three ironman tables. Fails when any table couldn't be reached,
   * since a missing table would otherwise look like the player not being on it and change their type.
   */
  private async fetchPlayerStatusAndType(username: string): Promise<PlayerStatusAndType> {
    const normalResult = await this.getHiscore(username, PlayerType.Normal);
    if (normalResult.status !== 'found') return { status: normalResult.status };

    const results = await Promise.all([
      this.getHiscore(username, PlayerType.Ironman),
      this.getHiscore(username, PlayerType.Ultimate),
      this.getHiscore(username, PlayerType.Hardcore),
    ]);

    if (results.some((result) => result.status === 'failed')) return { status: 'failed' };

    const normal = normalResult.hiscore;
    const [ironman, ultimate, hardcore] = results.map((result) => (result.status === 'found' ? result.hiscore : null));

    return {
      status: 'found',
      player: {
        username,
        combatLevel: PlayerUtils.getCombatLevel(normal.skills),
        type: PlayerUtils.determineType(ironman, ultimate, hardcore),
        status: PlayerUtils.determineStatus(normal, ironman, ultimate),
        diedAsHardcore: PlayerUtils.getTotalXp(hardcore) < PlayerUtils.getTotalXp(ironman),
        lastModified: new Date(),
      } as Player,
      partialHiscoreEntry: { skills: normal.skills, activities: normal.activities },
      layout: normalResult.layout,
    };
  }

  /**
   * Fetches one hiscore table with the shared client from `@osrs-tracker/hiscores` (see its `HiscoreResult`), through
   * the shared agent and the `jagex-hiscores` policy, and logs why it failed. A request the policy refuses (queue full,
   * circuit open) is `failed` too, without asking Jagex, and isn't logged here: `ResilienceEventsListener` logs the
   * circuit opening and bulkhead rejections (throttled), so an outage doesn't log a line per lookup.
   */
  private async getHiscore(username: string, type: PlayerType): Promise<HiscoreResult> {
    try {
      return await this.hiscoresPolicy.execute(async ({ signal }): Promise<HiscoreResult> => {
        const result = await getHiscore({
          baseUrl: this.config.get('OSRS_API_BASE_URL', { infer: true }),
          username,
          table: PlayerUtils.getHiscoreTable(type),
          fetch: (url, init) =>
            fetch(url, { ...init, dispatcher: this.agent, signal: AbortSignal.any([init.signal, signal]) }),
        });

        // The package only checks that `skills` is an array: a truncated hiscore would store a wrong combat level, so it
        // counts as failed like any other bad response
        if (result.status === 'found' && !PlayerUtils.hasCombatSkills(result.hiscore.skills)) {
          throw new HiscoreFailedError('missing combat skills');
        }
        if (result.status === 'failed') throw new HiscoreFailedError(result.reason);

        return result; // Found or not found: both mean Jagex answered
      });
    } catch (error) {
      if (error instanceof BulkheadFullError) {
        const reason = error.reason === 'full' ? 'too many requests queued' : 'timed out waiting for a request slot';
        return { status: 'failed', reason };
      }
      if (error instanceof CircuitOpenError) {
        return {
          status: 'failed',
          reason: `circuit open, Jagex is asked again in ${Math.ceil(error.retryAfterMs / 1000)}s`,
        };
      }
      if (!(error instanceof HiscoreFailedError)) throw error;

      this.logger.warn(`Hiscores (${type}) failed for '${username}': ${error.message}`);
      return { status: 'failed', reason: error.message };
    }
  }
}
