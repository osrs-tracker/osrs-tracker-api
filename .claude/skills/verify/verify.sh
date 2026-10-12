#!/usr/bin/env bash
# Runs every verify check at once (none waits for or stops at another's failure), then prints each one's output, the
# fast ones first, and a summary. Exits 1 when any check failed. Run from the checkout's root.
set -u
# Plain output: the logs are read by Claude, not a terminal
export NO_COLOR=1 FORCE_COLOR=0

names=(prettier lint types build test)
commands=(
  'npm run prettier:ci'
  'npm run lint:ci'
  # The build's type check (fork-ts-checker) reads tsconfig.build.json, which skips the specs: this is their only one
  'npx tsc --noEmit -p tsconfig.json'
  'npm run build'
  'npm test'
)

out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

for i in "${!names[@]}"; do
  (
    start=$SECONDS
    bash -c "${commands[$i]}" >"$out/$i.log" 2>&1
    echo "$? $((SECONDS - start))" >"$out/$i.status"
  ) &
done
wait

summary=()
failed=0
for i in "${!names[@]}"; do
  read -r code secs <"$out/$i.status"
  if [ "$code" -eq 0 ]; then
    summary+=("passed  ${names[$i]} (${secs}s): ${commands[$i]}")
  else
    failed=1
    summary+=("FAILED  ${names[$i]} (${secs}s): ${commands[$i]}")
    echo "=== ${names[$i]} failed: ${commands[$i]}"
    cat "$out/$i.log"
    echo
  fi
done

echo '=== Summary'
printf '%s\n' "${summary[@]}"
exit "$failed"
