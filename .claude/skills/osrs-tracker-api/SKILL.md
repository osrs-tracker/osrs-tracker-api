---
name: osrs-tracker-api
description: >-
  Repo-specific rules for the osrs-tracker-api NestJS/MongoDB service: Cache-Control rules for the web app's SSR
  transfer cache, Mongo pipeline-update pitfalls, the player pause/resume contract, production testing, and the Docker →
  Kubernetes deploy. Use when adding or changing endpoints, Cache-Control headers or player/item writes, testing against
  production data, or building, deploying, committing, pushing, releasing or shipping this repo.
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

## Mongo pipeline updates

Wrap player data and user input in `$literal` (strings starting with `$` read as field paths). Prepend `hiscoreEntries`
with `$concatArrays` (stored newest first), merge offsets with `$setUnion`, keep `upsert`/`hint`.

## Pausing and resuming players

The Lambda pauses players whose hiscores keep 404ing (`pausedScrapingOffsets`, `hiscoreNotFoundSince`,
`hiscoreNotFoundCount`). In `refreshPlayerInfo`:

- Success: resume in the same update — merge `pausedScrapingOffsets` into `scrapingOffsets`, unset the three fields.
- Not found (404/400 on the normal table) or failed (any other status, network error, timeout, or any of the four
  tables failing): write nothing and leave them alone. **Never** count 404s here; the Lambda owns that bookkeeping.
- `GET /players/:username` answers 404 only for not found. Failed returns the stored player with `refreshFailed: true`
  (`Cache-Control: max-age=60`), or 503 (`max-age=0, must-revalidate`) when the player isn't stored.

## Cache-Control (important)

Set it deliberately on every GET. The web app's SSR transfer cache **drops `no-store`, `no-cache` and `private`
responses**, making the UI flash back to skeletons on hydration — never use them.

- Read-only, slow-changing: `public, max-age=N` (`/news` 300, `/items/search/:query` 3600, `/news/image` 604800).
- GET routes that write (`/items/:id`, `/players/:username/hiscores`) and the recent-items/players lists:
  `max-age=0, must-revalidate` so the handler always runs. Comment the write.
- `/players/:username`: dynamic `max-age`, clamped to `[0, 900]` and capped at the time until the refresh window;
  `max-age=60` when the refresh failed so it's retried soon.

## Verify

```bash
npx tsc --noEmit -p tsconfig.json && npm run lint:ci && npm run prettier:ci && npm run build
```

No tests. For production testing, run locally with **ToxSick** as the test player: ask before writing to it, record its
state and restore it afterwards.

## Deploy

1. Verify (in a release, passing CI counts).
2. `npm run docker:build && npm run docker:push`, then put the digest in the `image:` line of `osrs-tracker-api.yaml`.
   If `docker` is missing or the engine is down, start Docker Desktop from Windows:
   `"/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe" desktop start`
3. Confirm the live image matches the yaml, so you don't roll back someone else's deploy:
   `kubectl -n osrs-tracker get deploy osrs-tracker-api -o jsonpath='{.spec.template.spec.containers[0].image}'`
4. `kubectl diff -f osrs-tracker-api.yaml` — expect only the digest (plus `generation`).
5. `kubectl apply -f osrs-tracker-api.yaml && kubectl -n osrs-tracker rollout status deploy/osrs-tracker-api --timeout=300s`
6. Smoke test `https://osrs-tracker-api.freekmencke.com`: `curl -s -D - -o /dev/null` the changed routes (status,
   `cache-control`) and `kubectl -n osrs-tracker logs deploy/osrs-tracker-api --since=5m`.
7. If the web app's rendering changes, check those pages in the browser (see the web skill); cached pages may lag up to
   5 minutes.

## Release ("release it", "ship it")

Run end to end without asking; stop only on failure. Verify locally once before committing; after that CI is the gate.

1. Commit on a `<type>/<short-name>` branch, push, `gh pr create --base main`.
2. Review `gh pr diff` for bugs and leftovers while the `conventions-reviewer` agent checks the PR; fix both and push.
3. In the background, Docker build/push alongside `gh pr checks <n> --watch`.
4. Once CI passes, deploy (steps 2–7).
5. Commit the digest, push, and add the digest and check results to the PR description.
6. When checks pass: `gh pr merge <n> --merge`, switch to `main`, pull, `git branch -d <branch>`, `git fetch --prune`.

## Commit and push

- Doc-only changes go straight to `main`. Otherwise, outside a release, **ask every time**: `main` or a PR. The admin
  account bypasses `main`'s PR rule; after a direct push, `gh run watch --exit-status`.
- Deploying from a PR branch runs unmerged code: say so, and don't deploy from `main` until it's merged.
- Conventional commits. Commit and push in the same session as a deploy, so prod never runs code that isn't on GitHub.
- **Every change gets a `CHANGELOG.md` entry** under `## YYYY/MM/DD`, newest first. Busy days get `###` subtitles (by
  area, "Behind the scenes" last); extend an existing entry rather than add a near-duplicate, and don't repeat the
  subtitle in its entries.
- GPG "Inappropriate ioctl for device": ask the user to run `echo test | gpg --clearsign > /dev/null` in their terminal.
  Never `--no-gpg-sign`.
- If `gh pr edit` fails on a Projects (classic) error:
  `gh api -X PATCH repos/osrs-tracker/osrs-tracker-api/pulls/<n> -F body=@<file>`.
