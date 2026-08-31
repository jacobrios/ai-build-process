#!/usr/bin/env node
// SubagentStop and Stop hook: run the whole suite once, when a task's agent or
// the main session's turn finishes, and only when an edit is waiting for it.
//
// Registered for BOTH events, and the file keeps its name for the event that
// prompted it. SubagentStop alone was the first version, and it left every edit
// made outside a task agent with no full-suite run at all: a narrow run and
// then nothing, which is a real class of work here (micro-PRs, one-line fixes,
// post-review corrections). Found by PR #64's own review. A turn that edited
// nothing still exits in about a fifth of a second, so the cost of covering
// both is only paid by turns that changed code.
//
// The 600-second timeout in settings.json is deliberate. A timed-out PostToolUse
// hook is visible, because the human sees the warning; a timed-out stop hook is
// invisible and self-perpetuating, since the run never finishes, the stamp is
// never cleared, and every later finish times out identically. The gate would
// be dead with no symptom. The suite is 83 seconds today and the queued §8
// database item names three minutes as its own trigger, so the ceiling is set
// far above both rather than near either.
//
// This is the other half of the split made on 12 August 2026. The per-edit hook
// runs only the tests that reach the edited file, which is fast but cannot see
// a break in a file the edited one never imports. This is what sees that, and
// it runs about twenty times a slice instead of two hundred.
//
// An agent that edited nothing (a reviewer, an explorer) finishes without
// paying for a suite run it cannot have broken. Every other case runs; see
// suite-stamp.mjs for why the ambiguous ones resolve that way.
//
// Exit 2 specifically, same contract as the per-edit hook: it is the only code
// Claude Code feeds back to the agent, so it is the only one that puts a red
// suite in front of the thing that turned it red.

import { spawnSync } from "node:child_process"
import { resolveProjectRoot } from "./project-root.mjs"
import { needsFullRun, recordFullRun } from "./suite-stamp.mjs"

function defaultSpawn(cwd, args) {
  return spawnSync("npx", args, { stdio: "inherit", cwd }).status
}

/**
 * The whole decision a finishing agent triggers, with the child process and the
 * clock injectable so the tests neither run a suite inside a suite nor wait on
 * real time.
 */
export function runStop({
  shellCwd,
  spawn = defaultSpawn,
  now = Date.now,
  stopHookActive = false,
  warn = console.error,
}) {
  const root = resolveProjectRoot(shellCwd)
  if (!needsFullRun(root)) return 0

  // Stamped with the time the run STARTED, not the time it finished: an edit
  // landing while the suite was running is not covered by that run, and the
  // finish time would swallow it.
  const startedAt = now()
  const status = spawn(root, ["vitest", "run"])

  if (status === 0) {
    recordFullRun(root, startedAt)
    return 0
  }

  // The harness is already holding this agent open on account of a stop hook.
  // Blocking again risks a loop it cannot escape, so the debt stays on the
  // stamp and the PR gate becomes the backstop: the suite's before and after
  // numbers go in the PR body either way.
  //
  // Said out loud rather than returned quietly. Exit 0 with nothing printed is
  // indistinguishable from a green suite, and this path is reachable in
  // ordinary use, since the suite is database-backed and has flaked before.
  if (stopHookActive) {
    warn(
      "The full suite still did not come back clean, and this gate has already " +
        "held this agent once, so it is letting go rather than looping. The " +
        "debt stays on the stamp and the next task finish will run it again. " +
        "If nothing looks broken, check that the runner started at all: this " +
        "same message covers the runner failing to run."
    )
    return 0
  }

  return 2
}

function main() {
  let input = ""
  process.stdin.on("data", (chunk) => (input += chunk))
  process.stdin.on("end", () => {
    let data = {}
    try {
      data = JSON.parse(input)
    } catch {
      // Unreadable payload: fall through, which runs the suite if one is owed.
    }

    const code = runStop({
      shellCwd: data && data.cwd,
      stopHookActive: Boolean(data && data.stop_hook_active),
    })

    if (code !== 0) {
      console.error(
        "The full suite did not come back clean. The narrow per-edit runs did " +
          "not cover this, which is what this gate is for. Fix it before " +
          "finishing the task. If nothing looks broken, check that the runner " +
          "started at all: this same message covers the runner failing to run."
      )
    }

    process.exit(code)
  })
}

// Only listen on stdin when the harness runs this file directly. Importing it
// (as the test file does) must not attach a listener that never resolves.
if (process.argv[1] && process.argv[1].endsWith("full-suite-on-subagent-stop.mjs")) {
  main()
}
