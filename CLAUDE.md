# osrs-tracker-api

NestJS + MongoDB Atlas (native driver) API, deployed to Kubernetes at https://osrs-tracker-api.freekmencke.com. Main
consumer: the Angular SSR app in `../osrs-tracker-web`; `../osrs-tracker-aws` Lambdas also write to the same database.

**Load the `osrs-tracker-api` skill before writing, reviewing, running, deploying or committing anything here.** It
holds the Cache-Control, Mongo and player pause/resume rules, plus deploy and release steps. Keep detail there, not in
this file.

## Commands

- Verify: `npx tsc --noEmit -p tsconfig.json && npm run lint:ci && npm run prettier:ci && npm run build` (no tests).
- Dev server: `npm run start:dev` on port 3000, Swagger at `/swagger`. `.env` points at production data.
- Worktrees in `.claude/worktrees/` use the main checkout's `node_modules` (found in a parent folder); run `npm ci` in
  one only when its `package.json` changes. Other sessions share port 3000: check `ss -ltn | grep :3000` before
  `npm run start:dev`, and stop it when done.

## Hard rules

- Every change gets a `CHANGELOG.md` entry under today's `## YYYY/MM/DD`. Parallel PRs all add that heading: when
  merging one after another, rebase and fold the entries under one heading.
- Doc-only changes go straight to `main`; for anything else, ask: `main` or a PR (unless releasing).
- Deploying is merging to `main` (GitHub Actions → Flux). Never build, push or `kubectl apply` by hand.
- Never `--no-gpg-sign`. Never `no-store`, `no-cache` or `private` in `Cache-Control`.

## Where things live

- `src/features/<feature>/` (items, news, players): controller, service and module per feature.
- `src/common/` shared providers, injected by string token (Mongo, HTTP agent, XML parser), plus bot detection and route
  labels; `src/middleware/` request logging and robots.
- `src/app-metrics.*` the metrics and `/healthy` server on `METRICS_PORT` (9090), not exposed publicly.
- `osrs-tracker-api.yaml` the Kubernetes manifest Flux applies; `.github/workflows/` `CI` (`nodejs.yml`) and `CD`
  (`deploy.yml`).
- `.claude/agents/conventions-reviewer.md` reviews diffs against the skill and this file;
  `.claude/hooks/pre-push-check.sh` lints and prettier-checks the pushed checkout before every `git push`.
