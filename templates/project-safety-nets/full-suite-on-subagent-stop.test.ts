// The per-task half of the test gate. The per-edit hook now runs only the tests
// that reach the edited file, so this is where the whole suite runs: once, when
// a task's agent finishes, and only when an edit is actually waiting for it.
//
// The reason this hook exists at all is that a narrow run cannot see a break in
// a file the edited one never imports. Skipping when nothing is waiting is what
// keeps reviewers and explorers free; skipping when something IS waiting would
// be a gate reporting green without doing its job.
//
// The child process and the clock are the two injected seams. Running a real
// suite from inside a suite is not something a test should do, and a test that
// waits on the real clock is a test that fails on a slow machine.

import { mkdtempSync, writeFileSync, realpathSync, rmSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { runStop } from "./full-suite-on-subagent-stop.mjs"
import { markEdited, needsFullRun, stampPaths } from "./suite-stamp.mjs"

const HOOK = fileURLToPath(
  new URL("./full-suite-on-subagent-stop.mjs", import.meta.url)
)

const cleanup: string[] = []

/**
 * The default for every case that is not about the database: behave as a
 * project with nothing to probe. Without it these cases would spawn the real
 * probe and stay off the database only because a temp folder cannot find pg.
 */
const skip = () => ({ status: "skipped" })

/**
 * A throwaway project with its stamps registered for cleanup.
 *
 * CLAUDE_PROJECT_DIR is pinned to it deliberately. The suite runs inside a real
 * session, so that variable is already set to THIS repo, and without the pin
 * every case below would read and write the live project's stamp instead of its
 * own: the tests would drive the gate they are supposed to be testing.
 */
function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "stop-hook-")))
  writeFileSync(join(root, "package.json"), "{}")
  process.env.CLAUDE_PROJECT_DIR = root
  cleanup.push(...Object.values(stampPaths(root)), root)
  return root
}

/** A stand-in for the child process, recording what it was asked to run. */
function fakeRunner(status = 0, onRun?: () => void) {
  const calls: { cwd: string; args: string[] }[] = []
  const spawn = (cwd: string, args: string[]) => {
    calls.push({ cwd, args })
    onRun?.()
    return status
  }
  return { spawn, calls }
}

/** A clock that moves on every read, so start and finish are tellable apart. */
function clock(...times: number[]) {
  let i = 0
  return () => times[Math.min(i++, times.length - 1)]
}

const savedEnv = process.env.CLAUDE_PROJECT_DIR
afterEach(() => {
  if (savedEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR
  else process.env.CLAUDE_PROJECT_DIR = savedEnv
  for (const f of cleanup.splice(0)) rmSync(f, { recursive: true, force: true })
})

describe("when no edit is waiting", () => {
  it("runs nothing, so a reviewer or explorer finishes free", () => {
    const root = project()
    const runner = fakeRunner()
    const code = runStop({ probe: skip, shellCwd: root, spawn: runner.spawn })
    expect(code).toBe(0)
    expect(runner.calls).toHaveLength(0)
  })
})

describe("when an edit is waiting", () => {
  it("runs the whole suite, which is what a narrow run could not cover", () => {
    const root = project()
    markEdited(root, 1_000)
    const runner = fakeRunner()
    runStop({ probe: skip, shellCwd: root, spawn: runner.spawn, now: clock(2_000) })

    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0].args).toEqual(["vitest", "run"])
    expect(runner.calls[0].cwd).toBe(root)
  })

  it("clears the debt once the suite has run green", () => {
    const root = project()
    markEdited(root, 1_000)
    runStop({ probe: skip, shellCwd: root, spawn: fakeRunner().spawn, now: clock(2_000) })
    expect(needsFullRun(root)).toBe(false)
  })

  it("keeps the debt when the suite failed, so the next finish runs it again", () => {
    const root = project()
    markEdited(root, 1_000)
    const code = runStop({ probe: skip,
      shellCwd: root,
      spawn: fakeRunner(1).spawn,
      now: clock(2_000),
    })
    expect(code).toBe(2)
    expect(needsFullRun(root)).toBe(true)
  })

  it("counts an edit made while the suite was running as still unverified", () => {
    // The run has to be stamped with the time it STARTED. Stamped with the time
    // it finished, an edit landing mid-run would look already covered by a run
    // that never saw it.
    const root = project()
    markEdited(root, 1_000)
    const midRunEdit = () => markEdited(root, 3_000)
    runStop({ probe: skip,
      shellCwd: root,
      spawn: fakeRunner(0, midRunEdit).spawn,
      now: clock(2_000, 4_000),
    })
    expect(needsFullRun(root)).toBe(true)
  })
})

describe("when the harness says a stop hook is already holding this agent", () => {
  it("does not block a second time, because a loop it cannot escape is worse", () => {
    // A suite the agent cannot fix would otherwise hold it forever. The PR gate
    // is the backstop: the suite's before and after numbers go in the PR body.
    const root = project()
    markEdited(root, 1_000)
    const code = runStop({ probe: skip,
      shellCwd: root,
      spawn: fakeRunner(1).spawn,
      now: clock(2_000),
      stopHookActive: true,
    })
    expect(code).toBe(0)
  })

  it("says so out loud, because giving up quietly looks the same as passing", () => {
    // Exit 0 with nothing printed is indistinguishable from a green suite, to
    // the agent and to the human both. This path is reachable in ordinary use:
    // the suite is database-backed and has already flaked once.
    const root = project()
    markEdited(root, 1_000)
    const said: string[] = []
    runStop({ probe: skip,
      shellCwd: root,
      spawn: fakeRunner(1).spawn,
      now: clock(2_000),
      stopHookActive: true,
      warn: (message: string) => said.push(message),
    })
    // Asserts that it speaks, not what it says. The test's whole point is that
    // silence here is indistinguishable from success, and a phrase-matching
    // regex pins wording the message is expected to outgrow: this assertion
    // previously required the words "still failing", which is the exact framing
    // the runner-never-started fix had to remove from this file.
    expect(said.join(" ").trim().length).toBeGreaterThan(0)
  })

  it("keeps the debt when it gives up, so the next finish tries again", () => {
    const root = project()
    markEdited(root, 1_000)
    runStop({ probe: skip,
      shellCwd: root,
      spawn: fakeRunner(1).spawn,
      now: clock(2_000),
      stopHookActive: true,
    })
    expect(needsFullRun(root)).toBe(true)
  })
})

describe("the harness contract", () => {
  it("exits 0 when nothing is waiting, driven exactly as Claude Code drives it", () => {
    const root = project()
    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        hook_event_name: "SubagentStop",
        cwd: root,
        stop_hook_active: false,
      }),
      encoding: "utf8",
    })
    expect(result.status).toBe(0)
  })
})

describe("when the database does not answer", () => {
  // Written 23 Sept 2026, after a paused dev-test database came back with its
  // connection pooler refusing logins. Every turn that ended with an edit owed
  // then ran the whole suite anyway, about three hundred failed logins a time,
  // which is plausibly what kept the pooler's lockout alive: the gate was
  // feeding the outage it was reporting, and printing a 295-failure wall that
  // said nothing new after the first. These cases hold the three things that
  // fix it: the suite is not run, the owed edit is not forgiven, and the agent
  // is told once per outage rather than once per turn.
  const down = () => ({ status: "down", code: "ECIRCUITBREAKER" })
  const up = () => ({ status: "ok" })

  it("does not run the suite", () => {
    const root = project()
    markEdited(root, 1_000)
    const runner = fakeRunner()
    runStop({ shellCwd: root, spawn: runner.spawn, probe: down, warn: () => {} })
    expect(runner.calls).toHaveLength(0)
  })

  it("never counts the outage as a pass: the edit is still owed a run", () => {
    const root = project()
    markEdited(root, 1_000)
    runStop({ shellCwd: root, spawn: fakeRunner().spawn, probe: down, warn: () => {} })
    expect(needsFullRun(root)).toBe(true)
  })

  it("tells the agent once, in one line, with the error code, and blocks", () => {
    const root = project()
    markEdited(root, 1_000)
    const said: string[] = []
    const code = runStop({
      shellCwd: root,
      spawn: fakeRunner().spawn,
      probe: down,
      warn: (m: string) => said.push(m),
    })
    expect(code).toBe(2)
    expect(said).toHaveLength(1)
    expect(said[0]).toMatch(/database unreachable/i)
    expect(said[0]).toMatch(/ECIRCUITBREAKER/)
    expect(said[0]).not.toMatch(/\n/)
  })

  it("stays silent and does not block on later turns of the same outage", () => {
    const root = project()
    markEdited(root, 1_000)
    runStop({ shellCwd: root, spawn: fakeRunner().spawn, probe: down, warn: () => {} })
    markEdited(root) // another edit during the outage, on the real clock, so a run is owed either way
    const said: string[] = []
    const runner = fakeRunner()
    const code = runStop({
      shellCwd: root,
      spawn: runner.spawn,
      probe: down,
      warn: (m: string) => said.push(m),
    })
    expect(code).toBe(0)
    expect(said).toHaveLength(0)
    expect(runner.calls).toHaveLength(0)
  })

  it("does not spend the announcement on a turn the harness is already holding", () => {
    // Exit 2 is the only code the agent hears, and a held turn cannot be
    // blocked again, so announcing there would be announcing to nobody.
    const root = project()
    markEdited(root, 1_000)
    const held = runStop({
      shellCwd: root,
      spawn: fakeRunner().spawn,
      probe: down,
      stopHookActive: true,
      warn: () => {},
    })
    expect(held).toBe(0)
    const next = runStop({ shellCwd: root, spawn: fakeRunner().spawn, probe: down, warn: () => {} })
    expect(next).toBe(2)
  })

  it("runs the suite exactly as before once the database answers again", () => {
    const root = project()
    markEdited(root, 1_000)
    runStop({ shellCwd: root, spawn: fakeRunner().spawn, probe: down, warn: () => {} })
    const runner = fakeRunner()
    const code = runStop({ shellCwd: root, spawn: runner.spawn, probe: up, now: clock(2_000) })
    expect(code).toBe(0)
    expect(runner.calls[0].args).toEqual(["vitest", "run"])
    expect(needsFullRun(root)).toBe(false)
  })

  it("announces a second, later outage, because recovery resets the one-shot", () => {
    const root = project()
    markEdited(root, 1_000)
    runStop({ shellCwd: root, spawn: fakeRunner().spawn, probe: down, warn: () => {} })
    runStop({ shellCwd: root, spawn: fakeRunner(1).spawn, probe: up, now: clock(2_000), warn: () => {} })
    const code = runStop({ shellCwd: root, spawn: fakeRunner().spawn, probe: down, warn: () => {} })
    expect(code).toBe(2)
  })

  it("behaves as today when the project has no database to check", () => {
    const root = project()
    markEdited(root, 1_000)
    const runner = fakeRunner()
    runStop({
      shellCwd: root,
      spawn: runner.spawn,
      probe: () => ({ status: "skipped" }),
      now: clock(2_000),
    })
    expect(runner.calls).toHaveLength(1)
  })

  it("never probes on a turn that owes nothing, so talk-only turns cost no connection", () => {
    const root = project()
    let probed = 0
    runStop({
      shellCwd: root,
      spawn: fakeRunner().spawn,
      probe: () => {
        probed++
        return up()
      },
    })
    expect(probed).toBe(0)
  })
})
