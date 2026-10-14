import { OsrsNewsItem } from '@osrs-tracker/models';

/**
 * A stored post, keyed on `link`: a feed item, or one backfilled once from the Wiki's `update` bucket (2026-10-13).
 * Backfilled posts got Jagex's teaser (`description`) and, where it's on `cdn.runescape.com`, image (`enclosure`) from
 * Jagex's news archive; the oldest have no image, and posts the archive doesn't list have neither. Both backfill
 * scripts ran once and were removed (`CHANGELOG.md`, 2026-10-13 and 2026-10-14).
 */
export type StoredNewsItem = Omit<OsrsNewsItem, 'description' | 'enclosure'> &
  Partial<Pick<OsrsNewsItem, 'description' | 'enclosure'>>;
