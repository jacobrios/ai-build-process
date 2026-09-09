// Serializes test-suite runs for one project, so two runs never contend for a
// single dev database. Wired as a vitest `globalSetup`, NOT as a Claude hook.
//
// THE INCIDENT (3 September 2026, interplanetary-groups)
// A subagent was running `npm test` as its own verification at the moment
// `full-suite-on-subagent-stop.mjs` fired and ran the suite too. That project
// has one dev-test database. The two runs contended for connections until a
// Prisma transaction could not start, and the suite went red naming
// `invite-token.test.ts`, a file nobody had touched. Run alone seconds later:
// 1704 of 1704 across 146 files.
//
// The misleading name is what makes this worth machinery rather than a habit.
// A red suite pointing at innocent code sends whoever reads it to debug
// something that was never broken, and the product manager cannot tell that
// report from a real one.
//
// WHY globalSetup AND NOT THE HOOK
// This is the load-bearing choice. A lock only works if every party takes it,
// and the two colliding parties are the hook's run and an agent's own typed
// `npm test`. A lock inside the hook covers one of them, so the collision
// survives in the case that actually happened. vitest reads its config at the
// start of every invocation, whoever started it, so a lock here covers both.
//
// Two consequences worth knowing. It protects a session that is already
// running, because the config is read per invocation rather than at session
// start, unlike a hook. And the hook file needs no change at all, so adopting
// this adds a file rather than editing one.
//
// WHY IT WAITS RATHER THAN TRUSTING
// The obvious cheaper design is to skip when another run is in flight and
// trust its result. That quietly weakens the gate: the other run may have
// started before the last edit, so its green does not cover the current tree.
// Waiting costs one extra suite length of background time, which is time
// nobody is sitting through. Trusting costs a gate that reports green without
// having checked.
//
// FAILING RATHER THAN PROCEEDING ON TIMEOUT
// If the wait times out, this throws instead of running anyway. Running anyway
// would reintroduce the exact misleading red this exists to prevent, while a
// throw says plainly what happened and names no innocent file.
//
// RE-ENTRANCY, AND WHY IT IS NOT OPTIONAL
// A suite can legitimately spawn a nested `vitest` in the same checkout.
// interplanetary-groups does exactly that: one test spawns `vitest related`
// for real, as the only proof that the per-edit gate selects what it claims
// to. Without re-entrancy the child waits for a lock its own parent holds, the
// parent waits for the child, and the whole suite hangs for the full timeout.
// Found on 3 September 2026 by adopting this file into that project, which is
// the only way it could have been found: the first version was never run
// against the suite it was written for, and it deadlocked on contact.
//
// A run that takes the lock records the lock path in an environment variable.
// A nested run sees this project's own path and skips acquiring. Keying on the
// path rather than a bare flag matters: a nested run against a DIFFERENT project
// still locks that project normally.
//
// HOW THE MARKER REACHES THE CHILD, stated precisely because the obvious answer
// is wrong and would misdirect whoever debugs this next. globalSetup runs in the
// vitest main process; the nested spawn happens in a pool worker, whose
// environment is rebuilt from process.env when the worker starts its tests,
// after global setup has run. So it depends on that ordering inside vitest, not
// on plain parent-to-child inheritance. (Reported by the reviewing session on
// 4 September 2026 from reading vitest's own code; not independently confirmed
// here.) If a future vitest snapshots worker environments earlier, the deadlock
// returns, and the symptom is a nested run waiting out WAIT_MS.
//
// WHAT THE GUARANTEE ACTUALLY IS, since the first version of this comment
// overclaimed it in exactly the shape of the incident it was written for. This
// delivers one LOCK-TAKING suite per checkout, not one suite per checkout. A
// nested run skips the lock by design and can still do real database work
// alongside its parent: in interplanetary-groups the nested `vitest related`
// reaches a route test that creates users, groups and events through Prisma
// while the parent suite runs. That predates this file and is not made worse by
// it, but a comment claiming the hole is closed is worse than the hole.
//
// WATCH MODE HOLDS THE LOCK, and that is correct. `vitest --watch` runs
// globalSetup once and tears it down only on close, so a watcher owns the lock
// for as long as it runs. It keeps beating while it does, so it reads as running
// rather than stuck and is never stolen from. Every other run in that checkout
// waits and then throws, which is honest: something really is using the database.
// Worth knowing before leaving a watcher running next to an agent that runs
// suites, because the agent will be told to wait rather than told why.
//
// WIRING (per project, in vitest.config.ts):
//   globalSetup: ["./.claude/hooks/suite-lock.mjs"]

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const LOCK_DIR = join(tmpdir(), "claude-suite-locks")

// A holder touches its lock file every BEAT_MS. A lock goes stale when its
// holder is gone, or when it has been silent for SILENT_MS.
//
// WHAT THAT ACTUALLY RECLAIMS, stated narrowly because the first version of this
// comment claimed far more. A beat is a `setInterval` on the vitest MAIN process,
// so it stops only when that process is killed, stopped, or blocked inside a
// synchronous call. It therefore reclaims:
//   - a holder whose process is gone
//   - a holder whose main event loop has been blocked for SILENT_MS, reclaimed
//     after SILENT_MS + CONFIRM_MS since a silent-looking holder is re-read once
//     before its lock is taken
// and it does NOT reclaim the ordinary ways a run wedges, because every one of
// them leaves that loop turning: an await that never settles, a hung globalSetup
// or teardown ((not 100% sure, verify) vitest appears to apply no timeout to either), a database disconnect that
// never returns, or a stuck pool worker. This repo contains a concrete instance:
// `run-tests-unless-docs.test.ts` calls spawnSync with no timeout, which blocks
// that worker's thread outright while the main process beats along happily.
//
// So the honest guarantee is weaker than "proves it is working". It is strictly
// better than liveness alone, and it is not a solution to a wedged run.
//
// AND THE INCIDENT BEHIND IT WAS NEVER DIAGNOSED. The overnight run that held
// this lock for 308 minutes was reported as hung on the strength of `ps` showing
// it idle, which is equally consistent with a healthy event loop. Neither the
// session that reported it nor the one that designed this established what that
// process was actually doing. Designing against an undiagnosed failure is the
// mistake this repo's own notes warn about, and it was made here. If it recurs,
// diagnose it first: get a stack, find out whether the main loop is turning and
// whether a worker is blocked. Do not tune SILENT_MS at it.
//
// Two earlier versions each collapsed a pair of states. Stealing any lock older
// than ten minutes treated a healthy `vitest --watch` as abandoned and silently
// put two suites back on one database. Liveness alone never reclaimed anything
// that was still running, whatever it was doing.
//
// The numbers are picked against measurements rather than roundness. The suite
// this guards runs 71 to 84 seconds, WAIT_MS is 300s, and the stop hook's budget
// is 600s. BEAT_MS at 5s means SILENT_MS at 120s is twenty-four missed beats, so
// a wrongly stolen lock needs a two-minute event-loop stall in a run whose whole
// length is under 90 seconds. And 120s sits well inside WAIT_MS, so a waiting run
// reclaims a stuck lock rather than waiting out its timeout and failing.
//
// Stated as silence, not as age, deliberately: age is a property of the run and
// varies per project, while silence is a property of the holder being stuck and
// does not.
const BEAT_MS = 5_000

// How long to re-watch a silent-looking holder before taking its lock. Longer
// than one beat so a running holder always gets a chance to speak up.
const CONFIRM_MS = 15_000
const SILENT_MS = 120_000

// Shorter than the stop hook's own 600s budget, so a wait cannot silently
// consume it and turn into an invisible timeout on the hook instead.
const WAIT_MS = 300_000

const POLL_MS = 250

/**
 * Marks the process tree that already holds a lock. Its value is the lock path,
 * so the marker is per project rather than global.
 */
export const HELD_ENV = "CLAUDE_SUITE_LOCK_HELD"

/** Where this project's lock lives. Exported so tests can inspect and corrupt it. */
export function lockPath(root) {
  const key = createHash("sha256").update(resolve(String(root))).digest("hex").slice(0, 16)
  return join(LOCK_DIR, `${key}.lock`)
}

function readHolder(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    // Unreadable or half-written: treat as abandoned. A lock we cannot parse is
    // a lock we can never legitimately release.
    return null
  }
}

function alive(pid, isAlive) {
  if (isAlive) return isAlive(pid)
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function stale(holder, now, isAlive) {
  if (!holder || typeof holder.pid !== "number") return true
  if (!alive(holder.pid, isAlive)) return true
  // `beat` falls back to `at` so a lock written by an older version, which never
  // touched itself, is judged by when it was taken rather than read as silent
  // from birth.
  const lastHeard = Number(holder.beat ?? holder.at ?? 0)
  return now - lastHeard > SILENT_MS
}

/**
 * Take the lock, waiting for a run already in flight. Resolves to a release
 * function. Throws if the wait exceeds WAIT_MS.
 *
 * The clock, the sleep and the liveness probe are injectable so the tests
 * neither wait on real time nor depend on real process ids.
 */
export async function acquire({
  root,
  pid = process.pid,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  isAlive,
  waitMs = WAIT_MS,
  env = process.env,
  // Injectable so tests can drive the heartbeat by hand instead of waiting on a
  // real timer, and so a test can assert that a silent holder is reclaimed.
  beatMs = BEAT_MS,
  confirmMs = CONFIRM_MS,
  startBeat = (touch) => {
    const timer = setInterval(() => {
      if (!touch()) clearInterval(timer)
    }, beatMs)
    if (typeof timer.unref === "function") timer.unref()
    return { stop: () => clearInterval(timer) }
  },
  // Injectable so a test can force a non-EEXIST failure, which is the path that
  // used to spin forever and cannot be provoked from a normal filesystem.
  write = (p, data) => writeFileSync(p, data, { flag: "wx" }),
} = {}) {
  const path = lockPath(root)

  // Already inside a run holding this project's lock: take no lock, and release
  // nothing on teardown, so a nested run cannot free its parent's.
  if (env[HELD_ENV] === path) return () => {}

  mkdirSync(LOCK_DIR, { recursive: true })
  const startedWaiting = now()

  for (;;) {
    let took = false
    try {
      // 'wx' fails when the file exists, which is what makes this atomic
      // between two processes racing to create it.
      const takenAt = now()
      write(path, JSON.stringify({ pid, at: takenAt, beat: takenAt }))
      took = true

      // Prove we are still working, rather than merely still existing. Rewrites
      // only our own lock: if ours went stale and someone else took it, beating
      // on would resurrect a lock we no longer hold. unref'd so a forgotten
      // interval can never be the thing keeping a process alive.
      const beat = startBeat(() => {
        const held = readHolder(path)
        if (!held || held.pid !== pid) return false
        try {
          // Atomic. A plain writeFileSync truncates first, so a waiter polling
          // at 250ms can read a zero-byte file, fail to parse it, call it
          // abandoned and steal from a live healthy holder: two suites on one
          // database, silently, which is the incident this file exists to
          // prevent. v1 and v2 never rewrote the file, so this arrived with the
          // heartbeat rather than being inherited.
          const tmp = `${path}.${pid}.tmp`
          writeFileSync(tmp, JSON.stringify({ ...held, beat: now() }))
          renameSync(tmp, path)
        } catch {
          // A failed touch is not worth taking the suite down for. Miss enough
          // of them and this holder reads as stuck, which is the right answer.
        }
        return true
      })

      // Set before returning, so anything this run spawns inherits the marker.
      // The previous value is restored rather than deleted on release: a nested
      // run against a DIFFERENT project would otherwise erase its parent's
      // marker, and a further nested run against the parent would then deadlock
      // on the parent's own lock, which is the v1 bug arriving by a side door.
      const previousMarker = env[HELD_ENV]
      env[HELD_ENV] = path
      return () => {
        beat.stop()
        // Release only our own lock. If ours went stale and someone else took
        // it, deleting would hand a third run a lock nobody holds.
        const held = readHolder(path)
        if (held && held.pid === pid) rmSync(path, { force: true })
        if (env[HELD_ENV] === path) {
          if (previousMarker === undefined) delete env[HELD_ENV]
          else env[HELD_ENV] = previousMarker
        }
      }
    } catch (err) {
      // Anything thrown AFTER the write succeeded is ours, not contention. Left
      // in the contended branch it would find its own fresh lock, wait out
      // WAIT_MS and report waiting on its own pid, leaving the lock behind.
      if (took) throw err

      // Only "the file already exists" means someone else holds the lock. Every
      // other failure (read-only lock dir, disk full, EACCES, EMFILE) used to
      // fall through readHolder -> null -> stale -> a no-op remove -> continue,
      // with no sleep and no elapsed check, which is a tight 100% CPU spin that
      // never times out: a silent permanent hang inside the file whose job is
      // making failures legible. Found by review on 4 September 2026.
      if (err && err.code && err.code !== "EEXIST") throw err

      // Above the stale branch on purpose. When it sat below, any path that
      // reached `continue` skipped it entirely, which is what made the spin
      // unbounded rather than merely wasteful.
      const holder = readHolder(path)
      if (now() - startedWaiting >= waitMs) {
        throw new Error(
          `suite-lock: waited ${Math.round(waitMs / 1000)}s for another test run ` +
            `(pid ${holder && holder.pid}) and gave up. No test failed; the suite ` +
            `never started. Check whether a suite is stuck, then re-run.`
        )
      }

      if (stale(holder, now(), isAlive)) {
        // A holder that is GONE is stolen from at once. A holder that is merely
        // SILENT gets a second look, because silence is measured on the wall
        // clock: close a laptop mid-run and a waiter wakes to a beat hours old
        // held by a run that is perfectly fine. No value of SILENT_MS fixes
        // that, since the measured quantity is wrong; re-reading does, because a
        // live holder beats again inside the window and a stuck one does not.
        const gone = !holder || typeof holder.pid !== "number" || !alive(holder.pid, isAlive)
        if (!gone) {
          const before = Number(holder.beat ?? holder.at ?? 0)
          await sleep(confirmMs)
          const again = readHolder(path)
          if (!again) continue // vanished under us: retry the create
          const after = Number(again.beat ?? again.at ?? 0)
          if (after > before) continue // it beat, so it is running: keep waiting
        }
        rmSync(path, { force: true })
        continue
      }
      await sleep(POLL_MS)
    }
  }
}

/** vitest globalSetup: hold the lock for the whole run, release on teardown. */
export default async function setup() {
  const release = await acquire({ root: process.cwd() })
  return () => release()
}
