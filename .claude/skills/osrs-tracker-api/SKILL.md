---
name: osrs-tracker-api
description: >-
  Repo-specific rules for the osrs-tracker-api NestJS/MongoDB service: Cache-Control rules for the web app's SSR
  transfer cache, Mongo pipeline-update pitfalls, the player pause/resume contract, production testing, and the Docker →
  Kubernetes deploy. Use when adding or changing endpoints, Cache-Control headers or player/item writes, testing against
  production data, or building, deploying, committing, pushing, releasing or shipping this repo.
---

# osrs-tracker-api

NestJS API backed by MongoDB Atlas (native driver, SCRAM auth), deployed as a Docker image to Kubernetes. Its main
consumer is the Angular SSR app in `../osrs-tracker-web`.

## Non-obvious setup

- Shared infrastructure in `src/common/` is injected with string tokens (`@Inject('MONGODB_DATABASE')`,
  `'MONGO_CLIENT'`, `'AGENT'`, `'XML_PARSER'`). `MongoModule` is global. New indexes go in `mongo.provider.ts`.
- Env vars: `.env.example` lists them, `.env` holds local values. In the cluster they come from the
  `aws-mongodb-credentials` secret plus the `env:` block in `osrs-tracker-api.yaml`, which overrides the secret's
  `OSRS_API_BASE_URL`.
- `OSRS_API_BASE_URL` is an API Gateway proxy to `https://secure.runescape.com` that passes Jagex's headers through.
- Lambdas in `../osrs-tracker-aws` also write to `players` (hiscore entries, pausing) and `items` (hourly upsert); the
  API isn't the only writer.
- `@osrs-tracker/models` is published from osrs-tracker-aws. Right after a publish, bump with `--prefer-online` (the
  registry's dist-tags lag).

## Mongo pipeline updates

Wrap player data and user input in `$literal` (strings starting with `$` are read as field paths), prepend
`hiscoreEntries` with `$concatArrays` (stored newest first), merge offsets with `$setUnion`, and keep `upsert`/`hint`.

## Pausing and resuming players

The Lambda pauses players whose hiscores keep returning 404 (`pausedScrapingOffsets`, `hiscoreNotFoundSince`,
`hiscoreNotFoundCount`). In `refreshPlayerInfo`:

- On a successful refresh, resume in the same update: merge `pausedScrapingOffsets` back into `scrapingOffsets` and
  remove the three pause fields.
- On a failed refresh, leave them alone. **Never** count 404s here: to the API, any non-OK response looks the same,
  including Jagex being down.

## Cache-Control (important)

Every GET handler sets `Cache-Control` deliberately. The web app's SSR transfer cache **drops responses with `no-store`,
`no-cache` or `private`**, which makes the UI flash back to skeletons on hydration, so never use those.

- Read-only, slow-changing data: `public, max-age=N` (`/news` 300, `/items/search/:query` 3600, `/news/image` 604800).
- **GET routes that write** (`/items/:id`, `/players/:username/hiscores`) and the recent-items/players lists:
  `max-age=0, must-revalidate`, so the handler and its write always run. Note the write in a comment.
- `/players/:username`: dynamic `max-age`, clamped to `[0, 900]` and capped at the time until the player's refresh
  window.

## Verify before handing off

```bash
npx tsc --noEmit -p tsconfig.json && npm run lint:ci && npm run prettier:ci && npm run build
```

There are no tests. To test against production data, run the API locally (`.env` points at prod) with **ToxSick** as the
test player: ask before writing to it, record its state and restore it afterwards.

## Deploy (Docker → Kubernetes)

1. Pass the verification steps (in a release, a passing CI run counts).
2. `npm run docker:build && npm run docker:push`
3. Put the pushed digest in the `image:` line of `osrs-tracker-api.yaml`.
4. Check the live image matches the yaml first, so you don't roll back someone else's deploy:

   ```bash
   kubectl -n osrs-tracker get deploy osrs-tracker-api -o jsonpath='{.spec.template.spec.containers[0].image}'
   ```

5. `kubectl diff -f osrs-tracker-api.yaml`: expect only the digest (plus `generation`).
6. `kubectl apply -f osrs-tracker-api.yaml && kubectl -n osrs-tracker rollout status deploy/osrs-tracker-api --timeout=300s`
7. Smoke test `https://osrs-tracker-api.freekmencke.com`: `curl -s -D - -o /dev/null` the changed routes (status and
   `cache-control`), and check `kubectl -n osrs-tracker logs deploy/osrs-tracker-api --since=5m`.
8. If it changes what the web app renders, check those pages in the browser too (see the web skill). Cached pages can
   show the old behaviour for up to 5 minutes.

## Release ("release it", "ship it")

Run the whole flow without asking between steps; stop only if a step fails. Verify locally once before committing; after
that CI is the gate, so don't re-run checks locally.

1. Commit on a `<type>/<short-name>` branch, push, `gh pr create --base main`.
2. Review `gh pr diff` for bugs and leftovers; fix and push.
3. In the background, run the Docker build and push alongside `gh pr checks <n> --watch`.
4. Once CI passes, deploy (steps 3–8 above).
5. Commit the digest to the branch, push, and put the digest and check results in the PR description.
6. Once the checks pass, `gh pr merge <n> --merge`, then switch to `main`, pull, `git branch -d <branch>`,
   `git fetch --prune`.

## Commit and push

- Doc-only changes (skills, docs) go straight to `main`. Otherwise, outside a release, **ask every time** whether to
  commit to `main` or open a PR. The admin account bypasses `main`'s PR rule; after a direct push, watch CI with
  `gh run watch --exit-status`. After a PR merges, do the switch-back from release step 6.
- A deploy from a PR branch runs unmerged code: tell the user, and don't deploy from `main` until it's merged.
- Conventional commits. Commit and push in the same session as a deploy, so production never runs code that isn't on
  GitHub.
- **Every change gets a `CHANGELOG.md` entry** under a `## YYYY/MM/DD` heading, newest first. Busy days get `###`
  subtitles (by area, "Behind the scenes" last); extend an existing entry rather than add a near-duplicate, and don't
  repeat the subtitle in its entries.
- If GPG signing fails with "Inappropriate ioctl for device", ask the user to run
  `echo test | gpg --clearsign > /dev/null` in their terminal. Never use `--no-gpg-sign`.
- `gh pr edit` can fail on a Projects (classic) error; use
  `gh api -X PATCH repos/osrs-tracker/osrs-tracker-api/pulls/<n> -F body=@<file>`.
