# Project startup checklist

The user-level `CLAUDE.md` decides when this file runs and which projects pay for it: it fires at new-project start and at adoption of an existing project, and only for builds meant to be production-quality and reviewable. If you are reading this, the mode question is already answered. Where this file and `CLAUDE.md` disagree, `CLAUDE.md` wins; this file carries the mechanics, that file carries the rules.

Moved out of `CLAUDE.md` on 31 July 2026 because it fires only at predictable moments; the operative pointer stays there.

---

## The checklist

- **CLAUDE.md written before the first line of code.** This is the project-level file: stack, architecture conventions, and standing product rules specific to this project. It gets seeded from the initial scoping conversation, not written blind mid-build. Its skeleton is below.
- **If the project talks to a database or any external environment, create a `db:which`-style identity script on day one.** Start from `~/.claude/templates/project-safety-nets/db-which.ts` and its test rather than rebuilding it from prose; the README there lists what to adapt. Why the script must exist: the global guard rightly blocks reading env files into a transcript, so without a sanctioned way to ask "which environment am I pointed at," that safety check silently gets skipped instead of performed. First built in interplanetary-groups, 28 July 2026.
- **If the project has a database, the test suite points at one on this machine, from the first slice.** A remote one is a deliberate, recorded exception, never the default. Why: a past project deferred this on day one, felt fine for two months, then lost 5.6 hours of a single build day to it.
- **Git from day one, deliberate commit history.**
- **Permissions need nothing added per project.** The routine allow-list in `~/.claude/settings.json` already covers every repo; merges, pushes, deletes and deploys still prompt by design. A new repo that asks about ordinary commands is missing an auto-mode profile, not permissions: run `/auto-mode-setup` in it. (Why: "Allow once" never persists, and "Always allow" saves only into that one project, so grants never accumulate.)
- **Test suite set up early, and verified as a reliable signal before it's trusted.** Why: a test that passes for the wrong reason (misconfigured, or trivially true regardless of the code underneath) is worse than no test, since it creates false confidence that something works when it hasn't actually been checked.
- **Read-only subagent code reviewer wired in, config checked into the repo, and PostToolUse/PreToolUse hooks for tests and migration protection** (see the safety nets in `CLAUDE.md`).
- **Copy the safety nets from `~/.claude/templates/project-safety-nets/` rather than rebuilding them from a description.** The README there says what each file does, when it fires, and what to adapt per project. Why: a rule describing a hook is not a hook, and rebuilding one from prose reintroduces every edge case the working version already handles. When a project improves one of these in a way that is not project-specific, copy the improvement back to the template.
- **At project start, name which plugins are in play and what they supersede.** If a plugin (Superpowers, or anything similar) owns part of the process the user-level file also covers, say so in the project's CLAUDE.md and follow the plugin's version there. Do not silently reconcile two sets of process rules. If no plugin is in play, the safety nets are yours to build. Remember the standing state recorded in `CLAUDE.md`: Superpowers is on machine-wide by default, and nothing inside a repo says so.
- **Verify the safety nets exist as files, not as intentions.** Show the hook configs and the reviewer config once they're set up, and alongside each one, say in plain language what it protects against and when it fires. Why: a rules file states requirements, it does not create machinery, and the product manager cannot tell the difference from outside. Seeing the file proves it exists; the plain-language note is what lets him tell whether it's the right one.
- **If the project will have designs made in Claude Design, paste `~/.claude/templates/design-board-rules.md` into that design project's instructions.** Claude Design reads nothing from this machine, so board backdrop and chrome rules have to be pasted per design project or they are not in play at all.
- **Conventions from day one:** a committed `.env.example`; a checked-in `.claude/launch.json` with the dev server command and port; commit subjects and PR titles written as plain-language prose sentences with no type prefixes; branches named `type/slug`.

*(The old "if the same issue recurs, write the solution into CLAUDE.md" bullet moved to the user-level rule-amendment rule on 31 July 2026; it fires at unpredictable moments and did not belong in a file only opened at project start.)*

---

## The project CLAUDE.md skeleton

The header carries the two-file division of labor, stated in both files: the project CLAUDE.md holds the rule in operative form, the decision record holds the reasoning, the rejected alternatives, and the lineage, and CLAUDE.md wins where they disagree. The header also names the decision record file and which plugins are in play.

**The "Where the build is" section.** Copied structurally from interplanetary-groups (31 July 2026), stripped of its product content. It opens with this standing note, kept verbatim because it explains the section to every future session:

> *Rewritten at each slice boundary. It lives here, not in the decision record, because it churns every slice and must load every session.*

Then, in order:

1. **One bold-led paragraph per shipped area**, each a product-language claim about what works end to end, stated so it could be checked ("navigation is built app-wide, and there are no dead ends left"), with the how compressed and pointers into the decision record for reasoning and evidence.
2. **"Next slice: [name]."** What it is, and the open questions to settle before it can be spec'd, each phrased as a product decision rather than a technical unknown.
3. **"Settled and not open, carried forward:"** the decisions the next slice must not relitigate, with a pointer to where each was decided.
4. **Queued and guardrail items:** anything spotted and deliberately deferred ("queued from QA," "written as a guardrail, not built"), each naming why it waits and where its open questions live.
5. **"Still missing, and known:"** the honest gaps, so absence reads as a decision rather than an oversight.

Rewriting this section is part of every slice's definition of done (the user-level rule). Stripped from the copied original: everything specific to interplanetary-groups (the product areas, the model behaviors, the named slices); the structure and the italic note are what generalize.

**Other sections seeded at start, extended per slice:**

- **Stack realities: where training-data conventions are actively wrong about this repo.** Name each place an agent's confident memory of an older API or pattern would ship a bug, and point at the authoritative local docs to read instead. Why: stale convention reads exactly like knowledge until it fails.
- **Load-bearing config carries its rationale inline.** A config line that exists for a reason states the reason next to itself. Secret protection is two independent layers, the ignore rule and the edit hook, each annotated so neither gets "fixed" away by a session that only sees one of them.

---

## Decision record mechanics

Set up the project's decision record to carry, from the start:

- **Debt entries graded by severity, each with a named successor:** the slice or pass where the debt gets paid, so no entry is an orphan.
- **Standing registers for recurring categories** (a visual feel-pass register, a running pre-deploy checklist that slices append their deploy-time obligations to).
- **Classification of entries against the project's definition of done,** so "known and accepted for launch" is distinguishable from "blocks done."
- The append-only discipline is the user-level rule; it is not restated here.

---

## QA data bookkeeping

The PR or its chat handoff records what rows QA created. The record is kept only while the PR is open, and the rows are cleared at merge. Why: seeded QA data left behind reads as product behavior to the next session, and a QA record that outlives its PR is clutter pretending to be history.
