#!/usr/bin/env node
// Blocks Claude Code from editing applied migrations and .env files.
// It reads the tool call as JSON on stdin, checks the target file path,
// and exits with code 2 (which tells Claude Code to block the edit) if the
// path is protected. schema.prisma is intentionally NOT protected, because
// editing it is the legitimate way to evolve the model; migrations are
// generated from it by the Prisma CLI, which this hook does not touch.

import { posix as posixPath } from "node:path";

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let data = {};
  try {
    data = JSON.parse(input);
  } catch {
    process.exit(0); // if we cannot parse the input, do not block
  }

  // String() rather than a bare read: the patterns below used to coerce a
  // non-string file_path for free, and the normalizing added below throws on
  // one. A guard is allowed to decide to let something through; it is not
  // allowed to crash into letting it through, which is what an uncaught throw
  // here would do (Claude Code only treats exit 2 as a block, so the exit 1 of a
  // crash is a write that proceeds).
  const rawPath = String(
    (data && data.tool_input && data.tool_input.file_path) || ""
  );

  // Match on a normalized copy of the path, never on the string as it arrived,
  // because the patterns below can only see literal text while the filesystem
  // sees a file. Two different ways of spelling one file have to be collapsed.
  //
  // Path shape, via node:path: prisma//migrations/x.sql and
  // prisma/./migrations/x.sql open the same applied migration this repo already
  // has on disk, and prisma/<a folder that exists>/../migrations/x.sql is the
  // same trick one step further. All of them walked past this hook until
  // 3 August 2026. A double slash is not exotic; any code joining a folder and a
  // name with a "/" makes one for free. The posix rules are used explicitly so a backslash stays an ordinary
  // filename character, which is what it is on macOS and Linux. This also cuts
  // the other way, which is the point rather than a side effect:
  // prisma/migrations/x/../../schema.prisma writes the schema, which is editable
  // on purpose, and used to be refused.
  //
  // Character shape, via NFKC: APFS compares folded, so a character that merely
  // folds to an ASCII letter names the same file. priſma/migrations/... (a long
  // s) resolves to the same inode as the real migration and returned exit 0 even
  // after the path-shape fix above; NFKC maps it back to a plain s. This is the
  // same defect class as the case hole fixed earlier the same day, one layer
  // deeper, and it is why the /i flags below are still load-bearing: neither of
  // these two steps folds case, so removing /i would reopen every one of those.
  //
  // What this deliberately does NOT do, so the comment cannot be read as a
  // guarantee it has not earned: it is lexical only. It does not follow
  // symlinks, does not consult the working directory, and does not touch the
  // disk. A symlink pointing at prisma/migrations would still get through.
  //
  // The empty case is short-circuited because normalize("") returns "." not "".
  const path = rawPath
    ? posixPath.normalize(rawPath).normalize("NFKC")
    : "";

  // Both patterns are case-insensitive on purpose. macOS filesystems are
  // case-insensitive by default, so .ENV.local and .env.local are the same file
  // on disk, and so are prisma/Migrations/ and prisma/migrations/; a
  // case-sensitive pattern waves through a write that clobbers the real secrets
  // file or an already-applied migration. The .env half was added 31 July 2026
  // from b1-coach PR #9; the migration half had the identical hole and was
  // fixed 3 August 2026, found by the review on PR #42.
  const protectedPatterns = [
    /(^|\/)\.env(\.|$)/i, // .env, .env.local, .env.production, etc.
    /(^|\/)prisma\/migrations\//i, // any already-applied migration file
  ];

  // .env.example is the one .env-shaped file that holds no secrets: it carries
  // placeholder values only and is meant to be committed, so agents must be able
  // to keep it in sync when a new variable is added. Every other .env file, and
  // every migration, stays protected. Matched case-insensitively too, or
  // .ENV.EXAMPLE would start getting blocked once the pattern above stopped
  // caring about case.
  const allowedPatterns = [/(^|\/)\.env\.example$/i];

  const isProtected =
    !allowedPatterns.some((re) => re.test(path)) &&
    protectedPatterns.some((re) => re.test(path));

  if (isProtected) {
    // Name the file that would actually be written, and, when the path asked
    // for is not that file, say so too. Otherwise a path blocked only after
    // normalizing reads as an unexplained refusal.
    const asAsked = path === rawPath ? "" : ` (asked for as ${rawPath})`;
    console.error(
      `Blocked: ${path}${asAsked} is a protected file (an applied migration or an env/secrets file). ` +
        `Do not edit it directly. Ask Jacob to make the change by hand. ` +
        `Note: schema.prisma is editable; migrations are generated from it via the Prisma CLI.`
    );
    process.exit(2);
  }

  process.exit(0);
});