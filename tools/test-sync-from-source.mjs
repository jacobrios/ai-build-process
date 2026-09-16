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
  check(
    "  naming the reason inside that notice, not merely somewhere in the file",
    out.includes("Withheld from the public mirror: operational detail about another repo"),
    out,
  )
  check("drops the markers themselves", !out.includes("<!-- private") && !out.includes("<!-- /private"))
  check(
    "never edits the source file itself",
    readFileSync(join(f.source, "decisions/rule-lineage.md"), "utf8") === source,
  )
  check("reports how many passages it withheld", r.stdout.includes("Withheld 1 passage marked"), r.stdout)
  rmSync(f.root, { recursive: true, force: true })
}

// A file with no markers must still be copied byte for byte, or the feature has
// changed the behaviour of every other file in the mirror.

{
  const original = "no markers here, just ordinary prose with arrows -> and --> in it\n"
  const f = fixture({ "CLAUDE.md": original })
  run(f)

  check(
    "leaves a file with no comment in it byte for byte identical",
    has(f.dest, "CLAUDE.md") && body(f.dest, "CLAUDE.md") === original,
  )
  rmSync(f.root, { recursive: true, force: true })
}

// The price of refusing every HTML comment, pinned here so it is a decision
// rather than a surprise. This fixture used to read "prose about <!-- and -->
// characters" and it stopped being publishable when the backstop widened.
// Today no mirrored file contains a comment at all, so nothing is lost yet.

{
  const f = fixture({ "CLAUDE.md": "prose that merely mentions an <!-- opener -->\n" })
  const r = run(f)

  check("refuses ordinary prose containing an HTML comment", r.code !== 0, `exit ${r.code}`)
  check("  and says the line it objected to", /CLAUDE\.md:1/.test(r.stdout), r.stdout)
  rmSync(f.root, { recursive: true, force: true })
}

// --check must compare against the WITHHELD form, not the raw source. Both
// halves matter: a mirror still carrying the passage is stale, and a mirror
// already carrying the notice is current. Comparing raw bytes would report
// both as changes and neither test would mean anything.

const MARKED = "# Lineage\n\nkeep\n\n<!-- private: reason -->\nthe private paragraph\n<!-- /private -->\n"
const WITHHELD = "# Lineage\n\nkeep\n\n*(Withheld from the public mirror: reason)*\n"

{
  // The dest is the source's own bytes, markers and all. If withholding were
  // reverted the two would match and --check would call it in sync, so this
  // pins the comparison to the withheld form rather than to any byte change.
  const f = fixture({ "decisions/rule-lineage.md": MARKED }, { "decisions/rule-lineage.md": MARKED })
  const r = run(f, ["--check"])

  check("--check sees a mirror still carrying the passage as stale", r.code === 1, `exit ${r.code}\n${r.stdout}`)
  check("--check writes nothing when a passage is marked", body(f.dest, "decisions/rule-lineage.md") === MARKED)
  rmSync(f.root, { recursive: true, force: true })
}

{
  const f = fixture({ "decisions/rule-lineage.md": MARKED }, { "decisions/rule-lineage.md": WITHHELD })
  const r = run(f, ["--check"])

  check("--check calls a mirror carrying the notice current", r.code === 0, `exit ${r.code}\n${r.stdout}`)
  rmSync(f.root, { recursive: true, force: true })
}

// --- markers as they get written by hand ------------------------------------
//
// The leak this guards against is a marker pair that BOTH halves of a
// deviation defeat equally: the pair stays balanced, nothing looks malformed,
// and the passage publishes with exit 0 and no warning. Found by review on
// 9 September 2026, after the first version anchored markers flush-left and
// case-sensitively. The lineage record is nested bullets throughout, so an
// indented marker is the likely way to write one, not an exotic case.

for (const [name, open, close] of [
  ["indented to line up with a list item", "  <!-- private: reason -->", "  <!-- /private -->"],
  ["indented with a tab", "\t<!-- private: reason -->", "\t<!-- /private -->"],
  ["inside a blockquote", "> <!-- private: reason -->", "> <!-- /private -->"],
  ["written in capitals", "<!-- PRIVATE: reason -->", "<!-- /PRIVATE -->"],
  ["capitalised as a sentence", "<!-- Private: reason -->", "<!-- /Private -->"],
]) {
  const f = fixture({ "decisions/rule-lineage.md": `# L\n\n${open}\nSECRET\n${close}\n` })
  run(f)
  const out = has(f.dest, "decisions/rule-lineage.md") ? body(f.dest, "decisions/rule-lineage.md") : ""

  // Asserting only "the secret did not publish" would be satisfied by the
  // residue backstop aborting the whole sync, which is safe but is not this
  // behaviour. Require the file to exist and carry the notice.
  check(
    `withholds a marker pair ${name}`,
    out.includes("Withheld from the public mirror") && !out.includes("SECRET"),
    out || "(nothing published: the sync aborted rather than withholding)",
  )
  rmSync(f.root, { recursive: true, force: true })
}

// An HTML comment may legally open with more than two dashes, and `<!---` is a
// spelling a hand would produce. It defeated both halves of the pair equally in
// the first fix, which is the leak condition, so it is honoured rather than
// merely caught. Found by the second review, 9 September 2026.

for (const [name, open, close] of [
  ["with three dashes", "<!--- private: reason --->", "<!--- /private --->"],
  ["with four dashes", "<!---- private: reason ---->", "<!---- /private ---->"],
  ["with an extra dash on the open only", "<!--- private: reason -->", "<!-- /private -->"],
]) {
  const f = fixture({ "decisions/rule-lineage.md": `# L\n\n${open}\nSECRET\n${close}\n` })
  run(f)
  const out = has(f.dest, "decisions/rule-lineage.md") ? body(f.dest, "decisions/rule-lineage.md") : ""

  check(
    `withholds a marker pair ${name}`,
    out.includes("Withheld from the public mirror") && !out.includes("SECRET"),
    out || "(nothing published: the sync aborted rather than withholding)",
  )
  rmSync(f.root, { recursive: true, force: true })
}

// A comment spread over three lines hides the word `private` from any
// line-by-line check. It cannot be honoured without parsing HTML comments
// properly, so it is refused instead.

{
  const f = fixture({ "decisions/rule-lineage.md": "# L\n\n<!--\nprivate: reason\n-->\nSECRET\n<!--\n/private\n-->\n" })
  const r = run(f)

  check("fails loudly on a marker split across lines", r.code !== 0, `exit ${r.code}`)
  check("  and publishes nothing", !has(f.dest, "decisions/rule-lineage.md"))
  rmSync(f.root, { recursive: true, force: true })
}

// The non-markdown refusal must use the same tolerant test as everything else.
// A capitalised marker in a hook file was slipping through it.

{
  const f = fixture({ "hooks/guard.mjs": "// <!-- PRIVATE: reason -->\nconst x = 1\n// <!-- /PRIVATE -->\n" })
  const r = run(f)

  check("fails loudly on a capitalised marker outside markdown", r.code !== 0, `exit ${r.code}`)
  check("  and publishes nothing", !has(f.dest, "hooks/guard.mjs"))
  rmSync(f.root, { recursive: true, force: true })
}

// --- code context is NOT an escape hatch ------------------------------------
//
// The second fix exempted fenced blocks and backticks so the syntax could be
// written about in the record it protects. The third review broke that two
// ways: one unmatched fence line anywhere above a marker disabled withholding
// for the rest of the file, and backticks hid a marker from the backstop while
// also hiding it from the parser, which is the balanced-pair leak again.
//
// Both came from one source: context that has to be tracked can be put into
// the wrong state from a distance, by an edit nowhere near the marker. So
// there is no code context any more. Marker-shaped text is either a marker or
// an error, wherever it appears. The cost is that a mirrored document cannot
// quote this syntax; the syntax is documented in the sync script's own header,
// which lives in this repo and is not mirrored.

// Both outcomes for marker-shaped text are safe, and which one you get depends
// only on whether the pair is well formed, never on surrounding context. A
// well-formed pair inside a fence is treated as a marker and withheld: the
// example disappears from the mirror, which is a documentation cost, not a
// leak. Anything not well formed refuses the whole file. Refusing the fenced
// case instead would mean tracking fences, which is what produced two leaks.

{
  const f = fixture({
    "decisions/rule-lineage.md": "# L\n\n```markdown\n<!-- private: why -->\nEXAMPLE\n<!-- /private -->\n```\n",
  })
  const r = run(f)
  const out = has(f.dest, "decisions/rule-lineage.md") ? body(f.dest, "decisions/rule-lineage.md") : ""

  check("treats a well-formed pair inside a fence as a marker, not an example", r.code === 0, `exit ${r.code}`)
  check("  withholding it rather than publishing it", !out.includes("EXAMPLE"), out)
  rmSync(f.root, { recursive: true, force: true })
}

for (const [name, open, close] of [
  ["wrapping the whole marker", "`<!-- private: reason -->`", "`<!-- /private -->`"],
  ["splitting it mid-marker", "the opener `<!--` private: reason -->", "the closer `<!--` /private -->"],
  ["around the word alone", "<!-- `private`: reason -->", "<!-- `/private` -->"],
]) {
  const f = fixture({ "decisions/rule-lineage.md": `# L\n\n${open}\nSECRET\n${close}\n` })
  const r = run(f)
  const out = has(f.dest, "decisions/rule-lineage.md") ? body(f.dest, "decisions/rule-lineage.md") : ""

  check(`backticks ${name} cannot publish the passage`, !out.includes("SECRET"), out)
  check("  the file is refused rather than published", r.code !== 0, `exit ${r.code}`)
  rmSync(f.root, { recursive: true, force: true })
}

// The finding that mattered most: the deviation was nowhere near the marker.
// An unclosed fence earlier in the document put the parser into a state where
// a correctly written marker pair published verbatim, exit 0, no notice.

for (const [name, preamble] of [
  ["an unmatched fence above a marker", "```js\nnever closed\n"],
  ["a prose line that merely starts with backticks", "```-fenced blocks were the old escape hatch.\n"],
  ["a lone tilde fence", "~~~\nnever closed\n"],
]) {
  const f = fixture({
    "decisions/rule-lineage.md": `# L\n\n${preamble}\n<!-- private: reason -->\nSECRET\n<!-- /private -->\n`,
  })
  run(f)
  const out = has(f.dest, "decisions/rule-lineage.md") ? body(f.dest, "decisions/rule-lineage.md") : ""

  check(
    `${name} cannot publish the passage`,
    out.includes("Withheld from the public mirror") && !out.includes("SECRET"),
    out || "(nothing published)",
  )
  rmSync(f.root, { recursive: true, force: true })
}

// The notice takes the marker's own indentation. Without that it lands
// flush-left inside an indented bullet, which ends the list item and splits
// the entry across three blocks on the rendered page. Cosmetic, but the
// rendered page is the thing a stranger actually reads.

{
  const f = fixture({
    "decisions/rule-lineage.md": "- a bullet\n  <!-- private: reason -->\n  withheld\n  <!-- /private -->\n  and more\n",
  })
  run(f)
  const out = body(f.dest, "decisions/rule-lineage.md")

  check(
    "indents the notice to match the marker it replaces",
    out.includes("\n  *(Withheld from the public mirror: reason)*\n"),
    JSON.stringify(out),
  )
  rmSync(f.root, { recursive: true, force: true })
}

// --- a mistyped marker must not publish invisibly ---------------------------
//
// The fourth review's central finding. A marker whose WORD is wrong
// (`privacy`, `private_note`, `secret`) defeated the parser and the backstop
// at once, because both were keyed on the word. The pair stayed balanced, and
// because the line is still a valid HTML comment a renderer HIDES it, so the
// withheld paragraph reads as ordinary published prose with nothing anywhere
// signalling it. That is the worst shape this feature can fail in.
//
// No detector keyed on a word can catch a different word, so the rule stops
// being about the word: an HTML comment in a mirrored markdown file is a
// well-formed marker or it is an error. No mirrored file contains one today,
// so the cost is future-only and loud.

for (const [name, open, close] of [
  ["a synonym", "<!-- privacy: reason -->", "<!-- /privacy -->"],
  ["an underscore suffix", "<!-- private_note: reason -->", "<!-- /private_note -->"],
  ["a plural", "<!-- privates: reason -->", "<!-- /privates -->"],
  ["a different word entirely", "<!-- secret: reason -->", "<!-- /secret -->"],
]) {
  const f = fixture({ "decisions/rule-lineage.md": `# L\n\n${open}\nSECRET\n${close}\n` })
  const r = run(f)
  const out = has(f.dest, "decisions/rule-lineage.md") ? body(f.dest, "decisions/rule-lineage.md") : ""

  check(`a marker mistyped as ${name} cannot publish the passage`, !out.includes("SECRET"), out)
  check("  the file is refused rather than published", r.code !== 0, `exit ${r.code}`)
  rmSync(f.root, { recursive: true, force: true })
}

// An ordinary HTML comment is refused for the same reason: nothing can tell it
// from a marker whose word was mistyped.

{
  const f = fixture({ "decisions/rule-lineage.md": "# L\n\n<!-- an ordinary note to self -->\n" })
  const r = run(f)

  check("refuses an ordinary HTML comment rather than guess it is not a marker", r.code !== 0, `exit ${r.code}`)
  rmSync(f.root, { recursive: true, force: true })
}

// The non-markdown refusal must be as crude as the markdown one. It was using
// the narrow test, so a marker with anything between the opener and the word
// published the whole file.

{
  const f = fixture({
    "hooks/guard.mjs": "// <!-- begin private: deploy map -->\nconst SECRET = 1\n// <!-- end private -->\n",
  })
  const r = run(f)

  check("refuses a loosely-worded marker outside markdown too", r.code !== 0, `exit ${r.code}`)
  check("  and publishes nothing", !has(f.dest, "hooks/guard.mjs"))
  rmSync(f.root, { recursive: true, force: true })
}

// --- the exclusion list is not case-sensitive -------------------------------
//
// `EXCLUDED.has(path)` is exact-match, and macOS filesystems are not. A
// case-only rename upstream would have published the two files this whole
// script exists to withhold, silently.

{
  const f = fixture({
    "CLAUDE.md": "the rules\n",
    "Settings.json": "{ profiles other repos }\n",
    "decisions/Access-Protections.md": "where the fence is thin\n",
  })
  run(f)

  check("excludes settings.json whatever its case", !has(f.dest, "Settings.json"))
  check("excludes access-protections.md whatever its case", !has(f.dest, "decisions/Access-Protections.md"))
  rmSync(f.root, { recursive: true, force: true })
}

// --- the notice cannot be broken out of -------------------------------------
//
// The reason publishes verbatim inside the notice. A reason carrying comment
// syntax turned the acknowledged hole into a silent one: `-->` closed the
// notice and the stray `<!--` swallowed the rest of the rendered document.

{
  const f = fixture({
    "decisions/rule-lineage.md": "# L\n\n<!-- private: see the note --><!-- -->\nSECRET\n<!-- /private -->\n",
  })
  const r = run(f)

  check("refuses a reason carrying comment syntax", r.code !== 0, `exit ${r.code}`)
  check("  and publishes nothing", !has(f.dest, "decisions/rule-lineage.md"))
  rmSync(f.root, { recursive: true, force: true })
}

// The backstop for every deviation not handled above: if anything still looks
// like a marker after the pass, the file is not publishable. Trailing content
// after `-->` defeats both halves equally, so balance alone would not catch it.

{
  const f = fixture({
    "decisions/rule-lineage.md": "# L\n\n<!-- private: reason --> x\nSECRET\n<!-- /private --> x\n",
  })
  const r = run(f)

  check("fails loudly when marker-shaped text survives the pass", r.code !== 0, `exit ${r.code}`)
  check("  and publishes nothing", !has(f.dest, "decisions/rule-lineage.md"))
  rmSync(f.root, { recursive: true, force: true })
}

{
  const f = fixture({
    "decisions/rule-lineage.md":
      "<!-- private: one -->\na\n<!-- /private -->\n\n<!-- private: two -->\nb\n<!-- /private -->\n",
  })
  const r = run(f)

  check("counts more than one withheld passage", r.stdout.includes("2 passages"), r.stdout)
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
  check(
    "  and the failure names the file and line",
    r.code !== 0 && /rule-lineage\.md:3/.test(r.stdout),
    r.stdout,
  )
  rmSync(f.root, { recursive: true, force: true })
}

{
  const f = fixture({ "decisions/rule-lineage.md": "# L\n\nsecret\n<!-- /private -->\n" })
  const r = run(f)

  check("fails loudly on a close with no open", r.code !== 0, `exit ${r.code}`)
  check("  and publishes nothing", !has(f.dest, "decisions/rule-lineage.md"))
  rmSync(f.root, { recursive: true, force: true })
}

{
  const f = fixture({
    "decisions/rule-lineage.md": "<!-- private: a -->\nx\n<!-- private: b -->\ny\n<!-- /private -->\n",
  })
  const r = run(f)

  check("fails loudly on a nested open", r.code !== 0, `exit ${r.code}`)
  check("  and publishes nothing", !has(f.dest, "decisions/rule-lineage.md"))
  rmSync(f.root, { recursive: true, force: true })
}

{
  const f = fixture({ "decisions/rule-lineage.md": "<!-- private -->\nx\n<!-- /private -->\n" })
  const r = run(f)

  check("fails loudly when a marker gives no reason", r.code !== 0, `exit ${r.code}`)
  check("  and publishes nothing", !has(f.dest, "decisions/rule-lineage.md"))
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

// --- the mirror's own .gitignore is honoured --------------------------------
//
// mirroredNow() walks the filesystem, so it sees what git ignores. A Finder
// visit left a .DS_Store in the real repo and --check reported it as a removal
// forever after, which ruins a gate whose whole value is being quiet. And a
// real sync would have deleted a local file the mirror has no business touching.

{
  const f = fixture({ "CLAUDE.md": "the rules\n" }, { "CLAUDE.md": "the rules\n" })
  execFileSync("git", ["init", "-q"], { cwd: f.dest })
  writeFileSync(join(f.dest, ".gitignore"), ".DS_Store\n")
  writeFileSync(join(f.dest, ".DS_Store"), "finder was here\n")
  const r = run(f, ["--check"])

  check("ignores files the mirror's .gitignore ignores, so --check stays quiet", r.code === 0 && !r.stdout.includes(".DS_Store"), `exit ${r.code}\n${r.stdout}`)
  run(f)
  check("  and never deletes them", has(f.dest, ".DS_Store"))
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
