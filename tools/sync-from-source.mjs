#!/usr/bin/env node
// Regenerates this repo's mirrored files from the live configuration on the
// author's machine (~/.claude, or $CLAUDE_CONFIG_DIR).
//
// Why this exists rather than hand-maintained copies: this repo is a curated
// PUBLIC subset of a PRIVATE backup repo. A hand-copied subset goes stale
// silently the moment the real file is edited, and a stale copy of a document
// whose whole point is "these are the rules I actually work under" is worse
// than no copy at all. Regenerating makes an update one command instead of a
// memory.
//
// What it does NOT do, deliberately: it never rewrites the contents of a file.
// Paths like `~/.claude/hooks/repo-boundary.mjs` are left exactly as written,
// because they are true statements about where these files live on the real
// machine, and this repo mirrors that layout so they resolve here too. What it
// leaves out instead of rewriting is whole files; see EXCLUDED below.
//
// Tested by tools/test-sync-from-source.mjs, added 9 Sep 2026 by the change
// that excluded access-protections.md, honoring the note this header used to
// carry: that no test covered the script and one belonged in whatever change
// touched it next. The harness copies this file into a scratch directory so it
// runs the shipped script byte for byte without writing into the real repo.
//
// Usage:  node tools/sync-from-source.mjs [--check]
//   --check exits nonzero if the mirror is out of date, and writes nothing.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, statSync } from "node:fs"
import { join, dirname, relative } from "node:path"
import { homedir } from "node:os"
import { execFileSync } from "node:child_process"

const SOURCE = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")
const DEST = join(dirname(new URL(import.meta.url).pathname), "..")
const CHECK = process.argv.includes("--check")

// Everything the source repo tracks is mirrored EXCEPT these.
//
// settings.json: carries an `autoMode.environment` block profiling other
//   projects (their deploy URLs, how their secrets are held, which branches are
//   unprotected). None of it is a credential and all of it is an operational map
//   of repos this artifact has no business describing.
// decisions/access-protections.md: the reasoning behind settings.json, and so
//   it inherits settings.json's problem in a more readable form: the same map
//   of other repositories, in prose. Note what the reason is NOT. Each hook
//   here publishes its own limits in its own header on purpose, so no single
//   gap is a secret. What that record adds is aggregation, every gap and every
//   permission and every repository in one place, and excluding the
//   configuration while publishing its rationale would have published the more
//   useful half. A public-safe rewrite of that reasoning would be welcome
//   here; a mirror of the live file is not, and the default has to be the
//   safe one.
// README.md: this repo has its own, written for a different reader.
// .gitignore: the source's ignore rules are about backing up a home directory.
const EXCLUDED = new Set([
  "settings.json",
  "decisions/access-protections.md",
  "README.md",
  ".gitignore",
])

// Directories this repo owns outright, never touched by the mirror.
const OURS = new Set(["tools", ".git", "README.md", ".gitignore", "LICENSE"])

function sourceFiles() {
  if (!existsSync(join(SOURCE, ".git"))) {
    throw new Error(`No git repo at ${SOURCE}. Set CLAUDE_CONFIG_DIR or run this on the machine that holds it.`)
  }
  return execFileSync("git", ["-C", SOURCE, "ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f && !EXCLUDED.has(f))
    .sort()
}

function mirroredNow() {
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const rel = relative(DEST, full)
      if (OURS.has(rel.split("/")[0])) continue
      if (statSync(full).isDirectory()) walk(full)
      else out.push(rel)
    }
  }
  walk(DEST)
  return out.sort()
}

const want = sourceFiles()
const have = mirroredNow()

const changed = []
for (const rel of want) {
  const src = readFileSync(join(SOURCE, rel))
  const dst = join(DEST, rel)
  const current = existsSync(dst) ? readFileSync(dst) : null
  if (current === null || !current.equals(src)) {
    changed.push((current === null ? "add    " : "update ") + rel)
    if (!CHECK) {
      mkdirSync(dirname(dst), { recursive: true })
      writeFileSync(dst, src)
    }
  }
}

// Removals must propagate, or a rule deleted upstream lives on here forever.
for (const rel of have) {
  if (!want.includes(rel)) {
    changed.push("remove " + rel)
    if (!CHECK) rmSync(join(DEST, rel))
  }
}

if (!changed.length) {
  console.log(`In sync with ${SOURCE} (${want.length} files).`)
  process.exit(0)
}

console.log(changed.join("\n"))
console.log(`\n${changed.length} change(s) against ${SOURCE}.`)
if (CHECK) {
  console.log("Run without --check to apply.")
  process.exit(1)
}
