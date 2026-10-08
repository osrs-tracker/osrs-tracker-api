#!/usr/bin/env bash
# PreToolUse hook: before Claude runs `git push`, lint and prettier-check the checkout being pushed. That's the session's
# own worktree when it has one (or the `git -C` path), not $CLAUDE_PROJECT_DIR, which is always the main checkout.
input=$(cat)

# The settings' `if` filter also lets through compound commands it can't parse (heredocs), so check for a push here too
cmd=$(jq -r '.tool_input.command // empty' <<<"$input")
push_re='(^|[;&|(]|[[:space:]])git([[:space:]]+-C[[:space:]]+([^[:space:]]+))?[[:space:]]+push([[:space:]]|$)'
[[ $cmd =~ $push_re ]] || exit 0

dir=$(jq -r '.cwd // empty' <<<"$input")
dir=${dir:-$CLAUDE_PROJECT_DIR}
# `git -C <path> push`: a relative path is relative to the command's cwd
if [ -n "${BASH_REMATCH[3]}" ]; then
  c=${BASH_REMATCH[3]//[\"\']/}
  case $c in /*) dir=$c ;; *) dir=$dir/$c ;; esac
fi
root=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || root=$CLAUDE_PROJECT_DIR
cd "$root" || exit 0

if ! out=$({ npm run -s lint:ci && npm run -s prettier:ci; } 2>&1); then
  printf 'Push blocked: lint or prettier check failed in %s.\n%s\n' "$root" "$(tail -40 <<<"$out")" >&2
  exit 2
fi
