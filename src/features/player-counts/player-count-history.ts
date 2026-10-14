import { millisecondsInDay as DAY } from 'date-fns/constants';
import { Document } from 'mongodb';

export const PLAYER_COUNT_RANGES = ['24h', '7d', '30d', '1y', 'all'] as const;
export type PlayerCountRange = (typeof PLAYER_COUNT_RANGES)[number];

/** One point of the history: a sample, or the averages over the UTC hour or day starting at `date`. */
export interface PlayerCountPoint {
  date: Date;
  total: number;
  members: number;
  f2p: number;
  /** Players per raw location code (`PlayerCount['byLocation']`); in a bucket, the average per code. */
  byLocation: Record<string, number>;
  /** Daily points only: the highest `total` sampled that day. */
  peak?: number;
}

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
 * Whether `range` reads `playerCountsDaily` (one document per UTC day, recomputed by the record-player-count Lambda after
 * every sample, so today's is partial) instead of `playerCounts`: averaging every sample per day on each request grew
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
          byLocation: 1,
          ...(points === 'days' && { peak: 1 }),
        },
      },
    ];

  // Each sample is one document per location code after the `$unwind`: its own fields count once, on its first code.
  const first = { $eq: ['$i', 0] };
  const once = (value: string | number) => ({ $sum: { $cond: [first, value, 0] } });

  return [
    ...match,
    {
      $project: {
        date: { $dateTrunc: { date: '$date', unit: 'hour' } },
        total: 1,
        members: 1,
        f2p: 1,
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
      },
    },
    {
      $group: {
        _id: '$_id.date',
        samples: { $sum: '$samples' },
        total: { $sum: '$total' },
        members: { $sum: '$members' },
        f2p: { $sum: '$f2p' },
        byLocation: { $push: { k: '$_id.code', v: { $round: ['$players', 0] } } },
      },
    },
    { $sort: { _id: 1 } },
    {
      $project: {
        _id: 0,
        date: '$_id',
        total: { $round: [{ $divide: ['$total', '$samples'] }, 0] },
        members: { $round: [{ $divide: ['$members', '$samples'] }, 0] },
        f2p: { $round: [{ $divide: ['$f2p', '$samples'] }, 0] },
        byLocation: { $arrayToObject: '$byLocation' },
      },
    },
  ];
}
