# OSRS Tracker API &middot; [![GitHub license](https://img.shields.io/github/license/osrs-tracker/osrs-tracker-api.svg)](https://github.com/osrs-tracker/osrs-tracker-api/blob/master/LICENSE) [![GitHub issues](https://img.shields.io/github/issues/osrs-tracker/osrs-tracker-api.svg)](https://github.com/osrs-tracker/osrs-tracker-api/issues) &middot; [![CI](https://github.com/osrs-tracker/osrs-tracker-api/actions/workflows/nodejs.yml/badge.svg)](https://github.com/osrs-tracker/osrs-tracker-api/actions/workflows/nodejs.yml)

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
everything is stored in MongoDB.

## Running it locally

Create a `.env` file with `MONGODB_URI`, `MONGODB_USERNAME`, `MONGODB_PASSWORD`, `MONGODB_DATABASE` and
`OSRS_API_BASE_URL`, then run:

```bash
npm ci
npm run start:dev
```

The API runs on http://localhost:3000.

## Built with

NestJS, MongoDB and Node 24, deployed with Docker on Kubernetes.

## Development

OSRS Tracker was originally built entirely without AI assistance. Since October 2026, I've started using
[Claude](https://claude.com/claude-code), Anthropic's AI coding assistant, to help improve development speed and
reliability.
