// The per-edit half of the test gate. It used to run the whole suite after
// every edit, which was measured on 12 August 2026 at 85 seconds per edit and
// five hours of a build day. It now runs only the tests that reach the edited
// file, and marks the stamp that makes the full suite run once when the task's
// agent finishes.
//
// Two things this file has to hold onto, both of which failed silently before:
//
//   - The runner runs from the project root, never the shell's cwd. Rooted in a
//     source folder it used to find the handful of tests under THAT folder,
//     pass, and report green having run a fraction of the suite (measured here:
//     5 of 801). A gate that reports success without doing its job is worse
//     than no gate.
//   - Every edit that runs the narrow check also marks the stamp, including one
//     whose tests failed. Narrow is not proof, so the full suite still owes
//     that edit a look.
//
// The child process is the one seam mocked. It is the process boundary, and
// exercising it for real would mean running a test suite from inside a test
// suite.

import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { runEdit } from "./run-tests-unless-docs.mjs"
import { resolveProjectRoot } from "./project-root.mjs"
import { needsFullRun, stampPaths } from "./suite-stamp.mjs"

const HOOK = fileURLToPath(new URL("./run-tests-unless-docs.mjs", import.meta.url))

/** A throwaway project: package.json at the top, a nested folder far below it. */
function fakeProject() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hook-root-")))
  writeFileSync(join(root, "package.json"), "{}")
  const deep = join(root, "src", "lib", "nav")
  mkdirSync(deep, { recursive: true })
  return { root, deep }
}

/** A stand-in for the child process, recording what it was asked to run. */
function fakeRunner(status = 0) {
  const calls: { cwd: string; args: string[] }[] = []
  const spawn = (cwd: string, args: string[]) => {
    calls.push({ cwd, args })
    return status
  }
  return { spawn, calls }
}

const cleanup: string[] = []

/**
 * A throwaway project with its stamps registered for cleanup.
 *
 * CLAUDE_PROJECT_DIR is pinned to it deliberately. The suite runs inside a real
 * session, so that variable is already set to THIS repo, and without the pin
 * every case below would mark the live project's stamp instead of its own: the
 * tests would drive the gate they are supposed to be testing.
 */
function tracked() {
  const project = fakeProject()
  process.env.CLAUDE_PROJECT_DIR = project.root
  const { edited, ran } = stampPaths(project.root)
  cleanup.push(edited, ran, project.root)
  return project
}

const savedEnv = process.env.CLAUDE_PROJECT_DIR
afterEach(() => {
  if (savedEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR
  else process.env.CLAUDE_PROJECT_DIR = savedEnv
  for (const f of cleanup.splice(0)) rmSync(f, { recursive: true, force: true })
})

describe("which directory the runner runs in", () => {
  it("uses the session's project directory when the harness provides one", () => {
    const { root, deep } = fakeProject()
    process.env.CLAUDE_PROJECT_DIR = root
    expect(resolveProjectRoot(deep)).toBe(root)
  })

  it("climbs to the project root when the shell is deep inside the project", () => {
    // The silent bug: standing here used to run only the tests under this folder.
    const { root, deep } = fakeProject()
    delete process.env.CLAUDE_PROJECT_DIR
    expect(resolveProjectRoot(deep)).toBe(root)
  })

  it("falls back to where the shell is standing when nothing else is knowable", () => {
    const orphan = realpathSync(mkdtempSync(join(tmpdir(), "hook-orphan-")))
    delete process.env.CLAUDE_PROJECT_DIR
    expect(resolveProjectRoot(orphan)).toBe(orphan)
  })

  it("normalizes even that last resort, so one directory has one spelling", () => {
    // Two spellings of one directory hash to two different stamp keys, and the
    // way that fails is the unsafe way: the stop hook finds no edit stamp and
    // skips. Found by PR #64's review.
    const orphan = realpathSync(mkdtempSync(join(tmpdir(), "hook-orphan-")))
    delete process.env.CLAUDE_PROJECT_DIR
    expect(resolveProjectRoot(`${orphan}/`)).toBe(orphan)
  })
})

describe("a documentation edit", () => {
  it("runs nothing, because a .md file cannot change what the code does", () => {
    const { root, deep } = tracked()
    const runner = fakeRunner()
    const code = runEdit({
      filePath: join(deep, "notes.md"),
      shellCwd: root,
      spawn: runner.spawn,
    })
    expect(code).toBe(0)
    expect(runner.calls).toHaveLength(0)
  })

  it("leaves no edit waiting, so a task of pure docs work finishes free", () => {
    const { root, deep } = tracked()
    process.env.CLAUDE_PROJECT_DIR = root
    runEdit({ filePath: join(deep, "NOTES.MD"), shellCwd: root, spawn: fakeRunner().spawn })
    expect(needsFullRun(root)).toBe(false)
  })
})

describe("a source edit", () => {
  it("runs only the tests that reach the edited file, not the whole suite", () => {
    const { root, deep } = tracked()
    const runner = fakeRunner()
    const filePath = join(deep, "front-door.ts")
    runEdit({ filePath, shellCwd: root, spawn: runner.spawn })

    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0].args).toEqual([
      "vitest",
      "related",
      "--run",
      "--passWithNoTests",
      filePath,
    ])
  })

  it("runs from the project root even when the shell is deep inside it", () => {
    const { root, deep } = tracked()
    delete process.env.CLAUDE_PROJECT_DIR
    const runner = fakeRunner()
    runEdit({ filePath: join(deep, "front-door.ts"), shellCwd: deep, spawn: runner.spawn })
    expect(runner.calls[0].cwd).toBe(root)
  })

  it("hands the path over untouched, so a route folder's brackets stay a filename", () => {
    // src/app/groups/[id]/page.tsx is a real path here. Treated as a glob it
    // matches nothing, and the narrow run would quietly cover no tests at all.
    const { root } = tracked()
    const runner = fakeRunner()
    const filePath = join(root, "src", "app", "groups", "[id]", "EventCard.tsx")
    runEdit({ filePath, shellCwd: root, spawn: runner.spawn })
    expect(runner.calls[0].args.at(-1)).toBe(filePath)
  })

  it("leaves an edit waiting for the full suite at the end of the task", () => {
    const { root, deep } = tracked()
    process.env.CLAUDE_PROJECT_DIR = root
    runEdit({ filePath: join(deep, "front-door.ts"), shellCwd: root, spawn: fakeRunner().spawn })
    expect(needsFullRun(root)).toBe(true)
  })

  it("still leaves it waiting when the narrow run failed, because narrow is not proof", () => {
    const { root, deep } = tracked()
    process.env.CLAUDE_PROJECT_DIR = root
    runEdit({ filePath: join(deep, "front-door.ts"), shellCwd: root, spawn: fakeRunner(1).spawn })
    expect(needsFullRun(root)).toBe(true)
  })

  it("reports a failure as exit 2, the only code the harness shows the agent", () => {
    const { root, deep } = tracked()
    const code = runEdit({
      filePath: join(deep, "front-door.ts"),
      shellCwd: root,
      spawn: fakeRunner(1).spawn,
    })
    expect(code).toBe(2)
  })
})

describe("a tool call we cannot read", () => {
  // The old hook always ran everything, so a garbled payload degraded into the
  // safe direction for free. Narrowing the run takes that away: with no path to
  // narrow to, there is nothing to be narrow about, so it has to fall back.
  it("runs the whole suite, because nothing says what changed", () => {
    const { root } = tracked()
    const runner = fakeRunner()
    runEdit({ filePath: "", shellCwd: root, spawn: runner.spawn })
    expect(runner.calls[0].args).toEqual(["vitest", "run"])
  })

  it("leaves the edit waiting anyway, since we cannot prove it was only docs", () => {
    const { root } = tracked()
    process.env.CLAUDE_PROJECT_DIR = root
    runEdit({ filePath: "", shellCwd: root, spawn: fakeRunner().spawn })
    expect(needsFullRun(root)).toBe(true)
  })
})

describe("when the stamp cannot be written", () => {
  // If the stamp did not record, the end-of-task run will not know this edit
  // happened, so the narrow run is all the verification it would ever get.
  // Verify it now instead. Found by PR #64's review, where this threw uncaught
  // and exited 1: the agent never heard, and neither half of the gate ran.
  it("runs the whole suite now, since the end-of-task run cannot be relied on", () => {
    const { root, deep } = tracked()
    const runner = fakeRunner()
    const throws = () => {
      throw new Error("temp directory is read-only")
    }
    runEdit({
      filePath: join(deep, "front-door.ts"),
      shellCwd: root,
      spawn: runner.spawn,
      mark: throws,
    })
    expect(runner.calls[0].args).toEqual(["vitest", "run"])
  })

  it("still reports a failing run as exit 2 rather than dying as exit 1", () => {
    const { root, deep } = tracked()
    const throws = () => {
      throw new Error("temp directory is read-only")
    }
    const code = runEdit({
      filePath: join(deep, "front-door.ts"),
      shellCwd: root,
      spawn: fakeRunner(1).spawn,
      mark: throws,
    })
    expect(code).toBe(2)
  })
})

describe("what vitest related actually selects", () => {
  // The one assumption this whole change rests on, and the only one every other
  // test fakes away. If a vitest upgrade changed what `related` resolves, every
  // unit test here would still pass while the gate quietly covered nothing.
  it("really does select the tests that reach an edited source file", () => {
    const result = spawnSync(
      "npx",
      ["vitest", "related", "--run", "--passWithNoTests", "src/lib/events/ics.ts"],
      { cwd: process.cwd(), encoding: "utf8" }
    )
    const output = `${result.stdout}${result.stderr}`
    expect(result.status).toBe(0)
    expect(output).toMatch(/Tests\s+\d+ passed/)
    expect(output).not.toMatch(/No test files found/)
  })
})

describe("the harness contract", () => {
  it("exits 0 on a docs edit when driven exactly as Claude Code drives it", () => {
    const { root, deep } = tracked()
    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        tool_name: "Write",
        tool_input: { file_path: join(deep, "notes.md") },
        cwd: root,
      }),
      encoding: "utf8",
    })
    expect(result.status).toBe(0)
  })
})
