#!/usr/bin/env node
// PostToolUse hook: after a file edit, run the tests that reach the edited file
// and mark that the full suite still owes this edit a look. A .md edit runs
// nothing, because it cannot change what the code does.
//
// The full suite moved to full-suite-on-subagent-stop.mjs, which runs it once
// when a task's agent finishes. Split on 12 August 2026: running it after every
// edit cost 85 seconds per edit and about five hours of a build day, measured
// across the session transcripts. Narrow-then-whole keeps the same gate at a
// twentieth of the runs.
//
// Exit 2 specifically, not the runner's own exit code. Claude Code only feeds a
// hook's output back to the agent on exit 2; any other nonzero code reaches the
// human while the agent carries on none the wiser.
//
// The runner runs from the project root, never the shell's cwd. Rooted in a
// source folder it finds the few tests under that folder, passes, and reports
// green having run a fraction of what it claimed (measured here: 5 of 801).

import { spawnSync } from "node:child_process"
import { resolveProjectRoot } from "./project-root.mjs"
import { markEdited } from "./suite-stamp.mjs"

function defaultSpawn(cwd, args) {
  return spawnSync("npx", args, { stdio: "inherit", cwd }).status
}

/**
 * The whole decision an edit triggers, with the child process injectable so the
 * tests do not have to run a test suite from inside a test suite.
 */
export function runEdit({
  filePath,
  shellCwd,
  spawn = defaultSpawn,
  mark = markEdited,
}) {
  const path = String(filePath || "")
  if (path.toLowerCase().endsWith(".md")) return 0

  const root = resolveProjectRoot(shellCwd)

  // Marked before the run, and regardless of how the run goes. A narrow pass is
  // not proof the suite is green, and a narrow failure leaves the edit no less
  // unverified, so both owe the full suite a look at the end of the task.
  //
  // If the mark cannot be written, the end-of-task run will never learn this
  // edit happened, so the narrow run would be the only verification it ever
  // got. Widen to the whole suite instead of narrowing, and never let the throw
  // escape: an uncaught one exits 1, which the harness shows the human while
  // the agent carries on unaware.
  let stamped = true
  try {
    mark(root)
  } catch {
    stamped = false
  }

  // With no path there is nothing to narrow to, so fall back to everything.
  const args =
    path && stamped
      ? ["vitest", "related", "--run", "--passWithNoTests", path]
      : ["vitest", "run"]

  return spawn(root, args) === 0 ? 0 : 2
}

function main() {
  let input = ""
  process.stdin.on("data", (chunk) => (input += chunk))
  process.stdin.on("end", () => {
    let data = {}
    try {
      data = JSON.parse(input)
    } catch {
      // Unreadable payload: fall through with no path, which runs everything.
    }

    const code = runEdit({
      filePath: (data && data.tool_input && data.tool_input.file_path) || "",
      shellCwd: data && data.cwd,
    })

    if (code !== 0) {
      console.error(
        "The tests covering this file did not come back clean after the edit. " +
          "Fix them before continuing; the full suite runs when this task " +
          "finishes. If nothing looks broken, check that the runner started at " +
          "all: this same message covers the runner failing to run."
      )
    }

    process.exit(code)
  })
}

// Only listen on stdin when the harness runs this file directly. Importing it
// (as the test file does) must not attach a listener that never resolves.
if (process.argv[1] && process.argv[1].endsWith("run-tests-unless-docs.mjs")) {
  main()
}
