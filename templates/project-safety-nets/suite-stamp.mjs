// Shared state for the two test hooks: run-tests-unless-docs (per edit) and
// full-suite-on-subagent-stop (per task). The per-edit hook now runs only the
// tests that reach the edited file, so the full suite has to run somewhere
// else; it runs when a task's agent finishes, and only when an edit is actually
// waiting for it.
//
// Every ambiguous case resolves toward running the suite. Missing state,
// unreadable state, and a tie all run, because the cost of running when we did
// not have to is one suite; the cost of skipping when we should have run is a
// gate reporting green without doing its job.
//
// The one case that correctly skips is "no edit was ever recorded": a reviewer
// or explorer agent that changed nothing has nothing unverified behind it.
//
// Stamps live in the system temp directory, keyed by a hash of the project
// path, because nothing then enters the repo and there is no .gitignore to keep
// in step. ~~And a cleared temp directory fails safe by the rule above: the run
// stamp disappears alongside the edit stamp, and the next finish runs.~~
// (Corrected 24 Sept 2026, second review: that was false. With the edit stamp
// gone, needsFullRun reads "nothing was ever edited" and the finish SKIPS. A
// cleared temp directory therefore silently forgives every owed run, and since
// 24 Sept the session's list of edited checkouts lives here too and goes with
// it. The OS clears this directory on reboot, rarely mid-session, so this was
// accepted rather than moved into the repo, but it fails toward green, not safe.)

import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const STAMP_DIR = join(tmpdir(), "claude-suite-stamps")

/**
 * Where this project's two stamps live. Exported so tests can corrupt them.
 *
 * The path is normalized before it is hashed, because the two hooks can reach
 * the same project by different spellings (a trailing slash, /tmp against
 * /private/tmp) and a different spelling is a different key. Note which way
 * that fails: the edit hook keys as A, the stop hook keys as B, finds no edit
 * stamp, and SKIPS. That is the unsafe direction, so it is worth the realpath.
 */
export function stampPaths(root) {
  const absolute = resolve(String(root))
  let canonical
  try {
    canonical = realpathSync(absolute)
  } catch {
    canonical = absolute // not on disk yet; the resolved spelling is the best we have
  }
  const key = createHash("sha256").update(canonical).digest("hex").slice(0, 16)
  return {
    edited: join(STAMP_DIR, `${key}.edited`),
    ran: join(STAMP_DIR, `${key}.ran`),
    outage: join(STAMP_DIR, `${key}.outage`),
  }
}

/**
 * The stamp's time. null ONLY when the file genuinely is not there; NaN when it
 * exists and cannot be trusted.
 *
 * The distinction is the whole invariant. "Absent" is the one input allowed to
 * skip the suite, so every other read failure (a permissions problem, a
 * directory where a file should be, too many open files) has to land on NaN
 * instead. Collapsing them all into null, which this did until PR #64's review
 * caught it, means an unreadable stamp silently reads as "nothing was ever
 * edited" and the gate goes permanently green.
 */
function readStamp(file) {
  let raw
  try {
    raw = readFileSync(file, "utf8").trim()
  } catch (err) {
    return err && err.code === "ENOENT" ? null : NaN
  }
  if (!raw) return NaN
  const at = Number(raw)
  return Number.isFinite(at) ? at : NaN
}

function writeStamp(file, at) {
  mkdirSync(STAMP_DIR, { recursive: true })
  writeFileSync(file, String(at))
}

/** Record that a source file changed and the full suite has not seen it yet. */
export function markEdited(root, at = Date.now()) {
  writeStamp(stampPaths(root).edited, at)
}

/**
 * Record that the full suite ran green. Pass the time the run STARTED, not the
 * time it finished: an edit landing while the suite was running is not covered
 * by that run, and stamping the finish time would swallow it.
 */
export function recordFullRun(root, at = Date.now()) {
  writeStamp(stampPaths(root).ran, at)
}

/** True when an edit is waiting that the full suite has not covered. */
export function needsFullRun(root) {
  const { edited, ran } = stampPaths(root)

  const editedAt = readStamp(edited)
  if (editedAt === null) return false // nothing was ever edited: nothing to verify
  if (Number.isNaN(editedAt)) return true

  const ranAt = readStamp(ran)
  if (ranAt === null || Number.isNaN(ranAt)) return true

  return editedAt >= ranAt
}

// WHERE THIS SESSION'S EDITS WENT (24 Sept 2026)
//
// The edit stamps above are per checkout, and they have to stay that way: a
// worktree and the main checkout owe separate runs. But the finish hook is only
// told where the shell is standing, and the shell moves. On 23-24 Sept 2026 a
// session's edits were all in a worktree, and its shell was later sent back to
// the main checkout when the owner ran a command in the terminal pane, so a
// finish hook trusting the shell would have tested main and found nothing owed.
//
// So each edit also records WHICH checkout it landed in, against the session,
// and the finish hook checks every checkout on that list AS WELL AS the shell's
// and the session's own (see full-suite-on-subagent-stop.mjs). Per session
// rather than per repository: a repository-wide list would have one SESSION's
// finish run, and be blocked by, another session's work in a different worktree.
//
// What that does NOT isolate, stated because the first version of this comment
// claimed more: helper agents inside one session. If they share the session's id,
// which is believed but unverified, one helper's finish checks another helper's
// worktree too, and can be held by its red suite. That errs toward running more,
// never less, and a held finish is loud; it was accepted rather than solved,
// since separating them needs an agent identity the hook input may not carry.

/** Where one session's list of edited checkouts lives. Exported so tests can clean it up. */
export function sessionRootsPath(sessionId) {
  const key = createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 16)
  return join(STAMP_DIR, `session-${key}.roots`)
}

/**
 * Add a checkout to this session's list.
 *
 * APPEND-ONLY, and that is the point. The first version read the list, added
 * one, and rewrote the whole file. Two edits at the same instant each read the
 * list before the other wrote, and the second write erased the first: that
 * checkout still owed a run, but the list no longer named it, so the finish never
 * checked it and reported green. Reproduced with twenty real processes before the
 * fix, found by the independent review. An append of one short line is not
 * interleaved with another on a local disk, so writers can only ever add. The
 * worst a race can now do is write one line twice, which reading removes.
 */
export function recordWorkRoot(sessionId, root) {
  if (!sessionId) return
  const path = sessionRootsPath(sessionId)
  const canonical = canonicalRoot(root)
  if (readRoots(path).includes(canonical)) return // saves growth; racing past it only duplicates
  mkdirSync(STAMP_DIR, { recursive: true })
  appendFileSync(path, canonical + "\n")
}

/**
 * The checkouts this session edited that still exist, each once. A worktree
 * deleted since is dropped, since blocking every later finish on a folder that
 * is gone would be worse. An unreadable list reads as empty; the finish still
 * checks the shell's and the session's own checkout regardless.
 */
export function workRootsFor(sessionId) {
  if (!sessionId) return []
  return [...new Set(readRoots(sessionRootsPath(sessionId)))].filter((r) => existsSync(r))
}

function readRoots(path) {
  try {
    return readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)
  } catch {
    return []
  }
}

function canonicalRoot(root) {
  const absolute = resolve(String(root))
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

// The one-per-outage marker (23 Sept 2026). When the database will not answer,
// the stop hook tells the agent once and then stays quiet until the database
// answers again, so an outage costs one red line rather than a wall on every
// turn. Kept per project like the other two stamps, so two sessions in one
// checkout share one announcement. It never touches the edit or run stamps:
// an outage must never count as a pass.

/**
 * An announcement older than this is treated as belonging to an earlier
 * outage. The marker is only cleared on a turn that owes a run while the
 * database answers, so a recovery nobody observed would otherwise hide the
 * next outage for good. Found by review.
 */
export const OUTAGE_ANNOUNCEMENT_TTL_MS = 3 * 60 * 60 * 1000

/** True when this outage has already been announced. Unreadable means no: one extra line is harmless. */
export function outageAnnounced(root, now = Date.now()) {
  const at = readStamp(stampPaths(root).outage)
  if (at === null || Number.isNaN(at)) return false
  return now - at < OUTAGE_ANNOUNCEMENT_TTL_MS
}

/** Record that the current outage has been announced. */
export function markOutageAnnounced(root, at = Date.now()) {
  writeStamp(stampPaths(root).outage, at)
}

/** The database answered: the next outage is a new one, and gets announced. */
export function clearOutage(root) {
  try {
    rmSync(stampPaths(root).outage, { force: true })
  } catch {
    // Failing to clear means a later outage might go unannounced. It still
    // never runs the suite against a dead database and never forgives an
    // edit, so this degrades toward quiet, not toward green.
  }
}
