import { BadRequestException, Injectable, ParseEnumPipe, PipeTransform } from '@nestjs/common';
import { ParseIntRangePipe } from '../../common/pipes/parse-int-range.pipe';
import { singleQueryValue } from '../../common/pipes/single-query-value';
import { ParseScrapingOffsetPipe } from './parse-scraping-offset.pipe';
import { RECENT_PLAYERS_ENTRY, type RecentPlayersEntry } from './players.service';
import { MAX_TOP_GAINERS } from './top-gainers';

const PLAYER_SORTS = ['lookedUp', 'gain'] as const;
type PlayerSort = (typeof PLAYER_SORTS)[number];

/** `GET /players`' query: the recently looked up players, or the top gainers. */
export type PlayerListQuery =
  | { sort: 'lookedUp'; limit: number; scrapingOffset?: number; entry?: RecentPlayersEntry }
  | { sort: 'gain'; limit: number };

const LIMIT_PIPES: Record<PlayerSort, ParseIntRangePipe> = {
  lookedUp: new ParseIntRangePipe({ min: 1, max: 50, default: 5 }),
  gain: new ParseIntRangePipe({ min: 1, max: MAX_TOP_GAINERS, default: 5 }),
};
const SCRAPING_OFFSET = new ParseScrapingOffsetPipe({ optional: true });
const ENTRY = new ParseEnumPipe(RECENT_PLAYERS_ENTRY, {
  optional: true,
  exceptionFactory: () => new BadRequestException(`Entry must be 'overall'.`),
});

/**
 * Parses `GET /players`' query: `sort` (`lookedUp`, the default, or `gain`) with its `limit`, and for `lookedUp` the
 * optional `scrapingOffset` and `entry`, which `gain` ignores. 400 for an unknown `sort`, an invalid value or a repeated
 * param.
 */
@Injectable()
export class ParsePlayerListQueryPipe implements PipeTransform<Record<string, unknown>, Promise<PlayerListQuery>> {
  async transform(query: Record<string, unknown>): Promise<PlayerListQuery> {
    const sort = singleQueryValue('sort', query.sort) ?? 'lookedUp';
    if (!PLAYER_SORTS.includes(sort as PlayerSort)) {
      throw new BadRequestException(`Sort must be one of ${PLAYER_SORTS.join(', ')}.`);
    }

    const limit = LIMIT_PIPES[sort as PlayerSort].transform(singleQueryValue('limit', query.limit), {
      type: 'query',
      data: 'limit',
    })!;
    if (sort === 'gain') return { sort, limit };

    const scrapingOffset = SCRAPING_OFFSET.transform(singleQueryValue('scrapingOffset', query.scrapingOffset));
    const entry = (await ENTRY.transform(singleQueryValue('entry', query.entry), { type: 'query', data: 'entry' })) as
      RecentPlayersEntry | undefined;

    return { sort: 'lookedUp', limit, scrapingOffset, entry };
  }
}
