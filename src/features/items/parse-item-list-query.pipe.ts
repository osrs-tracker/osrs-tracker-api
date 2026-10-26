import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { ParseIntRangePipe } from '../../common/pipes/parse-int-range.pipe';
import { singleQueryValue } from '../../common/pipes/single-query-value';
import { ParseBrowseLetterPipe } from './parse-browse-letter.pipe';
import { ParseItemSearchQueryPipe } from './parse-item-search-query.pipe';

const ITEM_SORTS = ['lookedUp', 'added'] as const;
type ItemSort = (typeof ITEM_SORTS)[number];

/** `GET /items`' query: one of item search, item browse, or a list in `sort` order. */
export type ItemListQuery = { search: string } | { letter: string } | { sort: ItemSort; limit: number };

const LIMIT_PIPES: Record<ItemSort, ParseIntRangePipe> = {
  lookedUp: new ParseIntRangePipe({ min: 1, max: 50, default: 5 }),
  added: new ParseIntRangePipe({ min: 1, max: 100, default: 25 }),
};

/**
 * Parses `GET /items`' query into one mode: `search` (`ParseItemSearchQueryPipe`), `letter` (`ParseBrowseLetterPipe`),
 * or `sort` (`lookedUp`, the default, or `added`) with its `limit`. 400 for more than one of the three, an unknown
 * `sort` or a repeated param; `limit` is ignored with `search` or `letter`.
 */
@Injectable()
export class ParseItemListQueryPipe implements PipeTransform<Record<string, unknown>, ItemListQuery> {
  transform(query: Record<string, unknown>): ItemListQuery {
    const search = singleQueryValue('search', query.search);
    const letter = singleQueryValue('letter', query.letter);
    const sort = singleQueryValue('sort', query.sort);

    if ([search, letter, sort].filter((value) => value !== undefined).length > 1) {
      throw new BadRequestException('Use only one of search, letter or sort.');
    }

    if (search !== undefined) return { search: new ParseItemSearchQueryPipe().transform(search) };
    if (letter !== undefined) return { letter: new ParseBrowseLetterPipe().transform(letter) };

    if (sort !== undefined && !ITEM_SORTS.includes(sort as ItemSort)) {
      throw new BadRequestException(`Sort must be one of ${ITEM_SORTS.join(', ')}.`);
    }
    const itemSort = (sort as ItemSort | undefined) ?? 'lookedUp';
    const limit = LIMIT_PIPES[itemSort].transform(singleQueryValue('limit', query.limit), {
      type: 'query',
      data: 'limit',
    });

    return { sort: itemSort, limit: limit! };
  }
}
