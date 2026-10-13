import { Document } from 'mongodb';

export const PLAYER_COUNT_RANGES = ['24h', '7d', '30d', '1y', 'all'] as const;
export type PlayerCountRange = (typeof PLAYER_COUNT_RANGES)[number];

/** One point of the history: a sample, or the averages over the UTC hour or day starting at `date`. */
export interface PlayerCountPoint {
  date: Date;
  total: number;
  members: number;
  f2p: number;
  /** Daily points only: the highest `total` sampled that day. */
  peak?: number;
}

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

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
    return [...match, { $sort: { date: 1 } }, { $project: { _id: 0, date: 1, total: 1, members: 1, f2p: 1 } }];

  const peak = bucket === 'day';

  return [
    ...match,
    {
      $group: {
        _id: { $dateTrunc: { date: '$date', unit: bucket } },
        total: { $avg: '$total' },
        members: { $avg: '$members' },
        f2p: { $avg: '$f2p' },
        ...(peak && { peak: { $max: '$total' } }),
      },
    },
    { $sort: { _id: 1 } },
    {
      $project: {
        _id: 0,
        date: '$_id',
        total: { $round: ['$total', 0] },
        members: { $round: ['$members', 0] },
        f2p: { $round: ['$f2p', 0] },
        ...(peak && { peak: 1 }),
      },
    },
  ];
}
