---
name: osrs-tracker-api
description: >-
  Repo-specific rules for the osrs-tracker-api NestJS/MongoDB service: Cache-Control rules for the web app's SSR
  transfer cache, param validation pipes, Mongo pipeline-update pitfalls, the player pause/resume contract, the log
  contract with Loki, the @nestjs/resilience presets, unit tests (Vitest), production testing, and the GitHub Actions →
  Flux deploy. Use when adding or changing endpoints, query or route params, Cache-Control headers, logging, outgoing
  requests or player/item writes, writing or running tests, testing against production data, or building, deploying,
  committing, pushing, releasing or shipping this repo.
---

# osrs-tracker-api

NestJS + MongoDB Atlas (native driver), deployed as a Docker image to Kubernetes. Main consumer: the Angular SSR app in
`../osrs-tracker-web`. The `conventions-reviewer` agent reviews diffs against this file and `CLAUDE.md` at runtime, so
keep code rules here, not in the agent.

## Setup gotchas

- `src/common/` providers are injected by string token, exported as constants from their provider file
  (`MONGODB_DATABASE`, `MONGO_CLIENT`, `AGENT`, `IMAGE_AGENT`, `XML_PARSER`): use the constant in `provide`, `@Inject`
  and `overrideProvider`, never the string.
- Outgoing requests use `fetch` from `undici` with `AGENT` (an `undici` `Agent`) as `dispatcher` and a timeout: an
  `AbortSignal.timeout` (news feed 10s, images 20s), or for hiscores the shared client's own (10s).
- News images use `IMAGE_AGENT` instead, whose `maxResponseSize` (`MAX_IMAGE_BYTES`) caps the body as read off the wire:
  request them with `accept-encoding: identity` so decompression can't exceed it, and don't set it on `AGENT` or count
  bytes by hand. undici rejects the body read with a `terminated` `TypeError` whose `cause` is a
  `ResponseExceededMaxSizeError`. It only counts bytes as they arrive, so an image whose `content-length` is already
  over the limit is refused before its body is read, rather than downloaded up to 10 MB in a conversion slot.
- Jagex data cached in memory (the news feed, images) is an `lru-cache` with a `fetchMethod`, read with `forceFetch`: it
  shares the fetch in flight per key and doesn't cache a rejection, so don't add a pending map beside it; to keep a
  stale value on failure, return it from `fetchMethod` (setting `options.ttl` for the retry delay).
- `MongoModule` is global, retries the initial connect (12 x 10s, a standalone `RetryPolicy`, sized against the
  `startupProbe` in `osrs-tracker-api.yaml`: change both together) and closes the client on shutdown (bounded to 5s).
  New indexes go in `mongo.provider.ts`, the only place the API creates indexes (never per request). `/healthy` only
  answers once bootstrap, including the Mongo connect, is done (the metrics server starts listening then, which is what
  the `startupProbe` waits for); after that it stays liveness only and never checks Mongo.
- The `players` and `items` collections, their fields, writers and index owners are described in osrs-tracker-aws's
  [`DATA-MODEL.md`](https://github.com/osrs-tracker/osrs-tracker-aws/blob/main/DATA-MODEL.md). A new or changed index or
  stored field also needs an update there: open an issue in osrs-tracker-aws.
- Env: `.env.example` lists the vars, `.env` holds local values (points at prod). In the cluster they come from the
  `aws-mongodb-credentials` secret (the `MONGODB_*` vars and `OSRS_API_BASE_URL`; its template is
  `cluster/osrs-tracker/secrets.example.yaml` in `../home-cluster`, and the user applies it, never this repo), with the
  `env:` block in `osrs-tracker-api.yaml` setting `CORS_ORIGIN` and overriding `OSRS_API_BASE_URL` (an API Gateway proxy
  to `https://secure.runescape.com` that passes Jagex's headers through). `validateEnv` (`src/config/env.ts`,
  `ConfigModule`'s `validate` in `AppModule`) checks and types them at startup; read them with
  `ConfigService<Env, true>` (`config.get('X', { infer: true })`), never `process.env`. A new var goes in `Env`,
  `validateEnv`, its spec and `.env.example`; a required one also in `app.e2e.spec.ts`'s `vi.stubEnv` calls (validation
  runs when `AppModule` is imported) and in the cluster: the `env:` block for a plain value, or, for a secret, an issue
  in home-cluster for the secret's template plus asking the user to apply it.
- Lambdas in `../osrs-tracker-aws` also write to `players` (hiscore entries, pausing) and `items` (hourly upsert).
- `npm run build` (`nest build -b rspack`, configured by `rspack.config.js`) bundles `node_modules` into `dist/` (only
  `sharp` is external; the image ships just `dist/` plus `sharp`, which the `Dockerfile` installs at the exact version
  `package.json` pins: keep it exact, with no `^`). It compiles with SWC and type checks with
  `fork-ts-checker-webpack-plugin`, CI's only type check: Nest CLI skips it silently when it's missing, so
  `rspack.config.js` fails the build instead. The builder is set in the script, not `nest-cli.json`, so `nest start`
  keeps using `tsc`. Nest CLI 12 only peers `@rspack/core` and the plugins, so they're direct dev dependencies: a
  worktree finds the main checkout's `node_modules` too, so check a build-tool change in a clean checkout outside the
  repo, like CI: commit it, `git worktree add <scratchpad>/build-check HEAD`, run `npm ci && npm run build` there, then
  `git worktree remove` it. An optional package a dependency imports lazily and tolerates missing fails the build with
  "Can't resolve": add it to `lazyImports` in `rspack.config.js`, under the exact specifier (Nest 12's ESM imports end
  in `.js`; the CLI's own list doesn't, so don't drop ours).
- `@nestjs/resilience` presets, registered in `AppModule`: `jagex-hiscores` (bulkhead with a bounded queue, and a
  circuit breaker; `player.config.ts`) for every hiscore request, and `news-images` (a bulkhead only; `news.config.ts`,
  with the memory arithmetic) for every image fetch and conversion, run inside the image cache's `fetchMethod` so a
  shared conversion takes one slot and a cache hit none. Resilience errors are mapped explicitly: `AppModule` sets
  `mapErrors: false`, so its global interceptor never turns them into 503/504s; `PlayersService` turns a refusal
  (`BulkheadFullError`, `CircuitOpenError`) into a `failed` result and `NewsService` a full bulkhead into its image 503,
  without a warning per call: the listener below logs refusals, so an outage doesn't log a line per lookup. A failure
  the breaker should count has to throw inside `execute()`; a not-found player is a success.
  `common/resilience/resilience-events.ts` logs breaker changes and (throttled) rejections, and serves the
  `resilience_*` metrics on `/metrics`. The package is young: keep it pinned exactly and read its release notes on every
  bump. Not used on purpose: no `@Retry`/`@Timeout`/`@CircuitBreaker` on controllers (GETs are cheap Mongo reads,
  `POST …/lookup` isn't idempotent and its Jagex calls are covered), no `retry` on Jagex (visitor latency;
  process-players retries), no `OutboundRateLimitPolicy` (the bulkhead caps Jagex load per pod), nothing on the news
  feed (one URL, cached and served stale on failure by `lru-cache`).
- TypeScript 6 only loads the `@types` packages listed in `tsconfig.json`'s `types` (`node`); add one there when its
  globals are needed. It resolves packages through `exports`, so a package that lists `types` after `require` gets its
  CJS typings (`@osrs-tracker/models` before 0.10.1).
- `@osrs-tracker/models` (the stored shapes) and `@osrs-tracker/hiscores` (the hiscore client, also used by
  process-players) are published from osrs-tracker-aws: a change to either is an issue there. Right after a publish,
  bump with `--prefer-online` (dist-tags lag).
- Logs go to Loki unparsed, so their shape is a contract: one JSON object per line with a top-level string `level` of
  `info`, `warn` or `error` (Loki keeps a level it doesn't know, like Nest's `log` or a number, as its own
  `detected_level`), an ISO `time`, a `type`, and `route` on request lines (Grafana's Express dashboard filters on it).
  The format comes from `@osrs-tracker/logger` (pino, published from osrs-tracker-aws and shared with osrs-tracker-web:
  a format change is an issue there). `common/logger/logger.ts` creates the one logger (`logger`; specs build their own
  with `createApiLogger(destination)`, since pino doesn't write through `process.stdout.write`). `NestLogger`
  (`common/logger/nest-logger.ts`, set in `main.ts`) passes Nest's and the app's lines to it, with `log` as `info`, the
  class name as `context`, structured params (`logger.warn('…', { username })`) as fields, except the format's own
  (`level`, `time`, `type`, `message`, `requestId`), an error as one string under `error` (Node's `util.inspect`: the
  stack, the error's own fields such as `code`, and its cause as `[cause]: …`), and `type` from the context: `lifecycle`
  (Nest's startup classes and `MONGO_LOG_CONTEXT`, the Mongo connect and close; `LIFECYCLE_CONTEXTS`), `uncaught`
  (`ExceptionsHandler`), else `app` (`ApiLogType`). A new startup or shutdown logger gets its context from a constant in
  that list, never a copied string. It's a `ConsoleLogger` that overrides only `printMessages` and `printStackTrace`
  (which would write the stack again as plain lines on stderr), so Nest still parses the arguments and filters the
  levels: `debug` and `verbose` are off, `fatal` stays on (Loki knows it). Log through Nest's `Logger`, never `console`.
  A warning that can repeat per request (evictions, rejections) goes through `ThrottledWarning`
  (`common/logger/throttled-warning.ts`): at most one per key and minute, with the count since. The request log (the
  package's `requestLogger`, applied in `AppModule`) is `type: 'incoming'`: 5xx `error`, 4xx `warn`, else `info`; a
  client that disconnects before the response is `warn` with `aborted: true` and no `status`. `main.ts` calls
  `logOutgoingRequests` once (twice would log every request twice), so every `fetch` (hiscores, news feed, images) is
  logged as `type: 'outgoing'` with its status and duration, and the `requestId` read when the `fetch` starts.
- Request IDs: `nestjs-cls` (`common/logger/request-id.ts`) gives each request a context with a new UUID (never a
  client's `X-Request-Id`: nothing upstream sends one, and a client could reuse one), sent back as `X-Request-Id`. Every
  line logged while handling a request carries it as top-level `requestId` (the logger's `context`): the request line,
  app lines and its outgoing requests; lines outside a request (startup, shutdown) have none. Find a request's lines
  with `{app="osrs-tracker-api"} | json | requestId="<id>"`; never make it a Loki label (one stream per request). The
  request log reads the ID when the request starts, so the CLS middleware must run first: it does because `ClsModule` is
  global, and Nest applies global modules' middleware first.
- Metrics: `/metrics` on `METRICS_PORT` comes from `@osrs-tracker/express-metrics` (HTTP durations and `up`, shared with
  osrs-tracker-web, plus Node's `nodejs_*`/`process_*`). Import `Counter`, `Gauge`, `Histogram` and `register` from it,
  never `prom-client` or `@prometheus-io/client` directly, so there's one registry. `metricsMiddleware` clears that
  registry when called, so `main.ts` calls it before creating `AppModule`: register app metrics in a provider's
  `onModuleInit` (like `ResilienceEventsListener`), never at import time, and remove them on shutdown so the e2e spec
  can boot the app again. Keep labels low-cardinality: route patterns (`routeLabel`), never usernames or IDs.
- Traefik compresses JSON for browsers (the `osrs-tracker-api-compress` Middleware in `osrs-tracker-api.yaml`, last in
  the Ingress's chain), adding `Vary: Accept-Encoding`; the web's SSR calls the Service directly and gets it plain. Its
  `encodings` are `br, gzip`: browsers send `Accept-Encoding` unweighted, so Traefik picks by that list's order, and its
  default (`gzip, br, zstd`) gave every browser gzip; zstd is left out, Traefik's is no smaller than gzip. Don't add
  Nest's `compression`. The request log's `contentLength` is the uncompressed size.
- Traefik reuses idle connections to the pods for up to 90s, so `main.ts` sets the API server's `keepAliveTimeout` to
  95s (Node's 5s default would close connections Traefik is about to reuse: 502s). Keep it above Traefik's.

## Validating params

Validate query and route params in pipes, not with checks in the handler: `ParseUsernamePipe`,
`ParseScrapingOffsetPipe`, and `new ParseIntRangePipe({ min, max?, default?, optional?, message? })` from
`common/pipes/` for any other integer (its message is named after the param: `Limit must be between 1 and 50.`). Don't
add `DefaultValuePipe` + `ParseIntPipe` + a range check, or an `isNaN` check after a parse pipe. Keep existing status
codes and messages: the web may show them. A new pipe gets a spec.

Stored usernames are Jagex's matching form: lowercase, `_` and `-` as spaces, trimmed (`PlayerUtils.normalizeUsername`,
which `ParseUsernamePipe` applies), so one player is one document. Anything that stores, looks up or compares a name
takes it through that function; never store a name as typed.

## Route doc comments

The API is read from the controllers. Each handler has a short JSDoc comment with what the code doesn't show: which
statuses it answers and when, each one's `Cache-Control` (named by its `CACHE_CONTROL` key, never a copied value) and
non-obvious param semantics. A change to a route's statuses or `Cache-Control` updates its comment in the same diff.

## Route conflicts

A route that duplicates or shadows another (`/items/recent` next to `/items/:id`, in any order) fails startup and the
e2e spec: `ROUTE_CONFLICT_POLICY` (`config/app-options.ts`, `error` for both kinds) is passed by `main.ts` and
`app.e2e.spec.ts`. Rename or restructure the route; don't relax the policy to `warn`, and leave
`routeResolutionStrategy` at its default (with conflicts rejected, declaration order doesn't matter).

## Mongo pipeline updates

Wrap player data and user input in `$literal` (strings starting with `$` read as field paths). Merge offsets with
`$setUnion`, keep `upsert`/`hint`. The refresh update is built by `buildRefreshUpdate` in `players/player.policy.ts`, so
it can be tested without Mongo.

`hiscoreEntries` are stored compactly (`{ d, o, l, s, a }`, newest first; the format, layouts and bare values are in
models and roadmap osrs-tracker-aws#52): write one only with models' `encodeHiscoreEntry` and
`hiscoreEntriesWriteExpression` (prepends, and reduces unchanged values in the previous entry for that offset and layout
to their bare rank), after `HiscoreLayoutsService.ensure` stored its layout; read them only through
`HiscoreLayoutsService.decode` (loads and caches the `hiscoreLayouts` they use). Only the newest entry per offset is
stored in full, so a page of entries is read from the newest (`$slice: [0, skip + size]`) and cut after decoding. Read
skills by name (`SkillEnum`), never by position, and never loop over the enums.

Concurrent lookups of one name share one hiscore result and then each run the update, so: decide anything that depends
on the stored document inside the pipeline (like prepending the initial entry only when `$scrapingOffsets` lacks the
offset), never from a read made before the update, and treat `matchedCount` (or `upsertedCount`) as success, never
`modifiedCount`, which is 0 when the second update writes the same values.

## Pausing and resuming players

The full contract with the `process-players` Lambda (which pauses players whose hiscores keep 404ing) is in
[`DATA-MODEL.md`](https://github.com/osrs-tracker/osrs-tracker-aws/blob/main/DATA-MODEL.md). The API's side, in
`refreshPlayerInfo`:

- Success: resume in the same update — merge `pausedScrapingOffsets` into `scrapingOffsets`, unset it,
  `hiscoreNotFoundSince` and `hiscoreNotFoundCount`.
- Not found (404/400 on the normal table) or failed (any other status, network error, timeout, or any of the four tables
  failing): write nothing and leave them alone. **Never** count 404s here; the Lambda owns that bookkeeping.
- `POST /players/:username/lookup` answers 404 only for not found. Failed returns the stored player with
  `refreshFailed: true`, or 503 when the player isn't stored.
- Hiscore lookups go through `determinePlayerStatusAndType`, which asks the normal table first, shares lookups in flight
  per name and sends every request through the `jagex-hiscores` preset (in flight and queued per pod, circuit breaker);
  a request the preset refuses is failed. Only previews read the not-found cache. Don't add a path to Jagex around it:
  the proxy is shared with process-players.
- GETs never write: `GET /players/:username` returns a stored player as stored (stale or not, never refreshed), and an
  unknown player as a live preview from `determinePlayerStatusAndType` that isn't stored (`scrapingOffsets: []`,
  `trackedSince: null`), 404 only for not found and 503 when the hiscores fail. `skipRefresh` skips the preview (404).

## Cache-Control (important)

Set it deliberately on every GET. The web app's SSR transfer cache **drops `no-store`, `no-cache` and `private`
responses**, making the UI flash back to skeletons on hydration — never use them. Values come from `CACHE_CONTROL` in
`src/common/http/cache-control.ts`; add new ones there, not as inline strings (only the stored player's dynamic
`max-age` is built in place). Enforced in CI: ESLint's `no-restricted-syntax` (`eslint.config.mjs`) rejects the three
banned words in any string in `src/`, and `src/app.e2e.spec.ts` requests every GET route and checks its exact
`Cache-Control` and that it doesn't write. Keep its `CASES` current: one case per outcome of a GET that sends its own
`Cache-Control` (stored or unknown, success or outage), so a GET change that adds, removes or changes such an outcome
changes `CASES` in the same diff. The spec fails on a new GET route without a case and on a new `CACHE_CONTROL` value no
case expects (values only POSTs send go in its `POST_ONLY`); a new branch reusing an existing value it can't see, so
that one is on the author and the `conventions-reviewer`.

- Read-only, slow-changing: `public, max-age=N` (`/news` 300, `/items/search/:query` 3600, `/news/image` 604800).
- Routes that fetch Jagex live (`/news`, `/news/image`) set it with `res.setHeader` after the fetch succeeds, not with
  `@Header` (which also applies to errors), so caches don't keep a 503.
- GETs never write; lookups are recorded by browser-only POSTs, since crawlers hit the GETs during SSR.
- `/items/:id`, `/players/:username/hiscores` and the recent-items/players lists: `max-age=0, must-revalidate` so
  they're always fresh.
- `/players/:username`: stored players get a dynamic `max-age` (`playerMaxAgeSeconds`), clamped to `[0, 900]` and capped
  at the time until the refresh window; the preview of an unknown player and the 503 get `max-age=0, must-revalidate`.

## Tests

Vitest, only for complex or important logic, never for coverage. Break the protected code once to confirm the test
fails. `npm test` runs once (CI's `test` job), `npm run test:watch` watches.

- Specs sit next to the code as `src/**/*.spec.ts` and import from `vitest`. They don't need Nest, Express or Mongo:
  move a rule into a pure function first (like `player.policy.ts`), then test that. Two exceptions:
  `src/app.e2e.spec.ts` boots `AppModule` with the Mongo and agent providers overridden by a fake database that records
  every collection call, and `undici`'s `fetch` mocked as a fake Jagex (no network); code behind a `@nestjs/resilience`
  policy is tested in a `Test.createTestingModule` with a real `ResilienceModule` and the production preset, not mocks
  (`players.service.spec.ts`, `news.service.spec.ts`). Vite's transformer emits Nest's decorator metadata from
  `tsconfig.json`, so no SWC plugin is needed.
- Covered (changing one of these means changing its spec):
  - `config/env.spec.ts`: the env validation (`validateEnv`).
  - `common/logger/`: Nest's and the app's line shape, `type`, params and `requestId`, and nothing written around pino
    (`nest-logger.spec.ts`); outgoing lines' `type` and `requestId` (`logger.spec.ts`, a local server and `undici`'s
    real `fetch`); `ThrottledWarning`.
  - `players/`: the stored player's `max-age`, when a lookup refreshes (`needsRefresh`), the lookup's `lastHiscoreFetch`
    and per-offset `scrapingOffsetLookups` date (`buildLookupUpdate`), the refresh update's pause/resume, `$literal`,
    and the initial entry written only for a new offset (`buildRefreshUpdate`); combat level, type and status
    (`PlayerUtils`; a hiscore without a combat skill's key counts as failed, a `null` one doesn't, `hasCombatSkills`);
    the layout cache, upsert and collision check (`hiscore-layouts.service.spec.ts`).
  - The validation pipes `ParseUsernamePipe`, `ParseScrapingOffsetPipe` and `ParseIntRangePipe` (`common/pipes/`, for
    `limit`, `size`, `skip` and IDs).
  - `items/item-search.spec.ts`: the item search's `$search` pipeline (`buildItemSearchPipeline`; `$search` doesn't run
    on a plain `mongod`, so the pipeline is checked, not its results). The `name_autocomplete` Atlas Search index it
    runs on is created in `mongo.provider.ts` only when missing: a changed definition is applied by hand.
  - `players.service.spec.ts` (real `ResilienceModule` with production's preset, `undici`'s `fetch` mocked): normal
    table first, shared in-flight lookups, the preview's not-found cache, the concurrency cap in FIFO order, the queue
    bound and queue timeout (no warning per refusal), the breaker opening on failures but not on not-found players; a
    hiscores page read from the newest entry so its bare values resolve, and the layout stored before the entry.
  - `news.service.spec.ts` (`undici`'s `fetch` mocked, `performance.now` as lru-cache's clock): shared in-flight
    fetches, the stale feed's 60s retry, the 503 and a 404 not cached; the image size limit against a local server with
    the real `fetch` and `IMAGE_AGENT` (503, its log line, `identity`), and an oversized `content-length` refused
    without reading the body; the `news-images` bulkhead (queue bound and timeout, 503 without fetching, one slot per
    shared conversion, none for a cache hit).
  - `mongo.provider.spec.ts` (fake timers): the connect retry's constant 10s delay, warn lines, giving up after 12 with
    the connect error (also when closing the failed client fails).
  - `app.e2e.spec.ts` (`logger` mocked to collect the lines): per GET route its `Cache-Control` and that it never writes
    (a route's header or a new GET route means changing `CASES`), that no route overlaps another, that the POST lookup
    writes nothing for a bot and writes `players` for a visitor, that shutdown closes the Mongo client, and the request
    ID (`X-Request-Id` matching the `incoming` line's `requestId`, a client's own ignored).
- Not covered: anything against a real database, and the `Cache-Control` of POST responses.
- In a worktree, `vitest.config.mjs` only picks up that checkout's `src/`, not other worktrees'. It counts as source in
  CI's `changes` job, like `src/`, so changing it runs build and test.

## Production testing

Verify with the command in `CLAUDE.md`. There is no development database, by choice (a local MongoDB was declined, #53):
a local run uses production data, so stick to GETs, which never write. When a change needs a write, ask first. For
`POST /players/:username/lookup`, use **ToxSick** as the test player: before the lookup, save `GET /players/ToxSick` and
`GET /players/ToxSick/hiscores?scrapingOffset=<n>` for each of its `scrapingOffsets` to the scratchpad (GETs never
write; the first page is enough, since entries are prepended). A lookup overwrites the stored player fields, merges
`scrapingOffsets` and may prepend a hiscore entry (`buildRefreshUpdate`). Restoring that is a write to Atlas the user
does, never Claude: give them the `updateOne` that puts back the changed fields and removes a prepended entry. Every
mongosh snippet handed over starts with `use('osrs-tracker')` (mongosh starts in `test`, where a write silently matches
nothing) and says the counts to expect (`deletedCount`, `modifiedCount`), so a no-op shows. To check live data, use the
MongoDB MCP server (Atlas project `osrs-tracker`, cluster `shared-cluster`, database `osrs-tracker`) for reads only,
before and after the user's write; its writes are blocked in auto mode. `POST /items/:id/lookup` only sets the item's
`lastFetch` (it moves to the top of `GET /items`), so it needs nothing restored. Automated tests never need a database:
they run on fakes (Tests).

## Deploy

**Deploying is merging to `main`.** Never build, push or `kubectl apply` by hand: Flux in the cluster (set up in
`../home-cluster`, `cluster/osrs-tracker/flux.yaml`) applies `osrs-tracker-api.yaml` from `main` and reverts manual
changes within 10 minutes.

1. When `CI` passes on a push to `main` whose `build` job ran, `.github/workflows/deploy.yml` builds the image, pushes
   it to Docker Hub as `freekmencke/osrs-tracker-api:latest` and `:<commit sha>`, and commits the digest to the `image:`
   line as `chore(deploy): deploy sha256:<first 8>` (pushed with the `DEPLOY_KEY` deploy key, which bypasses the PR
   rule). Pushes without source or image changes (docs) skip `build` and so don't deploy; pushes that only change
   `osrs-tracker-api.yaml` (digest commits, rollbacks) don't run CI at all. Changes under `.github/` count as source:
   merging them rebuilds and redeploys the same code.
2. Flux applies that commit within a minute and reports the rollout as the `Flux / sync` commit status (failures also
   reach Discord). Flux applies `main`'s tip, so a push right after the digest commit gets the status instead; the
   workflow then takes it from `main`'s tip when that contains the digest commit (same logic as osrs-tracker-web's
   `deploy.yml`: keep the two in step). It waits up to 10 minutes for it, then smoke tests
   `https://osrs-tracker-api.freekmencke.com`: `/items` and `/items/4151` answer 200, an unknown route 404 (not `/news`,
   which fetches Jagex live).
3. **Merging is the end of the job: don't wait for or watch the `CD` run.** It smoke tests on its own, and a failure
   shows as a failed `CD` run (named after the commit it deploys) and a failed `Flux / sync` status, and reaches
   Discord. Only when the user asks, follow it with `gh run watch` and smoke test the changed routes:
   `curl -s -D - -o /dev/null` (status, `cache-control`), the pod logs (the read-only `kubernetes` or `flux` MCP
   server's log tool; `kubectl -n osrs-tracker logs deploy/osrs-tracker-api --since=5m` as a fallback; reading the
   cluster is fine), and for web rendering changes the pages in the browser (see the web skill; cached pages may lag up
   to 5 minutes).

- **Retry** a failed deploy (Docker Hub or Flux hiccup) by re-running the failed `CD` run; a later docs-only push won't
  redeploy.
- **Roll back** by reverting the digest commit on `main` (`git revert <sha> && git push`, admin bypass): Flux applies
  the previous digest, and the revert itself doesn't trigger a build. Fix or revert the code too, or the next merge
  deploys it again.

## Release ("release it", "ship it")

Run end to end without asking; stop only on failure. Verify locally once before committing; after that CI is the gate.

1. Commit on a `<type>/<short-name>` branch, push, `gh pr create --base main`.
2. Review `gh pr diff` for bugs and leftovers while the `conventions-reviewer` agent checks the PR; fix both and push.
3. Get current with `main` before waiting on checks, and again before merging:
   `git fetch origin && git rebase origin/main`, fold `CHANGELOG.md` under one day's heading, verify,
   `git push --force-with-lease`. Then poll `gh pr view <n> --json mergeable,mergeStateStatus` until it isn't `UNKNOWN`;
   on `CONFLICTING` (recheck once, it lags a push), rebase again: GitHub runs no PR CI on a conflicting PR, so `--watch`
   would hang.
4. `gh pr checks <n> --watch`. When checks pass: `gh pr merge <n> --merge` (it deploys; if Claude Code's permission
   check blocks it, give the user the command and wait). GitHub deletes the PR branch on merge. Then pull `main` and
   `git fetch --prune`; in the main checkout also switch to `main` first and `git branch -d <branch>`. In a worktree
   `main` is checked out by the main checkout, so pull there (`git -C <main checkout> pull --ff-only`) instead of
   switching.
5. Done: the deploy runs on its own (Deploy step 3). Pull `main` again later for the digest commit.

## Commit and push

- PRs need the `build`, `lint` and `test` checks (the `main` ruleset); `build` and `test` report as skipped when CI
  finds no source changes, which still passes. `build` also builds the image and checks that `sharp` converts in it, so
  a `Dockerfile` change is tested on the PR (CD only builds after merging, and there is no Docker locally).
- `main` or a PR: see `CLAUDE.md`. The admin account bypasses `main`'s PR rule; after a direct push, watch its **CI**
  run (`gh run watch --exit-status`), not CD. A direct push to `main` with source changes deploys it. From a worktree,
  push with `git push origin HEAD:main`.
- Conventional commits. `chore(deploy)` is reserved for the CD workflow's digest commits (it skips them).
- `CHANGELOG.md`: newest day first. Busy days get `###` subtitles (by area, "Behind the scenes" last); extend an
  existing entry rather than add a near-duplicate, and don't repeat the subtitle in its entries. When adding an entry,
  reread the whole day: add subtitles once it's busy, and merge entries about the same feature.
- Dependabot PRs (`.github/dependabot.yml`) carry no `CHANGELOG.md` entry, and merging one deploys. After merging,
  commit the entry straight to `main` (docs only, no redeploy): one entry under that day's "Behind the scenes"
  ("Dependency updates: …", naming notable bumps), extended for further ones that day. Base image PRs bump the digest in
  both `FROM` lines. Actions are pinned to commit SHAs with a `# vX.Y.Z` comment, which the actions PRs bump together:
  pin a new action the same way (`gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`), never by tag. npm majors are
  ignored in the config: upgrade them by hand from an issue, together with whatever must move with them (e.g. NestJS 12
  needed TypeScript 6). TypeScript `>=6.1` is ignored too, until `typescript-eslint` allows it (its peer range is
  `<6.1.0`): drop that ignore when it does.
- GPG "Inappropriate ioctl for device": ask the user to run `echo test | gpg --clearsign > /dev/null` in their terminal.
- If `gh pr edit` fails on a Projects (classic) error:
  `gh api -X PATCH repos/osrs-tracker/osrs-tracker-api/pulls/<n> -F body=@<file>`.
