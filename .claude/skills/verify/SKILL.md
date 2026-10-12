---
name: verify
description:
  Runs osrs-tracker-api's verify checks (type check, lint, prettier, build, tests) and reports each one's result. Use
  right before a commit, and whenever asked to verify the repo.
---

# verify

Run this repo's verify command from the checkout's root (the worktree, not the main checkout):

```bash
npx tsc --noEmit -p tsconfig.json && npm run lint:ci && npm run prettier:ci && npm run build && npm test
```

Report each command's result (passed, failed, or not run because an earlier one failed), with the relevant output for a
failure. On a lint or prettier failure, `npm run lint` and `npm run prettier` fix what they can; fix the rest by hand
and run it again. Don't commit while a check fails.
