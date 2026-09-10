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

// --- withheld passages ------------------------------------------------------
//
// The exclusion list drops whole files, which is too blunt for a document that
// is mostly publishable and carries one private paragraph. A marked passage is
// dropped from the mirrored copy and replaced by a visible notice, so a reader
// sees that something was withheld and why, rather than a silent hole.

{
  const source = [
    "# Lineage",
    "",
    "Public reasoning that belongs in the mirror.",
    "",
    "<!-- private: operational detail about another repo -->",
    "The private paragraph, which must never reach the public mirror.",
    "<!-- /private -->",
    "",
    "More public reasoning.",
    "",
  ].join("\n")
  const f = fixture({ "decisions/rule-lineage.md": source })
  const r = run(f)
  const out = body(f.dest, "decisions/rule-lineage.md")

  check("withholds a marked passage from the mirror", !out.includes("The private paragraph"), out)
  check("keeps the public text around it", out.includes("Public reasoning") && out.includes("More public reasoning"))
  check("leaves a visible notice in its place", out.includes("Withheld from the public mirror"), out)
  check("  naming the reason given at the marker", out.includes("operational detail about another repo"), out)
  check("drops the markers themselves", !out.includes("<!-- private") && !out.includes("<!-- /private"))
  check(
    "never edits the source file itself",
    readFileSync(join(f.source, "decisions/rule-lineage.md"), "utf8") === source,
  )
  check("reports how many passages it withheld", r.stdout.includes("1 passage"), r.stdout)
  rmSync(f.root, { recursive: true, force: true })
}

// A file with no markers must still be copied byte for byte, or the feature has
// changed the behaviour of every other file in the mirror.

{
  const original = "no markers here, just prose about <!-- and --> characters\n"
  const f = fixture({ "CLAUDE.md": original })
  run(f)

  check("leaves an unmarked file byte for byte identical", body(f.dest, "CLAUDE.md") === original)
  rmSync(f.root, { recursive: true, force: true })
}

// --check must see a newly marked passage as a change, or marking something
// private would not propagate until some unrelated edit forced a sync.

{
  const published = "# Lineage\n\nkeep\n\nthe private paragraph\n"
  const marked = "# Lineage\n\nkeep\n\n<!-- private: reason -->\nthe private paragraph\n<!-- /private -->\n"
  const f = fixture({ "decisions/rule-lineage.md": marked }, { "decisions/rule-lineage.md": published })
  const r = run(f, ["--check"])

  check("--check sees a newly marked passage as a change", r.code === 1, `exit ${r.code}`)
  check("--check writes nothing when a passage is marked", body(f.dest, "decisions/rule-lineage.md") === published)
  rmSync(f.root, { recursive: true, force: true })
}

// --- a broken marker fails loudly ------------------------------------------
//
// The whole value of this feature is that it cannot fail quietly. A typo in a
// marker must stop the sync, never publish the passage it was meant to hide.

{
  const f = fixture({ "decisions/rule-lineage.md": "# L\n\n<!-- private: reason -->\nsecret\n" })
  const r = run(f)

  check("fails loudly on an unclosed marker", r.code !== 0, `exit ${r.code}`)
  check("  and does not publish the passage", !has(f.dest, "decisions/rule-lineage.md"))
  check("  and names the file", r.stdout.includes("rule-lineage.md"), r.stdout)
  rmSync(f.root, { recursive: true, force: true })
}

{
  const f = fixture({ "decisions/rule-lineage.md": "# L\n\nsecret\n<!-- /private -->\n" })
  const r = run(f)

  check("fails loudly on a close with no open", r.code !== 0, `exit ${r.code}`)
  rmSync(f.root, { recursive: true, force: true })
}

{
  const f = fixture({
    "decisions/rule-lineage.md": "<!-- private: a -->\nx\n<!-- private: b -->\ny\n<!-- /private -->\n",
  })
  const r = run(f)

  check("fails loudly on a nested open", r.code !== 0, `exit ${r.code}`)
  rmSync(f.root, { recursive: true, force: true })
}

{
  const f = fixture({ "decisions/rule-lineage.md": "<!-- private -->\nx\n<!-- /private -->\n" })
  const r = run(f)

  check("fails loudly when a marker gives no reason", r.code !== 0, `exit ${r.code}`)
  rmSync(f.root, { recursive: true, force: true })
}

// A marker only means anything in markdown. In any other file it is not a
// comment, so honouring it would be guesswork; refuse rather than guess.

{
  const f = fixture({ "hooks/guard.mjs": "// <!-- private: reason -->\nconst x = 1\n// <!-- /private -->\n" })
  const r = run(f)

  check("fails loudly on a marker outside a markdown file", r.code !== 0, `exit ${r.code}`)
  check("  and does not publish it", !has(f.dest, "hooks/guard.mjs"))
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
