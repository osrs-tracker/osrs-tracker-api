## 2026/10/09

- API responses to browsers are compressed (Brotli, gzip or zstd, whichever the browser asks for):
  `GET /players?limit=50` and a 50-entry hiscores page were about 350 KB each. Traefik compresses JSON responses of 1 KB
  and up; `/news/image` stays as it is (WebP is already compressed), and so do the web server's own calls to the API
  inside the cluster. `Cache-Control` is unchanged; responses now also vary on `Accept-Encoding`.
- Removed the Swagger docs (`/swagger`, only served locally and no longer used) and `@nestjs/swagger` with them, which
  also drops `swagger-ui-dist` and `@scarf/scarf` from the dependencies. What the docs said about each route (its
  statuses, their `Cache-Control` and the params' meaning) is now a short comment on the route's handler. Routes,
  responses and headers are unchanged.

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
