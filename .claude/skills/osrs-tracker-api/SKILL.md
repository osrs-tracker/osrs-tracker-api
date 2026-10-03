---
name: osrs-tracker-api
description: >-
  Repo-specific rules for the osrs-tracker-api NestJS/MongoDB service: Cache-Control rules for the web app's SSR
  transfer cache, Mongo pipeline-update pitfalls, the player pause/resume contract, production testing, and the Docker →
  Kubernetes deploy. Use when adding or changing endpoints, Cache-Control headers or player/item writes, testing against
  production data, or building, deploying, committing or pushing this repo.
---

# osrs-tracker-api

NestJS API on Express backed by MongoDB (native driver, no ODM), deployed as a Docker image to Kubernetes. Its main
consumer is the Angular SSR app in the sibling repo `../osrs-tracker-web`.

## Non-obvious layout

- Shared infrastructure in `src/common/<thing>/` is injected with string tokens (`@Inject('MONGODB_DATABASE')`,
  `'MONGO_CLIENT'`, `'AGENT'`, `'XML_PARSER'`). `MongoModule` is `@Global()`, so features don't import it. New indexes
  go in `mongo.provider.ts`.
- `src/config/cors.ts` always allows `http://localhost:4200` besides `CORS_ORIGIN`.
- Env vars are listed in `.env.example`. Locally they come from `.env` (gitignored, never commit it); in the cluster
  from the `aws-mongodb-credentials` secret plus the `env:` block in `osrs-tracker-api.yaml`, which overrides the
  secret's own `OSRS_API_BASE_URL` key.
- Prefer `@Res({ passthrough: true })` when you only need to set headers. A plain `@Res()` (as in `news/image`) makes
  you responsible for sending the response.

## External services and shared packages

- `OSRS_API_BASE_URL` is an AWS API Gateway proxy to `https://secure.runescape.com` that passes Jagex's headers through
  unchanged.
- MongoDB is Atlas, reached with username/password (SCRAM), not MONGODB-AWS. Lambdas in the sibling `osrs-tracker-aws`
  repo also write to `players` (hiscore entries, pausing) and `items` (hourly upsert), so don't assume the API is the
  only writer.
- `@osrs-tracker/models` (the `Player`/`Item` types) is owned by `osrs-tracker-aws` and published by the maintainer.
  Right after a publish, bump with `npm i @osrs-tracker/models@^x.y.z --prefer-online`, because the registry CDN's
  dist-tags lag.

## Mongo pipeline updates

In aggregation-pipeline updates, wrap player data and user input in `$literal` (strings starting with `$` would
otherwise be read as field paths), prepend `hiscoreEntries` with `$concatArrays` (they're stored newest first), merge
offsets with `$setUnion`, and keep `upsert`/`hint`.

## Pausing and resuming players

The Lambda pauses players whose hiscores keep returning 404 (`pausedScrapingOffsets`, `hiscoreNotFoundSince`,
`hiscoreNotFoundCount`). The API side of the contract, in `refreshPlayerInfo`:

- On any successful refresh, resume in the same update: merge `pausedScrapingOffsets` back into `scrapingOffsets` and
  remove the three pause fields.
- **Never** count 404s. Any non-OK hiscore response looks the same to the API, including Jagex being down.
- On a failed refresh, leave the pause fields alone.

## Cache-Control (important)

Every GET handler must set `Cache-Control` deliberately. The web app's Angular SSR transfer cache **drops any response
whose header contains `no-store`, `no-cache` or `private`**, which makes the browser refetch on hydration (visible as UI
flashing back to skeletons). So never use those as a default.

- Read-only, slow-changing data: `public, max-age=N` (`/news` 300, `/items/search/:query` 3600, `/news/image` 604800).
- **GET routes with DB writes** (`/items/:id` sets `lastFetch`, `/players/:username/hiscores` sets `lastHiscoreFetch`)
  and the recent-items/players lists: `max-age=0, must-revalidate`. Browsers then revalidate every time, so the handler
  and its write always run. Express computes the ETag and the 304 inside `res.send()`, after the handler has finished.
- `/players/:username`: dynamic `max-age`, clamped to `[0, 900]` and capped at the time left until the player's refresh
  window, so no refresh is ever skipped.
- When adding a GET route that writes, give it `max-age=0, must-revalidate`, and note the write in a comment.

## Verify before handing off

```bash
npx tsc --noEmit -p tsconfig.json && npm run lint:ci && npm run prettier:ci && npm run build
```

`npm run lint` runs `eslint --fix`, so check `git diff` after using it. The repo has no tests. To test against
production data, run the API locally (`.env` points at the prod database) and use **ToxSick** as the test player. Ask
the user before writing to it, record its state first, and restore it afterwards.

## Deploy (Docker → Kubernetes)

1. Pass the verification steps above.
2. Build and push:

   ```bash
   npm run docker:build && npm run docker:push
   ```

3. Copy the pushed digest (`latest: digest: sha256:…`) into the `image:` line of `osrs-tracker-api.yaml`
   (`freekmencke/osrs-tracker-api@sha256:…`).
4. Before changing anything, check that the live image matches the yaml, so you don't roll back someone else's deploy:

   ```bash
   kubectl -n osrs-tracker get deploy osrs-tracker-api -o jsonpath='{.spec.template.spec.containers[0].image}'
   ```

5. Review the diff before applying. Expect only the image digest (plus a `generation` bump):

   ```bash
   kubectl diff -f osrs-tracker-api.yaml
   ```

6. Apply and wait:

   ```bash
   kubectl apply -f osrs-tracker-api.yaml && kubectl -n osrs-tracker rollout status deploy/osrs-tracker-api --timeout=300s
   ```

7. Smoke test production (`https://osrs-tracker-api.freekmencke.com`): request the routes you changed with
   `curl -s -D - -o /dev/null` and check the status and `cache-control`. Check the pod logs:

   ```bash
   kubectl -n osrs-tracker logs deploy/osrs-tracker-api --since=5m
   ```

8. If the change affects what the web app renders, check the web side too. Its pages are regenerated on an interval (`/`
   every 5 min), so a cached page can show the old API behaviour for a few minutes.

## Commit and push

- **Every change gets a `CHANGELOG.md` entry** in the same commit: a `## YYYY/MM/DD` heading (newest first; add to
  today's heading if it exists) with short bullets.
- **Ask the user whether to commit straight to `main` or open a PR**, every time, before committing. `main` requires a
  PR and passing `lint` and `build` checks (no approvals), which the user's admin account can bypass, so a direct push
  works and shows a "bypassed rule violations" notice.
  - Straight to `main`: push, then watch the CI run (`gh run watch --exit-status`).
  - PR: commit on a `<type>/<short-name>` branch, push it, `gh pr create --base main` and check `gh pr checks`. Once the
    user says it's merged, `git switch main && git pull --ff-only`, delete the local branch with `git branch -d` and
    `git fetch --prune` (GitHub deletes the remote branch on merge).
  - Deploying from a PR branch leaves production running unmerged code: tell the user, and don't deploy from `main`
    until the PR is merged.
- Use conventional commits (`fix(scope): …`, `feat(scope): …`; commitizen is configured). Include the image digest bump
  in the same commit as the code it deploys.
- Commits are GPG-signed. If signing fails with "Inappropriate ioctl for device", ask the user to unlock the key in
  their own terminal (`echo test | gpg --clearsign > /dev/null`); never use `--no-gpg-sign`.
- Push over HTTPS via `gh` (`gh auth setup-git` is configured). If `gh auth status` fails, ask the user to log in.
- Deploying without committing leaves production running code that isn't on GitHub, so always commit and push a deploy.
