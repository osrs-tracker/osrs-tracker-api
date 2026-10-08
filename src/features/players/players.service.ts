import { Inject, Injectable, Logger } from '@nestjs/common';
import { getHiscore, HiscoreResult } from '@osrs-tracker/hiscores';
import { HiscoreEntry, Player, PlayerType } from '@osrs-tracker/models';
import { Agent } from 'https';
import { Collection, Db } from 'mongodb';
import fetch from 'node-fetch';
import { buildRefreshUpdate } from './player.policy';
import { PlayerUtils } from './player.utils';

type PartialHiscoreEntry = Pick<HiscoreEntry, 'skills' | 'activities'>;

export type RefreshResult = 'refreshed' | 'notFound' | 'failed';

/** Usernames passed in are expected normalized, as `ParseUsernamePipe` returns them. */
@Injectable()
export class PlayersService {
  private readonly COLLECTION_NAME = 'players';
  private readonly logger = new Logger(PlayersService.name);

  get collection(): Collection<Player> {
    return this.db.collection(this.COLLECTION_NAME);
  }

  constructor(
    @Inject('AGENT') private readonly agent: Agent,
    @Inject('MONGODB_DATABASE') private readonly db: Db,
  ) {}

  async getPlayer(
    username: string,
    scrapingOffset: number,
    includeLatestHiscoreEntry: boolean,
  ): Promise<Player | null> {
    const player = await this.collection.findOne<Player>(
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
          ...(includeLatestHiscoreEntry ? { hiscoreEntries: { $elemMatch: { scrapingOffset } } } : {}),
          // Date of the oldest stored entry for this offset (entries are stored newest first). The clean-hiscores Lambda
          // removes entries older than MAX_AGE_IN_DAYS, so this is where the history starts, not when tracking started.
          trackedSince: {
            $ifNull: [
              {
                $getField: {
                  field: 'date',
                  input: {
                    $last: {
                      $filter: {
                        input: { $ifNull: ['$hiscoreEntries', []] },
                        as: 'entry',
                        cond: { $eq: ['$$entry.scrapingOffset', scrapingOffset] },
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

    if (includeLatestHiscoreEntry && player) return { ...player, hiscoreEntries: player.hiscoreEntries ?? [] };

    return player;
  }

  async getPlayerHiscores(
    username: string,
    scrapingOffset: number,
    size: number,
    skip: number,
  ): Promise<HiscoreEntry[] | null> {
    // Retrieve the player's hiscores
    const player = await this.collection
      .aggregate<Player>([
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
                    cond: { $eq: ['$$entry.scrapingOffset', scrapingOffset] },
                  },
                },
                skip,
                size,
              ],
            },
          },
        },
      ])
      .next();

    return player?.hiscoreEntries ?? null;
  }

  /** Records a visitor's lookup for the recent players list. Doesn't create unknown players. */
  async recordLookup(username: string): Promise<void> {
    await this.collection.updateOne(
      { username: username },
      { $set: { lastHiscoreFetch: new Date() } },
      { hint: { username: 1 } },
    );
  }

  /**
   * Returns the most recently looked up players with their newest hiscore entry, for `scrapingOffset` when given or for
   * any offset otherwise.
   */
  async getLastFetchedPlayers(limit: number, scrapingOffset?: number): Promise<Player[]> {
    const players = await this.collection
      .aggregate<Player>(
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
                          cond: { $eq: ['$$entry.scrapingOffset', scrapingOffset] },
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

    return players.map((player) => ({
      ...player,
      hiscoreEntries: player.hiscoreEntries ?? [],
    }));
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
    const result = await this.determinePlayerStatusAndType(username);

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
   * @param scrapingOffset The `scrapingOffset` will be added to the player's `scrapingOffsets` if not already present.
   * @param initialScrape If true, will also add an initial `hiscoreEntry` for this `scrapingOffset`.
   * @returns `notFound` when the player isn't on the normal hiscores, `failed` when the hiscores couldn't be reached.
   */
  async refreshPlayerInfo(username: string, scrapingOffset: number, initialScrape: boolean): Promise<RefreshResult> {
    // Never upsert a name that isn't a valid OSRS name (e.g. a double URL-encoded one that the hiscores still resolve).
    if (!PlayerUtils.isValidUsername(username)) throw new Error(`Refusing to store invalid username '${username}'`);

    const result = await this.determinePlayerStatusAndType(username);

    if (result.status !== 'found') return result.status;

    const { player, partialHiscoreEntry } = result;

    const hiscoreEntry: HiscoreEntry = {
      scrapingOffset,
      date: new Date(),
      ...partialHiscoreEntry,
    };

    const { upsertedCount, modifiedCount } = await this.collection.updateOne(
      { username: player.username },
      buildRefreshUpdate(player, hiscoreEntry, scrapingOffset, initialScrape),
      {
        upsert: true,
        hint: { username: 1 },
      },
    );

    if (!upsertedCount && !modifiedCount) throw new Error('Player failed to be upserted');

    return 'refreshed';
  }

  /**
   * Determines the player's type and status from the four hiscore tables. Fails when any table couldn't be reached,
   * since a missing table would otherwise look like the player not being on it and change their type.
   */
  private async determinePlayerStatusAndType(
    username: string,
  ): Promise<
    { status: 'found'; player: Player; partialHiscoreEntry: PartialHiscoreEntry } | { status: 'notFound' | 'failed' }
  > {
    const results = await Promise.all([
      this.getHiscore(username, PlayerType.Normal),
      this.getHiscore(username, PlayerType.Ironman),
      this.getHiscore(username, PlayerType.Ultimate),
      this.getHiscore(username, PlayerType.Hardcore),
    ]);

    if (results[0].status === 'notFound') return { status: 'notFound' };
    if (results.some((result) => result.status === 'failed')) return { status: 'failed' };

    const [normal, ironman, ultimate, hardcore] = results.map((result) =>
      result.status === 'found' ? result.hiscore : null,
    );

    return {
      status: 'found',
      player: {
        username,
        combatLevel: PlayerUtils.getCombatLevel(normal!.skills),
        type: PlayerUtils.determineType(ironman, ultimate, hardcore),
        status: PlayerUtils.determineStatus(normal, ironman, ultimate),
        diedAsHardcore: PlayerUtils.getTotalXp(hardcore) < PlayerUtils.getTotalXp(ironman),
        lastModified: new Date(),
      } as Player,
      // Only what the model stores, like process-players (the hiscores JSON also echoes the queried `name`).
      partialHiscoreEntry: { skills: normal!.skills, activities: normal!.activities },
    };
  }

  /**
   * Fetches one hiscore table with the shared client from `@osrs-tracker/hiscores` (see its `HiscoreResult`), through
   * the shared agent, and logs why it failed.
   */
  private async getHiscore(username: string, type: PlayerType): Promise<HiscoreResult> {
    const result = await getHiscore({
      baseUrl: process.env.OSRS_API_BASE_URL!,
      username,
      table: PlayerUtils.getHiscoreTable(type),
      fetch: (url, init) => fetch(url, { ...init, agent: this.agent }),
    });

    if (result.status === 'failed') this.logger.warn(`Hiscores (${type}) failed for '${username}': ${result.reason}`);

    return result;
  }
}
