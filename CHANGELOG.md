## 2026/10/10

### Players

- Hiscore entries are stored in about an eighth of the space (roadmap osrs-tracker/osrs-tracker-aws#52), and the player
  responses change shape with them: in `GET /players/:username`, `GET /players/:username/hiscores`, `GET /players` and
  `POST /players/:username/lookup`, an entry's `skills` and `activities` are objects keyed by name (`"Attack"`,
  `"Clue Scrolls (all)"`) instead of Jagex's arrays with `id`s; an unranked skill or activity with a value has
  `rank: null` instead of `-1`, and one without a value is `null`. A skill or activity Jagex adds is stored and returned
  under its name without an update. Entries are stored by position in a layout (the names Jagex used, in the new
  `hiscoreLayouts` collection, cached in memory) and a value that didn't change since the next newer entry as its bare
  rank. Uses `@osrs-tracker/models` 2.0.0 and `@osrs-tracker/hiscores` 4.0.0.
- `POST /players/:username/lookup` also records when each scraping offset was last looked up (`scrapingOffsetLookups`),
  so the clean-hiscores Lambda can stop scraping an offset nobody has looked up for 180 days
  (osrs-tracker/osrs-tracker-aws#70, #126). Bots and `GET` requests still record nothing; responses are unchanged. Uses
  `@osrs-tracker/models` 2.3.0.
- New `GET /sitemap/players` for the web app's player sitemap (#120, osrs-tracker/osrs-tracker-web#169):
  `[{ username, lastEntry }]` by username, every tracked player that's still scraped (not paused), without a not-found
  streak and with a hiscore entry in the last 30 days, with `lastEntry` the date of its newest entry (about 530
  players). Not under `/players/`, where `sitemap` is a player's name. `Cache-Control: public, max-age=3600`.
- `GET /players` takes `entry=overall` (#132, osrs-tracker/osrs-tracker-web#202): each player's newest entry comes back
  with only its `date`, `scrapingOffset` and `skills.Overall` (`activities: {}`), about 2 KB for 6 players instead of 28
  KB, for the web's recent players rows, which are embedded in the SSR pages. Without it the response is unchanged; any
  other value is a 400.

### Items

- New `GET /items/browse/:letter` for the web app's A–Z item pages (#119, osrs-tracker/osrs-tracker-web#168): every item
  whose name starts with `letter` (`a`–`z`, or `0` for names starting with a digit or other character), sorted by name
  case-insensitively, as `[{ id, icon, name }]`; 400 for any other letter. Up to 600 items (`s`) per letter, so no
  pagination. Runs on a new case-insensitive index on `name`, created at startup.
  `Cache-Control: public, max-age=86400`.

- `GET /items/search/:query` matches the start of words, so `drag` finds Dragon items and `dragon scim` puts Dragon
  scimitar first; before, only whole words matched (`drag` found nothing). Every word of the query has to start a word
  of the name, in any order, and whole-word matches rank higher. Runs on a new Atlas Search index (`name_autocomplete`,
  created at startup when missing) instead of the `name_text` index, which the API no longer creates (#129). Responses
  keep their shape; `score` is now Atlas Search's.
- The recent items list (`GET /items`) only shows items visitors looked up: `lastFetch` was cleared on the 4,669 items
  last looked up before 2026-10-08, nearly all of them by crawlers before lookups ignored bots (#128). A one-off data
  fix, nothing deployed.

### Behind the scenes

- The combat level and total xp read skills with `@osrs-tracker/models` 2.1.0's `skillLevel` and `overallOf` (with
  `@osrs-tracker/hiscores` 4.1.0) instead of the API's own copies of those rules. Nothing visible changes.
- Claude Code copies `.env` into the worktrees it creates (`.worktreeinclude`), so a session in a worktree can run
  `npm run start:dev` without linking it by hand (#122). `CLAUDE.md` says where the sibling repos (`../<repo>`) are from
  a worktree.

## 2026/10/09

### Responses

- API responses to browsers are compressed, with Brotli when the browser supports it (every current one does), else
  gzip: `GET /players?limit=50` and a 50-entry hiscores page were about 350 KB each. Traefik compresses JSON responses
  of 1 KB and up; `/news/image` stays as it is (WebP is already compressed), and so do the web server's own calls to the
  API inside the cluster. `Cache-Control` is unchanged; responses now also vary on `Accept-Encoding`.
- Player lookups answer at once when Jagex's hiscores are down or swamped, instead of each waiting for its own 10s
  timeout: after half of the last 20 hiscore requests failed, the API stops asking Jagex for 30s and answers a lookup as
  failed right away (503 for an unknown player, the stored player with `refreshFailed` otherwise), and requests that
  would wait in a full queue (32 behind the 8 in flight per pod) or longer than 10s for a slot fail the same way. A
  player that isn't on the hiscores never counts as a failure. Built on `@nestjs/resilience` (pinned to 0.0.2), which
  replaces the hand-written request limiter; breaker changes and rejections are logged as warnings (at most one a
  minute, not one per lookup), and `/metrics` shows the `resilience_*` gauges and rejection counts.
- News images are converted at most two at a time per pod, with up to 10 more waiting up to 10s for a turn; beyond that
  `/news/image` answers 503 at once (without `Cache-Control`, so it's retried), so a burst of large CDN images can no
  longer run the pod out of memory. Concurrent requests for one image still share one conversion, and cached images
  never wait. The `news-images` bulkhead shows up in the `resilience_*` metrics and rejection warnings.

### Players and items

- Usernames match the way Jagex matches them: `_` and `-` count as spaces and leading or trailing ones are ignored, so
  `/players/Lynx_Titan`, `/players/lynx-titan` and `/players/lynx titan` are one player (`lynx titan`), stored and
  scraped once, instead of up to three separate players. The 12 players stored under an `_` or `-` name were renamed the
  same day, and the 3 of them also stored under the normalized name (with the same history) removed.
- Two lookups of one player at the same moment (two tabs, a double request) no longer answer one of them with a 500, and
  a player's first entry for a time zone (`scrapingOffset`) is no longer stored twice when that happens.
- `GET /players/:username/hiscores` answers 400 for a `skip` over 10,000, instead of a 500 from MongoDB for one that
  doesn't fit in 32 bits.
- The item search's 400 for a long query reads "Search query must be 64 characters or less" (was "must be at 64").

### Logging

- All log lines now come from the shared `@osrs-tracker/logger` (pino), the same format as the web server's, replacing
  the hand-written request log (`morgan`) and app logger. Every line is one JSON object with `level` `info`, `warn` or
  `error` (Loki's level detection is unchanged), `time` as an ISO string and a new `type` saying what it's about:
  `incoming` (a request the API answered), `outgoing` (a request it made), `lifecycle` (startup and shutdown),
  `uncaught` (an unhandled error) or `app` (the API's own warnings and notes), so Grafana can pick one kind with
  `| json | type="outgoing"`. App lines keep `context` (the logging class's name) and write an error as one string under
  `error`; everything goes to stdout. Request lines keep their fields (`status`, `route`, `aborted`, `responseTime`, …),
  but `responseTime` now runs until the response has finished, so it may read slightly higher, and it's whole
  milliseconds (`12ms`, was `12.345ms`), on outgoing lines too. An error logged with a stack no longer also prints it as
  plain lines on stderr (which Loki read as separate lines without a level), extra fields passed to a log call
  (`logger.warn('…', { username })`) are written as fields instead of dropped, and an object logged as the message reads
  as the object instead of `[object Object]`. Mongo's connect and close lines now have the context `MongoDB` (was
  `MongoProvider` and `MongoModule`). An error's `error` field now also has its cause and its own fields (`code`,
  `errno`, …), written by Node's `util.inspect` (the cause as an indented `[cause]: Error: …`, from
  `@osrs-tracker/logger` 0.2.0), so an unhandled `fetch failed` says why it failed.
- Requests the API makes (Jagex's hiscores, the news feed and news images) are now logged as `type: "outgoing"` with
  their status, URL and duration, carrying the `requestId` of the request that made them.
- Every request gets an ID, logged as `requestId` on its request line and on every line logged while handling it (such
  as a hiscores warning), so a warning can be tied to the request that caused it: in Grafana,
  `{app="osrs-tracker-api"} | json | requestId="<id>"`. Responses send it back as `X-Request-Id`; a client's own
  `X-Request-Id` is ignored, so clients can't give unrelated requests the same ID. Lines outside a request (startup,
  shutdown) have none.

### License

- The API's source code is now under the Elastic License 2.0 instead of Apache 2.0. You can still read it, learn from it
  and run it yourself, but not offer it to others as a hosted service, paid or free. The README's license badge now
  names it: GitHub can't identify the Elastic License, so it's a fixed badge.

### Behind the scenes

- The API keeps idle connections open for 95s instead of Node's 5s, longer than Traefik reuses them (90s), so a request
  can no longer land on a connection the API is just closing (a 502). The pods now run with a locked-down container
  (non-root `node` user enforced, read-only filesystem, no capabilities, like the web server's), a node drain keeps at
  least one of the two running (a PodDisruptionBudget), and pod starts no longer ask Docker Hub again for an image the
  node already has (`imagePullPolicy: IfNotPresent`; the image is pinned by digest).
- `/metrics` (port 9090, not public) now comes from the shared `@osrs-tracker/express-metrics`, like the web server's,
  instead of the unmaintained `express-prom-bundle` and the deprecated `prom-client` (its `npm ci` warning is gone).
  `http_request_duration_seconds`, `up` and the `resilience_*` series are unchanged; new are Node's process metrics
  (`nodejs_*`, `process_*`: event-loop lag, heap, GC). The skill now says how to add a metric.
- Removed the Swagger docs (`/swagger`, only served locally and no longer used) and `@nestjs/swagger` with them, which
  also drops `swagger-ui-dist` and `@scarf/scarf` from the dependencies. What the docs said about each route (its
  statuses, their `Cache-Control` and the params' meaning) is now a short comment on the route's handler. Routes,
  responses and headers are unchanged.
- The news feed and news image caches are now plain `lru-cache` caches that fetch on a miss, replacing the hand-written
  expiry and in-flight bookkeeping. Behaviour is unchanged: the feed is cached for 5 minutes and, while Jagex fails,
  served stale and retried every 60s (503 only when nothing is cached); concurrent requests for the feed or for one
  image share one fetch, and failed image requests aren't cached. Both are now covered by tests.
- A route that duplicates or shadows another (e.g. `/items/recent` next to `/items/:id`, which Express would never
  reach) now stops the API at startup and fails the tests, instead of silently never answering. Today's routes don't
  overlap, so nothing changes at runtime.
- The 10 MB news image limit is enforced by `undici` itself, on an HTTP agent of its own for image requests (hiscore and
  feed requests stay unlimited), replacing the hand-written byte counting. An image over it still answers 503: refused
  before downloading when it announces its size, cut off at 10 MB when it doesn't, and always requested uncompressed, so
  the limit holds for what is actually read.
- The MongoDB connect retry at startup uses `@nestjs/resilience`'s `RetryPolicy` instead of a hand-written loop, with
  the same timing (12 attempts, 10s apart) and log lines; now covered by tests. A failing cleanup of a failed attempt no
  longer hides the connect error.
- Docs: the skill now spells out the stored username form, the race-safe refresh update rules (decide in the pipeline,
  check `matchedCount`), and how Atlas writes are handed over (`use('osrs-tracker')` first, with the counts to expect)
  and checked (read-only MongoDB MCP); `CLAUDE.md` says the pre-push hook is Claude's, not git's.
- `NODE_ENV` is no longer one of the API's own settings (nothing read it after the Swagger docs went); the image still
  sets it to `production` for Express and the libraries that read it.
- ESLint's `no-useless-assignment` is off: it reported constants used only in a handler's parameter decorators as
  unused, which had forced `GET /players/:username/hiscores` out of its place in the controller.
- Docs audit: the README says where the MongoDB credentials come from, that Node 24 is needed, what a hanging start
  (MongoDB connect retries) means, that item lookups write too and where each route is described. The project skill
  explains how to record and restore the ToxSick test player, when `/healthy` starts answering, what the cluster secret
  holds, how to check a build-tool change in a clean checkout and the rebase before waiting on PR checks; `CLAUDE.md`
  says what to do when the pre-push hook blocks a push, and the conventions reviewer diffs against `origin/main`.

## 2026/10/08

### Rollouts

- Requests during a rollout no longer get a 502: a shutting-down pod keeps answering its health check until it has
  finished its requests and waits 5s for Traefik to stop sending it traffic. Rollouts are also faster: an old pod exits
  as soon as its requests are done instead of hanging until it's killed 30s after shutdown starts. New pods are probed
  once they're likely up, 2s after starting, so redeploys no longer fill the cluster with `Unhealthy` probe events.
- The API pods reserve 50m CPU and 128Mi memory and are capped at 512Mi, so they're no longer the first to be evicted
  when the node runs low on memory, and a runaway image conversion can't take the node's memory with it.
- A missing or invalid setting stops the API at startup with one error listing every problem (e.g.
  `OSRS_API_BASE_URL is required.`), instead of starting and then failing every hiscore fetch, or retrying MongoDB for
  minutes before the real error. Each MongoDB connect attempt now gives up after 10s (the driver waited 30s), and the
  startup probe allows 4.5 min instead of 3, so a pod waiting for cluster DNS after a node reboot is no longer restarted
  before its last retry.
- A shutting-down pod closes its MongoDB connections once its requests are done (giving up after 5s) instead of dropping
  them when the process exits.

### Logging

- Request logs no longer report a client that disconnects before the response as an error. These lines are logged at
  `warn` with `aborted: true` and no `status`, and `responseTime` is the time until the connection closed instead of
  `undefinedms`. Other requests are logged as before.
- Errors that Nest logs as plain text, such as the port already being in use or a failed shutdown, are logged with their
  real cause instead of crashing the logger with a `TypeError`. A failed shutdown now exits the way Nest intends. An
  error's stack trace is part of its JSON log line (`stack`) instead of being written to the output separately.

### Players

- Hiscore entries no longer have a `sourceString` (`@osrs-tracker/models` 0.10.0 removed it): the API stops writing
  `'LEGACY'` into new entries and returns stored entries as they are, now that none has a real one left. Responses get
  slightly smaller (24 bytes per entry).
- Player requests are faster: they no longer ask MongoDB to create the `username` index on every call (one extra round
  trip per `GET /players/:username` and `/hiscores`, two per POST lookup); the index is created once at startup.
- `GET /players/:username` no longer returns `"hiscoreEntries": null` when `includeLatestHiscoreEntry` isn't set; the
  key is left out, as the model describes.
- Hiscores are fetched with the shared client from `@osrs-tracker/hiscores` 3.1.1, the one the `process-players` Lambda
  uses, instead of the API's own copy. Timeouts, 404/400 handling and the 503s stay the same; a hiscores response is now
  also rejected when `activities` isn't a list, and a failure's log line says why (status, timeout or network error).
  New players' first hiscore entry, and the preview of an unknown player, no longer include the `name` the hiscores echo
  back, matching the entries the Lambda stores.
- Looking up players asks Jagex far less: the normal hiscores come first, so a name that isn't on them (or a hiscores
  outage) costs 1 request instead of 4, at the cost of one extra round trip for players that are. Concurrent lookups of
  one name share their requests, each pod sends at most 8 hiscore requests at once (the rest wait their turn), and a
  preview of an unknown name remembers for 60s that it isn't on the hiscores, so crawlers repeating it don't reach
  Jagex. The POST lookup always asks again. Status codes and `Cache-Control` stay the same.
- A hiscore response from Jagex that is missing skills now counts as a failed lookup (503, or the stored player with
  `refreshFailed: true`) instead of an error (500), and can no longer store a wrong combat level.

### Items

- `GET /items/search/:query` answers `200 []` when nothing matches, instead of a `204` with no body (thrown as an error,
  which dropped its message). It's still `public, max-age=3600`. The web app already treats both as no results.

### News

- `GET /news?limit=N` only accepts 1 to 50, like the other lists, and answers 400 otherwise (`limit=-1` used to return
  every item but the last).
- `GET /news` keeps the feed in memory for 5 minutes instead of fetching it from Jagex on every request, and keeps
  serving that copy when Jagex fails (retrying a minute later). Without one, a failing, hanging or malformed feed
  answers 503 within 10s instead of a 500 or a request that never finishes, and a feed with a single post no longer
  fails. Errors no longer carry the 5-minute `Cache-Control`, so a cache can't keep serving a failure.
- `GET /news/image` gives up on the CDN after 20s (503), answers 404 for an image the CDN doesn't have and 502 for a
  response that isn't a usable image, instead of a 500 for all of them. Concurrent requests for the same image fetch and
  convert it once. Converted images are now `public, max-age=604800`, so shared caches may keep them too.

### Behind the scenes

- Merging to `main` deploys the API automatically. The `CD` workflow (next to `CI`, with runs named after the commit
  they deploy) builds and pushes the image and commits its digest to `osrs-tracker-api.yaml` as `github-actions[bot]`
  (the committer email had the wrong user ID). The cluster applies it on its own, and the workflow then checks that the
  deploy succeeded and smoke tests routes the API serves itself (`/items`, `/items/4151`, a 404), so a Jagex outage
  doesn't fail a good deploy. A deploy no longer reports failure when another push lands on `main` before the cluster
  applies it. Rolling back is reverting the digest commit. Images are only built and pushed this way: the `docker:build`
  and `docker:push` scripts are gone.
- Pushes that don't change the code or the image (documentation, for example) don't rebuild or redeploy, including the
  first push after a deploy: CI compares with the last commit it checked, skipping the deploy's digest commits. Pushes
  that only change `osrs-tracker-api.yaml` (deploy digests and rollbacks) don't run CI at all, so they don't start a CD
  run that skips.
- Dependabot opens weekly update PRs: npm minor and patch updates grouped into one PR, GitHub Actions grouped, and the
  `node:24-alpine` base image, now pinned by digest so a rebuilt image (Node patches, Alpine fixes) gets a PR. npm and
  Node majors aren't proposed: they need migration work, so they're done by hand from an issue. The GitHub Actions are
  pinned to commit SHAs (with the version as a comment), so a moved tag can't change what runs with the Docker Hub
  credentials and the deploy key; Dependabot's actions PRs bump the SHAs.
- The image installs the `sharp` version `package.json` pins (now exactly 0.35.5) instead of a version written in the
  `Dockerfile`, so a Dependabot `sharp` update reaches the image. CI now builds the image on every code change and
  checks that its `sharp` converts an image, so a broken `Dockerfile` fails the PR instead of the deploy.
- Stricter checks: TypeScript runs in `strict` mode and ESLint fails on floating promises and flags `any` (the code
  already passed both). Removed unused dev dependencies (`@swc/cli`, `@swc/core`, `ts-node`, `tsconfig-paths`,
  `source-map-support`), which also clears the only `npm audit` finding, and leftover lint globs and Jest globals.
- Unit tests with Vitest (`npm test`, run in CI and required to merge) for the rules that protect player data and the
  web app's caching: the stored player's `max-age`, when a lookup refreshes a player, the refresh update that resumes
  paused players, the combat level, type and status calculations, and username validation. The first three moved out of
  the players controller and service into `player.policy.ts`, and every `Cache-Control` value is a named constant;
  responses are unchanged. A test also boots the whole API against a fake database and fake Jagex and requests every GET
  route: each must send its expected `Cache-Control` and must not write to the database, and a new GET route or a new
  `Cache-Control` value fails it until a test case covers it. ESLint rejects `no-store`, `no-cache` and `private`
  anywhere in a string in `src/`.
- Query and route param validation (`limit`, `size`, `skip`, `scrapingOffset` and item IDs) lives in two shared, tested
  pipes instead of checks repeated in every handler. Status codes and error messages are unchanged.
- The Swagger docs (`/swagger`, local only) now list every route's responses: each status it can answer (including `204`
  for bots, `404` vs `503` for players, and the unknown player's preview), with its `Cache-Control`, taken from the same
  constants the routes send. `limit`, `size`, `skip`, `scrapingOffset` and item IDs show their range and default, read
  from the validation pipes' options so the docs can't drift from the checks.
- Upgraded to NestJS 12 (`@nestjs/*` 12, `@nestjs/config` 12, `@nestjs/swagger` 12) and TypeScript 6.0; responses, logs
  and graceful shutdown are unchanged. Swagger 12 brings the patched `js-yaml` itself, so the `overrides` entry for it
  is gone. `@osrs-tracker/models` 0.10.1 lists its types first in `exports`, which TypeScript 6 needs, and
  `tsconfig.json` now names `node` in `types` (TypeScript 6 no longer loads every `@types` package). The build skips
  Nest's optional imports under their new ESM names and Swagger's optional `@fastify/static`. Dependabot doesn't propose
  TypeScript 6.1 until `typescript-eslint` supports it.
- The build uses rspack instead of webpack, which Nest CLI 12 deprecates (`rspack.config.js` replaces
  `webpack.config.js`; `webpack` and `ts-loader` are no longer dev dependencies). It takes about 1.5s instead of 2s, and
  the bundle is 6.1 MB instead of 6.7 MB. Responses, Swagger's document, logs and graceful shutdown are unchanged. The
  build still fails on type errors, CI's only type check, and now also fails if the type checker is missing instead of
  silently skipping it. `npm run start:dev` still compiles with `tsc`.
- Outgoing requests (hiscores, the news feed and news images) use `undici`'s `fetch` instead of `node-fetch`, which
  hasn't had a release since 2023. Keep-alive and the limit of 50 connections per host stay, and so do the timeouts. The
  10 MB news image limit now counts the bytes as they arrive and stops the download as soon as an image goes over it.
- Settings are read once, validated, through Nest's `ConfigService` (`src/config/env.ts`) instead of `process.env` in
  six files. `.env` is loaded once instead of twice, and CORS no longer depends on which module happens to load it
  first.
- Dependency updates: `eslint` 10.12.0 and `typescript-eslint` 8.71.1 (lint tooling only).
- Claude's pre-push lint check checks the worktree being pushed.
- Small cleanups: a log line's missing quote, the player refresh interval as a named constant
  (`MIN_PLAYER_REFRESH_HOURS`) and no second username normalisation in `PlayersService` (the route pipe already does
  it). The README and the project skill link osrs-tracker-aws's `DATA-MODEL.md` for who owns which field and index, and
  the skill keeps only the API's side of the pause/resume contract.
- Project skill: when adding a changelog entry, reread the whole day, add subtitles once it's busy and merge entries
  about the same feature. Regrouped this day and 2026/10/07 that way. Releasing from a worktree no longer tries to
  switch to `main` (the main checkout has it) or delete the PR branch GitHub already deleted; `CLAUDE.md` and the README
  point at the new Cache-Control checks.
- README: fixed the license badge link, setup now starts from `.env.example` and warns that `.env` points at production
  data, and it describes the metrics/health server on port 9090 and the checks to run before committing. Added a short
  summary of the history before 2026/10/02 at the end of this changelog. The `Dockerfile` health check comment now names
  the right file for `/healthy` (`src/app-metrics.controller.ts`, not `server.ts`). After the technical debt roadmap
  (#37), `CLAUDE.md`, the README, the project skill and the conventions reviewer were checked against the code:
  `CLAUDE.md` maps the new places (`src/config/`, `player.config.ts`, the `Semaphore`, the build and test config); the
  skill covers `validateEnv`'s tests, the hiscore client's own timeout, both `@osrs-tracker` packages and that there's
  no development database by choice; the reviewer also checks the Swagger and test rules.
- Shared providers (database, HTTP agent, XML parser) are injected by exported constants instead of repeated strings, so
  a typo fails the build instead of startup.

## 2026/10/07

### Read-only GETs and browser lookups

- The item and player GETs are read-only, so crawlers no longer change the recent lookups or start tracking players.
  `GET /items/:id` and `GET /players/:username/hiscores` stop recording the lookup. `GET /players/:username` returns a
  stored player as stored, without refreshing it, and an unknown player as a live preview from the hiscores that isn't
  stored (`scrapingOffsets: []`, `trackedSince: null`, `Cache-Control: max-age=0, must-revalidate`); not found is still
  a 404 and a hiscores outage a 503. The browser records lookups and starts tracking through the POST lookup endpoints.
- New `POST /items/:id/lookup` and `POST /players/:username/lookup?scrapingOffset=N` for the web app to call from the
  browser, so the recent lookups lists and player tracking follow visitors instead of crawlers. The item one sets
  `lastFetch` (204). The player one does what `GET /players/:username` does (refresh or start tracking when needed, same
  404/503/`refreshFailed` responses) and also sets `lastHiscoreFetch`. Bots (detected with `isbot`) and requests without
  a user agent get a 204 and write nothing. The GETs still write until the web app uses the POSTs.

### Players

- `GET /players/:username` (and the new lookup POST) return `pausedScrapingOffsets` for players whose tracking the
  hiscores-scraper paused, so the web app can still show their history.
- `GET /players/:username` no longer answers 404 for a stored player when the hiscores are down. 404 means Jagex itself
  doesn't know the player. When the hiscores fail (error status, network error, 10s timeout), a stored player is
  returned as stored with `refreshFailed: true` and `Cache-Control: max-age=60`, and an unknown player gets a 503. A
  refresh also fails when only one of the ironman tables is down, instead of storing the wrong account type.
- `GET /players/:username` returns `trackedSince`: the date of the oldest stored hiscore entry for the requested
  `scrapingOffset`, or `null` when there are none. Old entries are cleaned up, so it's where the stored history starts
  (about 60 days back at most), not when tracking started. `@osrs-tracker/models` is bumped to 0.9.0 for the new field,
  then 0.9.1, whose `lastHiscoreFetch` comment now says it is the last visitor lookup, not the last hiscores scrape.
- `GET /players` accepts an optional `scrapingOffset` (-12 to 11) and then returns each player's newest hiscore entry
  for that offset, so the XP gained in the recent lookups is measured from the right point. Without it, nothing changes.

### Behind the scenes

- Code changes are formatted automatically and checked for lint and formatting errors before they're pushed, and
  reviewed against the project's conventions before release. The automatic build only runs when the code or its
  dependencies change, not for deploys or documentation (unless the previous build didn't pass), and reuses the
  installed dependencies until they change.

## 2026/10/04

- Project skill: documented the changelog conventions (`###` subtitles on busy days, no near-duplicate entries) and
  tightened the wording throughout.
- The API retries its MongoDB connection at startup (every 10s, up to 12 times) when DNS or the network isn't ready yet,
  instead of crash-looping after a node reboot. A `startupProbe` gives it up to 3 minutes to come up.
- Request logs include the client IP (from Traefik's `X-Forwarded-For`, via `trust proxy`), the referer and the response
  size, for security.
- Prometheus metrics label requests with the route they matched (e.g. `/players/:username`) or `#unmatched`, instead of
  the URL, so every player name or scanner URL no longer creates its own time series. Request logs have the same value
  in a new `route` field, next to the full `url`.

## 2026/10/03

- The ingress runs on Traefik (ingress-nginx is retired); the rate limits moved to Traefik Middlewares with the same
  values.
- Project skill: documented the release flow (PR, review, deploy, update the PR, merge).
- Fixed a `url.parse()` deprecation warning in the logs.
- Project skill: ask whether to commit straight to `main` or open a PR, and how to clean up after a merge.
- Security: usernames must be valid OSRS names (1-12 letters, numbers, spaces, `-`, `_`), so double URL-encoded names
  are rejected and never stored; the hiscore lookup URL-encodes the username.
- Security: `/news/image` only accepts plain `cdn.runescape.com` URLs (no query or hash), refuses redirects, non-images,
  bodies over 10 MB and images over 25M pixels, and caches at most 50 MB of images (`lru-cache`), with a throttled
  warning in the logs when it has to evict.
- `/news/image` errors no longer carry the week-long `Cache-Control` of a successful image response.
- Security: bounded `limit` (1-50) on `/players` and `/items`, and `size` (1-100) and `skip` (≥ 0) on hiscores.
- Security: overrode `@nestjs/swagger`'s `js-yaml` to 5.4.2, pinned `sharp` in the Docker image and run the container as
  the `node` user.
- Removed a leftover `console.log` from the total XP calculation.
- Removed the unused `commitizen` dev dependency (and its `braces` audit findings).
- Database: removed 7 duplicate players stored under an invalid username (uppercase or with `'`/`,`) whose history was
  already in the valid record, and lowercased the 5 remaining uppercase usernames so they can be found again.

## 2026/10/02

- Fixed the project skill's frontmatter so its description parses as YAML again.
- Trimmed the project skill to repo-specific rules, added `.env.example` and ignored `tsconfig.tsbuildinfo`.
- Documented the player pause/resume contract, Mongo pipeline-update rules, shared packages and prod testing in the
  project skill.
- Resumed tracking of paused players (no hiscores for 7 days) when they're found on the hiscores again.
- Allowed caching of API responses so the web app's SSR transfer cache can reuse them (no more `no-store`/`no-cache`).
- Clamped the dynamic `max-age` of `/players/:username` to a minimum of 0.
- Updated to Node 24 (CI, `engines`, `@types/node`).
- Updated CI to `actions/checkout@v7` and `actions/setup-node@v7`, and made CI lint fail instead of auto-fixing.
- dependency updates
- Documented the external services (RuneScape API proxy, MongoDB Atlas, AWS Lambdas) in the project skill.
- Expanded the README with an overview, how the API fits into OSRS Tracker and how to run it locally.

## Before 2026/10/02

Summarised from the commit history (2025/04/19 to 2026/09/23); this changelog started on 2026/10/02.

- 2025/04: first version of the API: players with their hiscore history, items and item search, CI with lint and
  Prettier checks, JSON logging and Prometheus metrics. Added `skipRefresh` to `GET /players/:username`, `Cache-Control`
  headers on items and players, and the news endpoints with the `/news/image` proxy that converts images to WebP.
- 2025/06: usernames are normalised so the same player isn't stored twice, and `X-Robots-Tag` headers keep the API out
  of search engines.
- 2025/11 to 2026/07: fixed status codes on player errors (including a 200 for a missing player with `skipRefresh`),
  updated dependencies and fixed the bundling of the build and of `sharp`.
- 2026/09/23: switched to Jagex's JSON hiscores and the new `@osrs-tracker/models`; `sourceString` became legacy.
