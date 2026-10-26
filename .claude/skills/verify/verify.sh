#!/usr/bin/env bash
# Runs every verify check at once (none waits for or stops at another's failure), then prints each failed one's output,
# the fast ones first, and a summary. Exits 1 when any check failed. Run from the checkout's root.
set -u
# Plain output: the logs are read by Claude, not a terminal
export NO_COLOR=1 FORCE_COLOR=0

names=(prettier lint knip jscpd types build test)
commands=(
  'npm run prettier:ci'
  'npm run lint:ci'
  # Unused files, exports and dependencies (knip.jsonc)
  'npm run knip'
  # Copy-pasted code in src/ (.jscpd.json): fails over 1% duplicated lines
  'npm run jscpd'
  # The build's type check (fork-ts-checker) reads tsconfig.build.json, which skips the specs: this is their only one
  'npx tsc --noEmit -p tsconfig.json'
  'npm run build'
  'npm test'
)

# Kept when a check fails, so its full log can be read further
out=$(mktemp -d -t verify.XXXXXX)

for i in "${!names[@]}"; do
  (
    start=$SECONDS
    bash -c "${commands[$i]}" >"$out/${names[$i]}.log" 2>&1
    echo "$? $((SECONDS - start))" >"$out/${names[$i]}.status"
  ) &
done
wait

summary=()
failed=0
for i in "${!names[@]}"; do
  log="$out/${names[$i]}.log"
  read -r code secs <"$out/${names[$i]}.status"
  if [ "$code" -eq 0 ]; then
    summary+=("passed  ${names[$i]} (${secs}s): ${commands[$i]}")
  else
    failed=1
    summary+=("FAILED  ${names[$i]} (${secs}s): ${commands[$i]}")
    echo "=== ${names[$i]} failed: ${commands[$i]} (full log: $log)"
    if [ "$(wc -l <"$log")" -gt 80 ]; then
      echo '(last 60 lines)'
      tail -n 60 "$log"
    else
      cat "$log"
    fi
    echo
  fi
done

echo '=== Summary'
printf '%s\n' "${summary[@]}"
[ "$failed" -eq 0 ] && rm -rf "$out"
exit "$failed"
