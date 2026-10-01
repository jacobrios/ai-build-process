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

said() { # said <cwd> <command> -> prints what the guard told the user
  printf '{"tool_input":{"command":%s},"cwd":%s}' "$(printf '%s' "$2" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" \
    "$(printf '%s' "$1" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" \
    | node "$HOOK" 2>&1 >/dev/null
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

echo "another command's flags are not the PR body (false block, 23 Sept 2026):"
# `git commit -F -` means "read the commit message from stdin" and has nothing to
# do with the PR. The guard used to search the whole command line and take the
# FIRST -F it found, so it reported on git's flag while gh's real --body-file sat
# further along, never read. Three correct PRs were refused before the shape was
# clear, and the workaround (split into two Bash calls) reached the memory file,
# which is how a miscalibrated guard stops being reported and becomes permanent.
check "commit -F - before a real body-file"  0 "$(run "$TMP" "git commit -F - <<'EOF'
a commit message
EOF
git push && gh pr create -t t --body-file $TMP/with-review.md")"
# Attempt 2 of the incident failed for a DIFFERENT reason, found while writing these
# tests: a body file written earlier in the same command does not exist yet, because
# the hook runs before the command does. Blocking is correct, since an unread body is
# an unverified one. Only the message was wrong, and it now names the remedy.
check "body file written in the same command" 2 "$(run "$TMP" "cat > $TMP/b.md <<'EOF'
## Review
Reviewer found one issue; fixed.
EOF
gh pr create -t t --body-file $TMP/b.md")"
# These three keep the fix honest: it must read GH's own flag, not skip flags.
check "gh's own missing file still blocks"   2 "$(run "$TMP" "git commit -F - && gh pr create -t t --body-file $TMP/missing.md")"
check "gh genuinely reading stdin blocks"    2 "$(run "$TMP" 'gh pr create -t t -F -')"
check "commit -F - then a body with no review" 2 "$(run "$TMP" "git commit -F - && gh pr create -t t --body-file $TMP/without-review.md")"

# Found by the 23 Sept re-check, one hour after the fix above: the same mistake,
# reading a flag from ANOTHER command on the line, lived in the three checks that
# fix did not touch, and there it let PRs THROUGH rather than blocking them. An
# unrelated `-b` (git checkout -b) made the guard read the whole line as the body,
# so a review heading in a commit message passed a --fill PR that carried none. An
# unrelated `-h` (df -h, ls -h) matched the --help escape and passed anything.
echo "another command's flags must not let a PR through:"
check "unrelated -b before a --fill PR"      2 "$(run "$TMP" "git checkout -b x && git commit -m \"\$(printf '## Review\\nfound nothing')\" && gh pr create --fill")"
check "unrelated -h before a --fill PR"      2 "$(run "$TMP" 'df -h && gh pr create --fill')"
# Kept passing on purpose: the body built first and handed over in a variable. The
# whole-line check for --body is deliberate (see the guard), and this is why.
check "body built in a variable first"       0 "$(run "$TMP" "BODY=\$(printf '## Review\\nreviewer found one issue, fixed') && gh pr create -t t --body \"\$BODY\"")"

echo "the block names the real cause:"
# Exit codes cannot tell these apart, both are 2, so the message itself is checked.
# No pipe here on purpose: under `pipefail` a pipe reports the guard's own exit 2
# even when the text matched, which read as a failure on the first attempt.
out=$(said "$TMP" "cat > $TMP/w.md <<'EOF'
## Review
x
EOF
gh pr create -t t --body-file $TMP/w.md")
[[ "$out" == *"written by this same command"* ]]; check "a same-command body file says so" 0 "$?"
out=$(said "$TMP" "gh pr create -t t --body-file $TMP/missing.md")
[[ "$out" == *"could not be read"* ]];            check "a plain missing file says so"     0 "$?"

echo "fails open:"
echo 'not json' | node "$HOOK" >/dev/null 2>&1; check "unparseable stdin" 0 "$?"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
