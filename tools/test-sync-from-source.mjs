#!/usr/bin/env node
// Test harness for tools/sync-from-source.mjs.
//
// WHY THIS EXISTS
// The script's own header carried a note that no test covered it, and that one
// belonged in whatever change next touched the file. This is that change: the
// 9 September 2026 pass that excluded decisions/access-protections.md from the
// public mirror. The exclusion list is the one part of this script where a
// mistake is silent and consequential, because a file that should never have
// been published is indistinguishable from one that was meant to be there.
//
// HOW IT WORKS
// The real script is copied into a throwaway directory, which makes that
// directory its DEST (it derives DEST from its own location). A fake source
// repo is built beside it. So these tests run the shipped file byte for byte,
// against scratch directories, and can never write into the real repo.
//
//   node tools/test-sync-from-source.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { execFileSync } from "node:child_process"

const SCRIPT = join(dirname(new URL(import.meta.url).pathname), "sync-from-source.mjs")

let passed = 0
let failed = 0

function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`)
    passed++
  } else {
    console.log(`  FAIL  ${name}`)
    if (detail) console.log(`        ${detail}`)
    failed++
  }
}

// Builds a fake ~/.claude (a real git repo, since the script asks git what is
// tracked) and a fake mirror with the script installed in its tools/.
function fixture(sourceFiles, destFiles = {}) {
  const root = mkdtempSync(join(tmpdir(), "sync-test-"))
  const source = join(root, "source")
  const dest = join(root, "dest")

  for (const [rel, body] of Object.entries(sourceFiles)) {
    mkdirSync(join(source, dirname(rel)), { recursive: true })
    writeFileSync(join(source, rel), body)
  }
  execFileSync("git", ["init", "-q"], { cwd: source })
  execFileSync("git", ["add", "-A"], { cwd: source })

  for (const [rel, body] of Object.entries(destFiles)) {
    mkdirSync(join(dest, dirname(rel)), { recursive: true })
    writeFileSync(join(dest, rel), body)
  }
  mkdirSync(join(dest, "tools"), { recursive: true })
  cpSync(SCRIPT, join(dest, "tools", "sync-from-source.mjs"))

  return { root, source, dest }
}

function run({ source, dest }, args = []) {
  try {
    const stdout = execFileSync("node", [join(dest, "tools", "sync-from-source.mjs"), ...args], {
      encoding: "utf8",
      // execFileSync passes stderr through to this process by default, which
      // would print the stack trace from the deliberate no-git-repo case.
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CLAUDE_CONFIG_DIR: source },
    })
    return { stdout, code: 0 }
  } catch (e) {
    return { stdout: (e.stdout ?? "") + (e.stderr ?? ""), code: e.status }
  }
}

const has = (dest, rel) => existsSync(join(dest, rel))
const body = (dest, rel) => readFileSync(join(dest, rel), "utf8")

// --- the mirror copies, updates and deletes -------------------------------

{
  const f = fixture(
    { "CLAUDE.md": "the rules\n", "hooks/guard.mjs": "new body\n" },
    { "hooks/guard.mjs": "stale body\n", "decisions/deleted-upstream.md": "gone\n" },
  )
  const r = run(f)

  check("adds a file the mirror is missing", has(f.dest, "CLAUDE.md"))
  check("updates a file whose contents changed", body(f.dest, "hooks/guard.mjs") === "new body\n")
  check(
    "deletes a file removed upstream, so an old rule cannot live on",
    !has(f.dest, "decisions/deleted-upstream.md"),
  )
  check("leaves this repo's own tools/ alone", has(f.dest, "tools/sync-from-source.mjs"))
  check("reports what it did", r.stdout.includes("update hooks/guard.mjs"), r.stdout)
  rmSync(f.root, { recursive: true, force: true })
}

// --- the exclusion list ---------------------------------------------------
//
// The point of the whole script. Each of these exists in the source and must
// never appear in the public mirror.

{
  const f = fixture({
    "CLAUDE.md": "the rules\n",
    "settings.json": "{ profiles other repos }\n",
    "README.md": "the private readme\n",
    ".gitignore": "home directory ignores\n",
    "decisions/access-protections.md": "where the fence is thin\n",
    "decisions/rule-lineage.md": "why each rule exists\n",
  })
  run(f)

  check("mirrors an ordinary tracked file", has(f.dest, "CLAUDE.md"))
  check("mirrors the other decisions files", has(f.dest, "decisions/rule-lineage.md"))
  check("excludes settings.json", !has(f.dest, "settings.json"))
  check("excludes the source's README.md", !has(f.dest, "README.md"))
  check("excludes the source's .gitignore", !has(f.dest, ".gitignore"))
  check("excludes decisions/access-protections.md", !has(f.dest, "decisions/access-protections.md"))
  rmSync(f.root, { recursive: true, force: true })
}

// An excluded file already sitting in the mirror must be removed, not merely
// skipped. Otherwise adding a name to the list protects future syncs only, and
// the file it was added for stays published.

{
  const f = fixture(
    { "CLAUDE.md": "the rules\n", "decisions/access-protections.md": "where the fence is thin\n" },
    { "decisions/access-protections.md": "published by an earlier sync\n" },
  )
  run(f)

  check(
    "removes an excluded file an earlier sync had already published",
    !has(f.dest, "decisions/access-protections.md"),
  )
  rmSync(f.root, { recursive: true, force: true })
}

// --- --check reports without writing --------------------------------------

{
  const f = fixture({ "CLAUDE.md": "the rules\n" })
  const r = run(f, ["--check"])

  check("--check exits nonzero when the mirror is stale", r.code === 1, `exit ${r.code}`)
  check("--check writes nothing", !has(f.dest, "CLAUDE.md"))
  rmSync(f.root, { recursive: true, force: true })
}

{
  const f = fixture({ "CLAUDE.md": "the rules\n" }, { "CLAUDE.md": "the rules\n" })
  const r = run(f, ["--check"])

  check("--check exits zero when the mirror is current", r.code === 0, `exit ${r.code}`)
  check("  and says so", r.stdout.includes("In sync"), r.stdout)
  rmSync(f.root, { recursive: true, force: true })
}

// --- contents are never rewritten -----------------------------------------
//
// Paths like ~/.claude/hooks/repo-boundary.mjs are true statements about the
// real machine, and this repo mirrors that layout so they resolve here too.

{
  const original = "see ~/.claude/hooks/repo-boundary.mjs and $HOME/.claude/bin\n"
  const f = fixture({ "CLAUDE.md": original })
  run(f)

  check("copies file contents byte for byte, rewriting no paths", body(f.dest, "CLAUDE.md") === original)
  rmSync(f.root, { recursive: true, force: true })
}

// --- it refuses to guess ---------------------------------------------------

{
  const f = fixture({ "CLAUDE.md": "the rules\n" })
  rmSync(join(f.source, ".git"), { recursive: true, force: true })
  const r = run(f)

  check("fails loudly when the source is not a git repo", r.code !== 0, `exit ${r.code}`)
  check("  and says which directory it looked in", r.stdout.includes(f.source), r.stdout)
  rmSync(f.root, { recursive: true, force: true })
}

console.log(`\n  ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
