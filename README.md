# ai-build-process

**The rules, checklists and automated guardrails I direct AI coding work under.**

These are the real files, not a writeup about them. They load into every session on my machine, the hooks in here actually block tool calls, and the templates are copied into new projects at setup. [Interplanetary Groups](https://github.com/jacobrios/interplanetary-groups) is a live product built under them.

---

## The premise

I own the product and direct the build, and the work is done with AI assistance. That changes what the hard part is. Producing code stopped being the constraint. Knowing whether what came back is correct, and whether the report describing it is true, became the constraint.

Almost everything here answers that. Not "how do I get more code out of a model," but: how do I know it worked, what stops a plausible-sounding report from passing as a verified one, and what gets caught mechanically rather than by remembering to look.

---

## What's here

| | |
|---|---|
| **[CLAUDE.md](CLAUDE.md)** | The working rules. Loads at the start of every session, on every project. Written to be operative, so it states rules rather than explaining them. |
| **[decisions/](decisions/)** | Why each rule exists. **[rule-lineage.md](decisions/rule-lineage.md)** is the deep one: rules traced back to the failure that produced them. |
| **[hooks/](hooks/)** | The guardrails that mechanically block or check a tool call, with their own tests. This is the difference between a rule and a wish. |
| **[templates/](templates/)** | Reference implementations copied into new projects: test gates, protection for migrations and environment files, and a script that proves which database a checkout is pointed at. |
| **[checklists/](checklists/)** | The two procedures predictable and expensive enough to earn a file: starting or adopting a project, and handing over a pull request. |
| **[output-styles/](output-styles/)**, **[skills/](skills/)**, **[bin/](bin/)** | How responses are formatted, one custom skill, and the few commands run by hand rather than by the harness. |

`CLAUDE.md` opens by saying I do not read code, and that this is a deliberate arrangement rather than a gap. That is the load-bearing premise. It is why the verification and disclosure rules are shaped the way they are, and why "it works" is never an acceptable answer on its own.

---

## Four rules that carry most of the weight

**Show it works, do not say it works.** A self-report is a claim, not a fact. Evidence means test output, a command and its result, a rendered screen. "I could not verify this in a browser" is a complete and useful answer. A confident claim that turns out untrue costs more than an admitted gap, every time.

**A passing test is only evidence if it could have failed.** Write it first and watch it fail. When one passes on its first run, say why it could have failed. This rule earned its place: tests have been found here that structurally could not fail, each of which had been read as coverage for weeks.

**The context that plans the work is never the context that writes it.** Planning ends at a go decision that is mine. Then a fresh agent implements each task and an independent agent reviews it, one that can read but not write, and that treats the implementer's report as unverified claims.

**Records are append-only.** Corrections land as dated annotations rather than edits. A rewritable record shows what a file currently claims. An append-only one shows what happened, including what somebody got wrong first, which is usually the more useful half.

---

## What is deliberately not here

**`settings.json`.** The live one carries a block profiling other projects: their deploy URLs, how their secrets are held, which branches nothing mechanically protects. No credentials, but an operational map of repositories this artifact has no business describing. The hook wiring it holds is described in `hooks/` and in the template's own README instead.

**Conversation transcripts, plugin caches, and anything machine-specific.** Those live in the private configuration backup this repo is drawn from, and most of them do not belong in a backup either.

**Paths are left exactly as written.** References like `~/.claude/hooks/repo-boundary.mjs` are true statements about where these files live on the working machine, and this repo mirrors that layout, so they resolve here too. Rewriting them would make the public copy differ from the working one for no gain.

---

## How this stays current

This is a curated public subset of a private configuration backup, so a hand-copied version would go stale the moment the real file changed. It is generated instead:

```bash
node tools/sync-from-source.mjs --check   # exits nonzero if out of date, writes nothing
node tools/sync-from-source.mjs           # applies
```

It copies the tracked file set, propagates deletions so a rule removed upstream cannot survive here, and never rewrites file contents. Updating is one command rather than something to remember.
