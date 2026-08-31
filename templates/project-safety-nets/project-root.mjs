// Where the test hooks run the test runner. Shared by both of them, and kept
// out of either one, because a utility living inside one of its consumers
// invites the next reader to wonder which hook owns it.
//
// This is load-bearing rather than tidy-up. The per-edit hook used to spawn the
// runner with no working directory, so it rooted itself wherever the session's
// shell happened to be standing. A shell in a docs folder made it block a
// harmless edit; a shell in a source folder made it report the suite green
// after running 5 tests out of 801 (measured here, 12 August 2026). The silent
// direction is the one that matters.
//
// A third case, measured in b1-coach on 12 August 2026 and worse than both: a
// shell standing in a *different project* ran that project's suite and reported
// its success as verification of this project's edit. Exit 0, green, zero of
// the right tests. A project that adapted this hook to run through its package
// manager rather than the runner directly is not exempt; see the npm note in
// README.md, which is what that adaptation actually protects and what it does
// not.

import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

/**
 * Anchor order: CLAUDE_PROJECT_DIR (the harness sets it to the directory the
 * session was opened in), then the nearest ancestor holding a package.json,
 * then the shell's cwd as a last resort. package.json is the marker rather than
 * .git because it is what a Node test runner actually needs above it.
 */
export function resolveProjectRoot(shellCwd) {
  // Known limit, deliberate for now: the session's directory wins over where
  // the edited file actually lives. A session opened in project A that edits a
  // file in project B (which the user-level rules permit, with a yes) would run
  // A's tests for B's edit. Climbing from the file's own directory first would
  // be strictly more correct and still fix the bug above; not done here because
  // cross-project edits are rare and this is not the change to widen.
  const fromEnv = process.env.CLAUDE_PROJECT_DIR
  if (fromEnv && existsSync(fromEnv)) return resolve(fromEnv)

  const start = resolve(shellCwd || process.cwd())
  let dir = start
  while (dirname(dir) !== dir) {
    if (existsSync(join(dir, "package.json"))) return dir
    dir = dirname(dir)
  }
  // Normalized, not the raw argument: two spellings of one directory hash to
  // two different stamp keys, and that fails toward skipping the suite.
  return start
}
