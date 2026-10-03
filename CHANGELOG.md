## 2026/10/03

- Project skill: documented the release flow (PR, review, deploy, update the PR, merge).
- Fixed a `url.parse()` deprecation warning in the logs.
- Project skill: ask whether to commit straight to `main` or open a PR, and how to clean up after a merge.
- Security: usernames must be valid OSRS names (1-12 letters, numbers, spaces, `-`, `_`), so double URL-encoded names
  are rejected and never stored; the hiscore lookup URL-encodes the username.
- Security: `/news/image` only accepts plain `cdn.runescape.com` URLs (no query or hash), refuses redirects, non-images,
  bodies over 10 MB and images over 25M pixels, and caches at most 50 MB of images (`lru-cache`), with a throttled
  warning in the logs when it has to evict.
- `/news/image` errors no longer carry the week-long `Cache-Control` of a successful image response.
- Security: bounded `limit` (1-50) on `/players` and `/items`, and `size` (1-100) and `skip` (≥ 0) on hiscores.
- Security: overrode `@nestjs/swagger`'s `js-yaml` to 5.4.2, pinned `sharp` in the Docker image and run the container as
  the `node` user.
- Removed a leftover `console.log` from the total XP calculation.
- Removed the unused `commitizen` dev dependency (and its `braces` audit findings).
- Database: removed 7 duplicate players stored under an invalid username (uppercase or with `'`/`,`) whose history was
  already in the valid record, and lowercased the 5 remaining uppercase usernames so they can be found again.

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
