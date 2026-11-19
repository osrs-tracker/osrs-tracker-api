import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ParsePlayerCountRangePipe } from './parse-player-count-range.pipe';
import { buildPlayerCountHistoryPipeline, readsDailyAverages } from './player-count-history';

/**
 * There's no database in the tests, so this checks the pipeline: each range's start and what it averages over. The
 * hourly averages were checked against Atlas with `$documents` samples (#158); the stored daily averages against what
 * the API answered before reading them (#159).
 */
describe('buildPlayerCountHistoryPipeline', () => {
  const now = new Date('2026-10-13T12:00:00Z');
  const since = (range: Parameters<typeof buildPlayerCountHistoryPipeline>[0]) =>
    buildPlayerCountHistoryPipeline(range, now).find((stage) => stage.$match)?.$match.date.$gte;
  const groupOf = (range: Parameters<typeof buildPlayerCountHistoryPipeline>[0]) =>
    buildPlayerCountHistoryPipeline(range, now).find((stage) => stage.$group)?.$group;

  it('starts each range its span before now, and all at the first point', () => {
    expect(since('24h')).toEqual(new Date('2026-10-12T12:00:00Z'));
    expect(since('7d')).toEqual(new Date('2026-10-06T12:00:00Z'));
    expect(since('30d')).toEqual(new Date('2026-09-13T12:00:00Z'));
    expect(since('1y')).toEqual(new Date('2025-10-13T12:00:00Z'));
    expect(since('all')).toBeUndefined();
  });

  it('returns every sample for 24h and 7d, oldest first', () => {
    for (const range of ['24h', '7d'] as const) {
      const pipeline = buildPlayerCountHistoryPipeline(range, now);
      expect(groupOf(range)).toBeUndefined();
      expect(pipeline).toContainEqual({ $sort: { date: 1 } });
      expect(pipeline.at(-1)?.$project.byLocation).toBe(1);
    }
  });

  const truncOf = (range: Parameters<typeof buildPlayerCountHistoryPipeline>[0]) =>
    buildPlayerCountHistoryPipeline(range, now).find((stage) => stage.$project?.location)?.$project.date;

  it('averages 30d per hour, without a peak', () => {
    expect(truncOf('30d')).toEqual({ $dateTrunc: { date: '$date', unit: 'hour' } });
    expect(groupOf('30d')).not.toHaveProperty('peak');
  });

  it('reads 1y and all from the stored daily averages, with their peak and without their sample count', () => {
    for (const range of ['24h', '7d', '30d'] as const) expect(readsDailyAverages(range)).toBe(false);
    for (const range of ['1y', 'all'] as const) {
      const pipeline = buildPlayerCountHistoryPipeline(range, now);
      expect(readsDailyAverages(range)).toBe(true);
      expect(groupOf(range)).toBeUndefined();
      expect(pipeline).toContainEqual({ $sort: { date: 1 } });
      expect(pipeline.at(-1)?.$project).toEqual({
        _id: 0,
        date: 1,
        total: 1,
        members: 1,
        f2p: 1,
        hardcore: 1,
        byLocation: 1,
        peak: 1,
      });
    }
  });

  it('averages 30d byLocation per hour and code, and counts each sample once for its totals', () => {
    const pipeline = buildPlayerCountHistoryPipeline('30d', now);
    expect(pipeline).toContainEqual({ $unwind: { path: '$location', includeArrayIndex: 'i' } });
    expect(groupOf('30d')).toMatchObject({
      _id: { date: '$date', code: '$location.k' },
      players: { $avg: '$location.v' },
      samples: { $sum: { $cond: [{ $eq: ['$i', 0] }, 1, 0] } },
      total: { $sum: { $cond: [{ $eq: ['$i', 0] }, '$total', 0] } },
    });
    expect(pipeline.at(-1)?.$project).toMatchObject({
      total: { $round: [{ $divide: ['$total', '$samples'] }, 0] },
      byLocation: { $arrayToObject: '$byLocation' },
    });
  });

  it('returns hardcore with every sample and stored day that has it', () => {
    for (const range of ['24h', '7d', '1y', 'all'] as const)
      expect(buildPlayerCountHistoryPipeline(range, now).at(-1)?.$project).toHaveProperty('hardcore', 1);
  });

  it('averages 30d hardcore per hour over only the samples that have it, and leaves it out of hours without any', () => {
    const once = (value: unknown) => ({ $sum: { $cond: [{ $eq: ['$i', 0] }, value, 0] } });
    const pipeline = buildPlayerCountHistoryPipeline('30d', now);

    expect(pipeline.slice(1)).toEqual([
      {
        $project: {
          date: { $dateTrunc: { date: '$date', unit: 'hour' } },
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
          hardcore: {
            $cond: [
              { $gt: ['$hardcoreSamples', 0] },
              { $round: [{ $divide: ['$hardcore', '$hardcoreSamples'] }, 0] },
              '$$REMOVE',
            ],
          },
          byLocation: { $arrayToObject: '$byLocation' },
        },
      },
    ]);
    // `toEqual` ignores key order, which is the points' field order
    expect(Object.keys(pipeline.at(-1)?.$project)).toEqual([
      '_id',
      'date',
      'total',
      'members',
      'f2p',
      'hardcore',
      'byLocation',
    ]);
  });
});

describe('ParsePlayerCountRangePipe', () => {
  const pipe = new ParsePlayerCountRangePipe();

  it('accepts every range, and 24h when absent', () => {
    for (const range of ['24h', '7d', '30d', '1y', 'all']) expect(pipe.transform(range)).toBe(range);
    expect(pipe.transform(undefined)).toBe('24h');
  });

  it('rejects anything else, uppercase included', () => {
    for (const value of ['', '1w', '24H', 'ALL', '90d'])
      expect(() => pipe.transform(value)).toThrow(BadRequestException);
  });
});
