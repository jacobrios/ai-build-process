#!/usr/bin/env node
// ~/.claude/hooks/safety-net-drift.mjs
//
// Tells you, once at session start, where this project's safety-net hooks have
// fallen behind ~/.claude/templates/project-safety-nets/. Registered as a
// SessionStart hook. It reads. It never writes, copies, or edits anything.
//
// WHY IT EXISTS
// On 12 August 2026 the template's working-directory fix was made in the morning
// and never carried back into the project it came from, which then ran a broken
// gate for the rest of the day. Nothing anywhere announced the gap: the template
// and the project copy drift apart silently, and the only moment either is looked
// at is the moment one of them fails.
//
// THREE CASES, DELIBERATELY DISTINGUISHED
//   1. The project's file DIFFERS from the template. Could be an old copy, could
//      be a deliberate adaptation. Reported, never judged.
//   2. The template has a file the project does NOT. Usually a new capability the
//      project never picked up, which is the case most worth surfacing, so it is
//      reported first.
//   3. The project has a file the template does not. Not drift. Silent.
//
// A DIFFERENCE IS NEVER AUTOMATICALLY WRONG
// B1 Coach's run-tests-unless-docs.mjs calls `npm test` rather than the runner
// directly, on purpose, so the hook and the project's own test command cannot
// disagree. So a project can record an accepted difference in
// `.claude/safety-net-exceptions.json` and this check stays quiet about it.
// Without that escape hatch it would warn about the same file every session until
// it was ignored, and a warning that is always ignored is the same as no warning.
//
// THE ACCEPTANCE IS PINNED TO THE TEMPLATE FILE IT WAS MADE AGAINST
// This is the load-bearing choice, and it is what keeps the escape hatch from
// recreating the very failure above. An acceptance records the sha256 of the
// template file at the moment it was accepted. When that template file changes
// afterwards, the acceptance expires and the file is reported again, with the
// recorded reason shown, as a decision to re-make against the new template. A
// permanent "ignore this file" would have gone quiet on the morning of 12 August
// and stayed quiet all day.
//
// Acceptances are written only by `node ~/.claude/bin/accept-safety-net-difference.mjs`,
// which requires a written reason and refuses to record a difference that does not
// currently exist. This hook only ever reads that file.
//
// HONEST LIMITS
//   - Comparison is exact bytes. A whitespace-only difference is still reported.
//     That is one `diff` to dismiss, and the alternative is deciding for you which
//     differences are cosmetic.
//   - Only the TEMPLATE side of an accepted difference is pinned. Later edits to
//     the project's own copy do not re-open the acceptance. Pinning both would
//     nag on every ordinary local iteration of an intentionally diverged file,
//     which is the ignored-warning failure again.
//   - It compares files, not registration. A hook file present but never wired
//     into `.claude/settings.json` does nothing, and this check cannot see that.
//   - `settings.json`, `README.md` and `db-which.*` live in the template but not
//     in `.claude/hooks/`, so they are outside what this compares. See
//     collectTemplateSet() for the rule.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"

const HOME = homedir()
const CLAUDE_HOME = join(HOME, ".claude")

// SAFETY_NET_TEMPLATE_DIR exists so the test harness can point at a fixture.
// Nothing in normal use sets it.
const TEMPLATE_DIR =
  process.env.SAFETY_NET_TEMPLATE_DIR || join(CLAUDE_HOME, "templates", "project-safety-nets")

const TEMPLATE_LABEL = process.env.SAFETY_NET_TEMPLATE_DIR
  ? TEMPLATE_DIR
  : "~/.claude/templates/project-safety-nets"

const ACCEPT_CMD = process.env.SAFETY_NET_TEMPLATE_DIR
  ? `node ${join(CLAUDE_HOME, "bin", "accept-safety-net-difference.mjs")}`
  : "node ~/.claude/bin/accept-safety-net-difference.mjs"

const EXCEPTIONS_PATH = join(".claude", "safety-net-exceptions.json")

// Which template files have actually run inside a real project. Default is
// unproven: a file absent from it is reported as never having run anywhere, so
// silence means not-yet-trusted rather than fine. Added 3 September 2026 after
// suite-lock.mjs shipped a deadlock its own green tests could not have caught,
// because they only covered cases its author had thought of. This check could
// say a file was missing; nothing could say it had never been run.
const PROVENANCE_PATH = join(TEMPLATE_DIR, "provenance.json")

const PROVE_CMD = process.env.SAFETY_NET_TEMPLATE_DIR
  ? `node ${join(CLAUDE_HOME, "bin", "record-safety-net-proof.mjs")}`
  : "node ~/.claude/bin/record-safety-net-proof.mjs"

// Sessions resumed or cleared still deserve the report; a compaction is the same
// session continuing and would just repeat it.
const SILENT_SOURCES = new Set(["compact"])

function readInput() {
  try {
    return JSON.parse(readFileSync(0, "utf8"))
  } catch {
    return {}
  }
}

// Same preference order as repo-boundary.mjs, and for the same reason: the shell's
// cwd wanders, the session's anchor does not.
function resolveProjectRoot(shellCwd) {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR
  if (fromEnv && existsSync(fromEnv)) return realpathSync(fromEnv)

  const start = shellCwd || process.cwd()
  let dir = existsSync(start) ? realpathSync(start) : resolve(start)
  const cwd = dir
  while (dirname(dir) !== dir) {
    if (existsSync(join(dir, ".git"))) return dir
    dir = dirname(dir)
  }
  return cwd
}

function isDir(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

// Which template files belong in a project's `.claude/hooks/`.
//
// The rule is discovery, not a hand-kept manifest: every top-level `.mjs` in the
// template, plus its `<name>.test.ts` sibling when one exists. A manifest would
// need updating by whoever adds a template file, and the case this check exists
// for is exactly the one where that person forgot. Everything else in the template
// dir goes somewhere other than `.claude/hooks/` and is not compared.
function collectTemplateSet() {
  const names = readdirSync(TEMPLATE_DIR)
  const hooks = names.filter((n) => n.endsWith(".mjs")).sort()
  const set = []
  for (const hook of hooks) {
    set.push(hook)
    const test = `${hook.replace(/\.mjs$/, "")}.test.ts`
    if (names.includes(test)) set.push(test)
  }
  return set
}

function readProvenance() {
  if (!existsSync(PROVENANCE_PATH)) return { proven: {}, unreadable: false }
  try {
    const parsed = JSON.parse(readFileSync(PROVENANCE_PATH, "utf8"))
    const proven = parsed && typeof parsed.proven === "object" ? parsed.proven : {}
    return { proven: proven || {}, unreadable: false }
  } catch {
    // Same choice as the exceptions file: an unreadable record is reported, not
    // silently treated as empty, because empty would call every file unproven.
    return { proven: {}, unreadable: true }
  }
}

function readExceptions(projectRoot) {
  const path = join(projectRoot, EXCEPTIONS_PATH)
  if (!existsSync(path)) return { accepted: {}, unreadable: false }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    const accepted = parsed && typeof parsed.accepted === "object" ? parsed.accepted : {}
    return { accepted: accepted || {}, unreadable: false }
  } catch {
    // Silently treating this as empty would bury every acceptance in the project
    // under a wall of reports with no explanation. Say what happened instead.
    return { accepted: {}, unreadable: true }
  }
}

function main() {
  const input = readInput()
  if (SILENT_SOURCES.has(input.source)) return ""

  if (!isDir(TEMPLATE_DIR)) return ""

  const projectRoot = resolveProjectRoot(input.cwd)

  // A session opened in ~/.claude itself is not a project that adopted the nets;
  // comparing its own hooks folder against the template would report every
  // template file as missing.
  if (projectRoot === CLAUDE_HOME || projectRoot.startsWith(`${CLAUDE_HOME}/`)) return ""

  const hooksDir = join(projectRoot, ".claude", "hooks")
  // No hooks folder means the project never adopted the safety nets. This is a
  // drift check, not an adoption nag.
  if (!isDir(hooksDir)) return ""

  const { accepted, unreadable } = readExceptions(projectRoot)

  const { proven, unreadable: provenanceUnreadable } = readProvenance()
  const isProven = (name) => Boolean(proven[name])
  // Provenance is recorded against the implementation file, not its test.
  const provable = (name) => name.endsWith(".mjs")

  const missing = []
  const expired = []
  const differs = []
  const unprovenInUse = []

  for (const name of collectTemplateSet()) {
    const templatePath = join(TEMPLATE_DIR, name)
    const projectPath = join(hooksDir, name)
    const present = existsSync(projectPath)

    if (present && readFileSync(projectPath).equals(readFileSync(templatePath))) {
      // Running a file nobody has ever proven is the case this check was added
      // for, and it is invisible from every other angle: identical to the
      // template, so nothing else here has anything to say about it.
      if (provable(name) && !isProven(name)) unprovenInUse.push(name)
      continue
    }

    const note = accepted[name]
    if (note && typeof note === "object") {
      if (note.templateSha256 === sha256(templatePath)) continue // accepted, and still current
      expired.push({ name, note, present })
      continue
    }

    if (present) differs.push(name)
    else missing.push(name)
  }

  if (!missing.length && !expired.length && !differs.length && !unprovenInUse.length && !unreadable && !provenanceUnreadable)
    return ""

  const lines = []
  const rel = (name) => `.claude/hooks/${name}`
  const tpl = (name) => `${TEMPLATE_LABEL}/${name}`
  const seeDiff = (name) => `  see it:   diff ${rel(name)} ${tpl(name)}`
  const adopt = (name) => `  adopt it: cp ${tpl(name)} .claude/hooks/`
  const keep = (name, why) => `  keep it:  ${ACCEPT_CMD} ${name} "${why}"`

  // Missing first: a file the project never had is usually a capability it never
  // picked up, and it is the one case a passing test suite will never reveal.
  const neverRun = (name) =>
    `  note:     ${name} has never run inside a project, so it is unproven rather than merely unadopted`

  for (const name of missing) {
    lines.push(`safety nets: the template has ${name} and this project does not`)
    lines.push(`  see it:   cat ${tpl(name)}`)
    lines.push(adopt(name))
    if (provable(name) && !isProven(name)) lines.push(neverRun(name))
    lines.push(keep(name, "why this project does without it"))
  }

  // Adopted, identical to the template, and never proven anywhere. Worth saying
  // because this project is the one in a position to prove it, and because a
  // green suite here is exactly what turns unproven into proven.
  for (const name of unprovenInUse) {
    lines.push(`safety nets: this project runs ${name}, which has never been recorded as proven anywhere`)
    lines.push(`  what that means: its own tests have not been seen green inside any real project's suite`)
    lines.push(`  record it: ${PROVE_CMD} ${name} <project> "what ran and passed"`)
  }

  for (const { name, note, present } of expired) {
    const on = note.acceptedOn ? ` on ${note.acceptedOn}` : ""
    const what = present ? "different" : "missing"
    lines.push(
      `safety nets: ${name} was accepted as ${what}${on}, and the template has changed since`
    )
    if (note.reason) lines.push(`  accepted because: ${note.reason}`)
    lines.push(present ? seeDiff(name) : `  see it:   cat ${tpl(name)}`)
    lines.push(adopt(name))
    lines.push(keep(name, "why it still holds against the new template"))
  }

  for (const name of differs) {
    lines.push(`safety nets: ${name} differs from the template`)
    lines.push(seeDiff(name))
    lines.push(adopt(name))
    lines.push(keep(name, "why this project differs"))
  }

  if (unreadable) {
    lines.push(
      `safety nets: ${EXCEPTIONS_PATH} could not be read, so no accepted difference counted this session`
    )
  }

  if (provenanceUnreadable) {
    lines.push(
      `safety nets: ${PROVENANCE_PATH} could not be read, so nothing counted as proven this session`
    )
  }

  if (missing.length) {
    lines.push("")
    lines.push(
      `adopting a file the project never had usually means registering it in .claude/settings.json too; ${TEMPLATE_LABEL}/README.md says how.`
    )
  }
  lines.push("")
  lines.push("Adoption is per file and yours to decide. Run these from the project root.")

  return lines.join("\n")
}

let report = ""
try {
  report = main()
} catch (err) {
  // A drift check that breaks session start is worse than one that misses drift.
  process.stderr.write(`safety-net-drift: ${err.message}\n`)
  process.exit(0)
}

if (report) {
  process.stdout.write(
    JSON.stringify({
      systemMessage: report,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `Safety-net drift detected between this project's .claude/hooks/ and ${TEMPLATE_LABEL}. Report shown to the user:\n\n${report}\n\nDo not adopt, copy, or accept anything on your own initiative; these are the user's decisions.`,
      },
    })
  )
}
process.exit(0)
