---
name: osrs-tracker-api
description:
  Conventions, NestJS 11 best practices, verification and the deploy workflow for osrs-tracker-api. Use when writing or
  reviewing code in this repo, adding or changing endpoints or Cache-Control headers, or building, deploying, committing
  or pushing it.
---

# osrs-tracker-api

NestJS 11 API on Express 5 backed by MongoDB (native driver, no ODM), deployed as a Docker image to Kubernetes. Its main
consumer is the Angular SSR app in the sibling repo `../osrs-tracker-web`, which has its own `osrs-tracker-web` skill.
Shared types come from `@osrs-tracker/models`.

## Layout

- `src/main.ts`: bootstrap: CORS, JSON logger, Prometheus metrics on a separate app (`METRICS_PORT`, `/healthy`).
  Swagger is at `/swagger` outside production.
- `src/app.module.ts`: imports the global/common modules and feature modules, and applies `LoggerMiddleware` and
  `NoIndexMiddleware` to all routes.
- `src/common/<thing>/`: a factory provider plus a module per shared dependency: `mongo` (`'MONGO_CLIENT'`,
  `'MONGODB_DATABASE'`, and index creation), `agent` (`'AGENT'`, keep-alive https agent), `xml` (`'XML_PARSER'`),
  `logger`.
- `src/features/<feature>/`: `<feature>.module.ts`, `.controller.ts`, `.service.ts`, plus optional `.config.ts` and
  `.utils.ts`.
- `src/config/`: `cors.ts` (allows `CORS_ORIGIN` and `http://localhost:4200`) and `swagger.ts`.
- Env vars: `MONGODB_URI`, `MONGODB_USERNAME`, `MONGODB_PASSWORD`, `MONGODB_DATABASE`, `OSRS_API_BASE_URL`,
  `CORS_ORIGIN`, `PORT`, `METRICS_PORT`, `NODE_ENV`. Locally they come from `.env` (gitignored, never commit it); in the
  cluster from the `aws-mongodb-credentials` secret plus the `env:` block in the yaml (`env:` overrides the secret's own
  `OSRS_API_BASE_URL` key).
- External services: `OSRS_API_BASE_URL` is `https://runescape-api.freekmencke.com/rs`, an AWS API Gateway proxy to
  `https://secure.runescape.com` that passes Jagex's headers through unchanged. MongoDB is Atlas (db `osrs-tracker`),
  reached with username/password (SCRAM), not MONGODB-AWS. Lambdas in the sibling `osrs-tracker-aws` repo also write to
  `players` (hiscore entries) and `items` (hourly upsert), and publish `@osrs-tracker/models` and
  `@osrs-tracker/hiscores`.

## NestJS conventions

Match the surrounding code; these are the patterns the codebase already uses:

- **Feature modules** declare their own controllers and providers and export the service. Shared infrastructure is
  injected with string tokens and `@Inject('TOKEN')`. `MongoModule` is `@Global()`, so features don't import it.
- **Controllers stay thin**: parse with built-in pipes (`ParseIntPipe`, `ParseBoolPipe`, `DefaultValuePipe`), validate
  explicitly, and throw Nest HTTP exceptions (`BadRequestException`, `NotFoundException`) with a clear message. Business
  logic and DB access belong in the service.
- **Every endpoint gets Swagger decorators**: `@ApiTags` on the controller; `@ApiOperation`, `@ApiParam` and `@ApiQuery`
  on each handler.
- **Mongo**: use the typed `collection` getter, always add a `projection` (exclude `_id`), use `hint` when an index
  exists, and create new indexes in `mongo.provider.ts`.
- **Logging**: `private readonly logger = new Logger(ClassName.name)`. Don't use `console`.
- Prefer `@Res({ passthrough: true })` when you only need to set headers. A plain `@Res()` (as in `news/image`) makes
  you responsible for sending the response.

## Cache-Control (important)

Every GET handler must set `Cache-Control` deliberately. The web app's Angular SSR transfer cache **drops any response
whose header contains `no-store`, `no-cache` or `private`**, which makes the browser refetch on hydration (visible as UI
flashing back to skeletons). So never use those as a default.

- Read-only, slow-changing data: `public, max-age=N` (`/news` 300, `/items/search/:query` 3600, `/news/image` 604800).
- **GET routes with DB writes** (`/items/:id` sets `lastFetch`, `/players/:username/hiscores` sets `lastHiscoreFetch`)
  and the recent-items/players lists: `max-age=0, must-revalidate`. Browsers then revalidate every time, so the handler
  and its write always run. Express 5 computes the ETag and the 304 inside `res.send()`, after the handler has finished.
- `/players/:username`: dynamic `max-age`, clamped to `[0, 900]` and capped at the time left until the player's refresh
  window, so no refresh is ever skipped.
- When adding a GET route that writes, give it `max-age=0, must-revalidate`, and note the write in a comment.

## Verify before handing off

```bash
npx tsc --noEmit -p tsconfig.json
```

```bash
npm run lint:ci
```

```bash
npm run prettier:ci
```

```bash
npm run build
```

`npm run lint:ci` only reports problems. `npm run lint` runs `eslint --fix`, so check `git diff` after using it. The
repo has no tests. If `tsc` leaves a `tsconfig.tsbuildinfo` behind, delete it. CI (`.github/workflows/nodejs.yml`,
Node 24) runs `lint:ci`, `prettier:ci` and build on every push to `main`.

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

5. **Review the diff before applying.** Applying without reviewing is blocked. Expect only the image digest (plus a
   `generation` bump):

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

8. If the change affects what the web app renders, check the web side too. Its auto-generated pages refresh on an
   interval (`/` every 5 min), so a cached page can show the old API behaviour for a few minutes.

## Commit and push

- **Every change gets a `CHANGELOG.md` entry** in the same commit: a `## YYYY/MM/DD` heading (newest first; add to
  today's heading if it exists) with short bullets.
- Commit straight to `main` with conventional commits (`fix(scope): …`, `feat(scope): …`; commitizen is configured).
  Include the image digest bump in the same commit as the code it deploys.
- Commits are GPG-signed. If signing fails with "Inappropriate ioctl for device", ask the user to unlock the key in
  their own terminal (`echo test | gpg --clearsign > /dev/null`); never use `--no-gpg-sign`.
- Push over HTTPS via `gh` (`gh auth setup-git` is configured). If `gh auth status` fails, ask the user to log in.
- Deploying without committing leaves production running code that isn't on GitHub, so commit and push in the same
  session as the deploy.
