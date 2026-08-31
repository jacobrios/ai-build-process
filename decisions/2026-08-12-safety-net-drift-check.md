# Session-start drift check for the project safety nets

**12 August 2026.** Append-only. Later findings go on the end as dated
postscripts; nothing above gets rewritten.

## What happened, and why anything was built at all

The safety-net template's working-directory fix was made in the morning of 12
August and never carried into the project it came from. That project ran a
broken test gate for the rest of the day. Nobody was careless: there is simply
no moment in the working day when a project's copy of a hook and the template it
came from are looked at side by side. They drift apart in silence, and the first
signal is a gate failing to catch something, which by definition arrives late and
looks like a different problem.

The fix is not more discipline. It is putting the comparison at the one moment
that is guaranteed to happen: the start of every session.

## What was built

A read-only check that runs at session start, compares the current project's
`.claude/hooks/` against `~/.claude/templates/project-safety-nets/`, and prints
what differs, with a command to see each difference and a command to adopt it.
It never copies, edits, or writes anything into a project. When everything
matches it prints nothing at all.

Three cases, deliberately worded differently because they mean different things:
a file the project has but changed; a file the template has that the project does
not have at all, which is usually a capability never picked up and is reported
first; and a file the project has that the template does not, which is not drift
and is never mentioned.

## The decision that mattered: how a project opts out

A difference is not automatically wrong. B1 Coach's copy of the test hook calls
`npm test` rather than the runner directly, on purpose, so the hook and the
project's own test command cannot disagree. Without a way to record that, the
check would report the same file every session until it was ignored, and a
warning that is always ignored is the same as no warning at all. That failure was
the likeliest way this whole thing could end up worthless, so the opt-out got
more thought than the check.

**An acceptance is pinned to the version of the template file it was made
against.** It records that file's hash alongside the reason and the date. When
the template file later changes, the acceptance expires and the difference is
reported again, with the recorded reason shown back, as a decision to re-make
against the new version.

The alternative considered and rejected was a plain "ignore this file" list. It
was rejected because of what it would have done on the day that produced this:
gone quiet on the morning of 12 August and stayed quiet all day, hiding the exact
fix it existed to surface. An escape hatch that can permanently hide a template
improvement rebuilds the original problem inside the thing meant to solve it.

Recording an acceptance is a separate hand-run command rather than a flag on the
check, and it refuses two things: a difference that does not currently exist, and
a reason too short to be read later. That is what makes "accepted" mean a person
looked at the diff and decided, rather than a warning got turned off.

**Only the template side is pinned.** Later edits to a project's own adapted copy
do not re-open the acceptance. Pinning both was considered and rejected: it would
warn on every ordinary local change to a file that is meant to differ, which is
the ignored-warning failure again, arriving from the other direction.

## What it cost, and what it does not cover

It reads about nine small files and hashes a few of them, every session. Not
measurable next to session start.

Two honest gaps, both named in the template README so they do not read as
oversights. It compares files, not registration: a hook present in a project but
never wired into `.claude/settings.json` does nothing, and this check cannot see
that. And comparison is exact bytes, so a whitespace-only difference is reported;
that costs one `diff` to dismiss, and the alternative is the check deciding on
its own which differences are cosmetic.

## Evidence

39 assertions in `~/.claude/hooks/tests/test-safety-net-drift.sh`, all passing,
building every fixture fresh in a temp directory so the suite says the same thing
on a machine that has never seen these projects. Passing on the first run is not
evidence, so five deliberately broken copies were run through the same suite: the
hash pinning removed (2 failures), project-only files treated as drift (1),
missing files not reported first (3), the reason-length rule dropped (2), and a
syntax break (16). Every distinctive assertion was shown able to fail.

The founding scenario was then re-enacted end to end against a copy of the real
template: a project matching it was silent, one line was added to the template's
`project-root.mjs`, and the next run reported it. The accepted-difference path was
run with B1 Coach's real adapted hook file, in a stand-in project so that nothing
was written into B1 Coach: reported, accepted with a reason, silent, then
reported again with the reason shown back once the template moved underneath it.

Against the real projects at the time of writing: interplanetary-groups silent,
uigen and math-game silent (they never adopted the nets), b1-coach reporting six
files it does not have and three that differ, interplanetary-groups-oneshot
similar. Those reports are correct and are the point; b1-coach was mid-edit by
another session while this ran, so its exact count moves.

## Postscripts

*(none yet)*
