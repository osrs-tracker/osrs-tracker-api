## 2026/10/07

- New `POST /items/:id/lookup` and `POST /players/:username/lookup?scrapingOffset=N` for the web app to call from the
  browser, so the recent lookups lists and player tracking follow visitors instead of crawlers. The item one sets
  `lastFetch` (204). The player one does what `GET /players/:username` does (refresh or start tracking when needed, same
  404/503/`refreshFailed` responses) and also sets `lastHiscoreFetch`. Bots (detected with `isbot`) and requests
  without a user agent get a 204 and write nothing. The GETs still write until the web app uses the POSTs.
- `GET /players/:username` (and the new lookup POST) return `pausedScrapingOffsets` for players whose tracking the
  hiscores-scraper paused, so the web app can still show their history.
- `GET /players/:username` no longer answers 404 for a stored player when the hiscores are down. 404 means Jagex itself
  doesn't know the player. When the hiscores fail (error status, network error, 10s timeout), a stored player is
  returned as stored with `refreshFailed: true` and `Cache-Control: max-age=60`, and an unknown player gets a 503. A
  refresh also fails when only one of the ironman tables is down, instead of storing the wrong account type.
- `GET /players/:username` returns `trackedSince`: the date of the oldest stored hiscore entry for the requested
  `scrapingOffset`, or `null` when there are none. Old entries are cleaned up, so it's where the stored history starts
  (about 60 days back at most), not when tracking started. `@osrs-tracker/models` is bumped to 0.9.0 for the new field.
- `GET /players` accepts an optional `scrapingOffset` (-12 to 11) and then returns each player's newest hiscore entry
  for that offset, so the XP gained in the recent lookups is measured from the right point. Without it, nothing changes.
- Behind the scenes: code changes are formatted automatically and checked for lint and formatting errors before they're
  pushed, and reviewed against the project's conventions before release. The automatic build only runs when the code or
  its dependencies change, not for deploys or documentation (unless the previous build didn't pass), and reuses the
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
