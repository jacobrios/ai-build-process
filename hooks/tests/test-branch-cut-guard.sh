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

# An explicit origin/main (or origin/master) start point answers "where will
# this branch be cut from" directly, so the current-branch check no longer
# applies. Still on other-session-work, still clean, from the block above.
git update-ref refs/remotes/origin/main HEAD
git update-ref refs/remotes/origin/master HEAD
echo "explicit origin/main start point, feature branch, clean:"
check "checkout -b with origin/main"    0 "$(run "$R" 'git checkout -b x origin/main')"
check "switch -c with origin/main"      0 "$(run "$R" 'git switch -c x origin/main')"
check "checkout -b with origin/master"  0 "$(run "$R" 'git checkout -b x origin/master')"
check "checkout -b with other start"    2 "$(run "$R" 'git checkout -b x origin/feature')"
check "checkout -b with no start point" 2 "$(run "$R" 'git checkout -b x')"

echo "explicit origin/main start point, feature branch, dirty:"
echo dirty >> b.txt
check "still blocked when dirty"        2 "$(run "$R" 'git checkout -b x origin/main')"
git checkout -q -- b.txt

echo "explicit origin/main start point, on main:"
git checkout -q main
check "checkout -b with origin/main from main" 0 "$(run "$R" 'git checkout -b x origin/main')"

echo "blocked message names the alternative:"
git checkout -q other-session-work
msg="$(printf '{"tool_input":{"command":%s},"cwd":%s}' \
  "$(printf '%s' 'git checkout -b fix-x' | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" \
  "$(printf '%s' "$R" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" \
  | node "$HOOK" 2>&1 1>/dev/null)"
case "$msg" in
  *origin/main*) pass=$((pass+1)); echo "  ok    message names origin/main" ;;
  *) fail=$((fail+1)); echo "  FAIL  message names origin/main (got: $msg)" ;;
esac

# A command can cut more than one branch. Trust requires EVERY cut in the
# command to name origin/main or origin/master exactly; one untrusted cut
# anywhere in the command means the current-branch check still applies.
# Still on other-session-work, clean, from the block above.
echo "compound commands, feature branch, clean:"
check "second cut has no start point (&&)" 2 "$(run "$R" 'git checkout -b a origin/main && git checkout -b b')"
check "second cut names a branch (;)"       2 "$(run "$R" 'git checkout -b a origin/main ; git switch -c b feature')"
check "both cuts name origin/main"          0 "$(run "$R" 'git checkout -b a origin/main && git checkout -b b origin/main')"

# Look-alike start points must not be treated as trusted: the comparison is
# an exact string match, not a prefix or "starts with origin/main" test.
echo "look-alike start points, feature branch, clean:"
check "origin/main~3"   2 "$(run "$R" 'git checkout -b x origin/main~3')"
check "origin/main-old" 2 "$(run "$R" 'git checkout -b x origin/main-old')"
check "origin/main^"    2 "$(run "$R" 'git checkout -b x origin/main^')"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
