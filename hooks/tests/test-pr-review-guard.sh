#!/usr/bin/env bash
# Tests for pr-review-guard.mjs. Each case feeds the hook the JSON the harness
# sends for a Bash call and checks the exit code. Exit 2 = blocked, 0 = allowed.
set -uo pipefail

HOOK="$(cd "$(dirname "$0")/.." && pwd)/pr-review-guard.mjs"
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

REVIEW_BODY=$'## What changed\n- thing\n\n## Review\nReviewer found one issue; fixed.\n'
NO_REVIEW_BODY=$'## What changed\n- thing\n\n## Verification\n1777/149 before, 1778/149 after\n'
printf '%s' "$REVIEW_BODY" > "$TMP/with-review.md"
printf '%s' "$NO_REVIEW_BODY" > "$TMP/without-review.md"
printf '## Review\n' > "$TMP/empty-review.md"

echo "allowed:"
check "inline body with a review section"   0 "$(run "$TMP" "gh pr create --title t --body \$'## Review\\nfound nothing'")"
check "heredoc body with a review section"  0 "$(run "$TMP" "gh pr create --title t --body \"\$(cat <<'EOF'
## What changed
- a

## What the review found
Nothing to fix.
EOF
)\"")"
check "body-file with a review section"     0 "$(run "$TMP" "gh pr create -t t --body-file $TMP/with-review.md")"
check "-F short form"                       0 "$(run "$TMP" "gh pr create -t t -F $TMP/with-review.md")"
check "gh pr view untouched"                0 "$(run "$TMP" 'gh pr view 118')"
check "unrelated command"                   0 "$(run "$TMP" 'npm test')"
check "--help is harmless"                  0 "$(run "$TMP" 'gh pr create --help')"

echo "blocked:"
check "body without a review section"       2 "$(run "$TMP" "gh pr create --title t --body \$'## Verification\\n1777/149'")"
check "review mentioned in prose only"      2 "$(run "$TMP" "gh pr create --title t --body \$'## Verification\\nno review needed'")"
check "review heading with nothing under it" 2 "$(run "$TMP" "gh pr create --title t --body \$'## Review\\n\\n## Next'")"
check "body-file without a review section"  2 "$(run "$TMP" "gh pr create -t t --body-file $TMP/without-review.md")"
check "body-file with an empty review heading" 2 "$(run "$TMP" "gh pr create -t t -F $TMP/empty-review.md")"
check "body-file that does not exist"       2 "$(run "$TMP" "gh pr create -t t --body-file $TMP/missing.md")"
check "--fill (body from commits)"          2 "$(run "$TMP" 'gh pr create --fill')"
check "--web (body written in a browser)"   2 "$(run "$TMP" 'gh pr create --web')"
check "no body at all"                      2 "$(run "$TMP" 'gh pr create --title t')"
check "chained after other commands"        2 "$(run "$TMP" 'git push -u origin HEAD && gh pr create --title t --body x')"

echo "fails open:"
echo 'not json' | node "$HOOK" >/dev/null 2>&1; check "unparseable stdin" 0 "$?"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
