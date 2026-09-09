#!/usr/bin/env bash
# Tests for branch-cut-guard.mjs. Each case builds a throwaway git repo, feeds
# the hook the JSON the harness sends, and checks the exit code.
# Exit 2 = blocked, exit 0 = allowed.
set -uo pipefail

HOOK="$(cd "$(dirname "$0")/.." && pwd)/branch-cut-guard.mjs"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

run() { # run <cwd> <command> -> prints exit code
  printf '{"tool_input":{"command":%s},"cwd":%s}' "$(printf '%s' "$2" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" \
    "$(printf '%s' "$1" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" \
    | node "$HOOK" >/dev/null 2>&1
  echo $?
}

check() { # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ok    $1"
  else fail=$((fail+1)); echo "  FAIL  $1 (expected $2, got $3)"; fi
}

# A clean repo on main.
R="$TMP/clean"; mkdir -p "$R"; cd "$R"
git init -q -b main .; git config user.email t@t; git config user.name t
echo one > a.txt; git add a.txt; git commit -qm first

echo "clean main:"
check "cuts a branch"            0 "$(run "$R" 'git checkout -b feat/x')"
check "switch -c form"           0 "$(run "$R" 'git switch -c feat/x')"
check "plain checkout untouched" 0 "$(run "$R" 'git checkout feat/x')"
check "unrelated command"        0 "$(run "$R" 'npm test')"
check "worktree add not blocked" 0 "$(run "$R" 'git worktree add -b feat/x ../wt')"

# Same repo, now dirty: the incident's second defect.
echo two >> a.txt
echo "dirty tree:"
check "blocks the cut"           2 "$(run "$R" 'git checkout -b fix-1password-diagnosis')"
check "still allows plain checkout" 0 "$(run "$R" 'git checkout main')"

# On a feature branch: the incident's first defect.
git stash -q; git checkout -qb other-session-work; echo x > b.txt; git add b.txt; git commit -qm w
echo "on a feature branch:"
check "blocks the cut"           2 "$(run "$R" 'git checkout -b fix-1password-diagnosis')"
check "blocks chained form"      2 "$(run "$R" 'git checkout -b fix-x -q && git add a.txt')"

# Not a git repo, and unparseable input: both must fail open.
echo "fails open:"
check "outside a repo"           0 "$(run "$TMP" 'git checkout -b feat/x')"
echo 'not json' | node "$HOOK" >/dev/null 2>&1; check "unparseable stdin" 0 "$?"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
