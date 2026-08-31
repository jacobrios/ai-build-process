# Rules consolidation: settled decisions

Date: 31 July 2026
Scope: `~/.claude/CLAUDE.md`, the project startup checklist, and `~/.claude/templates/project-safety-nets/`

This is a sealed, dated account of the decisions made on 31 July 2026, and it is not extended. Later reasoning about these same rules goes to `rule-lineage.md`, the living record; annotations here correct this account, they do not continue it. (Relationship named 31 July 2026, closing a two-copies gap the length pass created.)

## Why this document exists

On 30 July 2026 several practices that had been running in `~/code/interplanetary-groups` for weeks turned out never to have been written at the user level, so they silently failed to carry into `~/code/b1-coach`. Two audits followed: a Claude Code audit of the interplanetary-groups repo (docs, PR history, `.claude` machinery, and a structural diff against b1-coach), and a read-only inventory of the installed Superpowers plugin. This document records what was decided from both, and why.

The reasoning is the part worth keeping. `CLAUDE.md` line 15 makes stated whys boundaries a session may reason inside of, so a rule whose reasoning lives only in a chat transcript is a rule a future session cannot apply well.

## Evidence and its limits

- The repo audit was performed by four read-only subagents. Counts, PR numbers, and file citations are theirs and were not independently re-verified. Treat as spot-checkable.
- The Superpowers inventory was read from the actual installed files at version 6.1.1 (installed 17 June 2026, updated 28 July 2026). File contents, the hook, and the scripts are high confidence. Claims about how reliably sessions obey the plugin's prose are judgment.
- A separate check of `git log` on interplanetary-groups confirmed nothing currently lands on main outside a PR.
- Line numbers below refer to the version of `~/.claude/CLAUDE.md` as of the morning of 31 July 2026. Verify against text, not line numbers.

---

# Section 1: The Superpowers conflicts

Background finding that shapes all five: **Superpowers enforces almost nothing mechanically.** It ships one hook, which injects text at session start saying skills exist and must be used. Every gate in it, including the ones written as HARD-GATE and Iron Law, is prose a session is persuaded to follow. The two hooks that actually fire on this machine are Jacob's own, from his templates.

That is not a dismissal. The prose is unusually good, built by adversarially testing agents until they stopped finding loopholes, and it intervenes at the moment of temptation in a way a descriptive rule cannot. But it degrades under long sessions and context compaction, and nothing catches it when it does.

The consequence for every conflict below: a rule of Jacob's that requires a session to notice a collision and deviate from what it was just instructed to do is a rule that fails silently and unpredictably. Where the plugin's behavior is acceptable, adopt it. Where it is not, declare a standing preference so the collision never arises.

## Conflict 1: when specs and plans get committed

**Jacob's rule (line 81):** plans stay untracked while planning is in flux, are committed on the slice branch when work begins, and reach GitHub only inside the PR carrying the finished build. Never delete a plan after the work lands. Never open a plan-only PR.

**The plugin:** brainstorming step 6 writes the design doc and commits it immediately, before planning starts, on whatever branch is checked out.

**Partly vocabulary.** Jacob's rule governs plans; the plugin's step governs specs. Any rewrite must say which artifact it covers.

**The real risk was sequencing, not tracking.** "On whatever branch is checked out" means that if brainstorming runs before the slice branch is cut, the plugin commits to main, bypassing the merge gate. Verified: this is not happening. Eight direct commits to main predate PR #2 (scaffold era) and exactly one landed inside the working era (`df6cff0`, docs only, between PR #10 and #12). PRs #37 and #41 are the spec-produced-during-design case and both went through branches. The branch is being cut first.

**Settled:**
1. The slice branch is cut before design work begins. The slice's identity is already known at session start, because line 108 has the previous slice propose what comes next. This single change makes the plugin's default behavior correct rather than contested.
2. Replace "untracked while in flux" with "never on main." The tidiness argument (arguments should leave no trace) weakened when interplanetary-groups moved to true merge commits around PR 35 and began deliberately preserving intermediate history. The thing genuinely worth defending is that nothing reaches main outside a PR, and that was implied rather than stated.
3. Both lessons from the 30 July incident survive untouched: never delete a plan after the work lands, never open a plan-only PR.

## Conflict 2: fresh session versus same session for execution

**Jacob's rule (lines 79 and 80):** a planning session fills its context producing a spec and plan, so hand the plan to a fresh session; end the planning session with a paste-able prompt naming the plan file.

**The plugin:** subagent-driven-development, its recommended engine, executes in the planning session, dispatching a fresh implementer per task and a fresh reviewer per task, with task text and diffs moving as files so neither flows through the coordinating conversation.

**Why the plugin wins on Jacob's own reasoning.** The spark slice evidence proves that fresh context catches what polluted context misses. It does not prove that one fresh session is the right implementation. The plugin produces more fresh contexts, not fewer: one per task rather than one per slice. Jacob's rule yields a clean context that then fills steadily across a long slice.

**Three things the plugin adds that the rule does not:**
- An independent reviewer per task, with a template ordering it to treat the implementer's report as unverified claims. Given that there is no automatic review anywhere in the stack, this engine is the thing that actually produces reviews.
- Crash recovery. A progress ledger on disk means a compacted session does not re-execute finished tasks.
- Cost control. Cheaper models for mechanical subtasks, with review as the net.

**What is lost:** a session boundary is a natural place for Jacob to stop and read before proceeding. Solvable by saying "not yet"; the session persists.

**Verification findings that changed the resolution:**

*The plugin has no plan gate.* `writing-plans` ends by asking "Which approach?", offering subagent-driven or inline execution. That is a choice of engine, not approval of the plan, and a casual "1" starts execution. Once execution begins the engine is told: "Do not pause to check in with your human partner between tasks." The plugin holds a spec gate ("Only proceed once the user approves") and a finish gate (the four-option menu), and nothing between them.

Line 30 already says a full technical plan does not need surfacing for approval by default, so on paper there was never a plan gate. But line 80's session boundary was one in practice: a plan handed to a fresh session cannot begin until Jacob pastes the prompt. Retiring line 80 would have deleted that gate silently.

*Model selection is per dispatch.* No model field exists in the plan format; the coordinator chooses at dispatch time, and both agent templates require an explicit model because an omitted one inherits the session's most expensive. Architecture tasks and the final whole-branch review are exempted from cheapness deliberately.

*Worktrees carry a real gap.* The execution engines invoke `using-git-worktrees`, which creates a second checkout at `.worktrees/<branch>/`, git-ignored, and writes all code there. It runs `npm install` in the new copy, so dependencies are handled. It says nothing about `.env`, and git only carries tracked files, so a fresh worktree has no `.env`: no database connection, and `db:which` has nothing to read. The dev server run from the open folder would show old code. The skill is optional ("If the user declines consent, work in place") and honors a declared preference silently without asking each session.

**Settled, three parts:**
1. The context that plans the work is never the context that writes the code. An execution engine dispatching a fresh agent per task satisfies this. Where no engine exists, hand the plan to a fresh session with a paste-able prompt naming the plan file. Line 80 becomes the fallback clause rather than the standard flow.
2. Before an autonomous multi-task execution run begins, Jacob gets a plain-language summary of what the run covers, what it defers, and roughly what it will cost, and gives an explicit go. This is a start signal, not a plan review; line 30's refusal to surface technical plans stands and gets amended to draw the distinction. This leaves exactly two gates in the flow, both Jacob's and both unmissable: start of execution, and merge.
3. Work in place on the slice branch. No worktrees, as a standing declared preference. Every cost of a worktree lands on the browser QA gate Jacob does not skip.

**Known exception, accepted knowingly:** a concurrent micro-PR (item 8 below) is the one situation where worktree isolation would earn its cost. Concurrent work is rare and the `.env` gap makes worktrees actively worse today, so the preference stands. Revisit if concurrent micro-PRs become common.

**No model rule is being added.** The plugin's per-task selection logic is more granular than any blanket line, and a blanket line would override good judgment in both directions. The Fable-plan-then-Opus-execute workaround is largely obsolete: heavy work runs on explicitly chosen models regardless of the coordinator's. The coordinator still referees on the session model, so that choice is not irrelevant, just no longer determinative of implementation quality.

## Conflict 3: the merge menu

**Jacob's rule (line 109):** open a pull request and stop. Never merge automatically, even for Markdown-only changes.

**The plugin:** `finishing-a-development-branch` presents a fixed four-option menu every time, and option 1 is merge locally to the base branch.

**Why this outranks its apparent severity.** The menu asks, so nothing merges without a yes, and the audit rated it low severity on that basis. Two reasons that undersells it. First, the failure mode is a tired human typing "1" at the end of a long build, which does not respond to better instructions to the agent; it responds to the option not being offered. Second, a local merge skips the PR, and therefore skips the browser QA script, the decision-record entry, and the PR body disclosures all at once. One keystroke bypasses every check in the system.

**The asymmetry:** option 4 (discard) requires typing the word. Option 1, the one that violates the process, requires one character. The menu protects against data loss and not against process loss, which is backwards here, since a discarded branch is far easier to recover than an unreviewed merge is to undo.

**Settled:** amend line 109 to govern what is offered, not only what is done. Where a finish flow presents a menu of ways to end a branch, merging locally is not among the available options and is not presented. The finish is always: open a PR and stop.

**(Not 100% sure, verify)** `using-git-worktrees` is confirmed to honor a declared preference silently. Whether `finishing-a-development-branch` has an equivalent was not checked. Line 15 makes a stated rule sufficient grounds to skip the option and say why, so this is not blocking.

**Noted, no action:** option 4 discards the spec and plan along with the code. Line 81 governs the after-the-work-lands case, so there is no contradiction. Awareness only.

## Conflict 4: review before commit versus before merge

**Jacob's rule (line 83):** a read-only subagent reviews code before it is committed.

**The plugin:** the implementer commits, the reviewer reads the committed diff, and fixes arrive as further commits. Review before merge, not before commit.

**The plugin's timing is better, for an unexpected reason.** Review-before-commit leaves no trace: if it happens nothing in the repo shows it, and if it is skipped nothing shows that either. Review-after-commit leaves a trail in the branch history (implement, review, fix) in that order. That is the "artifacts, not assertions" principle applied to the review itself, and Jacob cannot read the code in those commits but can see they exist.

**Annotation, 31 July 2026, length pass:** the branch-history argument above is retracted. A squash merge erases the implement-review-fix trail, and interplanetary-groups squashed through PR 34, so the trail is sometimes absent through no fault of the process. The PR-body review report was always carrying the enforcement load; the rule now says that and nothing more.

The rest of the rule is already satisfied: the plugin's reviewer is genuinely read-only and is told to distrust the implementer's self-report, and the final whole-branch review is dispatched on the most capable model deliberately.

**The rule was defending the wrong variable.** "Before commit" is a claim about when. What matters is whether it happened and whether Jacob was told. There is no automatic review anywhere in the stack: the plugin's discipline is prose, Jacob's hooks run tests and block protected paths, and Claude Code's own automatic review pass was removed in v2.1.215 (reported by a separate session; not independently verified). Every review received is a session choosing to run one.

**Settled:** rewrite line 83 around evidence rather than timing, and merge it with item 7 below rather than keeping two rules. Code is reviewed by an independent read-only agent before a PR is merged, and the PR body reports what the review found, what was fixed, and what was deliberately not fixed with the reasoning. A PR without that report is not ready to merge.

That last clause is the mechanism. Jacob holds exactly one gate that never degrades, never gets compacted, and never rationalizes: the merge click. Attaching a voluntary practice to it converts prose into enforcement, operated by the one component that does not fail. It costs nothing, because the PR body is already read before clicking.

## Conflict 5: ceremony on trivial changes

**Jacob's rule (line 22):** a genuinely trivial change, such as a one-line copy tweak, needs a one-sentence note, not a walkthrough.

**The plugin:** brainstorming fires before any creative work and explicitly rejects the exception: "A todo list, a single-function utility, a config change" all go through design and approval.

This is the likely explanation for the B1 Coach cold-start fix feeling heavier than it should have in late July 2026.

**Settled:** Jacob's version governs, fenced by an objective test rather than a feel test, and the exception must announce itself.

1. The design gate applies to anything that changes product behavior.
2. It does not apply to copy tweaks, configuration values, or dependency bumps that change no behavior.
3. When the gate is skipped, say so in one line and name which category applies. The exception is declared, never silently taken.

**Reasoning, including the risk being accepted.** The design gate exists to prevent building the wrong thing, and where a change alters no behavior the cost of being wrong is trivially recoverable. But "too simple to need a design" is precisely the rationalization the plugin's text was built to defeat, so the exception must be checkable rather than a judgment about how big something feels. The residual risk is a session judging something trivial when it is not, which Jacob would never see; dependency bumps are the weakest category, since a bump can change behavior and a session cannot always know. Requiring the exception to be declared converts a silent skip into a visible claim Jacob can disagree with, which is the same move used throughout this document.

**Blast radius, for calibration.** Skipping the design conversation does not skip the PR. The change still arrives with a QA script, a PR body, and the merge click on it. The worst case is a small change that was not discussed up front but is still seen and approved before it merges.

**Annotation, 31 July 2026, length pass:** dependency bumps are removed from the skip list. The category was already named the weakest above, and the applying session's pushback stood: a session usually cannot verify that a bump changes no behavior, so listing bumps invited exactly the silent misjudgment the fence was built to prevent. Copy tweaks and configuration values remain.

---

# Section 2: The thirteen audit items, with verdicts

The Superpowers inventory confirmed that almost none of these are redundant. Coverage findings are noted per item.

## To user-level CLAUDE.md

**Item 1: model-behavior verification, and cost disclosure.** Scoped to projects with an LLM call. The suite tests the deterministic interpretation seam and never calls the model; model behavior is verified by named hand-run scripts, and once behavior matters enough to protect, by an eval bench grading realistic cases through the real production path and scoring each as a rate over N runs. A single clean walkthrough is never evidence. A bench built to fix a failure must reproduce that failure first. Bench files must be provably outside the test runner's collection. Baseline and after numbers go in the decision record. Separately: when a model call is added or widened, state its per-unit cost as a product fact and name the spending-ceiling implication as debt.

*Coverage:* confirmed entirely absent from Superpowers, whose testing worldview is wholly deterministic. Found independently by three of four repo auditors. The strongest single item on the list.

**Item 2 (partial): the current-state section as definition of done.** A slice is not complete until the project CLAUDE.md's current-state section is rewritten. The section's skeleton and contents go to the template; only the definition-of-done clause is a user-level rule.

**Item 2b: the two-file division of labor.** The operative rule lives in the always-loaded CLAUDE.md; the reasoning and lineage live in the consulted decision record; CLAUDE.md wins on disagreement. Stated in both files' headers. This exists to stop a future session from "fixing" an apparent duplicate by deleting the wrong copy.

**Item 3: the baseline ledger.** Record the suite count before any code on a branch, cross-checked against the previous slice's recorded finishing number, and name and locate any pre-existing failure so it is carried untouched rather than misattributed or quietly fixed. The PR reports before and after.

*Coverage:* partial. `using-git-worktrees` Step 3 runs the suite before work starts, for exactly this reason. But it asks rather than records, nothing writes the baseline down, and nothing later requires naming pre-existing failures in the PR. **(Not 100% sure, verify)** with worktrees declined, whether that step still runs at all is unclear; the skill says a decline "skips to Step 2," which suggests later steps continue. Either way the recording half is absent.

**Annotation, 31 July 2026, length pass:** the rule now names where the previous slice's finishing number lives, the project's decision record, so the first session to apply it is not guessing where to look. The item as written above left that open; the applying session's pushback stood.

**Items 4 and 9 merged: records are append-only.** QA findings, including decisions not to build something, land as dated postscripts the day they happen. Corrections are dated annotations or strikethroughs, never rewrites. Resolved items are struck through with a date and a pointer, never deleted.

*Coverage:* absent. The plugin has no decision-record concept. Its debt tracking exists only inside a single branch's run, in a git-ignored scratch ledger that dies with the branch. Cross-slice memory is entirely Jacob's.

**Item 5: spec anatomy.** Un-parked after the inventory. Every spec carries: the settled decisions, marked do-not-relitigate; a not-in-this-slice list where each exclusion names where it does belong; how the slice gets verified, written before code; and the debt it is expected to open.

*Coverage:* partial, and the missing parts are exactly these. The plugin requires a spec, self-reviews it, and gives plans a "Global Constraints" header. It has nothing for fencing settled decisions, exclusions with homes, or debt forecast. This cannot be a template file, because Superpowers writes the spec and a template would never be opened. It has to be a rule.

**Item 6: the rule-amendment loop.** When a case shows a standing rule was written too narrowly and the tension is settled, amend the rule's own text with a dated inline note. When a slice's decision invalidates a standing rule, that edit is the slice's first task, because the rules file loads every session.

*Coverage:* absent for Jacob's rules. The plugin applies this discipline rigorously to its own skills and never points it at CLAUDE.md.

**Item 7: PR body conventions.** Merged with conflict 4's resolution. Beyond the QA script: what the review found (count, fixes, and deliberate non-fixes with reasoning), a named section of questions still open for Jacob, and every touch to already-shipped code or to any file the plan never named. A PR missing the review report is not ready to merge.

*Coverage:* confirmed absent. The plugin's finishing skill says nothing whatsoever about PR bodies.

**Item 8: out-of-lane finds.** A find worth fixing gets its own immediate micro-PR, never a ride in the slice's diff. A micro-PR may run concurrent with an open slice PR only when it touches no file the slice touches and the PR body says so. Appended to line 105.

*Coverage:* partial. The plugin prevents the scope creep thoroughly and provides no route for the finding; outside a plan run a spotted problem has no home.

**Item 10: deploy-time obligations.** A slice that creates one (a new environment variable, a migration to apply) appends it to the project's running pre-deploy checklist in the same PR.

*Coverage:* effectively absent. One reviewer-template question about migration strategy, which is a question a reviewer may raise, not a tracked obligation.

**Item 12 (partial): the suite runs green from an empty database.** Tests build their own fixtures. The QA-data bookkeeping mechanics go to the template.

## To the project startup checklist or the safety-nets template

- **Item 2 (main):** the "Where the build is" section skeleton and its contents.
- **Item 4 (mechanics):** debt severity grading, named successors, standing registers, classification against the project's definition of done.
- **Item 11:** a section naming where training-data conventions are actively wrong about this repo, pointing at authoritative local docs. Seeded at project start, extended per slice.
- **Item 12 (mechanics):** what rows QA created, kept only while the PR is open, cleared at merge.
- **Item 13:** load-bearing config carries its rationale inline, and secret protection is two independent layers (the ignore rule and the edit hook), each annotated so neither is "fixed" away.
- **Tier 4:** a committed `.env.example`; a checked-in `.claude/launch.json` with the dev server command and port; commit subjects and PR titles as plain-language prose sentences with no type prefixes, and branches as `type/slug`.

## Action item, not a rule

Copy `scripts/db-which.ts` and its test from interplanetary-groups into `~/.claude/templates/project-safety-nets/`, and point the checklist sentence at the file rather than describing it. The script is a tested design (pure parsing core, thin CLI wrapper, a test asserting the output can never contain a secret, cross-checking that all three env sources agree, and an `--expect wrong-ref` flag to prove the check can fail) and the template holds only the two hooks. This is Jacob's own "copy improvements back to the template" rule going unexercised.

---

# Section 3: Structural changes to `~/.claude/CLAUDE.md`

**Line 12 replaced.** The "roughly 30% technical comprehension" line goes. Fake precision on an undefined scale, and it describes the wrong variable: it understates Jacob on reasoning and product content, where he is a competent and argumentative reader, and overstates him on artifacts, where he is not a partial reader but a non-reader by deliberate choice. Replacement text is settled and appears in the write prompt.

The parallel line in the claude.ai project instructions was already replaced on 31 July 2026.

**Line 30 amended:** distinguish reviewing a technical plan (still not surfaced by default) from authorizing an autonomous execution run (always requires an explicit go, on a plain-language summary).

**Lines 79 and 80 amended** per conflict 2. Line 80 becomes the fallback path for plugin-free projects.

**Line 81 amended** per conflict 1.

**Line 83 rewritten** per conflict 4 and merged with item 7.

**Line 86 deleted.** It parks "build a personal lightweight toolkit instead of depending on Superpowers, revisit once there's a clearer sense of what's needed." The sense now exists, and the answer is no: the one thing the plugin provides that Jacob could not reproduce is precisely the moment-of-temptation prose, built by breaking agents until they stopped finding loopholes. What Jacob should own is the mechanical layer (he already does) and the product layer (the items above). The parenthetical also declares itself not a rule while sitting in a file that loads every session, which is pure cost.

**Line 105 amended.** Its two sentences currently say different things ("one slice lands fully before the next opens" is absolute; "avoid concurrent open PRs touching the same files" is about overlap) with no why stated, so a session picks blind. The binding constraint is not merge conflicts, it is Jacob's attention: he is the only QA gate and the only merge click, and two open slices means two mental models and two browser sessions. State that, and the item 8 exception falls out: a micro-PR costs almost no attention and may run concurrent when disjoint; a second full slice may not, however disjoint.

**Line 109 amended** per conflict 3.

**Line 113 amended.** The adoption audit currently checks for missing safety nets. It should also ask what is in play now that was not when the project was built. B1 Coach is the proof: it acquired a design-before-code gate in June without a single file in the repo changing, because Superpowers is enabled machine-wide.

**Line 122 extended** with the plugin standing state, compressed to a sentence or two: Superpowers is installed once at user level and switched on for every project by the master switch in `~/.claude/settings.json`; to exclude a project, set `superpowers@claude-plugins-official` to false in that project's `.claude/settings.json`, where a project-level false overrides the user-level true (confirmed against the official settings docs, not live-tested). New and adopted repos need no setup to turn it on, only to turn it off. This is what makes line 122's instruction executable: in a project like B1 Coach nothing local tells a session that Superpowers is in play.

**New: worktree standing preference.** Work in place on the slice branch; do not create worktrees. Placed where the plugin arrangement is discussed so the declared preference is found without asking.

**Length pass: the project startup checklist body moves out.** Lines 111 through 122 are twelve bullets, several long, and they fire only at project start or adoption, both perfectly predictable moments. What stays inline is the mode question (throwaway prototype versus production-quality and reviewable), because it decides whether the checklist applies at all, plus one pointer bullet to `~/.claude/checklists/project-startup.md`. The body moves to that file.

The test being applied, worth keeping for future passes: **a rule earns inline space by being unpredictable and cheap. A block that is predictable and expensive becomes one pointer line plus a file.** Line 82 (backing up `~/.claude`) passes: you cannot know at session start that you will edit that directory, so if the rule is not loaded it does not exist when needed, and it is four lines.

**Line 120's hook descriptions move** to a README inside `~/.claude/templates/project-safety-nets/`, next to the actual files. The bullet argues that a rule describing a hook is not a hook, and then describes the hooks at length.

**Repo housekeeping:** `~/.claude` is a git repo tracking only CLAUDE.md, hooks, skills, and templates. The new `decisions/` and `checklists/` folders need to be added to what it tracks, or this document and the checklist will sit outside the backup.

**Annotation, 31 July 2026, length pass:** the file this section produced was correct in substance and too heavy to work, roughly 34,700 characters of forty-odd uniformly dense rules, recreating the attention problem by another route. A second pass the same day moved incident narratives to `decisions/rule-lineage.md` (the durable home for all future lineage), moved the QA handoff procedure to `checklists/pr-handoff.md`, compressed the propose-next-slice rule in place, kept the model-behavior rule inline at full length, and made the three corrections annotated in their own sections above.

---

# Section 4: Deliberately not done

- **No model-selection rule.** See conflict 2.
- **No personal toolkit replacing Superpowers.** See line 86 above.
- **User-level rules the plugin covers are not deleted.** The Superpowers inventory recommended deferring engineering mechanics to the plugin and trimming Jacob's restatements. Correct at project level, where his project CLAUDE.md already does exactly this. Wrong at user level: opt-out exists, so a rule deleted at user level is deleted from opted-out projects too, and the file outlives any one plugin. Line 122's per-project supersession declaration is the right mechanism. The only trims worth making are where Jacob's text describes mechanism the plugin owns, not where it states an obligation to Jacob.
- **No generic quality boilerplate added.** Claude Code ships two system prompts and selects by model family; the lean one drops generic craft instruction ("write clean code"), not tool, permission, or safety machinery. Nothing was globally deleted, and Anthropic has not advised moving behavior instructions into CLAUDE.md; v2.1.206 added a `/doctor` check that proposes trimming it. Re-adding craft boilerplate would be importing cargo cult by hand.
- **The `repo-boundary.mjs` hook is left as-is.** During the inventory session it blocked a write to `~/Desktop` that had been explicitly authorized in the prompt, because the hook cannot hear a conversational yes. The session named the layer as Jacob-built, reported the block, refused to route around it, used a sanctioned alternative, and flagged the calibration gap: lines 94 and 95 executing correctly on a real case. The failure mode cost one extra message and a `cp` command. The alternative is an escape hatch in the one guard protecting everything outside the repos. Revisit if it bites twice more.
- **Not generalized, per the repo audit's own recommendation:** the squash-to-merge-commit shift (deliberate-looking but only six PRs deep and recorded nowhere; record the choice in the project first, promote later if it holds); the enforcement-point registry (the failure class is general and hit twice, but the registry was built once, and if adopted it should trigger when a policy lives in more than one place rather than on day one); leaving QA rows in the dev database as evidence (superseded by the clear-at-merge norm); "demo-critical versus launch" labels (portfolio-MVP-specific); all stack specifics.
- **Discarded as incidents rather than practices,** under the one-occurrence rule: the preserved sealed experiment log, the guardrail-exception documentation pattern, bench numbers appended into a plan file, debt severity labels in PR bodies (dropped after PR 25; the build-notes version is live), and the single post-merge PR comment.

---

# Section 5: Open, deferred, and worth knowing

**Unverified, non-blocking:**
- Whether `finishing-a-development-branch` honors a declared preference the way `using-git-worktrees` does.
- Whether declining a worktree also skips the pre-work baseline test run.
- Whether Claude Code v2.1.215 removed the automatic `/verify` and `/code-review` passes. Reported by a separate session, not independently confirmed. The resolution of conflict 4 does not depend on it.

**Unsettled product question: which mode is B1 Coach in?** Line 111 distinguishes production-quality and reviewable from deliberate throwaway prototype, and the answer decides whether the startup checklist applies there at all. It is currently a finished demo being polished for portfolio use, which argues for the throwaway side and makes the README matter far more than the machinery. Not decided.

**Worth knowing about B1 Coach:** it is currently the weakest configuration available. Superpowers is on there (via the machine-wide master switch, acquired without any file in the repo changing), and the adoption audit found no test suite, no hooks, and no committed reviewer config. All playbook, no machinery. That is a partial second explanation for "things I expected to happen didn't," alongside the practices that never made it to user level.

**Superpowers costs that were accepted, not fixed:**
- A dispatcher tax every session: the injected text and all skill descriptions consume context in every conversation.
- The "1% chance it might apply" threshold actively pulls skills into near-trivial requests. Conflict 5 is the sharp edge of this.
- Brainstorming overlaps the product discovery Jacob deliberately does elsewhere, and nothing in the plugin distinguishes product discovery from technical design. Any fence must be written in Jacob's files.
- Once execution starts the engine is instructed not to check in, by design.

**Revisit triggers:** worktrees, if concurrent micro-PRs become common. The `repo-boundary` hook, if it blocks an authorized write twice more. The merge-method choice, once it has more history behind it.