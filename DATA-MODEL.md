# Data model

MongoDB is written only by this repo, by two processes of the same image: the API, and the ingester (`src/ingest.ts`,
the `osrs-tracker-ingester` Deployment). The scraping Lambdas in
[osrs-tracker-aws](https://github.com/osrs-tracker/osrs-tracker-aws) write nothing to it since
osrs-tracker/osrs-tracker-aws#166: process-players and record-player-count send their results to the scrape results
queue, and the ingester applies them (`src/ingester/scrape-results.service.ts`). It also runs the scheduled jobs that
were Lambdas until osrs-tracker/osrs-tracker-api#205: the hourly items refresh (`items`,
`src/ingester/items-refresh.service.ts`, was refresh-items) and the nightly clean-up (`clean`,
`src/ingester/clean-hiscores.service.ts`, was clean-hiscores), plus the subscriptions sync to DynamoDB. This file says
which of them writes each field and owns each index, so a change in one doesn't break another, and what the Lambdas
still depend on. The TypeScript shapes are in
[`@osrs-tracker/models`](https://github.com/osrs-tracker/osrs-tracker-packages/tree/main/packages/models/src/models);
this file covers who writes what and when.

When you add, rename or stop writing a field, or add, change or drop an index, update this file in the same change, and
open an issue in osrs-tracker-aws when a Lambda has to follow (the scrape result messages, the subscriptions table).

Paths below are relative to this repo.

## `players`

One document per tracked or looked-up player, keyed by `username`. The clean job deletes a player once it has no hiscore
entries left (not scraped or looked up for `MAX_AGE_IN_DAYS`); a lookup creates it again.

| Field                                             | Written by                                                                                                                                                                                                                                                                                                                                                                                                                                           | Read by                                                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `username`                                        | API, on upsert in `refreshPlayerInfo`: normalized the way Jagex matches names (lowercase, `_` and `-` as spaces, trimmed; repeated separators aren't collapsed), so it never contains `_` or `-`, and only valid OSRS names (`src/features/players/player.utils.ts`). Never changed after that, except by a one-off migration on 2026-10-09 that renamed the names stored with `_` or `-`, or merged them into the already stored normalized player. | Everyone (the filter for every per-player read and write).                                                  |
| `combatLevel`, `type`, `status`, `diedAsHardcore` | API `refreshPlayerInfo`, from the four hiscore tables.                                                                                                                                                                                                                                                                                                                                                                                               | API, web.                                                                                                   |
| `lastModified`                                    | API `refreshPlayerInfo`: when the type and status were last determined.                                                                                                                                                                                                                                                                                                                                                                              | API (refresh at most every `MIN_PLAYER_REFRESH_HOURS` = 2, and `Cache-Control`).                            |
| `lastHiscoreFetch`                                | API `recordLookup` (`POST /players/:username/lookup`): when a visitor last looked the player up. Never set on insert, so players nobody looked up lack it.                                                                                                                                                                                                                                                                                           | API recent players list.                                                                                    |
| `scrapingOffsets`                                 | API `refreshPlayerInfo` adds the requested offset (`$setUnion` with any `pausedScrapingOffsets`). The ingester removes the field when it pauses the player. The clean job drops an offset not looked up for 180 days (see `scrapingOffsetLookups`).                                                                                                                                                                                                  | The ingester's sync (to the subscriptions table), API (the player sitemap lists only players with offsets). |
| `pausedScrapingOffsets`                           | The ingester sets it when it pauses the player. API `refreshPlayerInfo` merges it back and unsets it.                                                                                                                                                                                                                                                                                                                                                | API (a paused player still counts as tracked).                                                              |
| `scrapingOffsetLookups`                           | API `recordLookup` sets `scrapingOffsetLookups.<offset>` (the offset as a string, `"-12"` to `"11"`) to the lookup time. The clean job, every night: gives an offset without a date the current time, drops the offsets (active or paused) not looked up for 180 days with all their hiscore entries, but always keeps the most recently looked up one, and removes the keys of offsets the player no longer has.                                    | The clean job.                                                                                              |
| `hiscoreNotFoundCount`, `hiscoreNotFoundSince`    | The ingester sets them for a username in a `hiscores` message's `notFound` (a 404/400 hiscore) and unsets them on the next entry it stores. API `refreshPlayerInfo` also unsets them.                                                                                                                                                                                                                                                                | The ingester, API (the player sitemap leaves them out).                                                     |
| `hiscoreEntries`                                  | The ingester prepends one entry per found player in a `hiscores` message, unless it has one for that slot already. API `refreshPlayerInfo` prepends an initial entry when the player didn't have the requested offset. The clean job pulls entries older than `MAX_AGE_IN_DAYS` (90), and all entries of an offset it drops.                                                                                                                         | API (the player sitemap reads the newest `d`), web.                                                         |
| `trackedSince`, `refreshFailed`                   | Never stored: computed per response by the API.                                                                                                                                                                                                                                                                                                                                                                                                      | Web.                                                                                                        |

`hiscoreEntries` is stored **newest first** in a compact format (since 2026-10-10, roadmap
osrs-tracker/osrs-tracker-aws#52). Both writers prepend with `hiscoreEntriesWriteExpression` from `@osrs-tracker/models`
(a pipeline update: the ingester's bulk write, `hiscoreEntryUpdate` in `src/ingester/scrape-results.ts`, and the API's
`buildRefreshUpdate` in `src/features/players/player.policy.ts`), and readers decode with `decodeHiscoreEntries`. Bare
values only point to newer entries, so readers must decode from the newest entry, and the order matters: the API takes
the first matching entry as the latest and the last as `trackedSince`, and its player sitemap (`GET /sitemap/players`,
`src/features/players/player-sitemap.ts`) lists players whose first entry is at most 30 days old. The top gainers
(`GET /players?sort=gain`, `src/features/players/top-gainers.ts`) diff each player's first two offset-0 entries.

A change to this format that existing entries can't be decoded with (in `encodeHiscoreEntry`, `decodeHiscoreEntries`,
`hiscoreEntriesWriteExpression` or `layoutId`) isn't a normal release: it needs a migration and every writer and reader
switched together, like roadmap osrs-tracker/osrs-tracker-aws#52.

Each entry:

| Field | Notes                                                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `d`   | Date: scrape time. One time per process-players event (its message's `scrapedAt`), so every player in an event shares it.                  |
| `o`   | Scraping offset. Usually one entry per offset per day (the API's initial entry can add a second on the first day).                         |
| `l`   | Layout id: `_id` in [`hiscoreLayouts`](#hiscorelayouts), the skill and activity names the values are positioned by.                        |
| `s`   | Skills by position in the layout. Index 0 (Overall) is always `[rank or null, level, xp]`; other levels are derived from xp when decoding. |
| `a`   | Activities by position in the layout.                                                                                                      |

A value is `[rank, xp]` / `[rank, score]` (`rank` is `null` when unranked: the value is below Jagex's ranking cut-off),
`null` (no xp or score), or bare: a bare `rank` (or `0` when unranked) means "the same xp or score as this name in the
next newer entry with the same `o`". The write expression creates bare values: when it prepends an entry, it strips the
previous newest entry with the same `o` (wherever it is in the array), only if it also has the same `l`. So the newest
entry per offset is always stored in full, and the clean job pulling the oldest entries never breaks a bare value.

Scraping offsets are hours relative to UTC midnight, -12 to +11 (the API rejects anything else). queue-players also
queues offset `12` together with `-12` (the same time); nothing writes `12`.

### Pause/resume contract

A player who's off the hiscores (renamed, banned or unranked) shouldn't be scraped forever, but must come back when
found again.

1. **The ingester counts 404s.** Only the ingester counts, from the `notFound` usernames process-players sends for a 404
   or 400 hiscore. It sets `hiscoreNotFoundSince` (if not set) and increments `hiscoreNotFoundCount`
   (`hiscoreNotFoundPipeline` in `src/ingester/scrape-results.ts`), and alerts on Discord when it pauses a player. A
   repeated message counts once more, which changes nothing: the count is only read as "more than 0". The streak is
   date-based: once `hiscoreNotFoundSince` is 7 days old (`HISCORE_NOT_FOUND_PAUSE_DAYS`), it moves `scrapingOffsets`
   into `pausedScrapingOffsets` and removes `scrapingOffsets`, so the sync drops the player's subscription and
   queue-players stops queueing them. History is kept.
2. **A successful scrape ends the streak.** The ingester unsets `hiscoreNotFoundCount` and `hiscoreNotFoundSince` when
   it stores an entry.
3. **The API resumes.** A successful `refreshPlayerInfo` merges `pausedScrapingOffsets` (and the requested offset) into
   `scrapingOffsets` and unsets `pausedScrapingOffsets`, `hiscoreNotFoundSince` and `hiscoreNotFoundCount`.
4. **The API never counts.** A refresh that isn't successful (404 or hiscores outage) writes nothing.

## `hiscoreLayouts`

One document per list of skill and activity names Jagex has used (one on 2026-10-10). A RuneScape update that adds a
skill or activity gives a new layout; older entries keep theirs.

| Field                  | Written by                                                                                                                                                                                               | Read by                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `_id`                  | `layoutId(skills, activities)` from models: 32-bit FNV-1a over the names, as a signed int32. Writers upsert the layout **before** the first entry using it and fail when an existing id has other names. | API (cached).                |
| `skills`, `activities` | `$setOnInsert` by the API and its ingester (`src/features/players/hiscore-layouts.service.ts`), and once by the 2026-10-10 migration (a one-off script, removed since). Never changed after insert.      | API, to decode entries.      |
| `since`                | `$setOnInsert` (the first writer's scrape time); the migration lowered it with `$min` to the oldest entry using it.                                                                                      | The clean job's 1-day guard. |

The clean job deletes layouts no entry uses that are older than a day (`since`), after its nightly pull. The guard
protects a layout whose first entry is still being written.

## `items`

One document per OSRS item, keyed by `id`.

| Field                                                                               | Written by                                                                                                                                                                                                                                                                                                                                                                                                        | Read by                                                      |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `id`, `name`, `examine`, `icon`, `members`, `value`, `limit`, `lowalch`, `highalch` | The items job, every hour: upserts each item from the OSRS Wiki `mapping` endpoint that is new or differs from the stored one in a field the Wiki sends, with `$set` of the whole object. A field the Wiki omits for an item keeps its stored value.                                                                                                                                                              | API, web.                                                    |
| `addedAt`                                                                           | The items job, with `$setOnInsert` (one time per run): when it first stored the item. Items stored before then got their release day (UTC midnight) from the OSRS Wiki's `infobox_item` bucket (`release_date`) in a one-off backfill on 2026-10-25 (4,674 items, a script never committed), clamped to Old School's launch (2013-02-22) for the 2,599 released before it, which the game has had from the start. | API `GET /items?sort=added`.                                 |
| `updatedAt`                                                                         | The items job, on every item it writes (one time per run), so only when the item is new or a Wiki field changed. Items it hasn't written since 2026-10-25 have none (no backfill).                                                                                                                                                                                                                                | API item browse lists (the web's items sitemap `<lastmod>`). |
| `lastFetch`                                                                         | API `recordLookup` (`POST /items/:id/lookup`): when a visitor last looked the item up. Only on existing items.                                                                                                                                                                                                                                                                                                    | API recent items list.                                       |

The items job deletes the items missing from the Wiki's list after its upsert (items Jagex took off the GE), but skips
that run's delete when more than 50 would go (`MAX_REMOVED_ITEMS`), so a truncated response never wipes the collection.
It leaves out the Wiki's placeholder entries (examine text just "placeholder": unobtainable copies of real items Jagex
lists on the GE), so they're never stored and the ones stored before 2026-10-25 were deleted as missing.

## `playerCounts`

One document per sample of the players online (`PlayerCount` in models), every 10 minutes (about 52,560 a year, roughly
10 MB). Kept forever: nothing deletes or updates them.

| Field                                             | Written by                                                                                                                                                                                                                                                                                                                                                                                                                        | Read by                                                      |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `date`                                            | The ingester, from record-player-count's `playerCount` message: an upsert on `date` with `$setOnInsert`, so a repeated message stores nothing. When record-player-count fetched Jagex's world list.                                                                                                                                                                                                                               | API (osrs-tracker/osrs-tracker-api#146: latest and history). |
| `total`, `members`, `f2p`, `worlds`, `byLocation` | The ingester, as record-player-count read them from the world list: players summed over every world (an offline world counts 0), split by the world's members flag; the number of worlds; players per raw location code, as a string key: 0 United States (east and west together), 1 United Kingdom, 3 Australia, 7 Germany, 8 Brazil, 9 Japan, 10 Singapore, 12 South Africa; a new code can appear when Jagex adds a location. | API.                                                         |

A record-player-count run that can't read the world list, reads 0 worlds or 0 players, or can't send the message sends
nothing, so a gap in `date` is a missed sample, not a count of 0.

## `playerCountsDaily`

One document per UTC day that has [`playerCounts`](#playercounts) samples (`PlayerCountDay` in models): that day's
averages, about 365 a year. The ingester recomputes them for every `playerCount` message it applies, after storing its
sample, with one aggregation over the samples from the start of the sample's UTC day on (so a late sample reaches its
day) ending in `$merge` (`on: 'date'`, `whenMatched: 'replace'`). Recomputing instead of adding to running sums keeps it
idempotent: a repeated message, or the retry of one whose recompute failed, gives the same days. Until
osrs-tracker/osrs-tracker-aws#166 record-player-count did this, from the newest stored day on. The grouping and rounding
are the API's daily history (`src/features/player-counts/player-count-history.ts`), so the API answers the same from
either. Nothing else writes or deletes them.

| Field                     | Written by                                                                                                                                           | Read by                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `date`                    | The ingester: the UTC day's start (`$dateTrunc`).                                                                                                    | API (osrs-tracker/osrs-tracker-api#159: the `1y` and `all` history). |
| `total`, `members`, `f2p` | The ingester: the day's averages of the samples' fields, `$round`ed (half to even), so `members + f2p` can be one off `total`.                       | API.                                                                 |
| `byLocation`              | The ingester: the average per location code over the samples that have the code (one that appears mid-day averages only the samples since), rounded. | API.                                                                 |
| `peak`                    | The ingester: the highest `total` sampled that day.                                                                                                  | API.                                                                 |
| `samples`                 | The ingester: how many samples the day averages. Today's is partial; a whole day has 144, fewer when samples were missed.                            | API.                                                                 |

A day without samples has no document, so a gap stays a gap. When the recompute fails, the message fails and comes back:
its retry finds the sample stored and recomputes the days again.

## `news`

One document per Jagex news post (`OsrsNewsItem` in models; the API types a stored post as `StoredNewsItem`, with
`description` and `enclosure` optional), keyed by `link`. Written and read by the API only; the ingester doesn't touch
it. Kept forever: about 200 new posts a year, under 1 MB in all.

| Field                          | Written by                                                                                                                                                                                                                                                                                                                                                                 | Read by                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `link`                         | API `storeNews` (`src/features/news/news.service.ts`): on every news feed refresh (Jagex's RSS, the newest 15 posts; at most every 5 minutes per pod, on the first `/news` or first `/news/archive` page request after that), a `bulkWrite` of `updateOne({ link }, { $set: item }, { upsert: true })` per post. `https://secure.runescape.com/m=news/<slug>?oldschool=1`. | API (the upsert key).                  |
| `title`, `pubDate`, `category` | API `storeNews`, `$set` of the whole feed item, so a post Jagex republishes under the same link (e.g. Game Status Information Centre) gets the newer title and date. `pubDate` is a Date at midnight UTC, as the feed sends it; `category` is Jagex's (`Game Updates`, `Community`, `Technical`, `Future Updates`, …).                                                     | API `GET /news/archive`, then the web. |
| `description`, `enclosure`     | API `storeNews`, as above; `scripts/backfill-news-images.mjs` only where a post lacks them (see **Backfill.**). `enclosure` is `{ url, type }` (the image itself isn't stored).                                                                                                                                                                                            | API `GET /news/archive`, then the web. |

`GET /news/archive` (`getNewsArchive`) refreshes the feed first for its first page, then reads a page sorted
`{ pubDate: -1, link: -1 }`, `_id` projected out. `GET /news` still serves the feed from memory, not this collection. A
failed `storeNews` is logged, not thrown.

**Backfill.** Two one-off scripts, both run on 2026-10-13 and removed from osrs-tracker-api on 2026-10-14 (its git
history keeps them). `scripts/backfill-news.mjs` (after osrs-tracker/osrs-tracker-api#155) inserts about 1,840 posts
since 2013 from the OSRS Wiki's `update` bucket with `$setOnInsert`, so it never overwrites a feed post. It stores only
`link`, `title`, `pubDate` (midnight UTC) and `category` (mapped to Jagex's names): no `description` or `enclosure`,
because the Wiki's text is CC BY-NC-SA.

`scripts/backfill-news-images.mjs` (osrs-tracker/osrs-tracker-api#162) then gave most of them Jagex's own teaser and
image. It walks Jagex's monthly news archive (`secure.runescape.com/m=news/archive?oldschool=true&year&month&page`) and,
matched on `link` (or the same slug apart from Jagex's `-1` suffix), `$set`s `description` and `enclosure` only where a
post lacks them (filtered on `$exists: false`), so the feed's version wins. It stores image URLs only, and only
`https://cdn.runescape.com/` ones (the only origin `GET /news/image` serves). 1,809 posts got a teaser, 1,322 an image.
503 of the 1,840 stored posts have no image: posts from 2013 to 2016 pointed at the gone
`services.runescape.com/m=rswikiimages` host, and some later ones at imgur or a generic fallback. 16 posts that the
archive doesn't list have neither. The teaser is Jagex's text, not the Wiki's, so the CC BY-NC-SA note above still holds
for Wiki text.

Measured on 2026-10-13: a post with teaser and image is about 420 bytes, one with a teaser only about 265, one with
neither about 200; the collection is about 700 KB.

## `jobRuns`

One document per scheduled job of osrs-tracker-api's ingester, `_id` the job's name (`subscriptions`, the sync below,
`items` and `clean`), with `lastSuccess` (Date), when it last completed. Written and read only by the ingester's
`JobRunsService` (`src/ingester/job-runs.service.ts`), an `updateOne` with `$set` and `upsert` after each success; on
boot it runs a job whose `lastSuccess` is missing or older than its interval. Nothing else touches it, and it has no
index beyond `_id`.

## `osrs-tracker_subscriptions` (DynamoDB)

Who to scrape, outside MongoDB: one item per player, `PlayerSubscription` in models, `{ username, scrapingOffsets }`,
keyed by `username`. `scrapingOffsets` is a Number Set (a `Set<number>` through `@aws-sdk/lib-dynamodb`), so it's never
empty: a player with no offsets to scrape has no item. A derived copy of `players.scrapingOffsets`, never authoritative:
MongoDB stays the source of truth, and a wrong item is fixed there, not in the table.

- **Written only by** the ingester's subscriptions sync in osrs-tracker-api
  (`src/ingester/subscriptions-sync.service.ts`, osrs-tracker/osrs-tracker-api#204), every 15 minutes and on boot when
  overdue (`jobRuns`): whole items (puts and deletes), never deltas, so each run repairs any drift.
  `pausedScrapingOffsets` don't count, and offset `12` isn't copied (queue-players queues it with `-12`). It skips the
  deletes when MongoDB returns no players or over 10% of the items would go, so an empty or wrong database can't empty
  the table.
- **Read only by** queue-players, every hour: a Scan of the whole table, keeping the items whose `scrapingOffsets` have
  the hour's offset. It never writes it, and an empty table alerts on Discord and queues nothing.

So a player starts or stops being scraped up to 15 minutes after the change in MongoDB, and scraping goes on from the
last copy while MongoDB is unreachable.

## Indexes

One owner per index. The owner creates it; everyone else may rely on it (`hint`) but shouldn't create it.

| Collection          | Index                                           | Owner (creates it)                                                                                                                                            | Relied on by                                                                                                                                  |
| ------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `players`           | `{ username: 1 }`, unique                       | API, at startup (`src/common/mongo/mongo.provider.ts`)                                                                                                        | API `hint` in `getPlayer`, `recordLookup`, `refreshPlayerInfo`; the ingester `hint` in its entry and not-found writes.                        |
| `players`           | `{ lastHiscoreFetch: -1 }`, partial (`$exists`) | API, at startup                                                                                                                                               | API `getLastFetchedPlayers` (`hint`).                                                                                                         |
| `items`             | `{ id: 1 }`, unique                             | API, at startup                                                                                                                                               | API `getItem`, `recordLookup` (`hint`); the items job's upsert and delete (`hint`).                                                           |
| `items`             | `{ name: 1 }`, collation `en`, strength 2       | API, at startup                                                                                                                                               | API `browseItems` (`hint`, with the same collation, `ITEM_NAME_COLLATION`: without it Mongo can't use the index).                             |
| `items`             | `{ lastFetch: -1 }`, partial (`$exists`)        | API, at startup                                                                                                                                               | API `getLastFetchedItems` (`hint`).                                                                                                           |
| `items`             | `{ addedAt: -1 }`, partial (`$exists`)          | API, at startup                                                                                                                                               | API `getNewItems` (`hint`).                                                                                                                   |
| `playerCounts`      | `{ date: 1 }`, unique                           | The ingester, once Mongo answers after a start (`ScrapeResultsService.ensureIndexes`); record-player-count created it until osrs-tracker/osrs-tracker-aws#166 | API latest count and history ranges; the ingester's upsert on `date` (unique since 2026-10-22, so a repeat can't store a sample twice).       |
| `playerCountsDaily` | `{ date: 1 }`, unique                           | The ingester, once Mongo answers after a start (`ScrapeResultsService.ensureIndexes`); record-player-count created it until osrs-tracker/osrs-tracker-aws#166 | The ingester's `$merge` (its `on` needs a unique index); API `1y` and `all` history.                                                          |
| `news`              | `{ link: 1 }`, unique                           | API, at startup                                                                                                                                               | API `storeNews` upsert (no `hint`).                                                                                                           |
| `news`              | `{ pubDate: -1, link: -1 }`                     | API, at startup                                                                                                                                               | API `getNewsArchive` (`NEWS_ARCHIVE_SORT`, no `hint`); replaced `{ pubDate: -1 }` on 2026-10-25, which nothing read once `getNewsSince` went. |

A `hint` on a missing index fails the query, so don't drop an index without checking this table.

The clean job's `$pull` runs over the whole collection without an index; that's expected for a nightly job.

## Where the models and storage differ

- `Item.members` is typed `true`; stored values are `true` or `false`.
- One player has `type: 'CLEARED'`, which isn't a `PlayerType`, with `lastModified` set to 1900 and no `combatLevel`: a
  record cleared by hand.
- `OsrsNewsItem.description` and `enclosure` are required; the backfilled `news` posts Jagex's archive has no image or
  teaser for still lack them (about 500 without an image, 16 with neither), so the API's `StoredNewsItem` keeps both
  optional.
- Nothing checks stored documents against the models.

## Stored data

What the live database holds beyond what the code above writes. Recheck (read-only) when changing a writer.

- **`players` without entries**: none. The 153 there were on 2026-10-10 (144 with `hiscoreEntries: []` and
  `scrapingOffsets: []` whose entries aged out, 9 looked up before tracking existed with neither field) were deleted by
  the clean-hiscores Lambda that day; the clean job deletes any new ones nightly.
- **`scrapingOffsets: []`** on 8 players that still have entries (2026-10-10), from older code (current code always adds
  the requested offset). queue-players doesn't queue them and the ingester won't pause them (it only pauses a non-empty
  `scrapingOffsets`); a lookup gives them an offset again. Otherwise their entries age out and the clean job deletes
  them.
- **Offsets in use**: -12, -6, -4, -3, 0, 1, 2, 3; 0 for over 90% of entries. Per player (2026-10-10): 469 have one
  offset, 32 two, 5 three. None had `scrapingOffsetLookups` then: the clean-hiscores Lambda dated every current offset
  on its first run after 2026-10-10, so the first drops come 180 days after that (about April 2027).
- **Size**: the cluster's MongoDB volume is 10 GiB (fremen-cluster `cluster/mongodb/volume.yaml`; Atlas's free tier,
  until 2026-10-22, allowed 512 MB). Since the compact format (2026-10-10), an entry is about 0.8 KB (24.2 MB for 31,822
  entries of 514 players, was 223.9 MB); 90 days of entries for the players tracked on 2026-10-10 settles near 37 MB (60
  days, until 2026-10-13: near 25 MB). The migration also put the few out-of-order entries in date order and dropped the
  extra `name` some older API entries carried.
- **`items`**: `limit`, `lowalch`, `highalch` and `value` are missing on some items (the Wiki omits them).
