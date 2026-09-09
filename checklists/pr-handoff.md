# PR handoff procedure

Referenced from the QA-script rule in `~/.claude/CLAUDE.md`, which carries the obligation; this file carries the full procedure. Run it every time a PR is opened, unprompted. The lineage (what produced each requirement) is in `~/.claude/decisions/rule-lineage.md`.

## Before the PR is opened: run the production build

- Run the project's real production build, not just the test suite, and put the result in the PR body beside the test numbers.
- Why: the suite and the build are different instruments, and only one of them is what deploys. Vitest does not typecheck; Vercel runs `tsc` during the build. On 4 September 2026 an adopted test file carried 24 TypeScript errors, four consecutive green suites said nothing about them, and three production deploys failed in a row. Production served three-hour-old code throughout, including a fix for a live bug. Vercel emailed on every failure, so the alarm worked; what was missing was any gate before the merge.
- Per PR, not per task. A build on every task-finish would add 20 to 30 seconds to a gate that already costs 71 seconds, to catch a failure class that is rare.
- In a worktree, use the fallback bundler when the project's default refuses a symlinked dependency directory. In interplanetary-groups that means webpack, since Turbopack will not accept a symlinked `node_modules`.
- A red build blocks the PR; it is not a line in the body. If it cannot be fixed, say so in chat rather than opening the PR quietly.

## The script

- A short checklist the product manager can run in about five minutes, never more than ten: exact things to type or click, and what to look for.
- Focus on judgment calls (voice, feel, visual behavior) and on anything automated verification could not honestly reach, with those gaps named explicitly.
- Written in the chat message only, every time, adapted to what the product manager can actually do from his own browser. He does not open the PR, so a second copy there was written for nobody. (Amended 12 August 2026.) The PR body instead carries a four-line "how this was verified" section: test numbers before and after, what was checked by hand, and what could not be checked honestly. That is the part a stranger reading the repo later has any use for.
- He may skip it, but it is proposed every time. It adds a step before the merge signal; it changes nothing about who gives that signal.

## Arrive ready to run

Do not offer to stage state and wait; stage it. Before announcing the PR:

- Seed whatever the checks need, and say plainly what the seeded data is, so a seeding artifact is never mistaken for product behavior.
- Do not start the dev server; give its run command (`npm run dev` or the project's equivalent) in its own fenced `bash` block, which the app turns into a play button. A server left running across branch switches serves stale bundles, which invents bugs that are not in the code. Seeded state does not rot this way, so it stays yours to stage. (Amended 20 August 2026.)
- Put the checklist and every URL the checks touch in the same chat message, as clickable links rather than code blocks. A link is only clickable once the server is up, so say which step starts it.
- **Every URL uses the machine's LAN address, never `localhost`. (Added 21 August 2026.)** Read it fresh at handoff time (`ipconfig getifaddr en0`) rather than reusing the last one, because it is a DHCP lease. One set of LAN links works on both the laptop and the phone, since the Mac reaches its own LAN address; a `localhost` link works on the laptop only. When the address has changed, update the project's allowed dev origins in the same breath, or the phone loads the page while every JS-driven control is dead and CSS-only scrolling still works, which reads exactly like an app bug. Why: for months every QA link handed over was a `localhost` link, so the phone gate silently could not run at all. On a phone `localhost` is the phone. It read as "I can't access this on mobile anymore" across several sessions, and it produced a confident wrong diagnosis: an investigation that measured binding, firewall, origins and the process tree correctly, concluded macOS Local Network permission was blocking it, and blamed a rule change, while the actual defect was in the instructions being handed over rather than in the machine being investigated. (21 August 2026, PR #77.)
- **A deep link to a gated screen assumes the viewing device's own session is a member.** The phone's session is not the laptop's. For anything behind a membership or sign-in wall, the invite or sign-in link is its own numbered step first, and the deep link second. The `a.localhost` sibling-host trick for a fresh logged-out session does not work from a phone either, for the same reason `localhost` does not; the phone equivalent is a private browsing tab. (Added 21 August 2026.)
- Where one browser session cannot cover a step, give the workaround alongside the step instead of waiting to be asked.

## Artifacts and commands

Anything the product manager runs must outlive the session that wrote it and work on his terminal, not just yours.

- Commit it in the repo on the branch. Never hand over a `/tmp`, scratch, or session-scoped path.
- Pin a before-and-after comparison to a commit SHA, not `main`. After the merge `main` holds the change, so the comparison becomes before-and-before: still passing, no longer meaning anything.
- Run it once from another directory before handing it over.
- Keep the shell portable: no `\s` in grep (use `[[:space:]]` or a literal), prefer no filter to a clever one, and say what empty output would mean.
- Why: a scratch-folder QA script was deleted by macOS an hour after handoff, and a `grep -E "^\s+Tests\s"` filter matched nothing in his terminal. Both read as a broken build rather than a broken handoff. (3 August 2026, PRs #43 and #45.)

## Strict sequence

- One link, then the steps that run under that link, then the next link and its steps. Never present a set of links and let the product manager work out the order or which one to open first.
- If a step depends on setup (joining, signing in, creating something), that setup is its own numbered step with its own link, placed before anything that needs it.
- State what the screen should look like on arrival, so a wrong landing spot is caught immediately instead of halfway through the checks.
- Why the sequence is strict: a handoff that lists two links and five steps reads as five steps; it is actually a graph, and the product manager should never have to infer it.
