import { Inject, Injectable } from '@nestjs/common';
import { HiscoreEntry, Player, PlayerType } from '@osrs-tracker/models';
import { Agent } from 'https';
import { Collection, Db } from 'mongodb';
import fetch from 'node-fetch';
import { PlayerUtils } from './player.utils';

@Injectable()
export class PlayersService {
  private readonly COLLECTION_NAME = 'players';

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
    const username = this.normalizeUsername(_username);

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
        },
      },
    );

    return player;
  }

  async getPlayerHiscores(
    _username: string,
    scrapingOffset: number,
    size: number,
    skip: number,
  ): Promise<HiscoreEntry[] | null> {
    const username = this.normalizeUsername(_username);

    await this.collection.createIndex({ username: 1 }, { unique: true });

    await this.collection.updateOne(
      { username: username },
      { $set: { lastHiscoreFetch: new Date() } },
      { hint: { username: 1 } },
    );

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

  getLastFetchedPlayers(limit: number): Promise<Player[]> {
    return this.collection
      .find<Player>(
        {
          lastHiscoreFetch: { $exists: true }, // Ensure lastHiscoreFetch exists
        },
        {
          hint: { lastHiscoreFetch: -1 }, // Use the index on lastHiscoreFetch
          projection: {
            _id: 0,
            username: 1,
            combatLevel: 1,
            diedAsHardcore: 1,
            lastModified: 1,
            status: 1,
            type: 1,
            scrapingOffsets: 1,
            hiscoreEntries: { $slice: 1 },
          },
        },
      )
      .sort({ lastHiscoreFetch: -1 }) // Sort by lastHiscoreFetch in descending order
      .limit(limit)
      .toArray();
  }

  /**
   * Refreshes the player info for the given `username`.
   *
   * @param scrapingOffset The `scrapingOffset` will be added to the player's `scrapingOffsets` if not already present.
   * @param initialScrape If true, will also add an initial `hiscoreEntry` for this `scrapingOffset`.
   */
  async refreshPlayerInfo(_username: string, scrapingOffset: number, initialScrape: boolean): Promise<boolean> {
    const username = this.normalizeUsername(_username);

    const [player, sourceString] = await this.determinePlayerStatusAndType(username);

    if (player === null) return false;

    const { upsertedCount, modifiedCount } = await this.collection.updateOne(
      { username: player.username },
      {
        $set: player,
        $addToSet: { scrapingOffsets: scrapingOffset },
        ...(initialScrape ? { $push: { hiscoreEntries: { scrapingOffset, sourceString, date: new Date() } } } : {}),
      },
      {
        upsert: true,
        hint: { username: 1 },
      },
    );

    if (!upsertedCount && !modifiedCount) throw new Error('Player failed to be upserted');

    return true;
  }

  /** Returns determined player if determined, and normal sourceString, */
  private async determinePlayerStatusAndType(_username: string): Promise<[Player | null, string]> {
    const username = this.normalizeUsername(_username);

    const [normal, ironman, ultimate, hardcore] = await Promise.all([
      this.getHiscore(username, PlayerType.Normal),
      this.getHiscore(username, PlayerType.Ironman),
      this.getHiscore(username, PlayerType.Ultimate),
      this.getHiscore(username, PlayerType.Hardcore),
    ]);

    if (normal === null) return [null, ''];

    return [
      {
        username,
        combatLevel: PlayerUtils.getCombatLevel(normal),
        type: PlayerUtils.determineType(ironman, ultimate, hardcore),
        status: PlayerUtils.determineStatus(normal, ironman, ultimate),
        diedAsHardcore: PlayerUtils.getTotalXp(hardcore) < PlayerUtils.getTotalXp(ironman),
        lastModified: new Date(),
      } as Player,
      normal,
    ];
  }

  private async getHiscore(username: string, type: PlayerType): Promise<string | null> {
    const hiscoreUrl =
      process.env.OSRS_API_BASE_URL + `/m=${PlayerUtils.getHiscoreTable(type)}/index_lite.ws?player=${username}`;

    const result = await fetch(hiscoreUrl, { agent: this.agent, headers: { 'cache-control': 'no-cache' } });
    return result.ok ? result.text() : null;
  }

  private normalizeUsername(username: string): string {
    return username.trim().toLowerCase();
  }
}
