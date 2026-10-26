---
name: verify
description:
  Runs osrs-tracker-api's verify checks (prettier, lint, knip, jscpd, type check, build, tests) and reports each one's
  result. Use right before a commit, and whenever asked to verify the repo.
---

# verify

Run the script from the checkout's root (the worktree, not the main checkout), in one Bash call:

```bash
.claude/skills/verify/verify.sh
```

It runs these checks at once (about 5s instead of 13s one after another), never stopping at a failure, then prints the
output of each failed check (the last 60 lines of a log over 80, with the full log's path) and a summary line per check;
it exits 1 when any failed. The logs are kept when a check fails: when the tail isn't enough, find the lines in the full
log with `rg -n` and read that range, rather than rerunning the check.

1. `npm run prettier:ci`
2. `npm run lint:ci` (also `import-x/no-cycle`: no circular imports)
3. `npm run knip`: unused files, exports and dependencies (`knip.jsonc`; `src/main.ts` and `src/ingest.ts` are its
   entries). An export only its own file uses loses its `export`; a false positive goes in `knip.jsonc` with a comment
   saying why.
4. `npm run jscpd`: copy-pasted code in `src/` (`.jscpd.json`, the specs and fixtures left out), failing over 1%
   duplicated lines. Move the copy into one place; never raise the threshold to pass.
5. `npx tsc --noEmit -p tsconfig.json`: the only type check of the specs. The build type-checks too
   (`fork-ts-checker-webpack-plugin`), but with `tsconfig.build.json`, which excludes `**/*spec.ts`, so a type error
   outside the specs shows in both.
6. `npm run build`
7. `npm test` (Vitest doesn't type-check)

Report each check's result (passed or failed), with the relevant output for a failure. Then fix every failure in one
round (`npm run lint` and `npm run prettier` fix what they can; fix the rest by hand) and run the script again. Don't
commit while a check fails, and don't drop a check to save time: the push gate covers only lint and Prettier.
