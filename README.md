# ai-build-process

**The rules, checklists and automated guardrails I direct AI coding work under.**

These are the real files. They load into every session on my machine, the hooks in here actually block tool calls, and the templates are copied into new projects at setup. [Interplanetary Groups](https://interplanetarygroups.com) is a live product built under them; its repo is private for now.

---

## How the process works

I'm the product manager on this, not a developer. I don't read the code or the diffs. That is the premise everything here rests on: if I can't check the work by reading it, the process has to check it for me.

**Time goes in before any code exists.** A slice is planned in writing first: what is already settled, what is deliberately not being built and where it belongs instead, how the work will be verified, and what debt it is expected to open.

**Nothing merges until I have checked it myself.** A finished slice opens a pull request and waits there. Merging is mine, after I have manually QA'd it against a short script handed over with the pull request.

The rules in this repo serve those two gates: making a check specific enough to pass or fail, and mechanical wherever a hook can do the remembering instead of a person.

---

## What's here

| | |
|---|---|
| **[CLAUDE.md](CLAUDE.md)** | The working rules. Loads at the start of every session, on every project. States rules rather than explaining them. |
| **[decisions/](decisions/)** | Why each rule exists. **[rule-lineage.md](decisions/rule-lineage.md)** traces each rule back to the failure that produced it. |
| **[hooks/](hooks/)** | The guardrails that mechanically block or check a tool call, with their own tests. |
| **[templates/](templates/)** | Reference implementations copied into new projects: test gates, protection for migrations and environment files, and a script that proves which database a project is pointed at. |
| **[checklists/](checklists/)** | The two procedures worth a file: starting or adopting a project, and handing over a pull request. |
| **[output-styles/](output-styles/)**, **[skills/](skills/)**, **[bin/](bin/)** | How responses are formatted, one custom skill, and the few commands run by hand rather than automatically. |

---

## Four rules that carry most of the weight

**Show it works, do not say it works.** Evidence means test output, a command and its result, a rendered screen. "I could not verify this in a browser" is a complete and useful answer.

**A passing test is only evidence if it could have failed.** Write it first and watch it fail. When one passes on its first run, say why it could have failed. Tests have been found here that could never have failed, no matter what the code did, each of them read as coverage for weeks.

**The context that plans the work is never the context that writes the code.** Planning ends at a go decision that is mine. Then a fresh agent does the work and a separate one reviews it, able to read but not change anything, and treating the first one's report as claims rather than facts.

**Records are append-only.** Corrections land as dated notes rather than edits, so the record shows what happened, including what somebody got wrong first, which is usually the more useful half.

---

## What is deliberately not here

**`settings.json`.** The live one carries a block profiling other projects: their deploy URLs, how their secrets are held, which branches nothing mechanically protects. No credentials, but an operational map of other repositories. The hook wiring it holds is in `hooks/` and the template's README.

**Conversation transcripts, plugin caches, and anything machine-specific.** Those live in the private configuration backup this repo is drawn from.

**Paths are left exactly as written.** References like `~/.claude/hooks/repo-boundary.mjs` point to where these files live on the working machine, and this repo mirrors that layout, so they still point at the right file here.

---

## How this stays current

This is a curated public subset of a private configuration backup. It is generated:

```bash
node tools/sync-from-source.mjs --check   # says whether the copy has fallen behind, changes nothing
node tools/sync-from-source.mjs           # brings it up to date
```

It copies the files across, deletes anything I removed from the original so an old rule can't live on here, and never changes what's inside a file.
