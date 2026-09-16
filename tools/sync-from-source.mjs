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
// There is no escape hatch, and that is the third review's doing. A version
// that exempted fenced blocks and backticks, so the syntax could be documented
// in the record it protects, leaked two ways: one unmatched fence line
// anywhere above a marker switched withholding off for the rest of the file,
// and a backtick hid a marker from the backstop while also hiding it from the
// parser. Both are the same shape, context tracked across lines that an edit
// far from the marker can put into the wrong state. So no line is exempt.
//
// THE BACKSTOP: in a mirrored markdown file, an HTML comment is a well-formed
// marker or it is an error. It is not keyed on the word "private", and that is
// the fourth review's doing. Every narrower version was defeated by mistyping
// the thing it keyed on, and since a hand mistypes the open and the close the
// same way, the pair stayed balanced and the passage published at exit 0.
// `<!-- privacy: … -->` was the case that settled it: a synonym slip, and
// because the line is still a valid comment a renderer HIDES it, so the
// passage read as ordinary published prose with nothing signalling the
// failure. No detector keyed on a word can catch a different word.
//
// The cost, accepted: a mirrored document cannot quote this syntax, and cannot
// carry an HTML comment at all. Both are loud, and no mirrored file contains a
// comment today. This header is where the syntax is documented, and this file
// is not mirrored.
//
// WHAT THIS STILL CANNOT DO. A marker whose opener is mistyped into something
// that is not an HTML comment (`<-- private: … -->`, or smart-dashed `<!— … —>`)
// is invisible to all of the above and publishes the passage. It renders as
// literal text rather than disappearing, so it is visible in the result rather
// than silent, which is the only reason it is tolerated. The general form of
// this limit is the one below: a marker only protects what someone remembered
// to mark, correctly.
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
// Held lowercase and compared lowercase. macOS filesystems are case-insensitive,
// so an exact-match list would have let a case-only rename upstream publish the
// two files this whole script exists to withhold, silently. Found by review.
const EXCLUDED = new Set(
  ["settings.json", "decisions/access-protections.md", "README.md", ".gitignore"].map((f) => f.toLowerCase()),
)

// Directories this repo owns outright, never touched by the mirror.
const OURS = new Set(["tools", ".git", "README.md", ".gitignore", "LICENSE"])

function sourceFiles() {
  if (!existsSync(join(SOURCE, ".git"))) {
    throw new Error(`No git repo at ${SOURCE}. Set CLAUDE_CONFIG_DIR or run this on the machine that holds it.`)
  }
  return execFileSync("git", ["-C", SOURCE, "ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f && !EXCLUDED.has(f.toLowerCase()))
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
  const skip = ignored(out)
  return out.filter((rel) => !skip.has(rel)).sort()
}

// The walk sees what git ignores, so a Finder-created .DS_Store made it want
// `remove .DS_Store` and left --check noisy forever after, which ruins a gate
// whose whole value is being quiet. So the mirror's own .gitignore is honoured,
// asking git rather than reimplementing its rules. Exit 1 means nothing is
// ignored, and a DEST that is not a repo (the test fixtures) ignores nothing.
function ignored(rels) {
  if (!existsSync(join(DEST, ".git"))) return new Set()
  try {
    const out = execFileSync("git", ["-C", DEST, "check-ignore", "--stdin"], { input: rels.join("\n"), encoding: "utf8" })
    return new Set(out.split("\n").filter(Boolean))
  } catch (e) {
    if (e.status === 1) return new Set()
    throw e
  }
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

// A comment spread over several lines hides the word `private` from every
// line-by-line test here. Parsing HTML properly is not worth it, so the
// arrangement is refused instead of guessed at.
const COMMENT_OPEN = /<!-+/
const COMMENT_CLOSE = /-+>/

// There is deliberately no exemption for fenced blocks or backticks. The second
// fix had one, so the syntax could be documented in the record it protects, and
// the third review broke it twice over: one unmatched fence line anywhere above
// a marker disabled withholding for the rest of the file, and backticks hid a
// marker from the backstop while also hiding it from the parser, which is the
// balanced-pair leak again. Both are the same shape: context that has to be
// tracked can be put into the wrong state by an edit nowhere near the marker.
// So no line is exempt. The cost is that a mirrored document cannot quote this
// syntax; it is documented in this header instead, which is not mirrored.

// Returns the publishable text and how many passages were dropped. Throws on
// anything ambiguous rather than guessing, since guessing wrong publishes.
function withhold(rel, text) {
  const lines = text.split("\n")
  const out = []
  let openedAt = null
  let reason = null
  let indent = ""
  let count = 0

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.replace(LEAD, "")
    const at = `${rel}:${i + 1}`

    const opens = COMMENT_OPEN.exec(line)
    if (opens && !COMMENT_CLOSE.test(line.slice(opens.index + opens[0].length))) {
      let body = line.slice(opens.index)
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

    // The backstop, and the reason there is no code-context exemption: a line
    // that looks like a marker but is not one has unknown intent, so the file
    // is refused.
    //
    // The test is not keyed on the word "private" at all, and that is the
    // fourth review's doing. A marker mistyped as `<!-- privacy: … -->` or
    // `<!-- private_note: … -->` defeated the parser and a word-keyed backstop
    // in one stroke, and because a hand mistypes the open and the close the
    // same way, the pair stayed balanced. Worse, the line is still a valid HTML
    // comment, so a renderer HIDES it: the passage read as ordinary published
    // prose with nothing anywhere signalling the failure.
    //
    // No detector keyed on a word can catch a different word. So the rule is
    // now about the comment, not the word: in a mirrored markdown file an HTML
    // comment is a well-formed marker or it is an error. No mirrored file
    // contains one today, so the cost is future-only, loud, and fixed by
    // rewording.
    if (COMMENT_OPEN.test(raw) && !OPEN_ANY.test(line) && !CLOSE.test(line)) {
      throw new Error(
        `${at} looks like a <!-- private --> marker but this parser did not understand it, ` +
          `so its intent is unknown and nothing was written. Write it alone on its line as ` +
          `"<!-- private: why -->" ... "<!-- /private -->". A mirrored document cannot quote ` +
          `this syntax at all; it is documented in tools/sync-from-source.mjs, which is not mirrored.`,
      )
    }

    if (OPEN_ANY.test(line)) {
      indent = raw.slice(0, raw.length - line.length)
      if (openedAt !== null) {
        throw new Error(`Nested <!-- private --> at ${at}; the one at ${rel}:${openedAt} is still open.`)
      }
      const withReason = line.match(OPEN_WITH_REASON)
      if (!withReason) {
        throw new Error(`<!-- private --> at ${at} gives no reason. Write "<!-- private: why -->"; the reason publishes.`)
      }
      if (/<!-|--!?>/.test(withReason[1])) {
        throw new Error(
          `The reason at ${at} contains comment syntax. It publishes verbatim inside the ` +
            `notice, so it would close the notice and swallow the rest of the rendered page. ` +
            `Nothing was written.`,
        )
      }
      openedAt = i + 1
      reason = withReason[1]
      continue
    }

    if (CLOSE.test(line)) {
      if (openedAt === null) throw new Error(`<!-- /private --> at ${at} closes nothing.`)
      // The notice inherits the marker's own indentation. Flush-left inside an
      // indented bullet it would end the list item and split one entry into
      // three blocks on the rendered page, which is what a stranger reads.
      out.push(`${indent}*(Withheld from the public mirror: ${reason})*`)
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

  return { text: out.join("\n"), count }
}

// Every file is transformed before anything is written, so a malformed marker
// in the last file cannot leave the first ones already published.
let withheldPassages = 0
const publishable = new Map()
for (const rel of sourceFiles()) {
  const raw = readFileSync(join(SOURCE, rel))
  if (!rel.endsWith(".md")) {
    // As crude as the markdown path, and for the same reason: the narrow test
    // let `<!-- begin private: … -->` through and published the whole file.
    if (COMMENT_OPEN.test(raw.toString("utf8")) && /private/i.test(raw.toString("utf8"))) {
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
