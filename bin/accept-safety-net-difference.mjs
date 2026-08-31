#!/usr/bin/env node
// ~/.claude/bin/accept-safety-net-difference.mjs
//
// Records that a project's difference from ~/.claude/templates/project-safety-nets/
// is deliberate, so ~/.claude/hooks/safety-net-drift.mjs stops reporting it.
//
//   node ~/.claude/bin/accept-safety-net-difference.mjs <file> "<reason>"
//
// Run from the project root. It writes one file: `.claude/safety-net-exceptions.json`.
//
// WHY THIS IS A SEPARATE COMMAND AND NOT A FLAG ON THE CHECK
// The check runs unattended at session start and must never write into a project.
// Accepting a difference is the opposite: a deliberate act by a person who has
// looked at the diff and decided the project is right. Keeping them apart is what
// makes "accepted" mean something. So this refuses to record an acceptance for a
// difference that does not currently exist, and refuses a reason that says nothing:
// an entry no one can read later is a silenced warning, not a recorded decision.
//
// AN ACCEPTANCE EXPIRES WHEN THE TEMPLATE MOVES
// It stores the sha256 of the template file as it is right now. When that template
// file changes, the drift check reports the file again, with this reason attached,
// as a decision to re-make. That is the whole point: a permanent mute would have
// hidden the 12 August working-directory fix exactly as effectively as having no
// check at all.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"

const HOME = homedir()
const TEMPLATE_DIR =
  process.env.SAFETY_NET_TEMPLATE_DIR || join(HOME, ".claude", "templates", "project-safety-nets")
const MIN_REASON = 15

function die(msg) {
  process.stderr.write(`${msg}\n`)
  process.exit(1)
}

function isDir(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function resolveProjectRoot() {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR
  if (fromEnv && existsSync(fromEnv)) return realpathSync(fromEnv)
  let dir = realpathSync(process.cwd())
  const cwd = dir
  while (dirname(dir) !== dir) {
    if (existsSync(join(dir, ".git"))) return dir
    dir = dirname(dir)
  }
  return cwd
}

const [name, ...rest] = process.argv.slice(2)
const reason = rest.join(" ").trim()

if (!name || !reason) {
  die(
    [
      "usage: node ~/.claude/bin/accept-safety-net-difference.mjs <file> \"<reason>\"",
      "",
      "  <file>    a file name from the safety-net template, e.g. run-tests-unless-docs.mjs",
      "  <reason>  why this project is right to differ, in a sentence someone can read in six months",
    ].join("\n")
  )
}

if (reason.length < MIN_REASON) {
  die(
    `That reason is ${reason.length} characters. Write at least ${MIN_REASON}.\n` +
      "An acceptance no one can read later is a silenced warning, not a recorded decision."
  )
}

if (!isDir(TEMPLATE_DIR)) die(`No safety-net template at ${TEMPLATE_DIR}.`)

const templatePath = join(TEMPLATE_DIR, name)
if (!existsSync(templatePath)) {
  const known = readdirSync(TEMPLATE_DIR)
    .filter((n) => n.endsWith(".mjs") || n.endsWith(".test.ts"))
    .sort()
  die(`The template has no ${name}. It has:\n  ${known.join("\n  ")}`)
}

const projectRoot = resolveProjectRoot()
const hooksDir = join(projectRoot, ".claude", "hooks")
if (!isDir(hooksDir)) die(`No .claude/hooks/ under ${projectRoot}. Run this from the project root.`)

const projectPath = join(hooksDir, name)
const present = existsSync(projectPath)
if (present && readFileSync(projectPath).equals(readFileSync(templatePath))) {
  die(
    `${name} is identical to the template right now, so there is nothing to accept.\n` +
      "Nothing was written."
  )
}

const exceptionsPath = join(projectRoot, ".claude", "safety-net-exceptions.json")
let doc = { accepted: {} }
if (existsSync(exceptionsPath)) {
  try {
    const parsed = JSON.parse(readFileSync(exceptionsPath, "utf8"))
    doc = { ...parsed, accepted: parsed.accepted && typeof parsed.accepted === "object" ? parsed.accepted : {} }
  } catch {
    die(
      `${exceptionsPath} exists but is not readable JSON.\n` +
        "Fix or delete it by hand first; overwriting it would throw away every acceptance already recorded there."
    )
  }
}

const previous = doc.accepted[name]
const now = new Date()
const acceptedOn = [
  now.getFullYear(),
  String(now.getMonth() + 1).padStart(2, "0"),
  String(now.getDate()).padStart(2, "0"),
].join("-")

doc.$comment =
  "Differences from ~/.claude/templates/project-safety-nets/ that this project has deliberately accepted. " +
  "Written by `node ~/.claude/bin/accept-safety-net-difference.mjs`, read by ~/.claude/hooks/safety-net-drift.mjs. " +
  "Each entry is pinned to the template file it was accepted against: when that template file changes, the " +
  "acceptance expires and the difference is reported again."

doc.accepted[name] = {
  kind: present ? "differs" : "missing",
  reason,
  acceptedOn,
  templateSha256: createHash("sha256").update(readFileSync(templatePath)).digest("hex"),
}

writeFileSync(exceptionsPath, `${JSON.stringify(doc, null, 2)}\n`)

const what = present ? "differs from the template" : "is missing, and the template has it"
process.stdout.write(
  [
    previous
      ? `Replaced the acceptance recorded on ${previous.acceptedOn || "an unknown date"} for ${name}.`
      : `Recorded: ${name} ${what}, deliberately.`,
    `  reason:  ${reason}`,
    `  written: ${exceptionsPath}`,
    "",
    "The drift check will stay quiet about this file until the template's copy changes.",
    "Commit that file so the decision travels with the project.",
    "",
  ].join("\n")
)
