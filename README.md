<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Elastic--2.0-blue.svg" /></a>
  <a href="https://github.com/osrs-tracker/osrs-tracker-api/issues"><img src="https://img.shields.io/github/issues/osrs-tracker/osrs-tracker-api.svg" /></a>
  &middot;
  <a href="https://github.com/osrs-tracker/osrs-tracker-api/actions/workflows/nodejs.yml"><img src="https://github.com/osrs-tracker/osrs-tracker-api/actions/workflows/nodejs.yml/badge.svg" /></a>
  <a href="https://github.com/osrs-tracker/osrs-tracker-api/actions/workflows/deploy.yml"><img src="https://github.com/osrs-tracker/osrs-tracker-api/actions/workflows/deploy.yml/badge.svg" /></a>
</p>

# OSRS Tracker API

The API behind [OSRS Tracker](https://osrs-tracker.net). It looks up Old School RuneScape players, items and news, and
stores player progress so the website can show how players gain XP over time.

## What it provides

- **Players**: player details and their saved hiscore history, used for XP tracking, the day's top Overall XP gainers
  (`GET /players?sort=gain`), plus a sitemap list of tracked players for the website.
- **Items**: item details, search by name, browsing by first letter and the newest items (`GET /items?sort=added`).
- **News**: the latest OSRS news posts, with their images converted to WebP, and an archive of every post, paged and
  filterable by category (stored from the feed, and back to 2013 from the OSRS Wiki).
- **Player counts**: the players online now (live from Jagex's world list) and over time (sampled every 10 minutes by
  [osrs-tracker-aws](https://github.com/osrs-tracker/osrs-tracker-aws)).

Each route's statuses, `Cache-Control` and parameters are described in a short comment on its handler in
`src/features/*/*.controller.ts`.

## How it fits together

The [OSRS Tracker website](https://osrs-tracker.net)
([osrs-tracker-web](https://github.com/osrs-tracker/osrs-tracker-web)) gets its data from this API. Scraping Lambdas in
[osrs-tracker-aws](https://github.com/osrs-tracker/osrs-tracker-aws) fetch the hiscores and player counts, and the
ingester below stores them in MongoDB and keeps the item list and old hiscores tidy. Which process writes each field and
owns each index is described in [`DATA-MODEL.md`](DATA-MODEL.md).

## The ingester

A second process from the same image (`node ingest`, the `osrs-tracker-ingester` Deployment, one replica) writes the
scraping jobs' results to MongoDB. The Lambdas in osrs-tracker-aws send their hiscores and player counts to an SQS FIFO
queue, `osrs-tracker_scrape-results.fifo`, which keeps them for up to 14 days, so scraping goes on while the cluster is
down. The ingester:

- receives from the queue once a minute, and again at once while messages keep coming, but only while MongoDB answers a
  ping;
- applies the messages one at a time, in order, and deletes each only after its write. At the first that fails it stops,
  and that one and the rest come back once their visibility timeout runs out. A message it can't read is never deleted,
  so it ends in the dead-letter queue;
- skips a hiscore entry when the player already has one for that offset's scrape slot, since the start of its hour. That
  catches duplicates, repeated scrapes and late entries, which would otherwise break the stored history's order;
- counts the days a player isn't on the hiscores, pauses their scraping after 7 (with a Discord alert), and recomputes
  the daily player counts.

It also runs scheduled jobs, each also at startup when its last success (stored in `jobRuns`) is overdue: every 15
minutes the copy of who to scrape to DynamoDB, which the Lambdas read; every hour the item list from the
[OSRS Wiki](https://prices.runescape.wiki/api/v2/osrs/mapping); and every night at 00:00 UTC the clean-up of hiscores
older than 90 days, offsets not looked up for 180 days, unused layouts and players left without entries, alerting on
Discord when no hiscores were scraped for 2 days.

It has no public port: `/healthy`, which reports whether the poll loop is still making progress, and `/metrics`
(`ingester_job_last_success_timestamp_seconds`, `ingester_messages_total`) are on port 9090. Its settings are the
MongoDB ones plus the ingester section of `.env.example`, from the cluster's `osrs-tracker-ingester` secret, which also
gives it its own database user (`osrs-tracker-ingester`, overriding the API's `MONGODB_USERNAME` and
`MONGODB_PASSWORD`). Its AWS key only works from the server's IP, so `npm run start:ingest` can't receive anything from
elsewhere.

## Running it locally

You need Node 24 or newer, and `kubectl` with the cluster's admin kubeconfig (`~/.kube/admin.yaml`). MongoDB runs in the
cluster (the `mongodb` namespace, a single-member replica set) with no public port, so reach it through a port-forward,
and keep it running while the API runs:

```bash
kubectl --kubeconfig ~/.kube/admin.yaml -n mongodb port-forward svc/mongodb 27017:27017
```

Copy `.env.example` to `.env` and fill in the MongoDB settings:

- `MONGODB_URI`: `mongodb://localhost:27017/?directConnection=true&authSource=admin`. `directConnection=true` is
  required: without it the driver looks up the replica set member's in-cluster name, which doesn't resolve outside the
  cluster.
- `MONGODB_USERNAME` and `MONGODB_PASSWORD`: the user `osrs-tracker-api` and its password from the password manager, the
  same as the cluster's `aws-mongodb-credentials` secret (its template is `cluster/osrs-tracker/secrets.example.yaml` in
  `fremen-cluster`).

The database name and the OSRS API URL come prefilled. It also lists the optional settings (`CORS_ORIGIN`, a
comma-separated list of origins allowed besides `http://localhost:4200`; `PORT`; `METRICS_PORT`). The API won't start
while a required one is missing or a value is invalid; the error lists them all. Then run:

```bash
npm ci
npm run start:dev
```

If it logs a MongoDB connect warning every 40 seconds instead of starting, the port-forward isn't running (it also stops
when the MongoDB pod restarts: start it again) or the credentials are wrong. It gives up after 6 attempts (about 4
minutes) and stops with the connect error. If port 3000 is taken, set `PORT` in `.env`; if 27017 is, forward another
local port (`27018:27017`) and use it in `MONGODB_URI`.

**Careful:** there is no separate development database, so `.env` points at the **production** data. The POST lookup
endpoints write to it: looking up a player stores their latest hiscores, and looking up an item moves it to the top of
the recent items list.

The API runs on http://localhost:3000. A second server on port 9090 (`METRICS_PORT`) serves `/healthy` for the
Kubernetes probes and `/metrics` for Prometheus; it isn't exposed publicly.

## Checks

Before committing, run the formatting check, lint, type check, build and tests (Vitest, `src/**/*.spec.ts`). The tests
use fakes for MongoDB and the OSRS servers, so they never touch production data. This runs them all at once and reports
every failure:

```bash
.claude/skills/verify/verify.sh
```

## Built with

NestJS 12, TypeScript 6, MongoDB and Node 24, bundled with rspack and tested with Vitest, deployed with Docker on
Kubernetes. Merging to `main` deploys it: GitHub Actions builds the image and commits its digest to
`osrs-tracker-api.yaml`, and Flux applies it to the cluster.

## Development

OSRS Tracker was originally built entirely without AI assistance. Since October 2026, I've started using
[Claude](https://claude.com/claude-code), Anthropic's AI coding assistant, to help improve development speed and
reliability.

## License

[Elastic License 2.0](LICENSE): you're welcome to read the code, learn from it, change it and run it yourself, but not
to offer it to others as a hosted service, paid or free.
