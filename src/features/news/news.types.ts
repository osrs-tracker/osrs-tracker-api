import { OsrsNewsItem } from '@osrs-tracker/models';

/**
 * A stored post, keyed on `link`: a feed item, or one backfilled from the Wiki's `update` bucket (2026-10). Backfilled
 * posts got Jagex's teaser (`description`) and, where it's on `cdn.runescape.com`, image (`enclosure`) from Jagex's
 * news archive (`scripts/backfill-news-images.mjs`); the oldest have no image, and posts the archive doesn't list have
 * neither.
 */
export type StoredNewsItem = Omit<OsrsNewsItem, 'description' | 'enclosure'> &
  Partial<Pick<OsrsNewsItem, 'description' | 'enclosure'>>;
