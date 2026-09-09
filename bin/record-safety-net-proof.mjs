#!/usr/bin/env node
// ~/.claude/bin/record-safety-net-proof.mjs
//
// Records that a safety-net template file has actually RUN inside a real
// project, which is the one thing the drift checker could never tell you.
//
// WHY THIS EXISTS
// On 3 September 2026 suite-lock.mjs shipped from the template with a deadlock
// in it. Its own tests were green, but they only covered cases its author had
// thought of; the case that broke it was already sitting in the project it was
// written for, and adoption found it in minutes. safety-net-drift.mjs could say
// the file was missing from a project. Nothing could say it had never been run
// anywhere, and those are different states with only the second being evidence.
//
// THE BAR IS NARROW ON PURPOSE
// A file is proven when its own tests ran green inside a real project's suite,
// ON CODE THAT HAS LANDED ON THAT PROJECT'S MAIN BRANCH. Copying it in is not
// proof. Reading and approving it is not proof. Writing a convincing entry here
// is not proof either, which is why the reason field asks what ran rather than
// whether it looks right: a sentence naming a suite and a count can be checked
// by a stranger, and "looks correct" cannot.
//
// The merged half was added on 4 September 2026, hours after the rest, by the
// session adopting suite-lock. Its argument: a green run on an unmerged branch
// can still be rejected at review or reshaped by it, and provenance would then
// assert that a file is proven in a project that does not contain it, or that
// contains a different version of it. That is the same confident-claim-from-a-
// green-run failure this file exists to prevent, one level up. It was right, and
// it declined to record its own entry on those grounds before saying so.
//
// The check below makes that bar mechanical rather than a request, since a bar
// nobody can verify is the thing this file was built to replace.
//
// Provenance is per file, not per version. Whoever changes a file materially
// removes its entry, the same judgment the copy-improvements-back rule asks for.
//
// Deliberately the mirror of accept-safety-net-difference.mjs: that one records
// a decision to differ, this one records an observation that something worked.
//
// usage: node ~/.claude/bin/record-safety-net-proof.mjs <file> <project> "<what ran>"

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { homedir } from "node:os"

const TEMPLATE_DIR =
  process.env.SAFETY_NET_TEMPLATE_DIR ||
  join(homedir(), ".claude", "templates", "project-safety-nets")
const PROVENANCE = join(TEMPLATE_DIR, "provenance.json")

function die(message) {
  console.error(message)
  process.exit(1)
}

const [file, project, how] = process.argv.slice(2)

if (!file || !project || !how) {
  die(
    [
      'usage: node ~/.claude/bin/record-safety-net-proof.mjs <file> <project> "<what ran>"',
      "",
      "  <file>     a file name from the safety-net template, e.g. suite-lock.mjs",
      "  <project>  the project its tests ran green in, by folder name",
      "  <what ran> what actually ran and passed, in a sentence a stranger could check",
      "             (a suite name and a count beats an assurance that it looks right)",
      "",
      "The file must already be on main in that project; a green run on an",
      "unmerged branch is not yet a proof.",
    ].join("\n")
  )
}

if (!existsSync(join(TEMPLATE_DIR, file))) {
  die(`${file} is not in ${TEMPLATE_DIR}. Provenance is recorded against template files.`)
}

if (!file.endsWith(".mjs")) {
  die(`Provenance is recorded against the implementation file, not ${file}.`)
}

// Is the file actually on that project's main branch? Fails OPEN with a warning
// when the project cannot be located, because a tool that refuses to run in an
// unfamiliar layout gets worked around, and a working record beats a perfect one
// nobody uses. It only ever blocks when it can see the answer and the answer is no.
function checkLanded(projectName, fileName) {
  const root = join(homedir(), "code", projectName)
  if (!existsSync(root)) {
    return { known: false, why: `could not find ${root}, so nothing checked whether it has landed` }
  }
  const r = spawnSync("git", ["-C", root, "cat-file", "-e", `main:.claude/hooks/${fileName}`])
  if (r.error || r.status === null) {
    return { known: false, why: `could not ask git about ${root}, so nothing checked whether it has landed` }
  }
  return { known: true, landed: r.status === 0 }
}

const landed = checkLanded(project, file)
if (landed.known && !landed.landed) {
  die(
    [
      `${file} is not on main in ${project}, so it is not proven there yet.`,
      "",
      "A green suite on an unmerged branch can still be rejected at review, or",
      "reshaped by it, and this file would then claim a proof for a version the",
      "project does not contain. Merge first, then record.",
    ].join("\n")
  )
}
if (!landed.known) console.error(`note: ${landed.why}`)

let doc = { proven: {} }
if (existsSync(PROVENANCE)) {
  try {
    doc = JSON.parse(readFileSync(PROVENANCE, "utf8"))
  } catch {
    // Same refusal as the acceptances tool: overwriting a file we cannot read
    // would silently discard every entry already in it.
    die(`${PROVENANCE} could not be read. Fix or remove it by hand rather than losing what is in it.`)
  }
}
if (!doc.proven || typeof doc.proven !== "object") doc.proven = {}

const existing = doc.proven[file]
doc.proven[file] = {
  project,
  on: new Date().toISOString().slice(0, 10),
  how,
}

writeFileSync(PROVENANCE, `${JSON.stringify(doc, null, 2)}\n`)

console.log(
  existing
    ? `Replaced the proof for ${file} (was ${existing.project}, ${existing.on}).`
    : `Recorded: ${file} ran green in ${project}.`
)
console.log(`The drift checker will stop calling it unproven. Commit ${PROVENANCE}.`)
