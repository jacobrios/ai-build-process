#!/usr/bin/env node
// Hand-run check: does a heartbeat write ever leave the lock file unreadable?
//
//   node checks/suite-lock-atomicity.mjs
//
// DELIBERATELY OUTSIDE THE TEST RUNNER, and in a subdirectory so the drift
// checker (which discovers top-level .mjs files) does not ask every project to
// adopt it. This property cannot be observed from inside one process, so a unit
// test of it is theatre: `writeFileSync` blocks until the write completes, so a
// same-process read after it always sees a whole file, whether or not the write
// was atomic. A test that cannot fail is worse than no test, because it reports
// coverage that does not exist and the next reader trusts its name.
//
// That is not hypothetical. A unit test named "writes beats atomically" shipped
// on 4 September 2026, and reverting the fix left it green. It was deleted and
// replaced by this. Same shape, and the same reason, as the eval benches in
// interplanetary-groups: some properties need a real run, and pretending
// otherwise is how a suite reports a guarantee it never checked.
//
// WHAT IT PROVES. Two processes: one rewrites the lock as the heartbeat does,
// the other reads it as a waiter does at poll rate. A non-atomic write truncates
// before writing, so the reader sees a zero-byte file, fails to parse it, calls
// the lock abandoned and steals it from a live healthy holder. Two suites on one
// database, silently, which is the incident this whole file exists to prevent.
//
// MEASURED 4 September 2026, on this machine:
//   plain writeFileSync : 1739 unreadable of 27839 reads  (about 6%)
//   tmp + renameSync    :    0 unreadable of 76466 reads
//
// Exits nonzero if any read comes back unreadable.

import { writeFileSync, renameSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const LOCK = join(tmpdir(), `suite-lock-atomicity-${process.pid}.lock`)
const BODY = JSON.stringify({ pid: 42, at: 1e12, beat: 1e12 })
const MS = Number(process.env.ATOMICITY_MS || 1500)

// Child roles, so the parent can stay the reader and report.
if (process.argv[2] === "--write") {
  const until = Date.now() + MS
  while (Date.now() < until) {
    const path = process.argv[3]
    if (process.argv[4] === "atomic") {
      writeFileSync(`${path}.tmp`, BODY)
      renameSync(`${path}.tmp`, path)
    } else {
      writeFileSync(path, BODY)
    }
  }
  process.exit(0)
}

// The writer runs in the background and this process reads, because spawnSync
// would block the reader loop entirely and observe nothing.
import { spawn } from "node:child_process"
let failures = 0

for (const mode of ["plain", "atomic"]) {
  writeFileSync(LOCK, BODY)
  const writer = spawn(process.execPath, [process.argv[1], "--write", LOCK, mode], { stdio: "ignore" })
  let bad = 0
  let total = 0
  const until = Date.now() + MS
  while (Date.now() < until) {
    total++
    try {
      const text = readFileSync(LOCK, "utf8")
      if (!text.length) bad++
      else JSON.parse(text)
    } catch {
      bad++
    }
  }
  writer.kill()
  const label = mode === "plain" ? "plain writeFileSync" : "tmp + renameSync   "
  console.log(`  ${label}: ${bad} unreadable of ${total} reads`)
  if (mode === "atomic" && bad > 0) failures++
  if (mode === "plain" && bad === 0) {
    console.log("  note: the non-atomic case showed no corruption this run, so this")
    console.log("        machine did not reproduce the window. The check proves nothing today.")
  }
}

rmSync(LOCK, { force: true })
rmSync(`${LOCK}.tmp`, { force: true })

if (failures) {
  console.error("\nFAIL: the atomic write left the lock unreadable. Beats are not atomic.")
  process.exit(1)
}
console.log("\nOK: the atomic write never left the lock unreadable.")
