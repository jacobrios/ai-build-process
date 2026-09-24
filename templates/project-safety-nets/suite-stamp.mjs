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
// path, for two reasons. Nothing enters the repo, so there is no .gitignore to
// keep in step. And a cleared temp directory fails safe by the rule above: the
// run stamp disappears alongside the edit stamp, and the next finish runs.

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
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
