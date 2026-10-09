# osrs-tracker-api

NestJS + MongoDB Atlas (native driver) API, deployed to Kubernetes at https://osrs-tracker-api.freekmencke.com. Main
consumer: the Angular SSR app in `../osrs-tracker-web`; `../osrs-tracker-aws` Lambdas also write to the same database.

**Load the `osrs-tracker-api` skill before writing, reviewing, running, deploying or committing anything here.** It
holds the Cache-Control, param validation, route doc comment, Mongo, player pause/resume and test rules, plus deploy and
release steps. Keep detail there, not in this file.

## Commands

- Verify: `npx tsc --noEmit -p tsconfig.json && npm run lint:ci && npm run prettier:ci && npm run build && npm test`.
- Dev server: `npm run start:dev` on port 3000. `.env` points at production data.
- Worktrees in `.claude/worktrees/` use the main checkout's `node_modules` (found in a parent folder); run `npm ci` in
  one only when its `package.json` changes. They have no `.env` (`start:dev` then fails listing the missing vars): link
  the main checkout's with `ln -s ../../../.env .env` and remove the link when done. Other sessions share port 3000:
  check `ss -ltn | grep :3000` before `npm run start:dev`, and stop it when done.

## Hard rules

- Every change gets a `CHANGELOG.md` entry under today's `## YYYY/MM/DD`. Parallel PRs all add that heading: when
  merging one after another, rebase and fold the entries under one heading.
- Doc-only changes go straight to `main`; for anything else, ask: `main` or a PR (unless releasing).
- Deploying is merging to `main` (GitHub Actions → Flux). Never build, push or `kubectl apply` by hand.
- Never `--no-gpg-sign`. Never `no-store`, `no-cache` or `private` in `Cache-Control` (ESLint and `src/app.e2e.spec.ts`
  enforce it).

## Where things live

- `src/features/<feature>/` (items, news, players): controller, service and module per feature; the player refresh and
  `max-age` rules in `players/player.policy.ts`, its intervals and Jagex limits in `players/player.config.ts`, param
  pipes in `parse-*.pipe.ts`. Specs (`*.spec.ts`) sit next to the code; `src/app.e2e.spec.ts` boots the app on fakes and
  lists every GET route's `Cache-Control`.
- `src/common/` shared providers, injected by the token constant exported from their provider file (Mongo, the `undici`
  HTTP agent, XML parser), plus bot detection, route labels, the `Cache-Control` values (`http/cache-control.ts`),
  `ParseIntRangePipe` (`pipes/`) and the `Semaphore` capping Jagex requests (`concurrency/`); `src/middleware/` request
  logging and robots.
- `src/config/`: the env, validated at startup (`env.ts`, read through `ConfigService`), and CORS.
- `src/app-metrics.*` the metrics and `/healthy` server on `METRICS_PORT` (9090), not exposed publicly.
- Build and runtime: `rspack.config.js` (bundling), `Dockerfile` (image, `sharp` beside the bundle), `vitest.config.mjs`
  (tests), `osrs-tracker-api.yaml` (the Kubernetes manifest Flux applies, with the Traefik rate-limit and compress
  Middlewares); `.github/workflows/` `CI` (`nodejs.yml`) and `CD` (`deploy.yml`), `.github/dependabot.yml`.
- `.claude/agents/conventions-reviewer.md` reviews diffs against the skill and this file;
  `.claude/hooks/pre-push-check.sh` lints and prettier-checks the pushed checkout before every `git push`, and
  `.claude/settings.json` runs Prettier on every file Claude edits.
