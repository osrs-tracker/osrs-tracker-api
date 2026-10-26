import { PlayerSubscription, StoredPlayer } from '@osrs-tracker/models';

/** The DynamoDB table queue-players reads who to scrape from (osrs-tracker/osrs-tracker-aws#164). Only the sync writes it. */
export const SUBSCRIPTIONS_TABLE = 'osrs-tracker_subscriptions';

/** Deletes are skipped when more than this share of the table's items would go (`deleteGuard`). */
const MAX_DELETED_SHARE = 0.1;

/**
 * Not written: queue-players queues it together with -12 (the same hour), and nothing writes it to `players` either
 * (`DATA-MODEL.md`).
 */
const QUEUED_WITH_MINUS_12 = 12;

/** The writes that make the table match the players: whole items, never deltas, so a run repairs any drift. */
export interface SubscriptionsDiff {
  puts: PlayerSubscription[];
  /** Usernames whose items go. */
  deletes: string[];
}

/**
 * A player's item, or none when it has no offsets to scrape (a Number Set can't be empty). `pausedScrapingOffsets`
 * don't count: a paused player isn't scraped.
 */
export function subscriptionOf({
  username,
  scrapingOffsets,
}: Pick<StoredPlayer, 'username' | 'scrapingOffsets'>): PlayerSubscription | undefined {
  const offsets = new Set(scrapingOffsets?.filter((offset) => offset !== QUEUED_WITH_MINUS_12));
  return offsets.size ? { username, scrapingOffsets: offsets } : undefined;
}

/** A put for each player whose item is missing or has other offsets, a delete for each item without a player to scrape. */
export function diffSubscriptions(
  players: readonly Pick<StoredPlayer, 'username' | 'scrapingOffsets'>[],
  items: readonly PlayerSubscription[],
): SubscriptionsDiff {
  const stored = new Map(items.map((item) => [item.username, item.scrapingOffsets]));
  const wanted = new Set<string>();
  const puts: PlayerSubscription[] = [];

  for (const player of players) {
    const subscription = subscriptionOf(player);
    if (!subscription) continue;
    wanted.add(subscription.username);
    const offsets = stored.get(subscription.username);
    if (!offsets || !sameOffsets(offsets, subscription.scrapingOffsets)) puts.push(subscription);
  }

  return { puts, deletes: items.map(({ username }) => username).filter((username) => !wanted.has(username)) };
}

/**
 * Why the deletes must be skipped, if they must: MongoDB returned no players to scrape, or more than
 * `MAX_DELETED_SHARE` of the items would go. An empty or wrong database (a fresh one before the restore, a wrong
 * `MONGODB_DATABASE`) must never empty the table: that stops all scraping.
 */
export function deleteGuard(players: number, items: number, deletes: number): string | undefined {
  if (!deletes) return undefined;
  if (!players) return 'MongoDB returned no players with scraping offsets';
  if (deletes > items * MAX_DELETED_SHARE)
    return `${deletes} of ${items} subscriptions would be deleted, over ${MAX_DELETED_SHARE * 100}%`;
  return undefined;
}

function sameOffsets(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  return a.size === b.size && [...a].every((offset) => b.has(offset));
}
