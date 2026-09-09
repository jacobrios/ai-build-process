#!/bin/bash
# Test harness for ~/.claude/hooks/safety-net-drift.mjs and
# ~/.claude/bin/accept-safety-net-difference.mjs.
#
# Every fixture is built fresh in a temp directory on each run, so the suite says
# the same thing on a machine that has never seen this repo. It never reads or
# writes any real project.
#
# The most important section is "STAYS QUIET": a session-start check that talks
# when it has nothing to say gets ignored, and an ignored check is no check.

# Overridable so a deliberately broken copy can be run through the same suite, to
# prove these assertions can actually fail. Normal runs need neither variable.
HOOK=${DRIFT_HOOK:-~/.claude/hooks/safety-net-drift.mjs}
ACCEPT=${DRIFT_ACCEPT:-~/.claude/bin/accept-safety-net-difference.mjs}
ROOT=$(mktemp -d)
TPL="$ROOT/tpl"
pass=0; fail=0

cleanup() { rm -rf "$ROOT"; }
trap cleanup EXIT

# ---------------------------------------------------------------- fixtures ----
mkdir -p "$TPL"
printf 'hook alpha v1\n'        > "$TPL/alpha.mjs"
printf 'test for alpha\n'       > "$TPL/alpha.test.ts"
printf 'hook beta v1\n'         > "$TPL/beta.mjs"
printf '# readme\n'             > "$TPL/README.md"      # not a hook, never compared
printf '{"hooks":{}}\n'         > "$TPL/settings.json"  # goes to .claude/, not hooks/
printf 'export const x = 1\n'   > "$TPL/db-which.ts"    # goes to the project's lib
# Both fixture hooks are recorded as proven, so "everything matches" means
# matching AND proven. The unproven case gets its own section at the end, which
# is where that behaviour is actually asserted.
cat > "$TPL/provenance.json" <<'JSON'
{ "proven": {
    "alpha.mjs": { "project": "fixture", "on": "2026-01-01", "how": "fixture" },
    "beta.mjs":  { "project": "fixture", "on": "2026-01-01", "how": "fixture" }
} }
JSON

mkdir -p "$TPL/node_modules/whatever"

# mkproj <name> — a project whose hooks match the template exactly
mkproj() {
  local d="$ROOT/$1"
  mkdir -p "$d/.claude/hooks"
  cp "$TPL/alpha.mjs" "$TPL/alpha.test.ts" "$TPL/beta.mjs" "$d/.claude/hooks/"
  echo "$d"
}

# run <project-dir> [source] — the hook's stdout, as the harness would see it
run() {
  echo "{\"cwd\":\"$1\",\"source\":\"${2:-startup}\"}" \
    | env CLAUDE_PROJECT_DIR="$1" SAFETY_NET_TEMPLATE_DIR="$TPL" node "$HOOK" 2>/dev/null
}

ok()   { printf "  PASS  %s\n" "$1"; pass=$((pass+1)); }
bad()  { printf "  FAIL  %s\n        %s\n" "$1" "$2"; fail=$((fail+1)); }

says()     { case "$2" in *"$3"*) ok "$1";; *) bad "$1" "expected to find: $3";; esac; }
says_not() { case "$2" in *"$3"*) bad "$1" "should not have mentioned: $3";; *) ok "$1";; esac; }
silent()   { if [ -z "$2" ]; then ok "$1"; else bad "$1" "expected no output, got: $2"; fi; }

# ------------------------------------------------------------- stays quiet ----
echo
echo "STAYS QUIET (no output) — a check that talks needlessly gets ignored"

P=$(mkproj clean)
silent "everything matches the template" "$(run "$P")"

P=$(mkproj extra); printf 'local only\n' > "$P/.claude/hooks/project-invention.mjs"
silent "project has a file the template does not" "$(run "$P")"

P=$(mkproj compacted); printf 'changed\n' > "$P/.claude/hooks/alpha.mjs"
silent "source is a compaction, not a new session" "$(run "$P" compact)"

mkdir -p "$ROOT/no-hooks"
silent "project never adopted the safety nets" "$(run "$ROOT/no-hooks")"

silent "template dir does not exist" \
  "$(echo "{\"cwd\":\"$P\"}" | env CLAUDE_PROJECT_DIR="$P" SAFETY_NET_TEMPLATE_DIR="$ROOT/nope" node "$HOOK" 2>/dev/null)"

silent "session opened in ~/.claude itself" \
  "$(echo "{\"cwd\":\"$HOME/.claude\"}" | env CLAUDE_PROJECT_DIR="$HOME/.claude" SAFETY_NET_TEMPLATE_DIR="$TPL" node "$HOOK" 2>/dev/null)"

# ----------------------------------------------------------- reports drift ----
echo
echo "REPORTS DRIFT — the three cases, and they read differently on purpose"

P=$(mkproj differs); printf 'hook alpha, adapted\n' > "$P/.claude/hooks/alpha.mjs"
OUT=$(run "$P")
says     "a changed file is reported as differing" "$OUT" "alpha.mjs differs from the template"
says     "  and offers the diff first"             "$OUT" "see it:   diff .claude/hooks/alpha.mjs $TPL/alpha.mjs"
says     "  and offers per-file adoption"          "$OUT" "adopt it: cp $TPL/alpha.mjs .claude/hooks/"
says     "  and offers the way to accept it"       "$OUT" "keep it:  node"
says_not "  and says nothing about beta.mjs"       "$OUT" "beta.mjs"

P=$(mkproj missing); rm "$P/.claude/hooks/beta.mjs"
OUT=$(run "$P")
says "a file the project lacks is named as such" "$OUT" "the template has beta.mjs and this project does not"
says "  and is shown, not diffed"                "$OUT" "see it:   cat $TPL/beta.mjs"
says "  and warns that adopting means wiring"    "$OUT" "registering it in .claude/settings.json"

P=$(mkproj tests); printf 'edited test\n' > "$P/.claude/hooks/alpha.test.ts"
says "a hook's test file counts as a safety net" "$(run "$P")" "alpha.test.ts differs from the template"

P=$(mkproj nonhooks)
rm "$P/.claude/hooks/alpha.mjs"; cp "$TPL/alpha.mjs" "$P/.claude/hooks/"
OUT=$(run "$P")
says_not "README.md is not compared"    "$OUT" "README.md and this project"
says_not "settings.json is not compared" "$OUT" "settings.json and this"
says_not "db-which.ts is not compared"   "$OUT" "db-which"

P=$(mkproj ordering); printf 'changed\n' > "$P/.claude/hooks/alpha.mjs"; rm "$P/.claude/hooks/beta.mjs"
OUT=$(run "$P")
FIRST=$(echo "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).systemMessage.split("\n")[0]))')
says "the missing file is reported before the changed one" "$FIRST" "the template has beta.mjs"

# ------------------------------------------------------------ output shape ----
echo
echo "OUTPUT SHAPE — the human must see it, and the session must not break"

P=$(mkproj shape); printf 'changed\n' > "$P/.claude/hooks/alpha.mjs"
OUT=$(run "$P")
if echo "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.systemMessage||!j.hookSpecificOutput.additionalContext)process.exit(1)})'; then
  ok "stdout is JSON carrying both a user message and agent context"
else
  bad "stdout is JSON carrying both a user message and agent context" "$OUT"
fi

echo '{"cwd":"' | env SAFETY_NET_TEMPLATE_DIR="$TPL" node "$HOOK" >/dev/null 2>&1
[ $? = 0 ] && ok "malformed stdin does not fail the session" || bad "malformed stdin does not fail the session" "nonzero exit"

run "$P" >/dev/null 2>&1
[ $? = 0 ] && ok "exits 0 even when it has drift to report" || bad "exits 0 even when it has drift to report" "nonzero exit"

# ----------------------------------------------------- accepted difference ----
echo
echo "ACCEPTED DIFFERENCE — deliberate, recorded, and it expires when the template moves"

P=$(mkproj accepted); printf 'hook alpha, calls npm test\n' > "$P/.claude/hooks/alpha.mjs"
says "before accepting, it reports" "$(run "$P")" "alpha.mjs differs"

(cd "$P" && env CLAUDE_PROJECT_DIR="$P" SAFETY_NET_TEMPLATE_DIR="$TPL" node "$ACCEPT" alpha.mjs "runs npm test so the hook and the project cannot disagree" >/dev/null 2>&1)
silent "after accepting, it stays quiet" "$(run "$P")"
[ -f "$P/.claude/safety-net-exceptions.json" ] && ok "the acceptance is written into the project, not ~/.claude" \
  || bad "the acceptance is written into the project" "no exceptions file"
says "the reason is recorded verbatim" "$(cat "$P/.claude/safety-net-exceptions.json")" "so the hook and the project cannot disagree"

printf 'hook alpha v2, working-dir fix\n' > "$TPL/alpha.mjs"
OUT=$(run "$P")
says "when the template moves, the acceptance expires" "$OUT" "the template has changed since"
says "  and the recorded reason is shown back"         "$OUT" "accepted because: runs npm test"
printf 'hook alpha v1\n' > "$TPL/alpha.mjs"

P=$(mkproj accept-missing); rm "$P/.claude/hooks/beta.mjs"
(cd "$P" && env CLAUDE_PROJECT_DIR="$P" SAFETY_NET_TEMPLATE_DIR="$TPL" node "$ACCEPT" beta.mjs "this project has no subagent tasks to gate" >/dev/null 2>&1)
silent "a deliberately absent file can be accepted too" "$(run "$P")"

P=$(mkproj broken-json); printf 'changed\n' > "$P/.claude/hooks/alpha.mjs"
printf 'not json at all' > "$P/.claude/safety-net-exceptions.json"
says "an unreadable exceptions file is said out loud" "$(run "$P")" "could not be read"

# ------------------------------------------------------- the accept command ----
echo
echo "THE ACCEPT COMMAND — refuses anything that would make 'accepted' meaningless"

P=$(mkproj refuse); printf 'changed\n' > "$P/.claude/hooks/alpha.mjs"
(cd "$P" && env CLAUDE_PROJECT_DIR="$P" SAFETY_NET_TEMPLATE_DIR="$TPL" node "$ACCEPT" alpha.mjs "nope" >/dev/null 2>&1)
[ $? != 0 ] && ok "refuses a reason too short to mean anything" || bad "refuses a short reason" "exit 0"
[ ! -f "$P/.claude/safety-net-exceptions.json" ] && ok "  and writes nothing when it refuses" \
  || bad "writes nothing when it refuses" "file was created"

(cd "$P" && env CLAUDE_PROJECT_DIR="$P" SAFETY_NET_TEMPLATE_DIR="$TPL" node "$ACCEPT" alpha.mjs >/dev/null 2>&1)
[ $? != 0 ] && ok "refuses with no reason at all" || bad "refuses with no reason at all" "exit 0"

P=$(mkproj refuse-same)
(cd "$P" && env CLAUDE_PROJECT_DIR="$P" SAFETY_NET_TEMPLATE_DIR="$TPL" node "$ACCEPT" alpha.mjs "there is nothing here to accept" >/dev/null 2>&1)
[ $? != 0 ] && ok "refuses to accept a difference that does not exist" || bad "refuses a nonexistent difference" "exit 0"

(cd "$P" && env CLAUDE_PROJECT_DIR="$P" SAFETY_NET_TEMPLATE_DIR="$TPL" node "$ACCEPT" not-in-template.mjs "a perfectly good reason here" >/dev/null 2>&1)
[ $? != 0 ] && ok "refuses a file the template does not have" || bad "refuses an unknown file" "exit 0"

P=$(mkproj preserve); printf 'a\n' > "$P/.claude/hooks/alpha.mjs"; printf 'b\n' > "$P/.claude/hooks/beta.mjs"
(cd "$P" && env CLAUDE_PROJECT_DIR="$P" SAFETY_NET_TEMPLATE_DIR="$TPL" node "$ACCEPT" alpha.mjs "the first accepted difference here" >/dev/null 2>&1)
(cd "$P" && env CLAUDE_PROJECT_DIR="$P" SAFETY_NET_TEMPLATE_DIR="$TPL" node "$ACCEPT" beta.mjs "the second accepted difference here" >/dev/null 2>&1)
says "a second acceptance keeps the first" "$(cat "$P/.claude/safety-net-exceptions.json")" "the first accepted difference here"
silent "  and both files go quiet" "$(run "$P")"

P=$(mkproj corrupt); printf 'changed\n' > "$P/.claude/hooks/alpha.mjs"
# ---------------------------------------------------------------------------
# UNPROVEN — a file can be adopted, identical, and still never have run anywhere
echo ""
echo "UNPROVEN — adopted and identical is not the same as proven"

printf 'hook gamma v1\n' > "$TPL/gamma.mjs"          # in the template, in no provenance entry
P=$(mkproj unproven); cp "$TPL/gamma.mjs" "$P/.claude/hooks/"
OUT=$(run "$P")
says     "an adopted but unproven file is reported"   "$OUT" "this project runs gamma.mjs, which has never been recorded as proven anywhere"
says     "  and says what proven would mean"          "$OUT" "its own tests have not been seen green inside any real project's suite"
says     "  and offers the way to record it"          "$OUT" "record-safety-net-proof.mjs gamma.mjs"
says_not "  and stays silent about proven files"      "$OUT" "alpha.mjs, which has never"

P=$(mkproj unproven-missing); rm -f "$P/.claude/hooks/gamma.mjs"
OUT=$(run "$P")
says     "a missing unproven file says so on the missing line" "$OUT" "gamma.mjs has never run inside a project, so it is unproven"

cat > "$TPL/provenance.json" <<'JSON'
{ "proven": {
    "alpha.mjs": { "project": "fixture", "on": "2026-01-01", "how": "fixture" },
    "beta.mjs":  { "project": "fixture", "on": "2026-01-01", "how": "fixture" },
    "gamma.mjs": { "project": "fixture", "on": "2026-01-02", "how": "its tests ran green there" }
} }
JSON
P=$(mkproj proven-now); cp "$TPL/gamma.mjs" "$P/.claude/hooks/"
silent   "recording proof makes it stay quiet"        "$(run "$P")"

printf 'not json at all\n' > "$TPL/provenance.json"
P=$(mkproj prov-unreadable); cp "$TPL/gamma.mjs" "$P/.claude/hooks/"
says     "an unreadable provenance file is reported, not silently ignored" "$(run "$P")" "could not be read, so nothing counted as proven"

# Restore the fixture for anything that runs after this section.
cat > "$TPL/provenance.json" <<'JSON'
{ "proven": {
    "alpha.mjs": { "project": "fixture", "on": "2026-01-01", "how": "fixture" },
    "beta.mjs":  { "project": "fixture", "on": "2026-01-01", "how": "fixture" }
} }
JSON
rm -f "$TPL/gamma.mjs"

printf '{{{' > "$P/.claude/safety-net-exceptions.json"
(cd "$P" && env CLAUDE_PROJECT_DIR="$P" SAFETY_NET_TEMPLATE_DIR="$TPL" node "$ACCEPT" alpha.mjs "a perfectly good reason here" >/dev/null 2>&1)
[ $? != 0 ] && ok "refuses to overwrite an unreadable exceptions file" || bad "refuses to overwrite corrupt file" "exit 0"
[ "$(cat "$P/.claude/safety-net-exceptions.json")" = "{{{" ] && ok "  and leaves the existing acceptances alone" \
  || bad "leaves existing acceptances alone" "file was overwritten"

echo
echo "  $pass passed, $fail failed"
[ "$fail" = 0 ] || exit 1

