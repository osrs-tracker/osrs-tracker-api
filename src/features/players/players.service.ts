import { Inject, Injectable, Logger } from '@nestjs/common';
import { HiscoreEntry, Player, PlayerType } from '@osrs-tracker/models';
import { Agent } from 'https';
import { Collection, Db } from 'mongodb';
import fetch from 'node-fetch';
import { PlayerUtils } from './player.utils';

type PartialHiscoreEntry = Pick<HiscoreEntry, 'skills' | 'activities'>;

/**
 * - `found`: the player is on this hiscore table.
 * - `notFound`: HTTP 404 (or 400 for an invalid name), the player is not on this hiscore table.
 * - `failed`: any other status, a network error, a timeout or an unexpected body. Could be an outage.
 */
type HiscoreResult = { status: 'found'; hiscore: PartialHiscoreEntry } | { status: 'notFound' } | { status: 'failed' };

export type RefreshResult = 'refreshed' | 'notFound' | 'failed';

@Injectable()
export class PlayersService {
  private readonly COLLECTION_NAME = 'players';
  private readonly HISCORE_FETCH_TIMEOUT_MS = 10_000;
  private readonly logger = new Logger(PlayersService.name);

  get collection(): Collection<Player> {
    return this.db.collection(this.COLLECTION_NAME);
  }

  constructor(
    @Inject('AGENT') private readonly agent: Agent,
    @Inject('MONGODB_DATABASE') private readonly db: Db,
  ) {}

  async getPlayer(
    _username: string,
    scrapingOffset: number,
    includeLatestHiscoreEntry: boolean,
  ): Promise<Player | null> {
    const username = PlayerUtils.normalizeUsername(_username);

    await this.collection.createIndex({ username: 1 }, { unique: true });

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
          hiscoreEntries: includeLatestHiscoreEntry ? { $elemMatch: { scrapingOffset } } : undefined,
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

    if (includeLatestHiscoreEntry && player) {
      return {
        ...player,
        hiscoreEntries: player.hiscoreEntries?.map((entry) => this.stripSourceStringFromHiscoreEntry(entry)) ?? [],
      };
    }

    return player;
  }

  async getPlayerHiscores(
    _username: string,
    scrapingOffset: number,
    size: number,
    skip: number,
  ): Promise<HiscoreEntry[] | null> {
    const username = PlayerUtils.normalizeUsername(_username);

    await this.recordLookup(username);

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

    return player?.hiscoreEntries?.map((entry) => this.stripSourceStringFromHiscoreEntry(entry)) ?? null;
  }

  /** Records a visitor's lookup for the recent players list. Doesn't create unknown players. */
  async recordLookup(_username: string): Promise<void> {
    const username = PlayerUtils.normalizeUsername(_username);

    await this.collection.createIndex({ username: 1 }, { unique: true });

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
      hiscoreEntries: player.hiscoreEntries?.map((entry) => this.stripSourceStringFromHiscoreEntry(entry)) ?? [],
    }));
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
  async refreshPlayerInfo(_username: string, scrapingOffset: number, initialScrape: boolean): Promise<RefreshResult> {
    const username = PlayerUtils.normalizeUsername(_username);

    // Never upsert a name that isn't a valid OSRS name (e.g. a double URL-encoded one that the hiscores still resolve).
    if (!PlayerUtils.isValidUsername(username)) throw new Error(`Refusing to store invalid username '${username}'`);

    const result = await this.determinePlayerStatusAndType(username);

    if (result.status !== 'found') return result.status;

    const { player, partialHiscoreEntry } = result;

    const hiscoreEntry: HiscoreEntry = {
      scrapingOffset,
      sourceString: 'LEGACY',
      date: new Date(),
      ...partialHiscoreEntry,
    };

    // Aggregation pipeline update, values are wrapped in $literal so strings starting with '$' aren't field paths.
    const { upsertedCount, modifiedCount } = await this.collection.updateOne(
      { username: player.username },
      [
        {
          $set: {
            ...Object.fromEntries(Object.entries(player).map(([key, value]) => [key, { $literal: value }])),
            scrapingOffsets: {
              $setUnion: [
                { $ifNull: ['$scrapingOffsets', []] },
                { $ifNull: ['$pausedScrapingOffsets', []] },
                [scrapingOffset],
              ],
            },
            ...(initialScrape
              ? {
                  // Prepend, entries are stored newest first.
                  hiscoreEntries: {
                    $concatArrays: [[{ $literal: hiscoreEntry }], { $ifNull: ['$hiscoreEntries', []] }],
                  },
                }
              : {}),
          },
        },
        { $unset: ['pausedScrapingOffsets', 'hiscoreNotFoundSince', 'hiscoreNotFoundCount'] },
      ],
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
    _username: string,
  ): Promise<
    { status: 'found'; player: Player; partialHiscoreEntry: PartialHiscoreEntry } | { status: 'notFound' | 'failed' }
  > {
    const username = PlayerUtils.normalizeUsername(_username);

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
      partialHiscoreEntry: normal!,
    };
  }

  private async getHiscore(username: string, type: PlayerType): Promise<HiscoreResult> {
    const hiscoreUrl =
      process.env.OSRS_API_BASE_URL +
      `/m=${PlayerUtils.getHiscoreTable(type)}/index_lite.json?player=${encodeURIComponent(username)}`;

    try {
      const response = await fetch(hiscoreUrl, {
        agent: this.agent,
        headers: { 'cache-control': 'no-cache' },
        signal: AbortSignal.timeout(this.HISCORE_FETCH_TIMEOUT_MS),
      });

      if (response.status === 404 || response.status === 400) return { status: 'notFound' };

      if (!response.ok) {
        this.logger.warn(`Hiscores (${type}) returned HTTP ${response.status} for '${username}'`);
        return { status: 'failed' };
      }

      const hiscore = (await response.json()) as PartialHiscoreEntry;
      if (!Array.isArray(hiscore?.skills)) {
        this.logger.warn(`Hiscores (${type}) returned an unexpected body for '${username}'`);
        return { status: 'failed' };
      }

      return { status: 'found', hiscore };
    } catch (error) {
      this.logger.warn(`Hiscores (${type}) request failed for '${username}': ${(error as Error).message}`);
      return { status: 'failed' };
    }
  }

  /**
   * @deprecated Remove this when we get rid of the sourceString field in the database.
   * If the skills array is not empty, set sourceString to LEGACY, saves a lot of data.
   */
  private stripSourceStringFromHiscoreEntry(hiscoreEntry: HiscoreEntry): HiscoreEntry {
    return {
      ...hiscoreEntry,
      sourceString: hiscoreEntry.skills?.length > 0 ? 'LEGACY' : hiscoreEntry.sourceString,
    };
  }
}
