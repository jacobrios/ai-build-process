# Let helper agents work in their own worktrees

**23 September 2026.** Slice document. Append-only once the work lands; later findings go on the end as dated postscripts.

## Front section (for Jacob)

**Settled, do not relitigate** (approved by Jacob in chat, 23 Sept, after a second opinion from the "Claude Code access protections" session):
- The boundary guard also allows the *linked* worktree the session is standing in, when it belongs to the same repository. Never the repository's main checkout.
- The branch-cut guard allows cutting from an explicit `origin/main` (or `origin/master`) on a clean tree, whatever branch is checked out. There is no fetch requirement, because the guard cannot verify that a fetch worked.
- `ln` joins the boundary guard's write commands. The guard judges where the link is created, not what it points at.

**Non-goals:**
- Guarding `sed -i` is queued in `access-protections.md`.
- `touch`, `mkdir`, `chmod`, `dd`, `install` are declined there.
- The symlink-then-read gap around the sensitive-read guard is declined there.
- The CLAUDE.md wording about what the branch-cut guard enforces is queued for Jacob, who owns that file.

**Verification:** each behavior gets a black-box test in the existing bash suites, shown failing before the change. The new tests cover:
- a sibling linked worktree allowed;
- main checkout, third worktree and other repo still blocked;
- `ln` placement;
- `origin/main` start point allowed and other start points blocked.

Suite baseline before: 290/290. The header reasoning in each hook is documentation, and no test is owed for it.

**Debt opened:** a session that deliberately `cd`s into another session's linked worktree can write there. This is accepted, because the guard catches accidents. A branch cut from a stale `origin/main` is also possible, and it shows up at merge.

---

## Tasks (for the executing agents)

Repo: `~/.claude` (git, branch `main`; this repo commits straight to main by standing rule). Tests are plain bash: `bash hooks/tests/test-repo-boundary.sh`, `bash hooks/tests/test-branch-cut-guard.sh`, all guards `bash hooks/tests/check-guards.sh`. Hooks read a JSON tool call on stdin; exit 0 = allow, exit 2 = block. No em dashes or en dashes in any prose, comments, or commit messages (use commas, semicolons, parentheses). Commit messages in product language. End each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Use `git commit -F <file>` for messages (the sensitive-read guard judges prose in a `-m` string as commands).

### Global constraints

- Tests first. Add the new cases, run the suite, and capture the failing output before touching the hook. Put that output in your report.
- Every existing test must stay green.
- Put the WHY next to the code in each hook's header comment, in the style already there. A future reader who sees "same repo, so allow it" must find the reason the main checkout is excluded.
- Fail closed to today's behavior. If a git call fails or returns something unexpected, the new allowance simply does not apply. It must never block something that is allowed today, and never allow something beyond the stated case.

### Task 1: repo-boundary allows the linked worktree the session stands in

File: `hooks/repo-boundary.mjs`, tests in `hooks/tests/test-repo-boundary.sh`.

Incident: an Agent spawned with worktree isolation got `interplanetary-groups/.claude/worktrees/agent-...`, but the harness set `CLAUDE_PROJECT_DIR` to the parent session's worktree `interplanetary-groups/.claude/worktrees/open-source-github-prep-eecaac`, a sibling. The hook anchors on `CLAUDE_PROJECT_DIR` (lines ~62-72), so every write in the agent's own worktree was denied.

Behavior to add:
1. Keep the anchor exactly as today (env var first, then `.git` walk from `cwd`).
2. Additionally compute the worktree root containing the hook input's `cwd` (`data.cwd`, the persisted shell cwd, NOT the in-command `cd` tracking): the nearest ancestor-or-self containing a `.git` entry (file or directory).
3. If that root differs from the anchor and is not already inside an allowed root, run git once there to get its git dir and common dir as absolute, realpath'd paths, e.g. `git -C <root> rev-parse --path-format=absolute --git-dir --git-common-dir`. Do the same for the anchor, to get the anchor's common dir.
4. Add that root as an extra allowed root only if all of these hold:
   - its common dir equals the anchor's common dir (same repository);
   - its git dir differs from its common dir, which means it is a *linked* worktree (`.git/worktrees/<name>`) and not the main checkout.
5. Anything else, including any git failure, adds nothing.
6. Apply to every tool the hook checks (Edit/Write/MultiEdit/NotebookEdit and Bash), since `data.cwd` is on every input.

Why the main checkout is excluded (write this in the header): the main checkout is itself a worktree of the same repo. On 4 Sept only `pull --ff-only` and `branch -d` were opened from a worktree against it, with `checkout/switch/reset/restore/clean/stash/rebase/merge` deliberately kept blocked after the 1 Sept incident. That was PR #112, which swept another session's 32 unmerged commits into a branch. Allowing the main checkout would reopen all of that with one `cd`. Also say why this does not reintroduce the old cwd-anchoring bugs (fa5d797): the anchor is unchanged, so a subfolder `cd` cannot shrink the fence; and the extra root requires the same git common dir, so a `cd` into another repo cannot move the fence there. Name the accepted residual: a deliberate `cd` into another live session's linked worktree of the same repo makes it writable.

Tests to add (build a real fixture like the existing worktree section, ~lines 177-207: a main checkout with at least three linked worktrees `wt-a`, `wt-b`, `wt-c`, plus a separate repo with its own linked worktree; anchor `CLAUDE_PROJECT_DIR` at `wt-a`; clean up the fixture at the end):
- cwd = `wt-b`: Write to a file in `wt-b` is allowed.
- cwd = `wt-b`: Bash `rm wt-b/file` is allowed.
- cwd = `wt-b`: Bash `git branch -m newname` is allowed.
- cwd = a subfolder of `wt-b`: Write to `wt-b` root file is allowed.
- cwd = `wt-b`: Write into `wt-c` is blocked.
- cwd = `wt-b`: Write into the main checkout (outside `.claude/worktrees`) is blocked.
- cwd = the main checkout: Write into the main checkout is blocked, because the main checkout is not linked.
- cwd = the other repo's linked worktree: Write there is blocked.
- cwd = a non-git temp dir: behavior unchanged, still blocked outside.
Also check that existing cases still pass.

### Task 2: repo-boundary checks `ln`

File: `hooks/repo-boundary.mjs`, tests in `hooks/tests/test-repo-boundary.sh`. `ln` is on no write list today (delete-style list ~line 86, copy-style ~line 98).

Behavior:
- Positional args are the non-flag args. Flags include `-s -f -n -v -h -i -F -w` and combined forms like `-sf`.
- With 2 or more positionals, check only the LAST one (where the link is created).
- With exactly 1 positional, the link is created in the current directory (the in-command `cd`-tracked directory), so check that directory.
- If a `-t DIR` / `--target-directory=DIR` form is present (GNU), check DIR.
- Unresolvable args (`$`, backticks, globs) follow the hook's existing allow-as-unresolvable rule.
- The link target (what it points at) is NOT checked. Reading is not writing.

Header: add `ln` to the documented list. Also record the declined gap: a link created inside the project can point at a secret (`ln -s ~/.aws/credentials ./notes.txt`), and a later read of the innocent name is judged by `sensitive-read-guard.mjs` on its spelling. This is declined 23 Sept 2026, because it needs deliberate intent and these guards catch accidents. Same family as the 20 Aug `cp` finding.

Tests (use the file's existing `check`/`anchored_check` helpers and fake paths):
- `ln -s /some/outside/file ./link` from inside the project: allowed.
- `ln -s ./x /outside/path/link`: blocked.
- `ln -sf a b` inside: allowed.
- `cd /outside/dir && ln -s /x`: blocked (single positional, cwd outside).
- `ln -s /x`, single positional, cwd inside: allowed.
- `ln -s x ~/.claude/foo`: allowed (fixed allowed root).

### Task 3: branch-cut-guard accepts an explicit origin/main start point

File: `hooks/branch-cut-guard.mjs`, tests in `hooks/tests/test-branch-cut-guard.sh`.

Today (lines ~55-79) the guard matches `git checkout -b` / `git switch -c` and requires the current branch to be main/master (or detached) and the tree to be clean. It never reads the start point.

Behavior:
- Parse the start point from the matched `git checkout -b <name> [<start>]` / `git switch -c <name> [<start>]` segment.
- If the start point is exactly `origin/main` or `origin/master`, skip the current-branch check.
- The clean-tree check still applies, unchanged. Uncommitted work means someone else may be working there.
- Any other start point, or no start point, behaves exactly as today.
- No fetch requirement. Do not parse for `git fetch`.
- Update the block message so that when the current-branch check fires, it names the accepted alternative: `git checkout -b <name> origin/main` from a clean tree.

Header WHY: the two checks are proxies for "where will this branch be cut from". An explicit `origin/main` start point answers that directly, so the current branch no longer matters. No fetch requirement, because the hook matches command text and cannot know whether a fetch succeeded, and a check it cannot verify would be theatre. That is the mirror of the 18 Aug merge-gate lesson. Residual: a stale `origin/main` costs a rebase and shows up at merge. That is a much smaller harm than the 1 Sept incident this guard exists for.

Tests (temp repo as the file does today; add a bare remote or `git update-ref refs/remotes/origin/main HEAD` so `origin/main` exists):
- On feature branch, clean, `git checkout -b x origin/main`: allowed.
- On feature branch, clean, `git switch -c x origin/main`: allowed.
- On feature branch, clean, `git checkout -b x origin/master`: allowed.
- On feature branch, clean, `git checkout -b x origin/feature`: blocked.
- On feature branch, clean, `git checkout -b x` (no start point): blocked.
- On feature branch, dirty, `git checkout -b x origin/main`: blocked.
- On main, clean, `git checkout -b x origin/main`: allowed.
- On feature branch, blocked message contains `origin/main`.

### Task 4: record it

Files: `decisions/access-protections.md` (append-only: annotate, never rewrite), and a dated postscript at the end of this document.

1. In `access-protections.md` Open threads, strike through the entry beginning "**`repo-boundary.mjs` does not guard shell redirection.**". Append a dated annotation: closed 9 September 2026 in commit 21e33a3 (see `rule-lineage.md`), noticed stale 23 September 2026.
2. Append new Open-threads bullets, dated 23 September 2026, product language:
   - The accepted residual from Task 1: a deliberate `cd` into another live session's linked worktree makes it writable.
   - The declined symlink-then-read gap from Task 2.
   - `sed -i` unguarded: queued. Say it is the only remaining command that silently rewrites an existing file.
   - `touch`, `mkdir`, `chmod`, `dd of=`, `install`: declined, with a one-line why each or as a group. Nothing gets worse by never doing it; at most they create empty files or change permissions. Note `dd of=` can overwrite a file; if that is judged real, queue it alongside `sed -i` instead and say so.
   - `~/.claude/CLAUDE.md` says `branch-cut-guard.mjs` enforces a current main; it checks the branch name and a clean tree, and now also accepts `origin/main`. The wording amendment is queued for Jacob, who owns that file. Do NOT edit CLAUDE.md.
3. Append a dated section to `access-protections.md` in product language (about 400 words): what happened, the three changes, why the narrower worktree rule, why no fetch requirement, who reviewed (the "Claude Code access protections" session, second opinion). Include the test counts before (290/290 across check-guards.sh) and after (take the real after-number from `bash hooks/tests/check-guards.sh`).

**Postscript, 23 September 2026.** Shipped as planned, no scope changes. Task 1 (linked worktree), Task 2 (`ln`), and Task 3 (`origin/main` start point) all landed as scoped above. Two review catches during the slice, both closed the same day: Task 2's first pass missed the space-separated form of `ln`'s target-directory flag (`--target-directory DIR`); Task 3's first pass let a command chaining two branch cuts have one trusted `origin/main` cut vouch for a second, untrusted one, closed by requiring every cut in a command to name `origin/main` or `origin/master`. Suite: 290/290 before, 325/325 after (`bash hooks/tests/check-guards.sh`). Full writeup in `decisions/access-protections.md`.

**Postscript, 23 September 2026 (final review round 2).** A second review found two more holes in the `ln` write, one crash bug, and a scrubbing gap in the same-repository check, plus two documentation problems. All fixed same day:
- A bare `ln -t` or `ln --target-directory` with no following value crashed the hook (`undefined.replace`). A crashing hook exits 1, which does not block, so the crash let the rest of the command line, including a following `rm -rf` outside the project, run unchecked. Confirmed with `ln -t; rm -rf <outside path>` exiting 1 with the `rm` unguarded. Fixed: a missing value now means no target directory, not a value that crashes later.
- `gitDirs()` and `sameRepository()`, the two git calls the linked-worktree exception depends on, ran with the hook's own inherited environment. If the session that started Claude Code had `GIT_DIR` (or a sibling variable) set, every directory asked about answered for that repository regardless of which one was actually named, so the main checkout and unrelated repos could read as "the same repository as the anchor" and become writable. Confirmed by reproducing it: a fixture main checkout became writable through an inherited `GIT_DIR` pointing at its own linked worktree. Fixed by scrubbing `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, and `GIT_CEILING_DIRECTORIES` from the environment both calls run in.
- The header comment claiming `-t`/`--target-directory` was `ln`'s only value-taking flag was wrong; GNU `ln` also has `-S`/`--suffix`. More to the point, the parser did not recognize `-t` or `-S` inside a combined short-flag cluster (`-st DIR`) or attached to a short flag (`-tDIR`), so those forms let the real destination through unchecked. Fixed by parsing both letters inside a cluster and their attached-value form. macOS's own `ln` cannot produce these forms; the fix only matters for pasted or scripted GNU usage.
- `access-protections.md`'s 23 September `sed -i` bullet claimed it was "the only remaining command" that rewrites a file in place unguarded, which is not true (`dd of=`, `curl -o`, `tar -C`, `unzip -d`, `perl -i` also do). Corrected with a dated annotation beneath the original bullet, append-only; the recommendation is unchanged, `sed -i` and `perl -i` stay queued as the two that can silently destroy content, the rest recorded as known.
- A new open thread was queued, not fixed: `branch-cut-guard.mjs` checks the folder the session started in, not a folder a command `cd`s or `-C`s into, so `cd <other checkout> && git checkout -b x origin/main` and `git -C <dir> checkout -b x origin/main` both check the wrong tree. Predates this slice and is not made worse by it.

Six new black-box tests added to `hooks/tests/test-repo-boundary.sh`, each shown failing before its fix, per the standing verification rule. Suite: 325/325 before this round, 331/331 after (`bash hooks/tests/check-guards.sh`). Full writeup in `decisions/access-protections.md`.

**Postscript, 23 September 2026 (final review round 3).** The fix for `ln`'s combined and attached short-flag forms, above, itself let a wrong case through: it matched any token starting with a dash, long options included, so a long flag that merely contains the letter "t" or "S" was misread as `-t`/`-S` plus a value, and the real destination went unchecked. Confirmed with `ln --interactive a b`, `ln --no-target-directory a b`, `ln --backup=existing a b`, and `ln -s --no-target-directory a b`, all wrongly allowed. Fixed by limiting that branch to single-dash tokens only; every other flag, long or short, now falls through to a plain "consumes nothing" case. Four new tests added, shown failing first. Suite: 331/331 before this round, 335/335 after.

**Postscript, 23 September 2026 (after the slice).** The CLAUDE.md wording queued for Jacob above was approved and made the same day (commit 2a18b45; story in `rule-lineage.md`). This document was also tidied for the public mirror without changing anything it records: the home path in the Tasks preamble became `~/.claude`, and the three postscripts above moved here from inside Task 4, where they had been inserted, to the end, where the header says postscripts belong.
