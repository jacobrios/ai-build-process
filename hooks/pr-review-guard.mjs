#!/usr/bin/env node
// ~/.claude/hooks/pr-review-guard.mjs
//
// Refuses to open a pull request whose body carries no review report.
// Registered as a PreToolUse hook on Bash.
//
// THE RECORD (rule-lineage.md, 25 August and 1 September 2026)
// The rule that an independent read-only agent reviews the assembled diff
// before a PR is merged has been skipped or offered as optional three times:
// twice as "run the reviewer?" before opening a PR, and once, after the rule
// had been rewritten to say it is a standing instruction, as "accept no
// independent code review" among three options handed to Jacob. Two prose
// amendments did not close it. Jacob does not read code, so that review is his
// only written account of what the code does wrong, produced by something that
// did not write it.
//
// WHY A HOOK AND NOT A THIRD REWRITE
// Same reasoning as branch-cut-guard: the rule was never disbelieved, it was
// skipped. A check at the moment of the write does not depend on a session
// remembering, or on which of two conflicting instructions it weighs heavier.
//
// WHAT COUNTS AS A REPORT
// A markdown heading containing the word "review", with at least one non-blank,
// non-heading line under it. That is the shape the PR-body rule already asks
// for ("what the review found, what was fixed, and what was deliberately not
// fixed"), so a session following the rule passes without doing anything extra.
//
// WHAT IT DOES NOT COVER, deliberately
//   - A fabricated report. This guard makes skipping the review visible; it
//     cannot tell a real review from an invented one. The three incidents were
//     sessions declining openly, not lying, so this is the failure it targets.
//   - `gh pr edit`. The body can still be changed after creation.
//   - Bodies it cannot read: `--fill`, `--web`, `-F -`, or no body flag. Those
//     are blocked, since an unverifiable body is the same as a missing report.
// Anything it blocks is reportable to Jacob as a Jacob-built guard.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  let data = {};
  try {
    data = JSON.parse(input);
  } catch {
    process.exit(0); // unparseable input fails open, never jams every command
  }

  const cmd = (data && data.tool_input && data.tool_input.command) || "";
  if (!/(^|[;&|]|\s)gh\s+pr\s+create\b/.test(cmd)) process.exit(0);
  if (/\s(--help|-h)\b/.test(cmd)) process.exit(0);

  const cwd = data.cwd || process.cwd();
  let body = null;
  let why = null;

  const file = cmd.match(/\s(?:--body-file|-F)(?:=|\s+)(\S+)/);
  if (file) {
    const path = file[1].replace(/^["']|["']$/g, "");
    if (path === "-") why = "the body comes from stdin, which this guard cannot read";
    else {
      try {
        body = readFileSync(resolve(cwd, path), "utf8");
      } catch {
        why = `the body file ${path} could not be read`;
      }
    }
  } else if (/\s(?:--body|-b)(?:=|\s)/.test(cmd)) {
    // The body is embedded in the command (quoted string or heredoc), and shell
    // quoting is not worth parsing: check the whole command text for the report.
    body = cmd;
  } else if (/\s(--fill|--fill-first|--fill-verbose|--web|-w)\b/.test(cmd)) {
    why = "the body is generated or written elsewhere, so it cannot carry the review report";
  } else {
    why = "no --body or --body-file was given";
  }

  if (body !== null && hasReviewReport(body)) process.exit(0);
  if (why === null) why = "no heading containing \"review\" with findings under it was found in the body";

  console.error(
    `Blocked: this PR body has no review report (Jacob-built guard, pr-review-guard, tunable).\n` +
      `  - ${why}\n\n` +
      `The PR-body rule requires what the independent review found, what was fixed, and what ` +
      `was deliberately not fixed. Run the read-only reviewer on the assembled diff, then put ` +
      `its findings under a heading that contains the word "review".\n` +
      `Report this block to Jacob; skipping the review is his call, never the session's.`
  );
  process.exit(2);
});

function hasReviewReport(text) {
  const lines = text.replace(/\\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    // A heading may sit at line start (a file, a heredoc) or right after the
    // opening quote of an inline --body string on the command line.
    if (!/(?:^|["']|\$')\s*#{1,6}\s+.*\breview/i.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j].trim();
      if (!l) continue;
      if (/^#{1,6}\s/.test(l)) break; // next heading: this one was empty
      if (/^(EOF|['"]?\)?\s*["']?)$/.test(l)) break; // heredoc terminator or closing quote
      return true;
    }
  }
  return false;
}
