import { PlayerCountRange } from '@osrs-tracker/models';
import { millisecondsInDay as DAY } from 'date-fns/constants';
import { Document } from 'mongodb';

/**
 * How far back each range reaches (`all`: every point) and its points: every sample, hourly averages of the samples, or
 * the stored daily averages (`playerCountsDaily`).
 */
const RANGES: Record<PlayerCountRange, { span?: number; points: 'samples' | 'hours' | 'days' }> = {
  '24h': { span: DAY, points: 'samples' },
  '7d': { span: 7 * DAY, points: 'samples' },
  '30d': { span: 30 * DAY, points: 'hours' },
  '1y': { span: 365 * DAY, points: 'days' },
  'all': { points: 'days' },
};

/**
 * Whether `range` reads `playerCountsDaily` (one document per UTC day, recomputed by the ingester after every
 * sample, so today's is partial) instead of `playerCounts`: averaging every sample per day on each request grew
 * with the stored samples (6.5 s for 10 years, #159).
 */
export const readsDailyAverages = (range: PlayerCountRange): boolean => RANGES[range].points === 'days';

/**
 * The pipeline for `GET /player-counts?range=`, oldest point first, on the collection `readsDailyAverages` picks: every
 * sample for 24h and 7d (one every 10 minutes), hourly averages for 30d, the stored daily averages and peaks for 1y and
 * all. Averages are rounded, so `members + f2p` can be one off `total`. A missed sample is a gap, never a 0.
 */
export function buildPlayerCountHistoryPipeline(range: PlayerCountRange, now = new Date()): Document[] {
  const { span, points } = RANGES[range];
  const match = span === undefined ? [] : [{ $match: { date: { $gte: new Date(now.getTime() - span) } } }];

  if (points !== 'hours')
    return [
      ...match,
      { $sort: { date: 1 } },
      {
        $project: {
          _id: 0,
          date: 1,
          total: 1,
          members: 1,
          f2p: 1,
          hardcore: 1,
          byLocation: 1,
          ...(points === 'days' && { peak: 1 }),
        },
      },
    ];

  return [...match, ...sampleGroupingStages('hour'), { $sort: { _id: 1 } }, { $project: SAMPLE_AVERAGES }];
}

/**
 * Groups `playerCounts` samples per UTC hour (the 30d history) or day (the ingester's `playerCountDaysPipeline`) into
 * the sums `SAMPLE_AVERAGES` divides, plus per day the highest `total` as `peak`. `hardcore` is summed and counted only
 * over the samples that have it (`hardcoreSamples`), since samples from before it was recorded lack it.
 */
export function sampleGroupingStages(unit: 'hour' | 'day'): Document[] {
  const withPeak = unit === 'day';
  // Each sample is one document per location code after the `$unwind`: its own fields count once, on its first code.
  const first = { $eq: ['$i', 0] };
  const once = (value: string | number | Document) => ({ $sum: { $cond: [first, value, 0] } });

  return [
    {
      $project: {
        date: { $dateTrunc: { date: '$date', unit } },
        total: 1,
        members: 1,
        f2p: 1,
        hardcore: 1,
        location: { $objectToArray: '$byLocation' },
      },
    },
    { $unwind: { path: '$location', includeArrayIndex: 'i' } },
    {
      $group: {
        _id: { date: '$date', code: '$location.k' },
        players: { $avg: '$location.v' },
        samples: once(1),
        total: once('$total'),
        members: once('$members'),
        f2p: once('$f2p'),
        hardcore: once('$hardcore'),
        hardcoreSamples: once({ $cond: [{ $isNumber: '$hardcore' }, 1, 0] }),
        ...(withPeak && { peak: { $max: '$total' } }),
      },
    },
    {
      $group: {
        _id: '$_id.date',
        samples: { $sum: '$samples' },
        total: { $sum: '$total' },
        members: { $sum: '$members' },
        f2p: { $sum: '$f2p' },
        hardcore: { $sum: '$hardcore' },
        hardcoreSamples: { $sum: '$hardcoreSamples' },
        ...(withPeak && { peak: { $max: '$peak' } }),
        byLocation: { $push: { k: '$_id.code', v: { $round: ['$players', 0] } } },
      },
    },
  ];
}

const average = (sum: string, count: string) => ({ $round: [{ $divide: [sum, count] }, 0] });

/**
 * The `$project` fields that turn `sampleGroupingStages`' sums into a point. `hardcore` is left out of a bucket where no
 * sample has it, never 0: `$sum` counts a missing field as 0, so dividing it by `samples` would understate the bucket
 * where recording started and give every older one 0.
 */
export const SAMPLE_AVERAGES = {
  _id: 0,
  date: '$_id',
  total: average('$total', '$samples'),
  members: average('$members', '$samples'),
  f2p: average('$f2p', '$samples'),
  hardcore: {
    $cond: [{ $gt: ['$hardcoreSamples', 0] }, average('$hardcore', '$hardcoreSamples'), '$$REMOVE'],
  },
  byLocation: { $arrayToObject: '$byLocation' },
};
