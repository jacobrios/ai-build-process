#!/usr/bin/env node
// ~/.claude/hooks/branch-cut-guard.mjs
//
// Refuses to cut a new branch from a checkout that is not clean and on main.
// Registered as a PreToolUse hook on Bash.
//
// THE INCIDENT (1 September 2026, interplanetary-groups, PR #112)
// A session ran `git checkout -b fix-1password-diagnosis` in the shared main
// checkout while another session had work in flight there. It had checked the
// checkout hours earlier, seen a clean main, and carried that observation
// forward as current state. By the time it branched, the checkout had moved to
// another session's feature branch. The new branch was therefore cut from that
// branch's tip, and the PR carried 32 commits of an unmerged feature under a
// title about 1Password. Had it merged, the feature would have shipped
// unreviewed, past the one gate that is not supposed to degrade.
//
// The same command also swept in the other session's uncommitted work. Note
// that it staged NAMED PATHS, not `git add -A`: both sessions were editing the
// same two files. A guard on the shape of the `add` would have caught nothing.
// The discriminating facts are the branch and the dirty tree, so that is what
// this reads.
//
// WHY A HOOK AND NOT A RULE
// The rule already existed: start every slice from a current main. It was not
// disbelieved, it was skipped, on a stale belief that the checkout had not
// moved. The session had even said out loud, earlier in the same conversation,
// that the checkout was sitting on the other branch. Prose cannot close a gap
// between knowing something and acting on it; a check that runs at the moment
// of the write can.
//
// WHAT IT DOES NOT COVER, deliberately
//   - `git checkout <existing-branch>`: that is the fix-an-open-PR-in-place
//     case, which is legitimate and common.
//   - `git worktree add`: worktrees are the sanctioned way to work concurrently
//     and have caused no incidents.
// Anything it blocks is reportable to Jacob as a Jacob-built guard, per the
// guardrail rule; if the branch point is deliberate, he can say so.

import { execFileSync } from "node:child_process";

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

  // Only new-branch creation. `git worktree add -b` also carries -b and is
  // deliberately excluded, so match the checkout/switch forms specifically.
  const cuts = /(^|[;&|]|\s)git\s+(checkout\s+-b|switch\s+-c)\s/.test(cmd);
  if (!cuts || /\bgit\s+worktree\b/.test(cmd)) process.exit(0);

  const cwd = data.cwd || process.cwd();
  const git = (args) => {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  };

  const branch = git(["branch", "--show-current"]);
  if (branch === null) process.exit(0); // not a git repo: nothing to protect

  const dirty = git(["status", "--porcelain"]);
  const problems = [];
  if (branch && branch !== "main" && branch !== "master") {
    problems.push(`HEAD is on "${branch}", not main, so the new branch would be cut from it`);
  }
  if (dirty) {
    const n = dirty.split("\n").filter(Boolean).length;
    problems.push(`${n} uncommitted change(s) present, which may belong to another session`);
  }
  if (problems.length === 0) process.exit(0);

  console.error(
    `Blocked: cutting a branch here is not safe yet (Jacob-built guard, branch-cut-guard, tunable).\n` +
      problems.map((p) => `  - ${p}`).join("\n") +
      `\n\nCheck the state now rather than trusting an earlier look: ` +
      `git branch --show-current && git status --short\n` +
      `A dirty tree in a shared checkout usually means another session is working here; ` +
      `use a worktree or ask Jacob.\n` +
      `Report this block to him; if this branch point is deliberate, he can say so.`
  );
  process.exit(2);
});
