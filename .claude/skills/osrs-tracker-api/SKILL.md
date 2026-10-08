---
name: osrs-tracker-api
description: >-
  Repo-specific rules for the osrs-tracker-api NestJS/MongoDB service: Cache-Control rules for the web app's SSR
  transfer cache, Mongo pipeline-update pitfalls, the player pause/resume contract, unit tests (Vitest), production
  testing, and the GitHub Actions → Flux deploy. Use when adding or changing endpoints, Cache-Control headers or
  player/item writes, writing or running tests, testing against production data, or building, deploying, committing,
  pushing, releasing or shipping this repo.
---

# osrs-tracker-api

NestJS + MongoDB Atlas (native driver), deployed as a Docker image to Kubernetes. Main consumer: the Angular SSR app in
`../osrs-tracker-web`. The `conventions-reviewer` agent reviews diffs against this file and `CLAUDE.md` at runtime, so
keep code rules here, not in the agent.

## Setup gotchas

- `src/common/` providers are injected by string token (`'MONGODB_DATABASE'`, `'MONGO_CLIENT'`, `'AGENT'`,
  `'XML_PARSER'`). `MongoModule` is global; new indexes go in `mongo.provider.ts`, the only place the API creates
  indexes (never per request).
- The `players` and `items` collections, their fields, writers and index owners are described in osrs-tracker-aws's
  [`DATA-MODEL.md`](https://github.com/osrs-tracker/osrs-tracker-aws/blob/main/DATA-MODEL.md). A new or changed index or
  stored field also needs an update there: open an issue in osrs-tracker-aws.
- Env: `.env.example` lists the vars, `.env` holds local values (points at prod). In the cluster they come from the
  `aws-mongodb-credentials` secret, with the `env:` block in `osrs-tracker-api.yaml` overriding `OSRS_API_BASE_URL` (an
  API Gateway proxy to `https://secure.runescape.com` that passes Jagex's headers through).
- Lambdas in `../osrs-tracker-aws` also write to `players` (hiscore entries, pausing) and `items` (hourly upsert).
- `@osrs-tracker/models` is published from osrs-tracker-aws; right after a publish, bump with `--prefer-online`
  (dist-tags lag).
- Request logs (`logger.middleware.ts`, JSON to Loki): 5xx `error`, 4xx `warn`, else `info`. A client that disconnects
  before the response is `warn` with `aborted: true` and no `status`; keep that shape, osrs-tracker-web logs the same.

## Mongo pipeline updates

Wrap player data and user input in `$literal` (strings starting with `$` read as field paths). Prepend `hiscoreEntries`
with `$concatArrays` (stored newest first), merge offsets with `$setUnion`, keep `upsert`/`hint`. The refresh update is
built by `buildRefreshUpdate` in `players/player.policy.ts`, so it can be tested without Mongo.

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
- GETs never write: `GET /players/:username` returns a stored player as stored (stale or not, never refreshed), and an
  unknown player as a live preview from `determinePlayerStatusAndType` that isn't stored (`scrapingOffsets: []`,
  `trackedSince: null`), 404 only for not found and 503 when the hiscores fail. `skipRefresh` skips the preview (404).

## Cache-Control (important)

Set it deliberately on every GET. The web app's SSR transfer cache **drops `no-store`, `no-cache` and `private`
responses**, making the UI flash back to skeletons on hydration — never use them. Values come from `CACHE_CONTROL` in
`src/common/http/cache-control.ts`; add new ones there, not as inline strings (only the stored player's dynamic
`max-age` is built in place).

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
  move a rule into a pure function first (like `player.policy.ts`), then test that.
- Covered: the stored player's `max-age`, when a lookup refreshes (`needsRefresh`), the refresh update's pause/resume,
  `$literal` and `$concatArrays` (`buildRefreshUpdate`), combat level, type and status (`PlayerUtils`) and
  `ParseUsernamePipe`. Changing one of those means changing its spec.
- Not covered: which `Cache-Control` each route sends and that GETs never write (the `conventions-reviewer` agent checks
  them), and anything against a real database.
- In a worktree, `vitest.config.mjs` only picks up that checkout's `src/`, not other worktrees'. It counts as source in
  CI's `changes` job, like `src/`, so changing it runs build and test.

## Production testing

Verify with the command in `CLAUDE.md`. For production testing, run locally with **ToxSick** as the test player: ask
before writing to it, record its state and restore it afterwards.

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
   reach Discord). The workflow waits up to 10 minutes for it, then smoke tests
   `https://osrs-tracker-api.freekmencke.com`: `/items` and `/items/4151` answer 200, an unknown route 404 (not `/news`,
   which fetches Jagex live).
3. **Merging is the end of the job: don't wait for or watch the `CD` run.** It smoke tests on its own, and a failure
   shows as a failed `CD` run (named after the commit it deploys) and a failed `Flux / sync` status, and reaches
   Discord. Only when the user asks, follow it with `gh run watch` and smoke test the changed routes:
   `curl -s -D - -o /dev/null` (status, `cache-control`),
   `kubectl -n osrs-tracker logs deploy/osrs-tracker-api --since=5m` (reading the cluster is fine), and for web
   rendering changes the pages in the browser (see the web skill; cached pages may lag up to 5 minutes).

- **Retry** a failed deploy (Docker Hub or Flux hiccup) by re-running the failed `CD` run; a later docs-only push won't
  redeploy.
- **Roll back** by reverting the digest commit on `main` (`git revert <sha> && git push`, admin bypass): Flux applies
  the previous digest, and the revert itself doesn't trigger a build. Fix or revert the code too, or the next merge
  deploys it again.

## Release ("release it", "ship it")

Run end to end without asking; stop only on failure. Verify locally once before committing; after that CI is the gate.

1. Commit on a `<type>/<short-name>` branch, push, `gh pr create --base main`.
2. Review `gh pr diff` for bugs and leftovers while the `conventions-reviewer` agent checks the PR; fix both and push.
3. `gh pr checks <n> --watch`. When checks pass: `gh pr merge <n> --merge --delete-branch` (it deploys; if Claude Code's
   permission check blocks it, give the user the command and wait), switch to `main`, pull, `git branch -d <branch>`,
   `git fetch --prune`.
4. Done: the deploy runs on its own (Deploy step 3). Pull `main` again later for the digest commit.

## Commit and push

- PRs need the `build`, `lint` and `test` checks (the `main` ruleset); `build` and `test` report as skipped when CI
  finds no source changes, which still passes.
- `main` or a PR: see `CLAUDE.md`. The admin account bypasses `main`'s PR rule; after a direct push, watch its **CI**
  run (`gh run watch --exit-status`), not CD. A direct push to `main` with source changes deploys it.
- Conventional commits. `chore(deploy)` is reserved for the CD workflow's digest commits (it skips them).
- `CHANGELOG.md`: newest day first. Busy days get `###` subtitles (by area, "Behind the scenes" last); extend an
  existing entry rather than add a near-duplicate, and don't repeat the subtitle in its entries. When adding an entry,
  reread the whole day: add subtitles once it's busy, and merge entries about the same feature.
- Dependabot PRs (`.github/dependabot.yml`) carry no `CHANGELOG.md` entry, and merging one deploys. After merging,
  commit the entry straight to `main` (docs only, no redeploy): one entry under that day's "Behind the scenes"
  ("Dependency updates: …", naming notable bumps), extended for further ones that day. Base image PRs bump the digest in
  both `FROM` lines. npm majors are ignored in the config: upgrade them by hand from an issue, together with whatever
  must move with them (e.g. NestJS 12 needs TypeScript 6).
- GPG "Inappropriate ioctl for device": ask the user to run `echo test | gpg --clearsign > /dev/null` in their terminal.
- If `gh pr edit` fails on a Projects (classic) error:
  `gh api -X PATCH repos/osrs-tracker/osrs-tracker-api/pulls/<n> -F body=@<file>`.
