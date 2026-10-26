# osrs-tracker-api

NestJS + MongoDB (native driver; a single-member replica set in the cluster's `mongodb` namespace) API, deployed to
Kubernetes at https://osrs-tracker-api.freekmencke.com, plus the ingester, a second entrypoint of the same image that
applies the scraping Lambdas' results from SQS. Main consumer: the Angular SSR app in `../osrs-tracker-web`;
`../osrs-tracker-aws` holds those Lambdas (they never touch the database); `../osrs-tracker-packages` publishes the
`@osrs-tracker/*` packages. `../<repo>` in these docs (and the skill and agents) means a sibling of the main checkout;
from a worktree in `.claude/worktrees/<name>/` that's `../../../../<repo>`.

**Load the `osrs-tracker-api` skill before writing, reviewing, running, deploying or committing anything here.** It
holds the Cache-Control, param validation, route doc comment, Mongo, player pause/resume, logging, resilience and test
rules, plus deploy and release steps. Keep detail there, not in this file.

## Commands

- Verify: `.claude/skills/verify/verify.sh` runs `npm run prettier:ci`, `npm run lint:ci`, `npm run knip` (unused code),
  `npm run jscpd` (copy-pasted code), `npx tsc --noEmit -p tsconfig.json`, `npm run build` and `npm test` at once and
  reports every failure. The `verify` skill (`.claude/skills/verify/`) runs it, and Claude Code runs that skill before
  each commit of a code change.
- Dev server: `npm run start:dev` on port 3000. `.env` points at production data, through a port-forward to the
  cluster's MongoDB that the user runs with the admin kubeconfig (README, Running it locally): the `claude-agent`
  ServiceAccount can't port-forward, so when the connect fails, ask the user to start it.
- A `git push` blocked by Claude's pre-push hook (a Claude Code hook, not a git hook): run `npm run lint` and
  `npm run prettier` (both fix what they can), fix the rest by hand, commit and push again.
- Worktrees in `.claude/worktrees/` use the main checkout's `node_modules` (found in a parent folder); run `npm ci` in
  one only when its `package.json` changes, and in the main checkout after pulling a dependency change (else new
  worktrees build against the old packages). Claude Code copies the main checkout's `.env` into the worktrees it creates
  (`.worktreeinclude`); a copy, so later edits to `.env` don't reach existing ones. Other sessions share port 3000:
  check `ss -ltn | grep :3000` before `npm run start:dev`, and stop it when done.

## Hard rules

- Every change, tooling included, gets a `CHANGELOG.md` entry under today's `## YYYY-MM-DD`; doc-only changes
  (`README.md`, `CLAUDE.md`, the Markdown files in `.claude/skills/` and `.claude/agents/`) don't, and a Dependabot bump
  only when it changes behaviour. `.claude/hooks/`, `.claude/settings.json` and `.claude/skills/verify/verify.sh` are
  tooling, not docs. A comment-only change elsewhere (e.g. a workflow comment) counts as doc-only. Parallel PRs all add
  that heading: when merging one after another, rebase and fold the entries under one heading. The format and the
  Dependabot steps are in the skill's Commit and push.
- Doc-only changes go straight to `main`; for anything else, ask: `main` or a PR (unless releasing: "release it" or
  "ship it", see the skill's Release steps).
- Deploying is merging to `main` (GitHub Actions → Flux). Never build, push or `kubectl apply` by hand.
- Never `--no-gpg-sign`. Never `no-store`, `no-cache` or `private` in `Cache-Control` (ESLint and `src/app.e2e.spec.ts`
  enforce it).

## Where things live

- `src/features/<feature>/` (items, news, player-counts, players): controller, service and module per feature; the
  player refresh and `max-age` rules in `players/player.policy.ts`, its intervals and Jagex limits (the `jagex-hiscores`
  resilience preset, registered in `app.module.ts`) in `players/player.config.ts`, the stored hiscore entries' layouts
  (cached) in `players/hiscore-layouts.service.ts`, the news image limits (the `news-images` preset) in
  `news/news.config.ts`, param pipes in `parse-*.pipe.ts`. Specs (`*.spec.ts`) sit next to the code;
  `src/app.e2e.spec.ts` boots the app on fakes and lists every GET route's `Cache-Control`.
- `src/common/` shared providers, injected by the token constant exported from their provider file (Mongo, the `undici`
  HTTP agents, XML parser), plus the logger and request IDs (`logger/`), bot detection, route labels, the
  `Cache-Control` values (`http/cache-control.ts`), `ParseIntRangePipe` (`pipes/`) and the resilience policies' logs and
  metrics (`resilience/`); `src/middleware/` robots.
- `src/config/`: the env, validated at startup (`env.ts`, read through `ConfigService`), CORS and the app options shared
  by `main.ts` and the e2e spec (`app-options.ts`, the route conflict policy).
- `src/app-metrics.*` the metrics and `/healthy` server on `METRICS_PORT` (9090), not exposed publicly.
- `src/ingest.ts` and `src/ingester/`: the ingester (`node ingest`, the `osrs-tracker-ingester` Deployment): the poll
  loop (`ingester.service.ts`), the writes and the slot guard (`scrape-results.ts`), the scheduled jobs
  (`job-runs.service.ts`): the DynamoDB subscriptions sync (`subscriptions*.ts`), the items refresh
  (`items-refresh.service.ts`) and the hiscores clean-up (`clean-hiscores*.ts`), its env (`IngesterEnv` in
  `config/env.ts`) and `MongoModule.forIngester()`.
- `DATA-MODEL.md`: every collection's fields, which process writes them, and each index's owner. A change to a stored
  field or an index updates it.
- Build and runtime: `rspack.config.js` (bundling), `Dockerfile` (image, `sharp` beside the bundle), `vitest.config.mjs`
  (tests), `osrs-tracker-api.yaml` (the Kubernetes manifest Flux applies: both Deployments, which CD gives the same
  image digest, and the Traefik rate-limit and compress Middlewares); `.github/workflows/` `CI` (`nodejs.yml`), `CD`
  (`deploy.yml`) and `zizmor` (the workflows' security audit; findings ignored inline), `.github/dependabot.yml`.
- `.claude/agents/conventions-reviewer.md` reviews diffs against the skill (its `## Review rules`) and this file, its
  Bash limited to one git, gh or grep read command per call by `.claude/hooks/read-only-bash.sh` (byte-identical across
  the four osrs-tracker repos: change it here, and through an issue in each of osrs-tracker-aws, osrs-tracker-web and
  osrs-tracker-packages); `.claude/hooks/pre-push-check.sh` lints and prettier-checks the pushed checkout before every
  `git push`, and `.claude/settings.json` runs Prettier on every file Claude edits.
