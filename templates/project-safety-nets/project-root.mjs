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

import { execFileSync } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

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

// WHERE THE WORK IS, WHEN THE SESSION WORKS IN A GIT WORKTREE (24 Sept 2026)
//
// resolveProjectRoot answers "which folder was this session opened in", and the
// harness never updates CLAUDE_PROJECT_DIR when a session moves into a worktree.
// On 23-24 Sept 2026 a session opened in interplanetary-groups' main checkout
// did all its work in `.claude/worktrees/editable-event-card`, and both test
// hooks ran MAIN's suite: the gate never saw the branch being built.
//
// So the test hooks ask a different question, which checkout holds the work,
// and follow it anywhere inside the same repository, main checkout included.
// That is deliberately the opposite of repo-boundary.mjs, which refuses to follow
// a wandering shell because it is a FENCE and must stay put. A test runner is
// not a fence; its job is to test what was changed, and the silent-wrong
// direction for it is testing the wrong checkout and reporting green.
//
// It never follows the work into a different repository. That is the
// cross-project case resolveProjectRoot's header already names as a known,
// separately deferred limit, and this change does not widen it.

function gitPath(dir, flag) {
  try {
    const out = execFileSync("git", ["-C", dir, "rev-parse", flag], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim()
    return realpathSync(isAbsolute(out) ? out : resolve(dir, out))
  } catch {
    return null
  }
}

/** The nearest existing folder at or above `p`, since an edited file may be new. */
function existingDir(p) {
  let dir = p
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir)
  return dir
}

/**
 * The folder the test runner should run in, for this piece of work.
 *
 * With a file, the checkout holding that file decides. Without one, the shell's
 * location does. Either way the answer is the checkout's own project root, the
 * same relative spot that resolveProjectRoot found in the session's checkout, so
 * a shell standing in a subfolder can never shrink the run to part of the suite.
 * Anything that is not the same repository falls back to resolveProjectRoot.
 *
 * Two limits, both named by the independent review and both accepted:
 *   - ANY git failure lands on that same fallback, silently. A git call that
 *     errors or passes its 2 second timeout sends the tests back to the folder
 *     the session opened in, which is the original bug. git answering these
 *     read-only questions is fast and near-certain, and a hook that blocked every
 *     edit whenever git hiccuped would be switched off, so this was not hardened.
 *   - In a repository whose package.json is NOT at the top, the carried-over
 *     subfolder can be missing from another checkout's branch. The edit hook then
 *     fails visibly when it starts the runner. Not reachable in any project using
 *     this template today: all keep package.json at the repository's top.
 */
export function resolveWorkRoot({ filePath, shellCwd } = {}) {
  const anchor = resolveProjectRoot(shellCwd)
  const from = filePath
    ? existingDir(dirname(resolve(shellCwd || process.cwd(), String(filePath))))
    : existingDir(resolve(shellCwd || process.cwd()))

  const workTop = gitPath(from, "--show-toplevel")
  const anchorTop = gitPath(anchor, "--show-toplevel")
  if (!workTop || !anchorTop) return anchor

  const sameRepo = gitPath(workTop, "--git-common-dir") === gitPath(anchorTop, "--git-common-dir")
  if (!sameRepo) return anchor

  // The project root sits at the same place inside every checkout of one repo, so
  // carry the anchor's offset across. In a repo whose package.json is at the top,
  // which is the usual case, the offset is empty and this is just the checkout.
  let anchorReal
  try {
    anchorReal = realpathSync(anchor)
  } catch {
    anchorReal = anchor
  }
  return join(workTop, relative(anchorTop, anchorReal))
}
