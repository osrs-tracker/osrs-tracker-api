import { StoredPlayer } from '@osrs-tracker/models';
import { Document, Filter } from 'mongodb';

/** The players `dropUnusedScrapingOffsetsPipeline` runs on: those with an offset, active or paused. */
export const HAS_SCRAPING_OFFSETS: Filter<StoredPlayer> = {
  $or: [{ 'scrapingOffsets.0': { $exists: true } }, { 'pausedScrapingOffsets.0': { $exists: true } }],
};

/** The players `deletePlayersWithoutEntries` deletes: none left after the pull, or never any. */
export const HAS_NO_HISCORE_ENTRIES: Filter<StoredPlayer> = {
  $or: [{ hiscoreEntries: { $exists: false } }, { hiscoreEntries: { $size: 0 } }],
};

/** The temporary fields `dropUnusedScrapingOffsetsPipeline` sets, to unset when it's used as an update. */
export const DROP_PIPELINE_FIELDS = ['_lookups', '_keep', '_dropped'];

/**
 * Pipeline that drops the scraping offsets (active or paused) nobody looked up since `cutoff`, together with all their
 * hiscore entries, but always keeps the most recently looked up one, and leaves the dropped offsets in `_dropped`. An
 * offset without a lookup date gets `now`, so offsets from before the API recorded lookups (or merged back from a
 * pause) count from their first run. Ported from clean-hiscores (osrs-tracker-aws `MU.dropUnusedScrapingOffsets`).
 */
export function dropUnusedScrapingOffsetsPipeline(cutoff: Date, now: Date): Document[] {
  const offsets = { $setUnion: [{ $ifNull: ['$scrapingOffsets', []] }, { $ifNull: ['$pausedScrapingOffsets', []] }] };
  const lookupOf = (offset: unknown) => ({
    $getField: { field: { $toString: offset }, input: { $ifNull: ['$scrapingOffsetLookups', {}] } },
  });
  const keepFilter = (field: string) => ({
    $cond: [{ $isArray: field }, { $filter: { input: field, cond: { $in: ['$$this', '$_keep.o'] } } }, '$$REMOVE'],
  });

  return [
    // the lookup date of every offset the player has, `now` when it has none yet
    {
      $set: {
        _lookups: {
          $map: { input: offsets, in: { o: '$$this', d: { $ifNull: [lookupOf('$$this'), now] } } },
        },
      },
    },
    // the offsets looked up since `cutoff`, or else only the most recently looked up one
    {
      $set: {
        _keep: {
          $let: {
            vars: { used: { $filter: { input: '$_lookups', cond: { $gte: ['$$this.d', cutoff] } } } },
            in: {
              $cond: [
                { $gt: [{ $size: '$$used' }, 0] },
                '$$used',
                [{ $first: { $sortArray: { input: '$_lookups', sortBy: { d: -1 } } } }],
              ],
            },
          },
        },
      },
    },
    {
      $set: {
        _dropped: { $setDifference: [offsets, '$_keep.o'] },
        scrapingOffsetLookups: {
          $arrayToObject: { $map: { input: '$_keep', in: { k: { $toString: '$$this.o' }, v: '$$this.d' } } },
        },
      },
    },
    {
      $set: {
        scrapingOffsets: keepFilter('$scrapingOffsets'),
        pausedScrapingOffsets: keepFilter('$pausedScrapingOffsets'),
        hiscoreEntries: {
          $cond: [
            { $isArray: '$hiscoreEntries' },
            { $filter: { input: '$hiscoreEntries', cond: { $not: [{ $in: ['$$this.o', '$_dropped'] }] } } },
            '$$REMOVE',
          ],
        },
      },
    },
  ];
}
