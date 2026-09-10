#!/bin/bash
# Test harness for ~/.claude/hooks/repo-boundary.mjs
# Exit 0 = allowed, exit 2 = blocked.
#
# The "MUST STILL WORK" block is the most important section: a false positive here
# would break ordinary development, and a guardrail that breaks work gets disabled.

HOOKS="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$HOOKS/repo-boundary.mjs"
H=$(echo ~)
PROJ="$H/code/interplanetary-groups-oneshot"
OTHER="$H/code/interplanetary-groups"
SCRATCH="/private/tmp/claude-501/any-session/scratchpad"
pass=0; fail=0

# check <expected 0|2> <description> <json>
# CLAUDE_PROJECT_DIR is explicitly unset so results do not depend on where this
# suite is run from; the hook then anchors to the git root above the JSON's cwd,
# which for cwd=$PROJ is $PROJ itself, preserving every test's original meaning.
# anchored_check sets the env var instead, to test the session-anchor path.
check() {
  local expect="$1" desc="$2" json="$3"
  echo "$json" | env -u CLAUDE_PROJECT_DIR node "$HOOK" >/dev/null 2>&1
  local got=$?
  if [ "$got" = "$expect" ]; then
    printf "  PASS  %-54s (exit %s)\n" "$desc" "$got"; pass=$((pass+1))
  else
    printf "  FAIL  %-54s expected %s, got %s\n" "$desc" "$expect" "$got"; fail=$((fail+1))
  fi
}
anchored_check() {
  local expect="$1" desc="$2" json="$3" anchor="$4"
  echo "$json" | env CLAUDE_PROJECT_DIR="$anchor" node "$HOOK" >/dev/null 2>&1
  local got=$?
  if [ "$got" = "$expect" ]; then
    printf "  PASS  %-54s (exit %s)\n" "$desc" "$got"; pass=$((pass+1))
  else
    printf "  FAIL  %-54s expected %s, got %s\n" "$desc" "$expect" "$got"; fail=$((fail+1))
  fi
}
bash_check() { check "$1" "$2" "{\"tool_name\":\"Bash\",\"cwd\":\"$PROJ\",\"tool_input\":{\"command\":$3}}"; }
edit_check() { check "$1" "$2" "{\"tool_name\":\"Edit\",\"cwd\":\"$PROJ\",\"tool_input\":{\"file_path\":\"$3\"}}"; }

echo "MUST STILL WORK (exit 0) — false positives here would break real development"
bash_check 0 "npm test"                          '"npm test"'
bash_check 0 "npm run build"                     '"npm run build"'
bash_check 0 "npm run format (contains r-m!)"    '"npm run format"'
bash_check 0 "npm install"                       '"npm install"'
bash_check 0 "npx prisma generate"               '"npx prisma generate"'
bash_check 0 "git status"                        '"git status --short"'
bash_check 0 "git log"                           '"git log --oneline -5"'
bash_check 0 "git diff"                          '"git diff --stat"'
bash_check 0 "git commit IN this project"        '"git commit -m wip"'
bash_check 0 "git push IN this project"          '"git push origin main"'
bash_check 0 "cd a subdir then run tests"        '"cd src && npm test"'
bash_check 0 "gh pr create"                      '"gh pr create --title x --body y"'
bash_check 0 "rm a temp file in the project"     "\"rm $PROJ/tsconfig.tsbuildinfo\""
bash_check 0 "rm inside the scratchpad"          "\"rm $SCRATCH/tmp.txt\""
bash_check 0 "rm a relative path in-project"     '"rm ./build/output.js"'
bash_check 0 "mv within the project"             '"mv src/a.ts src/b.ts"'
bash_check 0 "an unresolvable variable path"     '"rm \"$TMPDIR/thing\""'
bash_check 0 "grep across the project"           '"grep -rn TODO src"'
edit_check 0 "edit a file in this project"       "$PROJ/README.md"
edit_check 0 "write to the global rules file"    "$H/.claude/CLAUDE.md"
edit_check 0 "write a memory file"               "$H/.claude/projects/p/memory/x.md"
edit_check 0 "write to the scratchpad"           "$SCRATCH/notes.txt"

echo
echo "THE ORIGINAL FAILURE — must block (exit 2)"
edit_check 2 "edit a file in a DIFFERENT repo"   "$OTHER/README.md"
bash_check 2 "cd other repo && git commit"       "\"cd $OTHER && git commit -am wip\""
bash_check 2 "cd other repo && git push"         "\"cd $OTHER && git push origin main\""
bash_check 2 "git -C otherrepo commit"           "\"git -C $OTHER commit -am wip\""
bash_check 2 "cd other repo, then rm a file"     "\"cd $OTHER && rm src/index.ts\""

echo
echo "DELETION AND MOVES OUTSIDE THE PROJECT — must block (exit 2)"
bash_check 2 "rm a file in Documents"            "\"rm $H/Documents/notes.txt\""
bash_check 2 "rm -rf an unrelated home folder"   "\"rm -rf $H/archive\""
bash_check 2 "rm your shell config"              "\"rm $H/.zshrc\""
bash_check 2 "rm -rf ANOTHER project in ~/code"  "\"rm -rf $OTHER\""
bash_check 2 "rm via the ~ shorthand"            '"rm -rf ~/Pictures/album"'
bash_check 2 "mv a project file out to home"     "\"mv src/secret.ts $H/stash.ts\""
bash_check 2 "sudo rm outside the project"       "\"sudo rm -rf $H/archive\""
bash_check 2 "rm buried later in a chain"        "\"npm test && rm $H/.zshrc\""
edit_check 2 "edit a file on the Desktop"        "$H/Desktop/x.txt"
edit_check 2 "edit a system file"                "/etc/hosts"

echo
echo "CROSS-REPO INSPECTION — read-only, must be allowed (exit 0)"
bash_check 0 "branch --contains (reported block)" "\"git -C $OTHER branch --contains abc123\""
bash_check 0 "branch -a"                         "\"git -C $OTHER branch -a\""
bash_check 0 "branch --list"                     "\"git -C $OTHER branch --list\""
bash_check 0 "tag --list"                        "\"git -C $OTHER tag --list\""
bash_check 0 "stash list"                        "\"git -C $OTHER stash list\""
bash_check 0 "stash show"                        "\"git -C $OTHER stash show\""
bash_check 0 "fetch"                             "\"git -C $OTHER fetch\""
bash_check 0 "remote -v"                         "\"git -C $OTHER remote -v\""
bash_check 0 "config --get"                      "\"git -C $OTHER config --get user.email\""
bash_check 0 "config read, one positional"       "\"git -C $OTHER config user.email\""
bash_check 0 "log"                               "\"git -C $OTHER log --oneline -5\""
bash_check 0 "show"                              "\"git -C $OTHER show HEAD\""
bash_check 0 "diff"                              "\"git -C $OTHER diff --stat\""

echo
echo "CROSS-REPO MODIFICATION — must be blocked (exit 2)"
bash_check 2 "branch -D deletes a branch"        "\"git -C $OTHER branch -D main\""
bash_check 2 "branch -m renames"                 "\"git -C $OTHER branch -m old new\""
bash_check 2 "tag -d deletes a tag"              "\"git -C $OTHER tag -d v1.0\""
bash_check 2 "bare stash shelves work"           "\"git -C $OTHER stash\""
bash_check 2 "stash pop"                         "\"git -C $OTHER stash pop\""
bash_check 2 "remote set-url (was a HOLE)"       "\"git -C $OTHER remote set-url origin https://example.com/x.git\""
bash_check 2 "remote add"                        "\"git -C $OTHER remote add other https://example.com/y.git\""
bash_check 2 "remote remove"                     "\"git -C $OTHER remote remove origin\""
bash_check 2 "config write (was a HOLE)"         "\"git -C $OTHER config user.email someone@example.com\""
bash_check 2 "config --unset"                    "\"git -C $OTHER config --unset user.email\""
bash_check 2 "cd other repo then branch -D"      "\"cd $OTHER && git branch -D main\""

echo
echo "THE SAME WRITES INSIDE THIS PROJECT — must be allowed (exit 0)"
bash_check 0 "branch -D here"                    '"git branch -D scratch"'
bash_check 0 "stash here"                        '"git stash"'
bash_check 0 "config write here"                 '"git config user.email someone@example.com"'
bash_check 0 "remote set-url here"               '"git remote set-url origin https://example.com/x.git"'

echo
echo "THE FENCE ANCHORS TO THE PROJECT, NOT THE SHELL'S CWD (11 Aug 2026)"
# The reported false positive: a shell cd'd into a subfolder must not shrink the
# project to that subfolder.
check 0 "write repo file while cwd is a subfolder"  "{\"tool_name\":\"Write\",\"cwd\":\"$PROJ/docs\",\"tool_input\":{\"file_path\":\"$PROJ/README.md\"}}"
check 0 "git commit while cwd is a subfolder"       "{\"tool_name\":\"Bash\",\"cwd\":\"$PROJ/src\",\"tool_input\":{\"command\":\"git commit -m wip\"}}"
check 2 "subfolder cwd still cannot write outside"  "{\"tool_name\":\"Write\",\"cwd\":\"$PROJ/docs\",\"tool_input\":{\"file_path\":\"$H/stash.txt\"}}"
# The bypass: a persistent cd into another repo must not move the fence there.
anchored_check 2 "write other repo after persistent cd there"  "{\"tool_name\":\"Write\",\"cwd\":\"$OTHER\",\"tool_input\":{\"file_path\":\"$OTHER/src/x.ts\"}}" "$PROJ"
anchored_check 2 "git commit in other repo after cd there"     "{\"tool_name\":\"Bash\",\"cwd\":\"$OTHER\",\"tool_input\":{\"command\":\"git commit -am wip\"}}" "$PROJ"
anchored_check 0 "write own repo while shell sits elsewhere"   "{\"tool_name\":\"Write\",\"cwd\":\"$OTHER\",\"tool_input\":{\"file_path\":\"$PROJ/notes.md\"}}" "$PROJ"
# Honest limit, pinned so a change to it is loud: with no env anchor, the git root
# above the cwd is the best guess, so a wandered shell anchors to the wandered repo.
check 0 "KNOWN LIMIT: no env anchor, wandered cwd anchors there" "{\"tool_name\":\"Write\",\"cwd\":\"$OTHER/src\",\"tool_input\":{\"file_path\":\"$OTHER/src/x.ts\"}}"

echo
echo "COPYING OUT OF THE PROJECT — the hole found 20 Aug 2026 (exit 2)"
bash_check 2 "copy a file to shared /tmp"        "\"cp docs/notes.txt /private/tmp/B.txt\""
bash_check 2 "recursive copy of the project"     '"cp -r . /private/tmp/whole"'
bash_check 2 "copy the source tree out"          '"cp -r src /private/tmp/whole-project"'
bash_check 2 "rsync the project out"             '"rsync -a src/ /private/tmp/mirror/"'
bash_check 2 "ditto the project out"             '"ditto . /private/tmp/clone"'
bash_check 2 "copy to the home directory"        "\"cp docs/notes.txt $H/notes.txt\""

echo
echo "COPYING THAT MUST KEEP WORKING (exit 0)"
bash_check 0 "copy into the session scratchpad"  "\"cp docs/notes.txt $SCRATCH/B.txt\""
bash_check 0 "recursive copy into scratchpad"    "\"cp -r src $SCRATCH/src-copy\""
bash_check 0 "copy within the project"           '"cp .env.example .env.local"'
bash_check 0 "copy FROM outside INTO the project" "\"cp /private/tmp/x.txt ./docs/x.txt\""
bash_check 0 "a malformed single-argument copy"  '"cp onlyonearg"'
bash_check 0 "an unresolvable destination"       '"cp a.txt \"$TMPDIR/b.txt\""'

echo
echo "MOVE STAYS STRICTER THAN COPY, because mv removes its source (exit 2)"
bash_check 2 "move a tracked file out"           "\"mv docs/notes.txt /private/tmp/B.txt\""
bash_check 0 "move within the project"           '"mv src/a.ts src/b.ts"'

echo
echo "WORKTREE RESYNC — a worktree and its main checkout are one repository"
# Real fixture rather than fake paths: the hook asks git whether two directories
# share a repository, so only a real worktree can exercise that answer. Built and
# torn down here so the suite never depends on a worktree that happens to exist.
# NOT under mktemp: macOS puts that in /private/var/folders, which is already an
# allowed root, so a fixture there sits inside the fence and every case passes for
# the wrong reason. (Caught by watching the must-stay-blocked cases go green.)
WT_ROOT="$H/code/.repo-boundary-fixture-$$"
trap 'rm -rf "$WT_ROOT"' EXIT
WT_MAIN="$WT_ROOT/main"
git init -q "$WT_MAIN" 2>/dev/null
git -C "$WT_MAIN" -c user.email=t@t -c user.name=t commit -q --allow-empty -m seed
git -C "$WT_MAIN" worktree add -q "$WT_MAIN/.claude/worktrees/wt" -b wt 2>/dev/null
WT="$WT_MAIN/.claude/worktrees/wt"
wt_check() {
  anchored_check "$1" "$2" "{\"tool_name\":\"Bash\",\"cwd\":\"$WT\",\"tool_input\":{\"command\":$3}}" "$WT"
}

# The two chores the merge-resync rule needs. Both refuse destructive cases in git
# itself: --ff-only cannot discard commits, -d cannot delete an unmerged branch.
wt_check 0 "catch up the main checkout"          "\"git -C $WT_MAIN pull --ff-only\""
wt_check 0 "delete the merged branch"            "\"git -C $WT_MAIN branch -d slice\""

# Everything that could move a live session's working tree stays blocked. These are
# what make this a short list of chores rather than "same repo, do what you like".
wt_check 2 "a pull that may not fast-forward"    "\"git -C $WT_MAIN pull\""
wt_check 2 "force-delete an unmerged branch"     "\"git -C $WT_MAIN branch -D slice\""
wt_check 2 "delete with --force"                 "\"git -C $WT_MAIN branch --delete --force slice\""
wt_check 2 "switch the main checkout's branch"   "\"git -C $WT_MAIN checkout main\""
wt_check 2 "reset the main checkout"             "\"git -C $WT_MAIN reset --hard origin/main\""
wt_check 2 "wipe the main checkout's untracked"  "\"git -C $WT_MAIN clean -fd\""

# The load-bearing one: the widening is same-repository only, never same-machine.
wt_check 2 "the same chore in a DIFFERENT repo"  "\"git -C $OTHER pull --ff-only\""
rm -rf "$WT_ROOT"


echo
echo "REDIRECTION (added 9 Sept 2026): cat > path, >>, tee are writes too"
echo "  must still work"
bash_check 0 "> /dev/null"                       '"echo x > /dev/null"'
bash_check 0 "2>&1 is a file descriptor"         '"npm test 2>&1"'
bash_check 0 ">&2 is a file descriptor"          '"echo err >&2"'
bash_check 0 "> relative path in project"        '"echo x > out.txt"'
bash_check 0 ">> relative path in project"       '"echo x >> out.txt"'
bash_check 0 "heredoc into the project"          '"cat > notes.md <<EOF\nhello\nEOF"'
bash_check 0 "heredoc body with -> in prose"     '"cat > notes.md <<EOF\nA -> B\nEOF"'
bash_check 0 "heredoc body with a > quote line"  '"cat > notes.md <<EOF\n> quoted line\nEOF"'
bash_check 0 "> a variable-built path"           '"echo x > \"$TMPDIR/x\""'
bash_check 0 ">> into the scratchpad"            "\"echo x >> $SCRATCH/log.txt\""
bash_check 0 "tee into the project"              '"echo x | tee out.txt"'
bash_check 0 "tee -a into the project"           '"echo x | tee -a out.txt"'
bash_check 0 "operator inside a quoted string"   '"echo \"see>~/notes\""'
bash_check 0 "> a literal \$var path elsewhere"     "\"echo x > $OTHER/\$name.md\""
bash_check 0 "heredoc body prose: > ~/x (cat)"     '"cat > notes.md <<EOF\nuse > ~/x to write\nEOF"'
bash_check 0 "heredoc body prose: rm ~/x (python)"  '"python3 - <<PY\nrm ~/x\nPY"'
echo "  must block"
bash_check 2 "> into another repo"               "\"echo x > $OTHER/notes.md\""
bash_check 2 ">> into another repo"              "\"echo x >> $OTHER/notes.md\""
bash_check 2 "> into the home directory"         '"echo x > ~/notes.md"'
bash_check 2 "heredoc into another repo"         "\"cat > $OTHER/x.md <<EOF\nhi\nEOF\""
bash_check 2 "tee into another repo"             "\"echo x | tee $OTHER/x.md\""
bash_check 2 "tee -a into another repo"          "\"echo x | tee -a $OTHER/x.md\""
bash_check 2 "cd elsewhere then > relative"      "\"cd $OTHER && echo x > notes.md\""
bash_check 2 "2> into another repo"              "\"echo x 2> $OTHER/err.log\""
bash_check 2 "&> into another repo"              "\"echo x &> $OTHER/all.log\""
bash_check 2 "attached form >path"               "\"echo x>$OTHER/attached.md\""
bash_check 2 "quoted target in another repo"     "\"echo x > \\\"$OTHER/notes.md\\\"\""
bash_check 2 "heredoc body run by bash: > ~/x"    '"bash <<EOF\necho x > ~/notes.md\nEOF"'
bash_check 2 "heredoc body run by sh: rm ~/x"      '"sh <<EOF\nrm ~/x\nEOF"'

echo
echo "  $pass passed, $fail failed"
[ "$fail" = 0 ] || exit 1
