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
// What it does NOT do, deliberately: it never rewrites the substance of a file.
// Paths like `~/.claude/hooks/repo-boundary.mjs` are left exactly as written,
// because they are true statements about where these files live on the real
// machine, and this repo mirrors that layout so they resolve here too.
//
// It leaves content out at two grains. Whole files, via EXCLUDED below. And
// marked passages, via WITHHELD MARKERS, added 9 September 2026 because the
// file grain turned out to be too blunt: `decisions/rule-lineage.md` is the
// most useful document in the mirror and it acquired one paragraph of
// operational detail about other repositories, the exact thing EXCLUDED exists
// to keep out. Excluding the file to hide the paragraph would have cost the
// document; publishing the document would have cost the paragraph.
//
// WITHHELD MARKERS
// In a markdown file, a passage between these lines is dropped:
//
//   <!-- private: a short, publishable reason -->
//   ...withheld...
//   <!-- /private -->
//
// Each marker sits on its own line. The published copy carries a visible
// notice naming the reason in the passage's place, because a silent hole is
// worse than an acknowledged one: a reader who can see that something was
// withheld, and why, is not being misled about what this document is. The
// reason itself publishes, so write it knowing that.
//
// Markers are read tolerantly: indented, inside a blockquote, capitalised, or
// opened with extra dashes all count. That is a safety property, not a
// convenience. Strictness only fails safe when a deviation breaks ONE half of
// the pair, leaving it unbalanced and detectable; a deviation that defeats the
// open and the close equally leaves the pair balanced, and a strict parser then
// publishes the passage with exit 0 and no warning. Both reviews of this
// feature found exactly that, which is why the rule is now: understand it, or
// refuse the file.
//
// Refusing means the sync stops and writes nothing, for any file. That covers
// an unclosed marker, a close with no open, a nested open, a marker with no
// reason, a comment spanning several lines that mentions "private" (which hides
// the word from every line-by-line test here), a marker in a file that is not
// markdown, and the backstop: any line left over that still looks marker-shaped.
// A typo that published the passage it was meant to hide would be worse than
// having no feature at all.
//
// The escape hatch is code context. Inside a fenced block or backticks, a
// marker is an example and is passed through untouched, so this syntax can be
// written about in the very record it protects. Without that, documenting the
// feature here would abort every sync with no way around it.
//
// Known limit, accepted: the marker only fires where someone remembered to
// write it. Nothing here scans unmarked prose for the kind of detail that
// should have been marked. That belongs in a check of its own.
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

// Markers tolerate the ways they actually get written: indented to line up
// with a list item (this record is nested bullets throughout), inside a
// blockquote, or capitalised. Being strict here does not fail safe. A
// deviation that defeats the open and the close equally leaves the pair
// balanced, so nothing looks malformed and the passage publishes with exit 0.
// That is the one failure this feature exists to prevent, and review found it
// in the first version, which anchored markers flush-left and case-sensitively.
// An HTML comment may open with any number of dashes, and `<!---` is a
// spelling a hand produces, so `<!-+` throughout rather than a literal `<!--`.
const LEAD = /^[\s>]*/
const OPEN_WITH_REASON = /^<!-+\s*private\s*:\s*(.+?)\s*-+>\s*$/i
const OPEN_ANY = /^<!-+\s*private\b\s*:?\s*(.*?)\s*-+>\s*$/i
const CLOSE = /^<!-+\s*\/\s*private\s*-+>\s*$/i

// Anything marker-shaped at all, used as a backstop: a deviation this parser
// did not understand must stop the sync, never publish. It has to be looser
// than the parser, or it catches nothing the parser did not already catch.
const MARKER_SHAPED = /<!-+\s*\/?\s*private\b/i

// A fenced block, and inline code, are where someone writes ABOUT this syntax.
// A marker there is an example, not an instruction: passed through untouched
// and exempt from the backstop. Without that, documenting the feature in the
// record it was built for would abort every sync, with no way around it.
const FENCE = /^\s*(?:```|~~~)/
const INLINE_CODE = /`[^`]*`/g

// A comment spread over several lines hides the word `private` from every
// line-by-line test here. Parsing HTML properly is not worth it, so the
// arrangement is refused instead of guessed at.
const COMMENT_OPEN = /<!-+/
const COMMENT_CLOSE = /-+>/

// Returns the publishable text and how many passages were dropped. Throws on
// anything ambiguous rather than guessing, since guessing wrong publishes.
function withhold(rel, text) {
  const lines = text.split("\n")
  const out = []
  let openedAt = null
  let reason = null
  let count = 0

  let inFence = false
  let residueAt = null

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.replace(LEAD, "")
    const at = `${rel}:${i + 1}`

    if (FENCE.test(raw)) {
      inFence = !inFence
      if (openedAt === null) out.push(raw)
      continue
    }
    if (inFence) {
      if (openedAt === null) out.push(raw)
      continue
    }

    // Code spans are examples too, so they are invisible to every test below.
    const bare = line.replace(INLINE_CODE, "")

    const opens = COMMENT_OPEN.exec(bare)
    if (opens && !COMMENT_CLOSE.test(bare.slice(opens.index + opens[0].length))) {
      let body = bare.slice(opens.index)
      for (let j = i + 1; j < lines.length; j++) {
        body += `\n${lines[j]}`
        if (COMMENT_CLOSE.test(lines[j])) break
      }
      if (/private\b/i.test(body)) {
        throw new Error(
          `${at} opens an HTML comment that spans lines and mentions "private". ` +
            `Write the marker on one line as "<!-- private: why -->". Nothing was written.`,
        )
      }
    }

    if (residueAt === null && MARKER_SHAPED.test(bare) && !OPEN_ANY.test(line) && !CLOSE.test(line)) {
      residueAt = i + 1
    }

    if (OPEN_ANY.test(line)) {
      if (openedAt !== null) {
        throw new Error(`Nested <!-- private --> at ${at}; the one at ${rel}:${openedAt} is still open.`)
      }
      const withReason = line.match(OPEN_WITH_REASON)
      if (!withReason) {
        throw new Error(`<!-- private --> at ${at} gives no reason. Write "<!-- private: why -->"; the reason publishes.`)
      }
      openedAt = i + 1
      reason = withReason[1]
      continue
    }

    if (CLOSE.test(line)) {
      if (openedAt === null) throw new Error(`<!-- /private --> at ${at} closes nothing.`)
      out.push(`*(Withheld from the public mirror: ${reason})*`)
      openedAt = null
      reason = null
      count++
      continue
    }

    if (openedAt === null) out.push(raw)
  }

  if (openedAt !== null) {
    throw new Error(`Unclosed <!-- private --> at ${rel}:${openedAt}. Nothing was written.`)
  }

  if (residueAt !== null) {
    throw new Error(
      `${rel}:${residueAt} looks like a <!-- private --> marker but this parser did not ` +
        `understand it, so its intent is unknown. Nothing was written. Write it on its own ` +
        `line as "<!-- private: why -->" ... "<!-- /private -->", or put it in backticks or a ` +
        `fenced block if you meant to write about the syntax rather than use it.`,
    )
  }
  return { text: out.join("\n"), count }
}

// Every file is transformed before anything is written, so a malformed marker
// in the last file cannot leave the first ones already published.
let withheldPassages = 0
const publishable = new Map()
for (const rel of sourceFiles()) {
  const raw = readFileSync(join(SOURCE, rel))
  if (!rel.endsWith(".md")) {
    if (MARKER_SHAPED.test(raw.toString("utf8"))) {
      throw new Error(`${rel} carries a <!-- private --> marker, which only means anything in markdown.`)
    }
    publishable.set(rel, raw)
    continue
  }
  const { text, count } = withhold(rel, raw.toString("utf8"))
  withheldPassages += count
  publishable.set(rel, count ? Buffer.from(text, "utf8") : raw)
}

const want = [...publishable.keys()]
const have = mirroredNow()

if (withheldPassages) {
  const s = withheldPassages === 1 ? "passage" : "passages"
  console.log(`Withheld ${withheldPassages} ${s} marked private in the source.\n`)
}

const changed = []
for (const rel of want) {
  const src = publishable.get(rel)
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
