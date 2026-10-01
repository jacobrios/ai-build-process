// Where the test hooks should run, when the session works in a git worktree.
//
// The incident (23-24 Sept 2026, interplanetary-groups): a session opened in the
// main checkout created a worktree and did all its work there. The harness kept
// CLAUDE_PROJECT_DIR pointed at the main checkout, and resolveProjectRoot takes
// that first, so both test hooks ran MAIN's suite. The gate never saw the branch
// being built, and reported on code nobody had touched.
//
// The fix follows the WORK, not the folder the session was opened in: the
// checkout that holds the edited file. It deliberately does not follow the work
// into a different repository, which is the case resolveProjectRoot's header
// already names as a known, separately deferred limit.
//
// Real git repositories, not stubs: whether two folders are one repository is
// git's answer to give, and a stub would only test the stub.

import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resolveWorkRoot } from "./project-root.mjs"

const cleanup: string[] = []
let savedEnv: string | undefined

function git(cwd: string, ...args: string[]) {
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" })
}

/** A repo with one commit and a linked worktree placed where Claude Code puts them. */
function repoWithWorktree(prefix: string) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanup.push(base)
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
  return { main, wt }
}

beforeEach(() => {
  savedEnv = process.env.CLAUDE_PROJECT_DIR
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR
  else process.env.CLAUDE_PROJECT_DIR = savedEnv
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("the edited file decides, not the folder the session opened in", () => {
  it("a session opened in main, editing in a worktree, tests the worktree", () => {
    const { main, wt } = repoWithWorktree("wr-a-")
    process.env.CLAUDE_PROJECT_DIR = main
    expect(resolveWorkRoot({ filePath: join(wt, "src", "a.ts"), shellCwd: main })).toBe(wt)
  })

  it("a session opened in a worktree, editing main, tests main", () => {
    // The reverse direction. A test runner should follow the edit wherever it is in
    // the same repo; restricting it to linked worktrees would test the worktree for
    // an edit made in main, which is the silent-wrong direction this exists to stop.
    const { main, wt } = repoWithWorktree("wr-b-")
    process.env.CLAUDE_PROJECT_DIR = wt
    expect(resolveWorkRoot({ filePath: join(main, "src", "a.ts"), shellCwd: wt })).toBe(main)
  })

  it("editing where the session opened is unchanged", () => {
    const { main } = repoWithWorktree("wr-c-")
    process.env.CLAUDE_PROJECT_DIR = main
    expect(resolveWorkRoot({ filePath: join(main, "src", "a.ts"), shellCwd: main })).toBe(main)
  })

  it("a relative file path resolves against the shell, not the anchor", () => {
    const { main, wt } = repoWithWorktree("wr-d-")
    process.env.CLAUDE_PROJECT_DIR = main
    expect(resolveWorkRoot({ filePath: "src/a.ts", shellCwd: wt })).toBe(wt)
  })
})

describe("with no file, the shell's location decides, within the same repo", () => {
  it("a shell standing in a worktree tests that worktree", () => {
    const { main, wt } = repoWithWorktree("wr-e-")
    process.env.CLAUDE_PROJECT_DIR = main
    expect(resolveWorkRoot({ shellCwd: wt })).toBe(wt)
  })

  it("a shell in a SUBFOLDER of a worktree still tests the whole worktree", () => {
    // The 12 Aug regression this template was built around: a shell in a source
    // folder once ran 5 tests out of 801 and reported green. The answer must be the
    // checkout's root, never wherever the shell happens to be standing inside it.
    const { main, wt } = repoWithWorktree("wr-f-")
    process.env.CLAUDE_PROJECT_DIR = main
    expect(resolveWorkRoot({ shellCwd: join(wt, "src") })).toBe(wt)
  })
})

describe("it never follows the work into a different repository", () => {
  it("a file in another repo's worktree falls back to the session's project", () => {
    const mine = repoWithWorktree("wr-g-")
    const theirs = repoWithWorktree("wr-h-")
    process.env.CLAUDE_PROJECT_DIR = mine.main
    expect(resolveWorkRoot({ filePath: join(theirs.wt, "src", "a.ts"), shellCwd: mine.main })).toBe(mine.main)
  })

  it("a shell wandered into another repo does not move the tests", () => {
    const mine = repoWithWorktree("wr-i-")
    const theirs = repoWithWorktree("wr-j-")
    process.env.CLAUDE_PROJECT_DIR = mine.main
    expect(resolveWorkRoot({ shellCwd: theirs.wt })).toBe(mine.main)
  })
})

describe("outside git it behaves exactly as before", () => {
  it("a plain project folder falls back to resolveProjectRoot", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "wr-k-")))
    cleanup.push(dir)
    writeFileSync(join(dir, "package.json"), "{}")
    process.env.CLAUDE_PROJECT_DIR = dir
    expect(resolveWorkRoot({ filePath: join(dir, "x.ts"), shellCwd: dir })).toBe(dir)
  })
})
