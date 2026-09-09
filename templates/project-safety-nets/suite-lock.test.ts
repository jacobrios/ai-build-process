// Tests for suite-lock.mjs, the vitest globalSetup that keeps two suite runs
// off one database at the same time.
//
// Every test injects the clock, the sleep and the liveness probe, so none of
// them waits on real time or depends on a real process id. The lock file
// itself is real, because atomic exclusive create is the thing under test and
// faking the filesystem would test the fake.
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { acquire, lockPath, HELD_ENV } from "./suite-lock.mjs"

// Every test injects its own `env`. `acquire` defaults to `process.env` and
// short-circuits when it sees this project's own lock path there, so a test that
// takes the default is reading ambient state left by whatever ran before it,
// including this file's own earlier tests. Injecting makes each one independent.
//
// And every test that waits advances the clock. A frozen `now` with a sleep that
// only yields a microtask spins forever and starves timers, so the test hangs
// instead of failing, which is far worse than a red result.
const advancing = (from: number, step = 250) => {
  let t = from
  return () => (t += step)
}

// Keyed per process. A fixed path is shared by every checkout on this machine,
// and two concurrent runs in different worktrees are explicitly NOT serialized by
// this lock, so one run's beforeEach could delete the lock another had just taken
// and fail it on an innocent assertion: the exact failure class this machinery
// exists to remove, manufactured by its own tests.
// A no-op scheduler for tests that drive time by hand and must not have a real
// interval writing underneath them.
const noBeat = () => ({ stop() {} })

const ROOT = `/tmp/suite-lock-test-project-${process.pid}`
const PATH = lockPath(ROOT)

beforeEach(() => {
  mkdirSync(dirname(PATH), { recursive: true })
  rmSync(PATH, { force: true })
})
afterEach(() => rmSync(PATH, { force: true }))

describe("acquire", () => {
  it("takes a free lock and records the holder", async () => {
    const release = await acquire({ root: ROOT, env: {}, pid: 111 })
    expect(existsSync(PATH)).toBe(true)
    expect(JSON.parse(readFileSync(PATH, "utf8")).pid).toBe(111)
    release()
    expect(existsSync(PATH)).toBe(false)
  })

  it("waits while a live holder keeps the lock, then takes it", async () => {
    writeFileSync(PATH, JSON.stringify({ pid: 222, at: Date.now() }))
    let polls = 0
    const promise = acquire({
      root: ROOT,
      env: {},
      pid: 111,
      isAlive: (pid) => pid === 222 && polls < 3,
      sleep: async () => {
        polls++
      },
    })
    const release = await promise
    expect(polls).toBe(3) // it really waited rather than barging in
    expect(JSON.parse(readFileSync(PATH, "utf8")).pid).toBe(111)
    release()
  })

  it("steals a lock whose holder is gone", async () => {
    writeFileSync(PATH, JSON.stringify({ pid: 999, at: Date.now() }))
    const release = await acquire({ root: ROOT, env: {}, pid: 111, isAlive: () => false })
    expect(JSON.parse(readFileSync(PATH, "utf8")).pid).toBe(111)
    release()
  })

  // Inverted on 4 September 2026. An earlier version stole any lock older than
  // ten minutes even from a live holder, which silently defeated the lock in
  // watch mode: a watcher holds it for hours, so every other run stole it and
  // two suites went back on one database with no symptom.
  it("never steals from a live holder, however old the lock", async () => {
    const t0 = 1_000_000_000_000
    writeFileSync(PATH, JSON.stringify({ pid: 222, at: t0 }))
    await expect(
      acquire({
        root: ROOT,
        env: {},
        pid: 111,
        waitMs: 1000,
        // The clock MUST advance. A frozen `now` plus a sleep that only yields a
        // microtask starves the elapsed check forever, and the loop cannot even
        // be broken by a timer. That is how the first version of this test hung
        // rather than failing, and it is why every test here advances time.
        now: advancing(t0),
        isAlive: () => true,
        sleep: async () => {},
      })
    ).rejects.toThrow(/waited/)
    expect(JSON.parse(readFileSync(PATH, "utf8")).pid).toBe(222)
  })

  it("gives up rather than spinning when the lock cannot be written at all", async () => {
    // A non-EEXIST failure used to fall through to the stale branch and re-loop
    // with no sleep and no elapsed check: a tight spin that never timed out.
    const err: NodeJS.ErrnoException = new Error("read-only file system")
    err.code = "EROFS"
    await expect(
      acquire({ root: ROOT, env: {}, pid: 111, write: () => { throw err } })
    ).rejects.toThrow(/read-only file system/)
  })

  it("steals an unreadable lock rather than blocking on it forever", async () => {
    writeFileSync(PATH, "half-written garbage")
    const release = await acquire({ root: ROOT, env: {}, pid: 111, isAlive: () => true })
    expect(JSON.parse(readFileSync(PATH, "utf8")).pid).toBe(111)
    release()
  })

  it("throws a message naming the wait, not a test, when it gives up", async () => {
    const t0 = 1_000_000_000_000
    let t = t0
    writeFileSync(PATH, JSON.stringify({ pid: 222, at: t0 }))
    await expect(
      acquire({
        root: ROOT,
        env: {},
        pid: 111,
        waitMs: 1000,
        now: () => t,
        isAlive: () => true,
        sleep: async () => {
          t += 400
        },
      })
    ).rejects.toThrow(/waited 1s for another test run/)
    // The suite must be able to tell this apart from a real failure.
    expect(existsSync(PATH)).toBe(true) // the other run still holds it
  })

  it("release does not remove a lock that has been taken over", async () => {
    const release = await acquire({ root: ROOT, env: {}, pid: 111 })
    writeFileSync(PATH, JSON.stringify({ pid: 333, at: Date.now() }))
    release()
    expect(JSON.parse(readFileSync(PATH, "utf8")).pid).toBe(333)
  })

  it("keys the lock per project, so two projects never block each other", () => {
    expect(lockPath("/tmp/project-a")).not.toBe(lockPath("/tmp/project-b"))
  })
})

// A holder must prove it is working, not merely existing. These cover the three
// states the lock has to tell apart, and all three resolve with no human: alive
// and beating is running, alive and long silent is stuck, gone is gone. Both
// earlier versions collapsed a pair of them, and each collapse had an incident.
describe("stuck versus working", () => {
  const t0 = 1_000_000_000_000

  it("reclaims a holder that is alive but has gone silent for hours", async () => {
    // The real case: an overnight run held this 308 minutes, alive and idle,
    // confirmed with ps, and blocked every later run until a human killed it.
    writeFileSync(PATH, JSON.stringify({ pid: 222, at: t0, beat: t0 }))
    const release = await acquire({
      root: ROOT,
      env: {},
      pid: 111,
      waitMs: 2000,
      isAlive: () => true,
      startBeat: noBeat,
      now: advancing(t0 + 308 * 60 * 1000),
      sleep: async () => {},
    })
    expect(JSON.parse(readFileSync(PATH, "utf8")).pid).toBe(111)
    release()
  })

  it("never reclaims a watcher that is still beating, however long it has held", async () => {
    const eightHours = t0 + 8 * 3600 * 1000
    writeFileSync(PATH, JSON.stringify({ pid: 222, at: t0, beat: eightHours }))
    await expect(
      acquire({
        root: ROOT,
        env: {},
        pid: 111,
        waitMs: 2000,
        isAlive: () => true,
        startBeat: noBeat,
        now: advancing(eightHours),
        sleep: async () => {},
      })
    ).rejects.toThrow(/waited/)
    expect(JSON.parse(readFileSync(PATH, "utf8")).pid).toBe(222)
  })

  it("does not treat a recent pre-beat lock as silent from birth", async () => {
    // The protective half of the `?? holder.at` fallback. Drop it and every
    // legacy lock is stolen instantly from a healthy holder, suite still green.
    writeFileSync(PATH, JSON.stringify({ pid: 222, at: t0 })) // no beat field
    await expect(
      acquire({
        root: ROOT,
        env: {},
        pid: 111,
        waitMs: 2000,
        isAlive: () => true,
        startBeat: noBeat,
        now: advancing(t0 + 1000), // taken a second ago, well inside SILENT_MS
        sleep: async () => {},
      })
    ).rejects.toThrow(/waited/)
    expect(JSON.parse(readFileSync(PATH, "utf8")).pid).toBe(222)
  })

  it("judges a lock written before beats existed by when it was taken", async () => {
    writeFileSync(PATH, JSON.stringify({ pid: 222, at: t0 })) // no beat field
    const release = await acquire({
      root: ROOT,
      env: {},
      pid: 111,
      waitMs: 2000,
      isAlive: () => true,
      startBeat: noBeat,
      now: advancing(t0 + 200_000),
      sleep: async () => {},
    })
    expect(JSON.parse(readFileSync(PATH, "utf8")).pid).toBe(111)
    release()
  })

  it("moves beat forward when it touches", async () => {
    let touch: (() => boolean) | null = null
    let clock = t0
    const release = await acquire({
      root: ROOT,
      env: {},
      pid: 111,
      now: () => clock,
      startBeat: (t: () => boolean) => {
        touch = t
        return { stop() {} }
      },
    })
    clock = t0 + 60_000
    touch!()
    expect(JSON.parse(readFileSync(PATH, "utf8")).beat).toBe(t0 + 60_000)
    release()
  })

  it("refuses to beat on a lock someone else has taken, and stops itself", async () => {
    let touch: (() => boolean) | null = null
    const release = await acquire({
      root: ROOT,
      env: {},
      pid: 111,
      startBeat: (t: () => boolean) => {
        touch = t
        return { stop() {} }
      },
    })
    writeFileSync(PATH, JSON.stringify({ pid: 333, at: Date.now(), beat: Date.now() }))
    expect(touch!()).toBe(false) // and returning false clears its own interval
    expect(JSON.parse(readFileSync(PATH, "utf8")).pid).toBe(333)
    release()
  })
})

// Added 4 September 2026 after an independent review of the heartbeat. Each of
// these covers a defect that shipped, and each was verified by breaking the fix
// and watching the test go red.
describe("the heartbeat's own hazards", () => {
  const t0 = 1_000_000_000_000

  // A test named "writes beats atomically" lived here and was DELETED on
  // 4 September 2026: it called touch() and read the file in the same process,
  // and writeFileSync blocks, so it could never observe the zero-byte window a
  // non-atomic write leaves for an external reader. Reverting the fix left it
  // green. The property is real and is checked by
  // `checks/suite-lock-atomicity.mjs`, two real processes, deliberately outside
  // the runner. A test that cannot fail reports coverage that does not exist.

  it("keeps waiting when a seemingly silent holder beats during the confirm window", async () => {
    // Silence is wall-clock, so a laptop closed mid-run wakes a waiter to a beat
    // hours old held by a run that is fine. Re-reading catches it; no value of
    // SILENT_MS can.
    writeFileSync(PATH, JSON.stringify({ pid: 222, at: t0, beat: t0 }))
    let confirms = 0
    await expect(
      acquire({
        root: ROOT,
        env: {},
        pid: 111,
        waitMs: 3000,
        confirmMs: 1,
        isAlive: () => true,
        startBeat: noBeat,
        now: advancing(t0 + 10 * 3600 * 1000),
        sleep: async () => {
          if (++confirms === 1) {
            writeFileSync(PATH, JSON.stringify({ pid: 222, at: t0, beat: t0 + 10 * 3600 * 1000 + 900_000 }))
          }
        },
      })
    ).rejects.toThrow(/waited/)
    expect(JSON.parse(readFileSync(PATH, "utf8")).pid).toBe(222)
  })

  it("surfaces a failure that happens after the lock was taken", async () => {
    // Left in the contended branch it would find its own fresh lock, wait out
    // WAIT_MS and report waiting on its own pid, leaving the lock behind.
    await expect(
      acquire({
        root: ROOT,
        env: {},
        pid: 111,
        waitMs: 2000,
        now: advancing(t0),
        sleep: async () => {},
        startBeat: () => {
          throw new Error("beat setup exploded")
        },
      })
    ).rejects.toThrow(/beat setup exploded/)
  })

  it("really beats on the real scheduler, and release really stops it", async () => {
    // Every other test injects startBeat, so the interval, its clearInterval and
    // its unref would otherwise never execute under test at all.
    let clock = t0
    const release = await acquire({
      root: ROOT,
      env: {},
      pid: 111,
      beatMs: 20,
      now: () => {
        clock += 1000
        return clock
      },
    })
    const first = JSON.parse(readFileSync(PATH, "utf8")).beat
    await new Promise((r) => setTimeout(r, 120))
    expect(JSON.parse(readFileSync(PATH, "utf8")).beat).toBeGreaterThan(first)
    release()
    await new Promise((r) => setTimeout(r, 80))
    expect(existsSync(PATH)).toBe(false) // stopped, and did not recreate it
  })
})

// A suite can legitimately spawn a nested vitest in the same checkout; this
// project's own run-tests-unless-docs test does exactly that. Without these,
// the child waits for a lock its parent holds and the suite hangs. Found by
// adopting the first version of this file, which deadlocked on contact.
describe("re-entrancy", () => {
  it("lets a nested run through instead of waiting for its own parent", async () => {
    const env: Record<string, string> = {}
    const outer = await acquire({ root: ROOT, pid: 111, env })
    const inner = await acquire({ root: ROOT, pid: 222, env, waitMs: 0 })
    inner()
    expect(JSON.parse(readFileSync(PATH, "utf8")).pid).toBe(111) // parent's lock survives
    outer()
    expect(existsSync(PATH)).toBe(false)
    expect(env[HELD_ENV]).toBeUndefined()
  })

  it("marks the tree with this project's lock path, so children inherit it", async () => {
    const env: Record<string, string> = {}
    const release = await acquire({ root: ROOT, pid: 111, env })
    expect(env[HELD_ENV]).toBe(lockPath(ROOT))
    release()
  })

  it("still locks a DIFFERENT project reached from inside a held run", async () => {
    const other = `/tmp/suite-lock-test-other-${process.pid}`
    rmSync(lockPath(other), { force: true })
    const env: Record<string, string> = {}
    const outer = await acquire({ root: ROOT, pid: 111, env })
    const marker = env[HELD_ENV]
    const inner = await acquire({ root: other, pid: 222, env })
    expect(existsSync(lockPath(other))).toBe(true)
    inner()
    // The assertion that was missing: releasing the nested run must restore the
    // parent's marker, not delete it. Deleting it makes a further nested run
    // against the parent deadlock on the parent's own lock.
    expect(env[HELD_ENV]).toBe(marker)
    outer()
  })

  it("ignores a marker belonging to some other project", async () => {
    const env: Record<string, string> = { [HELD_ENV]: "/some/other/projects/lock" }
    const release = await acquire({ root: ROOT, pid: 111, env })
    expect(existsSync(PATH)).toBe(true)
    release()
  })
})
