import {
  hiscoreEntriesWriteExpression,
  PlayerCount,
  ScrapeResultMessage,
  StoredHiscoreEntry,
  StoredPlayer,
} from '@osrs-tracker/models';
import { subDays } from 'date-fns';
import { millisecondsInHour as HOUR } from 'date-fns/constants';
import { Document, Filter, UpdateFilter } from 'mongodb';
import { SAMPLE_AVERAGES, sampleGroupingStages } from '../features/player-counts/player-count-history';

/** Scraping is paused when a player hasn't been on the hiscores for this many days in a row. */
export const HISCORE_NOT_FOUND_PAUSE_DAYS = 7;

/** A message the ingester can't apply: it's never deleted, so it ends in the dead-letter queue. */
export class UnknownScrapeResultError extends Error {}

/**
 * Parses a message body and checks its version, type and dates. The rest is trusted: the scraping Lambdas send it,
 * typed by models' `ScrapeResultMessage`.
 */
export function parseScrapeResult(body: string | undefined): ScrapeResultMessage {
  let message: ScrapeResultMessage | null;
  try {
    message = JSON.parse(body ?? '') as ScrapeResultMessage | null;
  } catch {
    throw new UnknownScrapeResultError('Not JSON');
  }
  if (message?.v !== 1) throw new UnknownScrapeResultError(`Unknown version ${JSON.stringify(message?.v)}`);

  const date: unknown =
    message.type === 'hiscores'
      ? message.scrapedAt
      : message.type === 'playerCount'
        ? message.playerCount?.date
        : undefined;
  if (date === undefined) throw new UnknownScrapeResultError(`Unknown type ${JSON.stringify(message.type)}`);
  if (typeof date !== 'string' || Number.isNaN(Date.parse(date)))
    throw new UnknownScrapeResultError(`Invalid date ${JSON.stringify(date)}`);
  return message;
}

/**
 * The start of the scrape slot `scrapedAt` belongs to: the latest whole UTC hour at or before it whose hour is the one
 * queue-players queues `scrapingOffset` at (osrs-tracker-aws `scrapingOffsetForHour`: offset `o` at hour
 * `(o + 24) % 24`, so 12 and -12 share hour 12). Assumes every scrape runs within 24 hours of its slot, which
 * process-players' max event age (1 hour) and requeue cap (3) ensure.
 */
export function slotStart(scrapingOffset: number, scrapedAt: Date): Date {
  const hourStart = Math.floor(scrapedAt.getTime() / HOUR) * HOUR;
  const hoursSinceSlot = (new Date(hourStart).getUTCHours() - ((scrapingOffset + 24) % 24) + 24) % 24;
  return new Date(hourStart - hoursSinceSlot * HOUR);
}

/**
 * Prepends `entry` to the player's `hiscoreEntries` (models' `hiscoreEntriesWriteExpression`, after its layout is
 * stored) and ends any not-found streak, unless the player already has an entry for the same offset scraped at or after
 * the start of its slot (`slotStart`). That guard skips a duplicate delivery, a second scrape of the same slot and a
 * late entry older than a stored one, which would break decoding (entries are stored newest first): an update that
 * matches nothing is stale.
 */
export function hiscoreEntryUpdate(
  username: string,
  entry: StoredHiscoreEntry,
): { filter: Filter<StoredPlayer>; update: Document[] } {
  return {
    filter: {
      username,
      hiscoreEntries: { $not: { $elemMatch: { o: entry.o, d: { $gte: slotStart(entry.o, entry.d) } } } },
    } as Filter<StoredPlayer>,
    update: [
      { $set: { hiscoreEntries: hiscoreEntriesWriteExpression(entry) } },
      { $unset: ['hiscoreNotFoundCount', 'hiscoreNotFoundSince'] },
    ],
  };
}

/**
 * Update pipeline for a player that is not on the hiscores at `scrapedAt`: starts or continues the not-found streak,
 * and once the streak is `HISCORE_NOT_FOUND_PAUSE_DAYS` old, moves `scrapingOffsets` to `pausedScrapingOffsets` so the
 * player is no longer queued. The data is kept, and the API restores the offsets when the player is found again. The
 * scrape time, not the time it's applied: a drained backlog would otherwise delay pauses. Ported from process-players,
 * which wrote it until osrs-tracker/osrs-tracker-aws#166.
 */
export function hiscoreNotFoundPipeline(scrapedAt: Date): Document[] {
  const shouldPause = {
    $and: [
      { $lte: ['$hiscoreNotFoundSince', subDays(scrapedAt, HISCORE_NOT_FOUND_PAUSE_DAYS)] },
      { $gt: [{ $size: { $ifNull: ['$scrapingOffsets', []] } }, 0] },
    ],
  };

  return [
    {
      $set: {
        hiscoreNotFoundSince: { $ifNull: ['$hiscoreNotFoundSince', scrapedAt] },
        hiscoreNotFoundCount: { $add: [{ $ifNull: ['$hiscoreNotFoundCount', 0] }, 1] },
      },
    },
    {
      $set: {
        pausedScrapingOffsets: {
          $cond: [
            shouldPause,
            { $setUnion: [{ $ifNull: ['$pausedScrapingOffsets', []] }, '$scrapingOffsets'] },
            '$pausedScrapingOffsets',
          ],
        },
        scrapingOffsets: { $cond: [shouldPause, '$$REMOVE', '$scrapingOffsets'] },
      },
    },
  ];
}

/** Whether `hiscoreNotFoundPipeline(scrapedAt)` paused the player, from the document as it was before. */
export function pausedByNotFound(
  before: Pick<StoredPlayer, 'scrapingOffsets' | 'hiscoreNotFoundSince'>,
  scrapedAt: Date,
): boolean {
  return (
    !!before.scrapingOffsets?.length &&
    !!before.hiscoreNotFoundSince &&
    before.hiscoreNotFoundSince <= subDays(scrapedAt, HISCORE_NOT_FOUND_PAUSE_DAYS)
  );
}

/**
 * Inserts the sample unless one with its `date` is stored, so a repeated sample changes nothing, rather than failing on
 * the unique `{ date: 1 }` index (`ScrapeResultsService.ensureIndexes`) as an insert would.
 */
export function playerCountUpsert({ date, ...counts }: PlayerCount): {
  filter: Filter<PlayerCount>;
  update: UpdateFilter<PlayerCount>;
} {
  return { filter: { date }, update: { $setOnInsert: counts } };
}

/** The start of `date`'s UTC day: the first day to recompute after storing a sample of `date`. */
export function startOfUTCDay(date: Date): Date {
  const day = new Date(date);
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

/**
 * The `playerCounts` pipeline that averages the samples from `from` on per UTC day, into one `PlayerCountDay` per day
 * that has samples. The grouping and averages are the API's 30d hourly history's (`sampleGroupingStages`), per day.
 * Ported from record-player-count (osrs-tracker-aws `playerCountDaysPipeline`).
 */
export function playerCountDaysPipeline(from: Date): Document[] {
  return [
    { $match: { date: { $gte: from } } },
    ...sampleGroupingStages('day'),
    {
      $project: {
        ...SAMPLE_AVERAGES,
        // computed, not included (`1`), so the stored fields keep this order
        peak: '$peak',
        samples: '$samples',
      },
    },
  ];
}
