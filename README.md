# OSRS Tracker API &middot; [![GitHub license](https://img.shields.io/github/license/osrs-tracker/osrs-tracker-api.svg)](https://github.com/osrs-tracker/osrs-tracker-api/blob/main/LICENSE) [![GitHub issues](https://img.shields.io/github/issues/osrs-tracker/osrs-tracker-api.svg)](https://github.com/osrs-tracker/osrs-tracker-api/issues) &middot; [![CI](https://github.com/osrs-tracker/osrs-tracker-api/actions/workflows/nodejs.yml/badge.svg)](https://github.com/osrs-tracker/osrs-tracker-api/actions/workflows/nodejs.yml) [![CD](https://github.com/osrs-tracker/osrs-tracker-api/actions/workflows/deploy.yml/badge.svg)](https://github.com/osrs-tracker/osrs-tracker-api/actions/workflows/deploy.yml)

The API behind [OSRS Tracker](https://osrs-tracker.freekmencke.com). It looks up Old School RuneScape players, items and
news, and stores player progress so the website can show how players gain XP over time.

## What it provides

- **Players**: player details and their saved hiscore history, used for XP tracking.
- **Items**: item details and search by name.
- **News**: the latest OSRS news posts, with their images converted to WebP.

When you run it locally, the Swagger docs are available at `/swagger`.

## How it fits together

The [OSRS Tracker website](https://osrs-tracker.freekmencke.com)
([osrs-tracker-web](https://github.com/osrs-tracker/osrs-tracker-web)) gets its data from this API. Background jobs in
[osrs-tracker-aws](https://github.com/osrs-tracker/osrs-tracker-aws) keep the player and item data up to date, and
everything is stored in MongoDB. Which fields and indexes each of them owns is described in osrs-tracker-aws's
[`DATA-MODEL.md`](https://github.com/osrs-tracker/osrs-tracker-aws/blob/main/DATA-MODEL.md).

## Running it locally

Copy `.env.example` to `.env` and fill in the MongoDB credentials (`MONGODB_URI`, `MONGODB_USERNAME`,
`MONGODB_PASSWORD`). It also lists the optional settings (`CORS_ORIGIN`, `PORT`, `METRICS_PORT`, `NODE_ENV`). Then run:

```bash
npm ci
npm run start:dev
```

**Careful:** there is no separate development database, so `.env` points at the **production** data. Looking up a player
through the POST endpoints writes to it.

The API runs on http://localhost:3000. A second server on port 9090 (`METRICS_PORT`) serves `/healthy` for the
Kubernetes probes and `/metrics` for Prometheus; it isn't exposed publicly.

## Checks

Before committing, run the type check, lint, formatting check, build and tests (Vitest, `src/**/*.spec.ts`). The tests
use fakes for MongoDB and the OSRS servers, so they never touch production data:

```bash
npx tsc --noEmit -p tsconfig.json && npm run lint:ci && npm run prettier:ci && npm run build && npm test
```

## Built with

NestJS 12, TypeScript 6, MongoDB and Node 24, deployed with Docker on Kubernetes. Merging to `main` deploys it: GitHub
Actions builds the image and commits its digest to `osrs-tracker-api.yaml`, and Flux applies it to the cluster.

## Development

OSRS Tracker was originally built entirely without AI assistance. Since October 2026, I've started using
[Claude](https://claude.com/claude-code), Anthropic's AI coding assistant, to help improve development speed and
reliability.
