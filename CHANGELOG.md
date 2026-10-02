## 2026/10/02

- Allowed caching of API responses so the web app's SSR transfer cache can reuse them (no more `no-store`/`no-cache`).
- Clamped the dynamic `max-age` of `/players/:username` to a minimum of 0.
- Updated to Node 24 (CI, `engines`, `@types/node`).
- Updated CI to `actions/checkout@v7` and `actions/setup-node@v7`, and made CI lint fail instead of auto-fixing.
- dependency updates
- Documented the external services (RuneScape API proxy, MongoDB Atlas, AWS Lambdas) in the project skill.
