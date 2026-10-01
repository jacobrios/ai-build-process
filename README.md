# ai-build-process

**The rules, checklists and automated guardrails I direct AI coding work under.**

These are the real files. They load into every session on my machine, the hooks in here actually block tool calls, and the templates are copied into new projects at setup. For example, [Interplanetary Groups](https://interplanetarygroups.com) is a live product built under them, and [its repo](https://github.com/jacobrios/interplanetary-groups) is public.

---

## How the process works

I'm the product manager on this, not a developer. I don't read the code or the diffs. That is the premise everything here rests on: if I can't check the work by reading it, the process has to check it for me.

**Time goes in before any code exists.** A slice is planned in writing first: what is already settled, what is deliberately not being built and where it belongs instead, how the work will be verified, and what debt it is expected to open.

**Nothing merges until I say so.** A finished slice opens a pull request and waits there. Every pull request comes with a short QA script for me, and in practice I run it before nearly every merge. The merge is always my call.

The rules in this repo serve those two gates: making a check specific enough to pass or fail, and mechanical wherever a hook can do the remembering instead of a person.

---

## What's here

| | |
|---|---|
| **[CLAUDE.md](CLAUDE.md)** | The working rules. Loads at the start of every session, on every project. States rules rather than explaining them. |
| **[decisions/](decisions/)** | Why each rule exists. **[rule-lineage.md](decisions/rule-lineage.md)** traces many rules back to the failure that produced them; others came from audits or outside guidance. |
| **[hooks/](hooks/)** | The guardrails that mechanically block or check a tool call, with their own tests. |
| **[templates/](templates/)** | Reference implementations copied into new projects: test gates, protection for migrations and environment files, and a script that proves which database a project is pointed at. |
| **[checklists/](checklists/)** | The two procedures worth a file: starting or adopting a project, and handing over a pull request. |
| **[output-styles/](output-styles/)**, **[skills/](skills/)**, **[bin/](bin/)** | How responses are formatted, one custom skill, and the few commands run by hand rather than automatically. |
| **[tools/](tools/)** | The script that brings the mirrored files here across from my private configuration, its tests, and the list of lines its privacy scan has been told are fine to publish. |

---

## Four rules that carry most of the weight

**Show it works, do not say it works.** Evidence means test output, a command and its result, a rendered screen. "I could not verify this in a browser" is a complete and useful answer.

**A passing test is only evidence if it could have failed.** Write it first and watch it fail. When one passes on its first run, say why it could have failed. Tests have been found here that could never have failed, no matter what the code did, each of them read as coverage for weeks.

**The context that plans the work is never the context that writes the code.** Planning ends at a go decision that is mine. Then a fresh agent does the work and a separate one reviews it, able to read but not change anything, and treating the first one's report as claims rather than facts.

**Records are append-only.** Corrections land as dated notes rather than edits, so the record shows what happened, including what somebody got wrong first, which is usually the more useful half.

---

## What is deliberately not here

**`settings.json`, and the decision record explaining it.** The live configuration carries a block profiling other projects: their deploy URLs, how their secrets are held, which branches nothing mechanically protects. No credentials, but an operational map of other repositories. `decisions/access-protections.md`, which is the reasoning behind that configuration, is held back for the same reason: it is that map again, in more readable prose. Not because it admits the guards have gaps. Each hook here documents its own limits in its own header, deliberately, and a guard whose weaknesses are only in the author's head is worth less than one whose weaknesses are written down. What that record adds is aggregation: every gap, every permission, and every repository in one place, which is a different object from any one of them. Other files here point at it by name; those links resolve on the working machine and not in this copy. The hook wiring it holds is in `hooks/` and the template's README.

**Passages I've marked private, inside files that are otherwise here.** As of this writing they are all in `decisions/rule-lineage.md`. Dropping a whole document to hide a paragraph would have cost the document, so the passage is left out and a notice sits in its place: *(Withheld from the public mirror: the reason)*. If you meet one, that is all it means. Something was left out on purpose, and the notice says why.

**Conversation transcripts, plugin caches, and anything machine-specific.** Those live in the private configuration backup this repo is drawn from.

**Paths are left exactly as written.** References like `~/.claude/hooks/repo-boundary.mjs` point to where these files live on the working machine, and this repo mirrors that layout, so they still point at the right file here.

---

## How this stays current

This is a curated public subset of a private configuration backup. It is generated:

```bash
node tools/sync-from-source.mjs --check   # says whether the copy has fallen behind, changes nothing
node tools/sync-from-source.mjs           # brings it up to date
```

It copies the files across and deletes anything I removed from the original so an old rule can't live on here. It never rewrites what a file says. Inside a file, the one thing it takes out is a passage I've marked private in the original, and it replaces each one with a visible notice giving the reason.
