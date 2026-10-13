import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ParsePlayerCountRangePipe } from './parse-player-count-range.pipe';
import { buildPlayerCountHistoryPipeline } from './player-count-history';

/**
 * There's no database in the tests, so this checks the pipeline: each range's start and what it averages over. Its
 * results were checked against Atlas with `$documents` samples (#158).
 */
describe('buildPlayerCountHistoryPipeline', () => {
  const now = new Date('2026-10-13T12:00:00Z');
  const since = (range: Parameters<typeof buildPlayerCountHistoryPipeline>[0]) =>
    buildPlayerCountHistoryPipeline(range, now).find((stage) => stage.$match)?.$match.date.$gte;
  const groupOf = (range: Parameters<typeof buildPlayerCountHistoryPipeline>[0]) =>
    buildPlayerCountHistoryPipeline(range, now).find((stage) => stage.$group)?.$group;

  it('starts each range its span before now, and all at the first sample', () => {
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

  it('averages 1y and all per day, with the peak total', () => {
    for (const range of ['1y', 'all'] as const) {
      expect(truncOf(range)).toEqual({ $dateTrunc: { date: '$date', unit: 'day' } });
      expect(groupOf(range)?.peak).toEqual({ $max: { $cond: [{ $eq: ['$i', 0] }, '$total', null] } });
    }
  });

  it('averages byLocation per bucket and code, and counts each sample once for its totals', () => {
    for (const range of ['30d', '1y', 'all'] as const) {
      const pipeline = buildPlayerCountHistoryPipeline(range, now);
      expect(pipeline).toContainEqual({ $unwind: { path: '$location', includeArrayIndex: 'i' } });
      expect(groupOf(range)).toMatchObject({
        _id: { date: '$date', code: '$location.k' },
        players: { $avg: '$location.v' },
        samples: { $sum: { $cond: [{ $eq: ['$i', 0] }, 1, 0] } },
        total: { $sum: { $cond: [{ $eq: ['$i', 0] }, '$total', 0] } },
      });
      expect(pipeline.at(-1)?.$project).toMatchObject({
        total: { $round: [{ $divide: ['$total', '$samples'] }, 0] },
        byLocation: { $arrayToObject: '$byLocation' },
      });
    }
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
