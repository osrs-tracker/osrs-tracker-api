## 2026/10/08

### Rollouts

- Requests during a rollout no longer get a 502: a shutting-down pod keeps answering its health check until it has
  finished its requests and waits 5s for Traefik to stop sending it traffic. Rollouts are also faster: an old pod exits
  as soon as its requests are done instead of hanging until it's killed 30s after shutdown starts. New pods are probed
  once they're likely up, 2s after starting, so redeploys no longer fill the cluster with `Unhealthy` probe events.
- The API pods reserve 50m CPU and 128Mi memory and are capped at 512Mi, so they're no longer the first to be evicted
  when the node runs low on memory, and a runaway image conversion can't take the node's memory with it.

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

### Behind the scenes

- Merging to `main` deploys the API automatically. The `CD` workflow (next to `CI`, with runs named after the commit
  they deploy) builds and pushes the image and commits its digest to `osrs-tracker-api.yaml` as `github-actions[bot]`
  (the committer email had the wrong user ID). The cluster applies it on its own, and the workflow then checks that the
  deploy succeeded and smoke tests routes the API serves itself (`/items`, `/items/4151`, a 404), so a Jagex outage
  doesn't fail a good deploy. Rolling back is reverting the digest commit. Images are only built and pushed this way:
  the `docker:build` and `docker:push` scripts are gone.
- Pushes that don't change the code or the image (documentation, for example) don't rebuild or redeploy, including the
  first push after a deploy: CI compares with the last commit it checked, skipping the deploy's digest commits. Pushes
  that only change `osrs-tracker-api.yaml` (deploy digests and rollbacks) don't run CI at all, so they don't start a CD
  run that skips.
- Dependabot opens weekly update PRs: npm minor and patch updates grouped into one PR, majors separately (the `@nestjs`
  packages together), GitHub Actions grouped, and the `node:24-alpine` base image, now pinned by digest so a rebuilt
  image (Node patches, Alpine fixes) gets a PR. Node majors stay manual.
- Stricter checks: TypeScript runs in `strict` mode and ESLint fails on floating promises and flags `any` (the code
  already passed both). Removed unused dev dependencies (`@swc/cli`, `@swc/core`, `ts-node`, `tsconfig-paths`,
  `source-map-support`), which also clears the only `npm audit` finding, and leftover lint globs and Jest globals.
- Dependency updates: `eslint` 10.12.0 and `typescript-eslint` 8.71.1 (lint tooling only).
- Claude's pre-push lint check checks the worktree being pushed.
- Project skill: when adding a changelog entry, reread the whole day, add subtitles once it's busy and merge entries
  about the same feature. Regrouped this day and 2026/10/07 that way.
- README: fixed the license badge link, setup now starts from `.env.example` and warns that `.env` points at production
  data, and it describes the metrics/health server on port 9090 and the checks to run before committing. Added a short
  summary of the history before 2026/10/02 at the end of this changelog. The `Dockerfile` health check comment now names
  the right file for `/healthy` (`src/app-metrics.controller.ts`, not `server.ts`).

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
