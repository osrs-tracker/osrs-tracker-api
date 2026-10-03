## 2026/10/03

- Fixed a `url.parse()` deprecation warning in the logs.

## 2026/10/02

- Fixed the project skill's frontmatter so its description parses as YAML again.
- Trimmed the project skill to repo-specific rules, added `.env.example` and ignored `tsconfig.tsbuildinfo`.
- Documented the player pause/resume contract, Mongo pipeline-update rules, shared packages and prod testing in the
  project skill.
- Resumed tracking of paused players (no hiscores for 7 days) when they're found on the hiscores again.
- Allowed caching of API responses so the web app's SSR transfer cache can reuse them (no more `no-store`/`no-cache`).
- Clamped the dynamic `max-age` of `/players/:username` to a minimum of 0.
- Updated to Node 24 (CI, `engines`, `@types/node`).
- Updated CI to `actions/checkout@v7` and `actions/setup-node@v7`, and made CI lint fail instead of auto-fixing.
- dependency updates
- Documented the external services (RuneScape API proxy, MongoDB Atlas, AWS Lambdas) in the project skill.
- Expanded the README with an overview, how the API fits into OSRS Tracker and how to run it locally.
