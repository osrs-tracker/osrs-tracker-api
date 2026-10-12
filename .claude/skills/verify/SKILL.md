---
name: verify
description:
  Runs osrs-tracker-api's verify checks (prettier, lint, type check, build, tests) and reports each one's result. Use
  right before a commit, and whenever asked to verify the repo.
---

# verify

Run the script from the checkout's root (the worktree, not the main checkout), in one Bash call:

```bash
.claude/skills/verify/verify.sh
```

It runs these checks at once (about 5s instead of 13s one after another), never stopping at a failure, then prints the
output of each failed check and a summary line per check; it exits 1 when any failed:

1. `npm run prettier:ci`
2. `npm run lint:ci`
3. `npx tsc --noEmit -p tsconfig.json`: the only type check of the specs. The build type-checks too
   (`fork-ts-checker-webpack-plugin`), but with `tsconfig.build.json`, which excludes `**/*spec.ts`, so a type error
   outside the specs shows in both.
4. `npm run build`
5. `npm test` (Vitest doesn't type-check)

Report each check's result (passed or failed), with the relevant output for a failure. Then fix every failure in one
round (`npm run lint` and `npm run prettier` fix what they can; fix the rest by hand) and run the script again. Don't
commit while a check fails, and don't drop a check to save time: the push gate covers only lint and Prettier.
