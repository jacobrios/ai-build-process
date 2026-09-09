# Project safety nets: reference implementation

Copy these into a new project's `.claude/` when setting it up. They are a
starting point to adapt, not a drop-in that works untouched.

Kept here, alongside the user-level `CLAUDE.md` that references them, so the
reference does not depend on any particular project still existing on this
machine. Copied from interplanetary-groups on 30 July 2026, where they were
first built and are still running.

## What is here

`settings.json` wires both hooks and records which plugins are enabled. Goes at
the project's `.claude/settings.json` and is meant to be committed, unlike
`settings.local.json`, which is machine-specific and should stay untracked.

**The test gate is two hooks, not one, as of 12 August 2026.** Take both or
neither; the per-edit half is deliberately not sufficient on its own.

`run-tests-unless-docs.mjs` is a PostToolUse hook. It fires after every Edit,
Write, or MultiEdit, skips `.md` files because a documentation edit cannot
change runtime behavior, and otherwise runs *the tests that reach the edited
file*. On failure it exits **2**, which is the only exit code Claude Code feeds
back to the agent; any other non-zero code is shown to the human while the agent
carries on unaware. Do not "simplify" that to propagating the runner's own exit
code. **The test command inside it is project-specific and must be changed** to
whatever the new project actually runs.

`full-suite-on-subagent-stop.mjs` is the other half, and it must be registered
for **both `SubagentStop` and `Stop`**. A narrow run cannot see a break in a file
the edited one never imports, so this runs the whole suite once when a task's
agent or the main session's turn finishes, and only when an edit is waiting for
it. An agent that edited nothing (a reviewer, an explorer) finishes without
paying for a run it cannot have broken.

**Register both events or the gate has a hole**, and the file keeps its
subagent-shaped name only because that is the event that prompted it. The first
version registered `SubagentStop` alone, which left every edit made outside a
task agent with a narrow run and then nothing at all: no full-suite run was ever
triggered by that turn ending. Micro-PRs, one-line fixes and post-review
corrections all live there. Give both entries an explicit generous `timeout`
too: a timed-out PostToolUse hook is visible to the human, while a timed-out
stop hook is invisible and self-perpetuating, since the run never finishes, the
stamp is never cleared, and every later finish times out identically.

`suite-stamp.mjs` is the state the two share, and where the whole risk of the
design lives. Every ambiguous case resolves toward running the suite: missing
state, unreadable state, and same-millisecond ties all run. The one case that
skips is "no edit was ever recorded." Stamps live in the system temp directory,
keyed by a hash of the project path, so nothing runtime enters the repo.

`project-root.mjs` answers which directory the runner runs in. Both hooks need
it and neither should own it. This is load-bearing rather than tidy-up: see the
12 August entry under "Keeping this current."

`provenance.json` records which files here have actually RUN inside a real
project, as opposed to existing here and looking finished. The default is
unproven, so a file absent from it is reported by the drift checker as never
having run anywhere, and silence means not-yet-trusted rather than fine. The bar
is narrow: a file is proven when its own tests ran green inside a real project's
suite. Copying it in is not proof and neither is reading it. Record one with
`node ~/.claude/bin/record-safety-net-proof.mjs <file> <project> "<what ran>"`.

This exists because suite-lock.mjs shipped from here with a deadlock on 3
September 2026. Its own tests were green; they only covered cases its author had
thought of, and the case that broke it was already sitting in the project it was
written for. The drift checker could say a file was missing. Nothing could say
it had never been run.

`suite-lock.mjs` keeps two suite runs off one database at the same time. It is
**not a hook**: it is a vitest `globalSetup`, wired in the project's own
`vitest.config.ts` and needed only where the tests share a single database.

```ts
globalSetup: ["./.claude/hooks/suite-lock.mjs"]
```

Why a globalSetup rather than a lock inside the stop hook, which is the obvious
place and the wrong one: a lock only works if every party takes it, and the two
parties that collided were the hook's run and an agent's own typed `npm test`.
A lock in the hook covers one of them, leaving the case that actually happened.
vitest reads its config at the start of every invocation, so a lock here covers
both. Two consequences fall out of that: it protects a session that is already
running, because nothing waits for a restart the way a hook does, and adopting
it adds a file rather than editing one, so neither hook drifts.

A run that takes the lock marks its process tree with an environment
variable, so a nested `vitest` spawned by the suite skips acquiring rather
than waiting for its own parent. That is not a nicety: the first version
lacked it and deadlocked interplanetary-groups' suite on contact, because one
test there spawns `vitest related` for real. The marker holds the lock path,
so a nested run against a different project still locks that one.

It waits for an in-flight run rather than skipping and trusting it. Trusting is
cheaper and quietly weakens the gate, since the other run may have started
before the last edit. On timeout it throws with a message naming the wait, so
the failure can never be mistaken for a test result.

`checks/suite-lock-atomicity.mjs` is a hand-run check, deliberately outside the
runner and in a subdirectory so the drift checker does not ask projects to adopt
it. It proves with two real processes that a heartbeat never leaves the lock file
unreadable, which no single-process test can observe. Run it after changing how
the beat writes:

```bash
node checks/suite-lock-atomicity.mjs
```

A project with no shared database does not need this and should record that as
a deliberate difference rather than adopting it.

**Why the split exists, since a slower gate looks safer from outside.** Running
the whole suite after every edit cost 85 seconds per edit and about 5.6 hours of
a single build day in interplanetary-groups, measured across session
transcripts, because that suite is network-bound against a remote database and
grows with the product. The split is roughly 20 whole-suite runs a slice instead
of 200, with the same gate at the end of every task.

`protect-paths.mjs` is a PreToolUse hook. It fires before every edit and blocks
changes to `.env` files and already-applied migrations. It deliberately allows
`.env.example` and `schema.prisma`, since those are the legitimate ways to
evolve config and the data model. The `.env` patterns are case-insensitive
because macOS filesystems are, so `.ENV.local` is the same file as `.env.local`.
Before matching, the path is also normalized twice over: `node:path` collapses
separators and `.`/`..` segments, and NFKC collapses Unicode compatibility forms,
which is what catches a long s standing in for an `s`. All three mechanisms are
load-bearing and none replaces another; in particular NFKC does no case folding,
so it does not make the `/i` flags redundant, and it is not the filesystem's own
fold table, so on a different filesystem the overlap would need rechecking. NFKC
also over-blocks a broad compatibility class as a side effect (fullwidth,
mathematical, circled and enclosed letters, and the fullwidth solidus), which is
the right direction for a guard and reaches nothing a developer would edit;
accented, ligature and emoji paths are unaffected in both NFC and NFD. The
matching is lexical throughout: it never touches the disk, so it does not follow
symlinks.

`protect-paths.test.ts` is that hook's test, and it belongs wherever the hook
lands, which is `.claude/hooks/` rather than the project's normal script folder.
Co-location is the point: the thing most likely to rot is somebody editing the
hook without noticing it has a test. It is a black-box test, spawning the hook
as a child process and piping it the JSON shape Claude Code actually sends, so
it asserts the guard's real contract with the harness (exit 2 plus an
explanation on stderr) rather than the regexes behind it. That makes it portable
to any project regardless of what the patterns were adapted to; change the rows
of the `CASES` table to match that project's protected paths and nothing else.
**Two collection details to check when adopting it,** because both are silent
when wrong: a test under a dot-directory is picked up by Vitest, which globs
with `dot: true`, but is **not** picked up by `tsc`, whose wildcard include skips
dot-directories, so the project's `tsconfig.json` needs `.claude/**/*.ts` added
to `include` or the table's types go unchecked. Verify both rather than assuming:
the test appearing in the suite's file count, and `tsc --noEmit --listFiles`
naming it.

`db-which.ts` and `db-which.test.ts` are the database identity check: the
sanctioned way to ask "which environment is this checkout pointed at" without
reading `.env` into a transcript, where it sits next to the credentials. Copied from
interplanetary-groups on 31 July 2026, with the expected ref blanked, because
the design is the part worth keeping: a pure parsing core with a
thin CLI wrapper, a cross-check that every env source agrees on one project
ref, an `--expect` flag that proves the check can fail, and a test asserting
the output can never contain a secret. To adapt for a new project, change: the
expected ref constant (confirm the new value against the provider's dashboard,
not against what the script itself prints); the env variable names and their
parsers; the `db:which` npm script wiring; and the CLAUDE.md reference in its
error text.

## Adapt, do not copy blindly

- The `.env` protection is universal. Keep it in every project.
- The migration protection is Prisma-specific and pointless in a project with no
  database. Drop it or replace it with whatever that project's equivalent is.
- The test runner needs a real test suite behind it. A hook that runs a
  nonexistent command is worse than no hook, because it fails on every edit and
  gets disabled.

## Keeping this current

When a project improves one of these in a way that is not specific to that
project, copy the improvement back here so the next project starts from it.
Otherwise this directory drifts into being the oldest version rather than the
best one.

**31 July 2026, from b1-coach PR #9.** Two fixes came back, both found by a code
review of the first project to adopt these files after interplanetary-groups.
The test hook was propagating the suite's exit code, so a failing suite never
reached the agent that broke it and the hook's whole purpose silently did not
work; it now exits 2 with an explanation on stderr. The `.env` patterns were
case-sensitive on a case-insensitive filesystem, so a write to `.ENV.local` went
unblocked and would have clobbered the real secrets file; both the blocked and
the allowed patterns are now case-insensitive. ~~interplanetary-groups still has
both faults and gets its own change.~~ *(Struck 3 August 2026: both were fixed
there that day, in PRs #42 and #44. The sentence is left visible rather than
deleted because it is why the next two entries exist.)*

**3 August 2026, from interplanetary-groups PRs #42 and #44.** The migration
pattern had the identical case-sensitivity fault one line below the `.env` one
that b1-coach found, so `prisma/Migrations/` walked past the guard on a Mac. Both
copies were made case-insensitive together, which is the only reason they are
still byte-identical.

**3 August 2026, from interplanetary-groups, the change after that.** #44's own
review found a bypass easier than the one it had just closed: `prisma//migrations/`
and `prisma/./migrations/` both open the real applied migration and both returned
exit 0, because the patterns can only see literal text. The hook now normalizes
the path's separators and its `.`/`..` segments before matching, which closes
both in one move. It cuts the other way too: a path like
`prisma/migrations/x/../../schema.prisma` writes the schema, which is editable on
purpose, and used to be refused.

**The case fix above is still load-bearing, and do not let anyone tell you
otherwise.** The prediction at the time was that normalizing would make the `/i`
flags redundant. It does not: normalizing collapses separators and segments and
does not touch case. Remove `/i` and every case hole reopens the same day.

**A fourth hole, found by that change's own review, and the reason the test
exists.** `priſma/migrations/x.sql`, with a long s, opens the same inode as the
real applied migration on APFS, because the filesystem compares folded while a
regex compares text. It survived the fix above untouched. The hook now also
folds the path with NFKC; every codepoint to U+2FFFF was then substituted into
each letter of `prisma/migrations` and checked against the real file, and all
eighteen spellings that reach it are refused. **The lesson worth carrying, more
than any of the fixes:** four holes in this one 50-line file, all four found by a
human reading regexes by hand and none by anything automatic. That is why
`protect-paths.test.ts` exists and why it ships alongside the hook rather than
being left in the project that wrote it.

**12 August 2026, from interplanetary-groups PR #64: the test gate split in
two, and the reason is a number.** The owner reported build runs going from
about ninety minutes to between two and four hours. Measured across the session
transcripts, the per-edit round trip had gone from 9-15 seconds in late July to
85 seconds, and 5.6 hours of one build day was spent waiting on it. Nothing had
changed except the suite: 45 test files became 84, and that suite is
network-bound against a remote database. Two plausible causes were tested and
rejected with evidence first (same-session execution, where coordinator context
was flat at 259-296k tokens throughout; and slice size, 7 to 16 tasks with no
trend), which is the part worth copying: the fix was cheap, finding the right
target was not.

Same day, in the same file, a second thing: this template's own
working-directory fix had been made here in the morning and never carried into
the project it came from, so that repo spent the day with a runner that rooted
itself wherever the shell was standing. **A template is only current in the
direction it gets copied**, and this directory had drifted ahead of the project
rather than behind it for once. Check both directions when adopting.

**The same day, from that PR's own review, five findings worth carrying.** All
five are fixed in the files here, and four of them are the same shape: a path
where the gate could report green without having looked. `SubagentStop` alone
missed every main-session edit (see above). An unreadable stamp counted as an
absent one, and absent is the only input allowed to skip. A stamp that could not
be written threw uncaught, exiting 1, where the agent never hears and neither
half of the gate runs. And the "already holding this agent, letting go" path
returned 0 in silence, which reads exactly like a pass. The fifth is a
measurement rather than a bug, and it belongs in any project adopting this:
`vitest related` selects **nothing at all** for a schema file, a stylesheet, or
a file that does not exist yet, and `--passWithNoTests` turns that into a green
exit. Whole categories of file get no per-edit signal, which is survivable only
because the turn-boundary run covers them.

The lesson underneath, and the reason this paragraph is long: every one of the
four was found by a human-shaped reading of the code against its own comments,
and none by a test. The same thing was true of `protect-paths.mjs`, four holes,
all four found by reading. Whatever else changes, keep sending these files to an
independent reviewer.

Two design notes worth keeping, because both are the kind of thing a later
reader would simplify away. The stamp records the time a run **started**, not
finished, so an edit landing mid-run is not swallowed by a run that never saw
it. And `full-suite-on-subagent-stop.mjs` deliberately does **not** block twice:
when the harness reports a stop hook is already holding the agent, it returns 0
rather than 2, because a loop the agent cannot escape is worse than a red suite
reaching the PR gate, where the before-and-after numbers are reported anyway.

**Still open in this template, named so it does not read as complete.** The
PreToolUse matcher in `settings.json` is `Edit|Write|MultiEdit`, so a shell
redirect, `sed -i`, `cp`, or `tee` skips both guards entirely. Adding `Bash` was
considered on 3 August 2026 and **declined, not deferred**: the hook would have
to parse arbitrary shell to find a target path, and a guard that parses shell
badly is worse than an honest gap, because it reads as protection that is not
there. Treat the guard as covering the agent's file-editing tools, not the
filesystem.

## Nothing here tells a project it has fallen behind, so something else has to

**12 August 2026, and the reason it was written that day.** The working-directory
fix above was made in this template in the morning and never carried into the
project it came from, which then ran a broken gate for the rest of the day. There
was nothing to notice: a project's copy and this one drift apart in silence, and
the only moment either gets looked at is the moment one of them fails.

`~/.claude/hooks/safety-net-drift.mjs` runs at session start and says what
differs. It reads only. It never copies, edits, or writes anything into a
project, because deciding to adopt a change is a judgment about that project and
belongs to a person. It reports three things and stays silent otherwise:

- a file here that the project has, changed;
- a file here that the project **does not have at all**, which is usually a
  capability it never picked up and is reported first;
- nothing at all for a file the project has and this template does not, which is
  the project's own business.

**Which files it compares, and where a new one should go.** Every top-level
`.mjs` here, plus its `<name>.test.ts` sibling if there is one. That is discovery
rather than a hand-kept list, because a list would need updating by whoever adds
a file and the whole failure being guarded against is that person forgetting.
`README.md`, `settings.json` and `db-which.*` are not in `.claude/hooks/` and are
not compared; a new file that does belong in a project's hooks folder should
arrive here as a `.mjs`, or it will be invisible to the check.

**Running through `npm test` protects less than it looks like it protects, and
what it does protect can be broken by a stray folder.** Measured in b1-coach on
12 August 2026, standing in `src/`: `npm test` ran all 171 tests while
`npx vitest run` ran 127 and reported green, because npm finds the package root
before running anything. That is real, and it is a fair reason for a project to
adapt this hook to its own test command. Three things go with it, all found the
same day.

- npm climbs to the first ancestor holding a `package.json` **or a
  `node_modules`**. An `npx` run inside a subfolder leaves a `node_modules/.vite`
  cache behind, and from that moment `npm test` in that subfolder stops there and
  dies with ENOENT having run nothing. Verifying the claim above is what created
  the cache that broke it. One had accumulated in this template directory too,
  and the backup's `!templates/**` rule had committed it into git; both removed
  on 13 August 2026, with a `node_modules` ignore rule so it cannot return.
  Assume any folder an `npx` command has run in now has one.
- None of it helps when the shell is standing in a *different project*. npm finds
  that project's root and runs that project's suite, cleanly and greenly, and the
  agent is told its edit is verified.
- So the anchoring and the `npm test` adaptation are not alternatives. A project
  with one still wants the other.

**A difference is never automatically wrong, and the escape hatch is the delicate
part.** B1 Coach's `run-tests-unless-docs.mjs` calls `npm test` rather than the
runner directly, on purpose, so the hook and the project's own test command
cannot disagree. A project records that with

```
node ~/.claude/bin/accept-safety-net-difference.mjs <file> "<reason>"
```

which writes `.claude/safety-net-exceptions.json` in the project and nothing
else. It refuses a difference that does not currently exist and a reason too
short to be read later, because an entry no one can understand in six months is
a silenced warning rather than a recorded decision. Commit that file: the
decision belongs to the project, not to this machine.

**The acceptance is pinned to the version of the template file it was made
against, and this is the load-bearing choice.** It stores that file's hash. When
the file here changes, the acceptance expires and the difference is reported
again with its recorded reason attached, as a decision to re-make against the new
version. A permanent mute would have gone quiet on the morning of 12 August and
stayed quiet all day, which is the exact failure that produced all of this.

**Two limits worth knowing.** Only the template side is pinned, so later edits to
a project's own adapted copy do not re-open an acceptance; pinning both would nag
on every ordinary local change to a file that is meant to differ, and a warning
that is always ignored is the same as no warning. And it compares files, not
registration: a hook sitting in a project that was never wired into
`.claude/settings.json` does nothing, and this check cannot see that.

## Postscript, 13 August 2026: the second message on the letting-go path

The runner-never-started rewording landed in both hooks this morning and missed
one line: the "already holding this agent, letting go" path still said the suite
"is still failing". One file, two vocabularies, and the un-updated one sat on the
worst path for the overclaim, since a runner that never starts exits nonzero,
reaches that branch, and would have told the agent a suite was failing that may
never have run. Found by an independent review during the adoption into
interplanetary-groups, and fixed here first so the adopting project could stay
byte-identical rather than carry a local improvement.

**The fix had to touch the test, and that is the part worth recording.** The
assertion read `toMatch(/still failing/i)`, which pinned the exact framing the
change existed to remove: the message could not be corrected without the test
failing, and the test's own comment says its purpose is that the hook must not
give up *silently*. Asserting a phrase over-specified that purpose. It now
asserts the message is non-empty, which still fails when the message is silenced
(verified by blanking the string and watching it go red) and no longer stands in
the way of the next rewording. The general form, since this is the second time a
message here has been hard to fix: **a test on a human-facing message should
assert that it speaks, not what it says**, unless the wording itself carries a
guarantee somebody depends on.

Both `.mjs` and `.test.ts` changed here, so every adopting project sees drift on
two files rather than one; the check compares test siblings as well as hooks.
