---
name: osrs-tracker-api
description: >-
  Repo-specific rules for the osrs-tracker-api NestJS/MongoDB service: Cache-Control rules for the web app's SSR
  transfer cache, Mongo pipeline-update pitfalls, the player pause/resume contract, production testing, and the GitHub
  Actions → Flux deploy. Use when adding or changing endpoints, Cache-Control headers or player/item writes, testing
  against production data, or building, deploying, committing, pushing, releasing or shipping this repo.
---

# osrs-tracker-api

NestJS + MongoDB Atlas (native driver), deployed as a Docker image to Kubernetes. Main consumer: the Angular SSR app in
`../osrs-tracker-web`. The `conventions-reviewer` agent reviews diffs against this file at runtime, so keep code rules
here, not in the agent.

## Setup gotchas

- `src/common/` providers are injected by string token (`'MONGODB_DATABASE'`, `'MONGO_CLIENT'`, `'AGENT'`,
  `'XML_PARSER'`). `MongoModule` is global; new indexes go in `mongo.provider.ts`.
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
with `$concatArrays` (stored newest first), merge offsets with `$setUnion`, keep `upsert`/`hint`.

## Pausing and resuming players

The Lambda pauses players whose hiscores keep 404ing (`pausedScrapingOffsets`, `hiscoreNotFoundSince`,
`hiscoreNotFoundCount`). In `refreshPlayerInfo`:

- Success: resume in the same update — merge `pausedScrapingOffsets` into `scrapingOffsets`, unset the three fields.
- Not found (404/400 on the normal table) or failed (any other status, network error, timeout, or any of the four tables
  failing): write nothing and leave them alone. **Never** count 404s here; the Lambda owns that bookkeeping.
- `POST /players/:username/lookup` answers 404 only for not found. Failed returns the stored player with
  `refreshFailed: true`, or 503 when the player isn't stored.
- GETs never write: `GET /players/:username` returns a stored player as stored (stale or not, never refreshed), and an
  unknown player as a live preview from `determinePlayerStatusAndType` that isn't stored (`scrapingOffsets: []`,
  `trackedSince: null`), 404 only for not found and 503 when the hiscores fail. `skipRefresh` skips the preview (404).

## Cache-Control (important)

Set it deliberately on every GET. The web app's SSR transfer cache **drops `no-store`, `no-cache` and `private`
responses**, making the UI flash back to skeletons on hydration — never use them.

- Read-only, slow-changing: `public, max-age=N` (`/news` 300, `/items/search/:query` 3600, `/news/image` 604800).
- GETs never write; lookups are recorded by browser-only POSTs, since crawlers hit the GETs during SSR.
- `/items/:id`, `/players/:username/hiscores` and the recent-items/players lists: `max-age=0, must-revalidate` so
  they're always fresh.
- `/players/:username`: stored players get a dynamic `max-age`, clamped to `[0, 900]` and capped at the time until the
  refresh window; the preview of an unknown player and the 503 get `max-age=0, must-revalidate`.

## Verify

```bash
npx tsc --noEmit -p tsconfig.json && npm run lint:ci && npm run prettier:ci && npm run build
```

No tests. For production testing, run locally with **ToxSick** as the test player: ask before writing to it, record its
state and restore it afterwards.

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
   reach Discord). The workflow waits up to 10 minutes for it, then checks that `/news` and `/items` on
   `https://osrs-tracker-api.freekmencke.com` answer 200.
3. Follow it with `gh run watch` on the `CD` run (named after the commit it deploys, like the `CI` run), then smoke test
   the changed routes yourself: `curl -s -D - -o /dev/null` (status, `cache-control`), and
   `kubectl -n osrs-tracker logs deploy/osrs-tracker-api --since=5m` (reading the cluster is fine).
4. If the web app's rendering changes, check those pages in the browser (see the web skill); cached pages may lag up to
   5 minutes.

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
4. Watch the deploy and smoke test (Deploy steps 3–4), then pull again for the digest commit.

## Commit and push

- Doc-only changes go straight to `main`. Otherwise, outside a release, **ask every time**: `main` or a PR. The admin
  account bypasses `main`'s PR rule; after a direct push, `gh run watch --exit-status`. A direct push to `main` with
  source changes deploys it.
- Conventional commits. `chore(deploy)` is reserved for the CD workflow's digest commits (it skips them).
- **Every change gets a `CHANGELOG.md` entry** under `## YYYY/MM/DD`, newest first. Busy days get `###` subtitles (by
  area, "Behind the scenes" last); extend an existing entry rather than add a near-duplicate, and don't repeat the
  subtitle in its entries.
- GPG "Inappropriate ioctl for device": ask the user to run `echo test | gpg --clearsign > /dev/null` in their terminal.
  Never `--no-gpg-sign`.
- If `gh pr edit` fails on a Projects (classic) error:
  `gh api -X PATCH repos/osrs-tracker/osrs-tracker-api/pulls/<n> -F body=@<file>`.
