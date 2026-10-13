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

/** How far back each range reaches (`all`: every sample) and what it averages over (none: every sample). */
const RANGES: Record<PlayerCountRange, { span?: number; bucket?: 'hour' | 'day' }> = {
  '24h': { span: DAY },
  '7d': { span: 7 * DAY },
  '30d': { span: 30 * DAY, bucket: 'hour' },
  '1y': { span: 365 * DAY, bucket: 'day' },
  'all': { bucket: 'day' },
};

/**
 * The `playerCounts` pipeline for `GET /player-counts?range=`, oldest point first: every sample for 24h and 7d (one
 * every 10 minutes), hourly averages for 30d, daily averages and peaks for 1y and all. Averages are rounded, so
 * `members + f2p` can be one off `total`. A missed sample is a gap, never a 0.
 */
export function buildPlayerCountHistoryPipeline(range: PlayerCountRange, now = new Date()): Document[] {
  const { span, bucket } = RANGES[range];
  const match = span === undefined ? [] : [{ $match: { date: { $gte: new Date(now.getTime() - span) } } }];

  if (!bucket)
    return [
      ...match,
      { $sort: { date: 1 } },
      { $project: { _id: 0, date: 1, total: 1, members: 1, f2p: 1, byLocation: 1 } },
    ];

  const peak = bucket === 'day';
  // Each sample is one document per location code after the `$unwind`: its own fields count once, on its first code.
  const first = { $eq: ['$i', 0] };
  const once = (value: string | number) => ({ $sum: { $cond: [first, value, 0] } });

  return [
    ...match,
    {
      $project: {
        date: { $dateTrunc: { date: '$date', unit: bucket } },
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
        ...(peak && { peak: { $max: { $cond: [first, '$total', null] } } }),
      },
    },
    {
      $group: {
        _id: '$_id.date',
        samples: { $sum: '$samples' },
        total: { $sum: '$total' },
        members: { $sum: '$members' },
        f2p: { $sum: '$f2p' },
        ...(peak && { peak: { $max: '$peak' } }),
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
        ...(peak && { peak: 1 }),
      },
    },
  ];
}
