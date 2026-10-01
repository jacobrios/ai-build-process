// The test gate, end to end, when a session works in a git worktree.
//
// Three parts had to change together, and each is tested here against real git
// repositories, because "are these one repository" is git's question to answer:
//
//   1. The per-edit hook tests the checkout holding the edited file, and records
//      where this session's edits went.
//   2. The finish hook checks every checkout this session recorded, plus the one
//      the shell is standing in, and runs at most ONE full suite per finish. The
//      shell is not trusted alone because it moves: on 23-24 Sept 2026 a
//      session's shell was sent back to the main checkout mid-session when the
//      owner ran a command in the terminal pane, after all its edits were in the
//      worktree. One suite per finish because each finish has a 600 second limit
//      and each run can wait up to 300 seconds for the lock: two in one finish can
//      be killed, and a killed run never records that it ran, so it would be
//      killed identically on every finish after (found by the second review).
//   3. The suite lock is shared by every worktree of one repository. They share
//      one test database, and before this change the bug made every session test
//      the main checkout, so they all took turns BY ACCIDENT. Fixing 1 and 2
//      alone would have given each worktree its own lock and sent them all at the
//      database at once, which is the collision the lock exists to prevent.

import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runStop } from "./full-suite-on-subagent-stop.mjs"
import { runEdit } from "./run-tests-unless-docs.mjs"
import { lockPath } from "./suite-lock.mjs"
import { needsFullRun, recordWorkRoot, sessionRootsPath, stampPaths, workRootsFor } from "./suite-stamp.mjs"

const cleanup: string[] = []
let savedEnv: string | undefined
let n = 0

function git(cwd: string, ...args: string[]) {
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" })
}

function repoWithWorktree(prefix: string) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  const main = join(base, "main")
  mkdirSync(join(main, "src"), { recursive: true })
  writeFileSync(join(main, "package.json"), "{}")
  writeFileSync(join(main, "src", "a.ts"), "")
  git(main, "init", "-q")
  git(main, "add", "-A")
  git(main, "commit", "-qm", "seed")
  mkdirSync(join(main, ".claude", "worktrees"), { recursive: true })
  const wt = join(main, ".claude", "worktrees", "wt")
  git(main, "worktree", "add", "-q", wt, "-b", "wt")
  cleanup.push(base, ...Object.values(stampPaths(main)), ...Object.values(stampPaths(wt)))
  return { main, wt }
}

/** A session id no other test or real session will share. */
function session() {
  const id = `test-session-${process.pid}-${Date.now()}-${n++}`
  cleanup.push(sessionRootsPath(id))
  return id
}

function fakeRunner(status = 0) {
  const calls: { cwd: string; args: string[] }[] = []
  return { calls, spawn: (cwd: string, args: string[]) => (calls.push({ cwd, args }), status) }
}

const skipProbe = () => ({ status: "skipped" })

beforeEach(() => {
  savedEnv = process.env.CLAUDE_PROJECT_DIR
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR
  else process.env.CLAUDE_PROJECT_DIR = savedEnv
  for (const p of cleanup.splice(0)) rmSync(p, { recursive: true, force: true })
})

describe("the per-edit hook", () => {
  it("runs the edited file's tests in the worktree, not the main checkout", () => {
    const { main, wt } = repoWithWorktree("wt-edit-")
    process.env.CLAUDE_PROJECT_DIR = main
    const { calls, spawn } = fakeRunner()
    runEdit({ filePath: join(wt, "src", "a.ts"), shellCwd: main, sessionId: session(), spawn })
    expect(calls[0].cwd).toBe(wt)
  })

  it("owes the full suite to the worktree, and records where this session worked", () => {
    const { main, wt } = repoWithWorktree("wt-owe-")
    process.env.CLAUDE_PROJECT_DIR = main
    const id = session()
    runEdit({ filePath: join(wt, "src", "a.ts"), shellCwd: main, sessionId: id, spawn: fakeRunner().spawn })
    expect(needsFullRun(wt)).toBe(true)
    expect(needsFullRun(main)).toBe(false)
    expect(workRootsFor(id)).toEqual([wt])
  })
})

describe("the finish hook", () => {
  it("tests the worktree even after the shell has moved back to main", () => {
    // The case that makes following the shell insufficient on its own.
    const { main, wt } = repoWithWorktree("wt-back-")
    process.env.CLAUDE_PROJECT_DIR = main
    const id = session()
    runEdit({ filePath: join(wt, "src", "a.ts"), shellCwd: wt, sessionId: id, spawn: fakeRunner().spawn })

    const { calls, spawn } = fakeRunner()
    runStop({ shellCwd: main, sessionId: id, spawn, probe: skipProbe })
    expect(calls.map((c) => c.cwd)).toEqual([wt])
  })

  it("with nothing recorded, follows a shell standing in the worktree", () => {
    const { main, wt } = repoWithWorktree("wt-shell-")
    process.env.CLAUDE_PROJECT_DIR = main
    const { calls, spawn } = fakeRunner()
    runEdit({ filePath: join(wt, "src", "a.ts"), shellCwd: wt, spawn: fakeRunner().spawn }) // no session id
    runStop({ shellCwd: wt, spawn, probe: skipProbe })
    expect(calls.map((c) => c.cwd)).toEqual([wt])
  })

  it("tests every checkout this session edited, one per finish", () => {
    const { main, wt } = repoWithWorktree("wt-both-")
    process.env.CLAUDE_PROJECT_DIR = main
    const id = session()
    runEdit({ filePath: join(wt, "src", "a.ts"), shellCwd: wt, sessionId: id, spawn: fakeRunner().spawn })
    runEdit({ filePath: join(main, "src", "a.ts"), shellCwd: main, sessionId: id, spawn: fakeRunner().spawn })

    const { calls, spawn } = fakeRunner()
    const quiet = () => {}
    const first = runStop({ shellCwd: main, sessionId: id, spawn, probe: skipProbe, warn: quiet })
    expect(calls).toHaveLength(1) // never two suites inside one finish's time limit
    expect(first).toBe(2) // and the finish is held, because another checkout still owes a run
    const second = runStop({ shellCwd: main, sessionId: id, spawn, probe: skipProbe, warn: quiet, stopHookActive: true })
    expect(second).toBe(0)
    expect(calls.map((c) => c.cwd).sort()).toEqual([main, wt].sort())
  })

  it("a held finish that still owes more says so rather than blocking again", () => {
    // stop_hook_active means the harness is already holding this agent once. The
    // existing rule is never to block twice, so a third owed checkout is left on
    // its stamp and named out loud, never dropped silently.
    const { main, wt } = repoWithWorktree("wt-held-")
    process.env.CLAUDE_PROJECT_DIR = main
    const id = session()
    runEdit({ filePath: join(wt, "src", "a.ts"), shellCwd: wt, sessionId: id, spawn: fakeRunner().spawn })
    runEdit({ filePath: join(main, "src", "a.ts"), shellCwd: main, sessionId: id, spawn: fakeRunner().spawn })

    const said: string[] = []
    const { calls, spawn } = fakeRunner()
    const code = runStop({ shellCwd: main, sessionId: id, spawn, probe: skipProbe, stopHookActive: true, warn: (m: string) => said.push(m) })
    expect(code).toBe(0)
    expect(calls).toHaveLength(1)
    expect(said.join(" ")).toMatch(/still owes/)
  })

  it("a failed first run is never reported as a pass", () => {
    // The first version of the one-per-finish message said the suite "passed" in
    // the first checkout whenever that checkout returned 0. It also returns 0 when
    // a held agent's suite FAILS and is let go, so the message would have called a
    // red suite green, which is the exact failure this gate exists to prevent.
    const { main, wt } = repoWithWorktree("wt-red-")
    process.env.CLAUDE_PROJECT_DIR = main
    const id = session()
    runEdit({ filePath: join(wt, "src", "a.ts"), shellCwd: wt, sessionId: id, spawn: fakeRunner().spawn })
    runEdit({ filePath: join(main, "src", "a.ts"), shellCwd: main, sessionId: id, spawn: fakeRunner().spawn })

    const said: string[] = []
    const { spawn } = fakeRunner(1) // every suite comes back red
    const code = runStop({ shellCwd: main, sessionId: id, spawn, probe: skipProbe, stopHookActive: true, warn: (m: string) => said.push(m) })
    expect(code).toBe(0)
    expect(said.join(" ")).not.toMatch(/passed/)
  })

  it("does not run another session's debt in the main checkout", () => {
    // The first version always added the folder the session was opened in. So a
    // session working only in its worktree also ran, and could be held by, the
    // main checkout's owed suite from ANOTHER session's edits. Its own records
    // already name every checkout it actually touched.
    const { main, wt } = repoWithWorktree("wt-other-")
    process.env.CLAUDE_PROJECT_DIR = main
    runEdit({ filePath: join(main, "src", "a.ts"), shellCwd: main, sessionId: session(), spawn: fakeRunner().spawn }) // someone else
    const mine = session()
    runEdit({ filePath: join(wt, "src", "a.ts"), shellCwd: wt, sessionId: mine, spawn: fakeRunner().spawn })

    const { calls, spawn } = fakeRunner()
    const code = runStop({ shellCwd: wt, sessionId: mine, spawn, probe: skipProbe, warn: () => {} })
    expect(calls.map((c) => c.cwd)).toEqual([wt])
    // Checking what ran is not enough on its own. With one suite per finish, the
    // worktree runs first either way, so the other session's main-checkout debt
    // would only show up as this finish being HELD to run it next. This assertion
    // is the one that catches that; without it this test passed while the defect
    // it names was present (caught by breaking it deliberately, 24 Sept 2026).
    expect(code).toBe(0)
  })

  it("a session that edited nothing still runs nothing", () => {
    const { main } = repoWithWorktree("wt-none-")
    process.env.CLAUDE_PROJECT_DIR = main
    const { calls, spawn } = fakeRunner()
    runStop({ shellCwd: main, sessionId: session(), spawn, probe: skipProbe })
    expect(calls).toEqual([])
  })

  it("ignores a recorded worktree that has since been deleted", () => {
    const { main, wt } = repoWithWorktree("wt-gone-")
    process.env.CLAUDE_PROJECT_DIR = main
    const id = session()
    recordWorkRoot(id, join(wt, "..", "deleted-long-ago"))
    expect(workRootsFor(id)).toEqual([])
  })
})

// Found by the independent review of this change, 24 Sept 2026. All three are the
// silent direction: an owed run that never happens while the finish reports green.
describe("no owed run is lost from the session's list", () => {
  it("twenty simultaneous writers all land", async () => {
    // The first version read the list, added one, and rewrote it. Two edits at the
    // same instant, say two helper agents in separate worktrees, could each read
    // the list before the other wrote, and the second write erased the first. The
    // erased checkout still owed a run, the list was no longer empty, so nothing
    // fell back to it, and it was never tested. Real processes, because a race
    // inside one process cannot happen and a test of it could not fail.
    //
    // Twenty processes each writing ten notes, not twenty writing one. With one
    // write each, a variant whose read and write sat closer together slipped past
    // this test while still being racy: the window was too narrow to hit. Ten
    // writes per process keeps them overlapping for the whole run. This is still a
    // test of a race, so it shows the bug CAN happen rather than proving it never
    // will; the guarantee is the append-only design in suite-stamp.mjs.
    const id = session()
    const perWriter = Array.from({ length: 20 }, () =>
      Array.from({ length: 10 }, () => {
        const d = realpathSync(mkdtempSync(join(tmpdir(), "wt-race-")))
        cleanup.push(d)
        return d
      })
    )
    const stampModule = new URL("./suite-stamp.mjs", import.meta.url).href
    await Promise.all(
      perWriter.map(
        (dirs) =>
          new Promise<void>((done, fail) => {
            const child = spawn(process.execPath, [
              "--input-type=module",
              "-e",
              `import { recordWorkRoot } from ${JSON.stringify(stampModule)}; ` +
                `for (const d of ${JSON.stringify(dirs)}) recordWorkRoot(${JSON.stringify(id)}, d)`,
            ])
            child.on("exit", (code) => (code === 0 ? done() : fail(new Error(`writer exited ${code}`))))
          })
      )
    )
    expect(workRootsFor(id).sort()).toEqual(perWriter.flat().sort())
  })

  it("the finish also checks the shell's checkout when the list does not name it", () => {
    // A list that is not empty used to be trusted completely. So a checkout whose
    // edit never reached the list, for any reason, was not checked at all, even
    // with the shell standing in it.
    const { main, wt } = repoWithWorktree("wt-union-")
    process.env.CLAUDE_PROJECT_DIR = main
    const id = session()
    runEdit({ filePath: join(main, "src", "a.ts"), shellCwd: main, sessionId: id, spawn: fakeRunner().spawn })
    runEdit({ filePath: join(wt, "src", "a.ts"), shellCwd: wt, spawn: fakeRunner().spawn }) // never recorded

    const { calls, spawn: run } = fakeRunner()
    const quiet = () => {}
    runStop({ shellCwd: wt, sessionId: id, spawn: run, probe: skipProbe, warn: quiet })
    runStop({ shellCwd: wt, sessionId: id, spawn: run, probe: skipProbe, warn: quiet, stopHookActive: true })
    expect(calls.map((c) => c.cwd).sort()).toEqual([main, wt].sort())
  })

  it("an edit whose note cannot be written runs the whole suite on the spot", () => {
    // The same treatment this hook already gives a stamp that cannot be written:
    // if the finish may never learn about this edit, verify it fully now.
    const { main, wt } = repoWithWorktree("wt-norec-")
    process.env.CLAUDE_PROJECT_DIR = main
    const { calls, spawn: run } = fakeRunner()
    runEdit({
      filePath: join(wt, "src", "a.ts"),
      shellCwd: wt,
      sessionId: session(),
      spawn: run,
      record: () => {
        throw new Error("disk full")
      },
    })
    expect(calls[0].args).toEqual(["vitest", "run"])
  })
})

describe("the suite lock", () => {
  it("is one lock for every worktree of a repository", () => {
    const { main, wt } = repoWithWorktree("wt-lock-")
    expect(lockPath(wt)).toBe(lockPath(main))
  })

  it("is still a different lock for a different repository", () => {
    const a = repoWithWorktree("wt-lock-a-")
    const b = repoWithWorktree("wt-lock-b-")
    expect(lockPath(a.wt)).not.toBe(lockPath(b.wt))
  })
})
