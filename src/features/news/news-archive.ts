import { Filter, Sort } from 'mongodb';
import type { StoredNewsItem } from '@osrs-tracker/models';

/** Where a page of `GET /news/archive` ends: the last post it returned. The next page starts after it. */
export interface NewsArchiveCursor {
  pubDate: Date;
  link: string;
}

/**
 * Newest first, ties broken on `link` (unique): many posts share a `pubDate` (backfilled ones are dated by day), so
 * `pubDate` alone would let a page boundary skip or repeat a post.
 */
export const NEWS_ARCHIVE_SORT: Sort = { pubDate: -1, link: -1 };

/** The cursor the web sends back as `before`: opaque base64url, so it can change shape without a new param. */
export function encodeNewsCursor({ pubDate, link }: NewsArchiveCursor): string {
  return Buffer.from(JSON.stringify([pubDate.toISOString(), link])).toString('base64url');
}

/** The cursor in `before`, or `undefined` when it isn't one `encodeNewsCursor` made. */
export function decodeNewsCursor(value: string): NewsArchiveCursor | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString());
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;

  const [iso, link] = parsed as unknown[];
  if (typeof iso !== 'string' || typeof link !== 'string' || !link) return undefined;

  const pubDate = new Date(iso);
  if (isNaN(pubDate.getTime()) || pubDate.toISOString() !== iso) return undefined;

  return { pubDate, link };
}

/** The posts after `cursor` in `NEWS_ARCHIVE_SORT` order, in `category` when given. */
export function buildNewsArchiveFilter(cursor?: NewsArchiveCursor, category?: string): Filter<StoredNewsItem> {
  return {
    ...(category !== undefined && { category }),
    ...(cursor && {
      $or: [{ pubDate: { $lt: cursor.pubDate } }, { pubDate: cursor.pubDate, link: { $lt: cursor.link } }],
    }),
  };
}
