import { PlayerSubscription, PlayerType, StoredPlayer } from '@osrs-tracker/models';

/** The fields of a stored player that make its item: the sync projects only these. */
type SubscribedPlayer = Pick<StoredPlayer, 'username' | 'scrapingOffsets' | 'type'>;

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
 * don't count: a paused player isn't scraped. A Hardcore main is scraped from its own table; any other player has no
 * `table` (the main one), never `table: undefined`, which the document client refuses to write.
 */
export function subscriptionOf({ username, scrapingOffsets, type }: SubscribedPlayer): PlayerSubscription | undefined {
  const offsets = new Set(scrapingOffsets?.filter((offset) => offset !== QUEUED_WITH_MINUS_12));
  if (!offsets.size) return undefined;
  return type === PlayerType.HardcoreMain
    ? { username, scrapingOffsets: offsets, table: 'hiscore_oldschool_hardcore_mains' }
    : { username, scrapingOffsets: offsets };
}

/**
 * A put for each player whose item is missing or has other offsets or another table, a delete for each item without a
 * player to scrape.
 */
export function diffSubscriptions(
  players: readonly SubscribedPlayer[],
  items: readonly PlayerSubscription[],
): SubscriptionsDiff {
  const stored = new Map(items.map((item) => [item.username, item]));
  const wanted = new Set<string>();
  const puts: PlayerSubscription[] = [];

  for (const player of players) {
    const subscription = subscriptionOf(player);
    if (!subscription) continue;
    wanted.add(subscription.username);
    const item = stored.get(subscription.username);
    if (!item || !sameItem(item, subscription)) puts.push(subscription);
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

function sameItem(a: PlayerSubscription, b: PlayerSubscription): boolean {
  return (
    a.table === b.table &&
    a.scrapingOffsets.size === b.scrapingOffsets.size &&
    [...a.scrapingOffsets].every((offset) => b.scrapingOffsets.has(offset))
  );
}
