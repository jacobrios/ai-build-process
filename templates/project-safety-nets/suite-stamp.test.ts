// The stamp is what lets the two test hooks divide the work: the per-edit hook
// marks that a source file changed, and the subagent-stop hook runs the full
// suite only when a change is waiting for it. That means a read-only agent
// (a reviewer, an explorer) finishes without paying for a suite run it cannot
// have broken.
//
// The whole risk of the design lives in this file, so it is tested directly
// rather than through the hooks. A stamp that wrongly says "nothing to verify"
// is a gate reporting green without doing its job, which is the same failure
// class as the working-directory bug the hook carried until 12 August 2026.
// Every ambiguous case below therefore resolves toward running the suite:
// missing state, unreadable state, and same-millisecond ties all run.
//
// Time is passed in explicitly. These tests never sleep and never read the
// clock, so a slow machine, a busy machine, and a machine in another timezone
// all produce the same result.

import { chmodSync, mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  markEdited,
  markOutageAnnounced,
  outageAnnounced,
  recordFullRun,
  needsFullRun,
  stampPaths,
} from "./suite-stamp.mjs"

/** A throwaway project root. Only its path matters; nothing is read from it. */
function project() {
  return mkdtempSync(join(tmpdir(), "stamp-project-"))
}

const written: string[] = []
function track(root: string) {
  const { edited, ran } = stampPaths(root)
  written.push(edited, ran)
  return root
}

afterEach(() => {
  for (const f of written.splice(0)) rmSync(f, { force: true })
})

describe("when the full suite is owed a run", () => {
  it("is not owed one when no edit has ever been recorded", () => {
    // A reviewer or explorer agent that changed nothing. Nothing is unverified,
    // so there is nothing for the suite to catch.
    expect(needsFullRun(track(project()))).toBe(false)
  })

  it("is owed one after a source file is edited", () => {
    const root = track(project())
    markEdited(root, 1_000)
    expect(needsFullRun(root)).toBe(true)
  })

  it("is not owed one again once that edit has been covered by a run", () => {
    const root = track(project())
    markEdited(root, 1_000)
    recordFullRun(root, 2_000)
    expect(needsFullRun(root)).toBe(false)
  })

  it("is owed one again when an edit lands after the last run", () => {
    const root = track(project())
    markEdited(root, 1_000)
    recordFullRun(root, 2_000)
    markEdited(root, 3_000)
    expect(needsFullRun(root)).toBe(true)
  })

  it("is owed one when an edit lands in the same instant as the last run", () => {
    // The tie has to resolve toward running. Resolving it the other way would
    // drop an edit whenever a run and an edit share a millisecond.
    const root = track(project())
    markEdited(root, 2_000)
    recordFullRun(root, 2_000)
    expect(needsFullRun(root)).toBe(true)
  })
})

describe("when the stamp itself cannot be trusted", () => {
  it("is owed a run when an edit is recorded but no run ever was", () => {
    const root = track(project())
    markEdited(root, 1_000)
    expect(needsFullRun(root)).toBe(true)
  })

  it("is owed a run when the recorded run is unreadable", () => {
    const root = track(project())
    markEdited(root, 1_000)
    recordFullRun(root, 2_000)
    writeFileSync(stampPaths(root).ran, "not a number")
    expect(needsFullRun(root)).toBe(true)
  })

  it("is owed a run when the edit stamp exists but cannot be read", () => {
    // The one input allowed to skip is "absent". A stamp that is there and
    // unreadable must not be mistaken for one that was never written, or the
    // gate reads "nothing was ever edited" forever.
    const root = track(project())
    markEdited(root, 1_000)
    chmodSync(stampPaths(root).edited, 0o000)
    expect(needsFullRun(root)).toBe(true)
    chmodSync(stampPaths(root).edited, 0o600) // so afterEach can remove it
  })

  it("is owed a run when the recorded edit is unreadable", () => {
    const root = track(project())
    markEdited(root, 1_000)
    recordFullRun(root, 2_000)
    writeFileSync(stampPaths(root).edited, "not a number")
    expect(needsFullRun(root)).toBe(true)
  })
})

describe("which project a stamp belongs to", () => {
  it("keeps two projects apart, so one project's edit never covers another's", () => {
    const a = track(project())
    const b = track(project())
    markEdited(a, 1_000)
    expect(needsFullRun(a)).toBe(true)
    expect(needsFullRun(b)).toBe(false)
  })

  it("stores stamps outside the project, so nothing lands in the repo", () => {
    const root = project()
    const { edited, ran } = stampPaths(root)
    expect(edited.startsWith(root)).toBe(false)
    expect(ran.startsWith(root)).toBe(false)
  })
})

describe("the one-per-outage marker", () => {
  it("expires, so an outage long after the last one is announced again", () => {
    // Found by review: the marker only clears on a turn that owes a run while
    // the database answers, so a recovery nobody observed would otherwise hide
    // the next outage for good.
    const root = track(project())
    markOutageAnnounced(root, Date.now() - 4 * 60 * 60 * 1000)
    expect(outageAnnounced(root)).toBe(false)
  })
  it("holds within an outage", () => {
    const root = track(project())
    markOutageAnnounced(root)
    expect(outageAnnounced(root)).toBe(true)
  })
})
