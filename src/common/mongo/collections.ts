/**
 * The collections the API reads and writes. Their fields, writers and index owners are in osrs-tracker-aws's
 * `DATA-MODEL.md`; the API's own indexes are created in `mongo.provider.ts`.
 */
export const PLAYERS_COLLECTION = 'players';
/** The skill and activity names stored hiscore entries refer to (`HiscoreLayoutsService`). */
export const HISCORE_LAYOUTS_COLLECTION = 'hiscoreLayouts';
export const ITEMS_COLLECTION = 'items';
/** The stored news posts, keyed on `link`. */
export const NEWS_COLLECTION = 'news';
/** The player count samples, written every 10 minutes by osrs-tracker-aws. */
export const PLAYER_COUNTS_COLLECTION = 'playerCounts';
/** One document per UTC day of player count averages and peak, recomputed by osrs-tracker-aws after every sample. */
export const PLAYER_COUNTS_DAILY_COLLECTION = 'playerCountsDaily';
/** One document per ingester job, `_id` its name, with when it last succeeded (`JobRunsService`). */
export const JOB_RUNS_COLLECTION = 'jobRuns';
