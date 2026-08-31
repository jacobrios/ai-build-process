// The protect-paths hook is the guard that stops an agent from editing an
// already-applied migration or a secrets file. It is run by the Claude Code
// harness and imported by nothing, so until this file existed the only way a
// hole in it got found was somebody reading the regexes by hand: three separate
// holes were found that way on 3 August 2026 (PRs #42 and #44, then the review
// on #44 that found two more). This test exists so the next hole is found by the
// suite instead.
//
// It is deliberately a black-box test. It spawns the real hook as a child
// process and pipes it the same JSON shape Claude Code sends on PreToolUse,
// then asserts on the exit code and stderr, because exit 2 plus an explanation
// on stderr IS the guard's contract with the harness. Testing the regexes
// directly would pass while the contract was broken.

import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const HOOK = fileURLToPath(new URL("./protect-paths.mjs", import.meta.url))

/** Run the hook exactly as the harness does: JSON on stdin, read exit + stderr. */
function runHook(stdin: string) {
  const result = spawnSync(process.execPath, [HOOK], {
    input: stdin,
    encoding: "utf8",
  })
  return { status: result.status, stderr: result.stderr }
}

function runHookOnPath(filePath: string) {
  return runHook(
    JSON.stringify({ tool_name: "Write", tool_input: { file_path: filePath } })
  )
}

type Case = {
  /** The file_path the harness would hand the hook. */
  path: string
  /** True when the hook must refuse the edit (exit 2). */
  blocked: boolean
  /** Why this path is in the table, used as the test name. */
  why: string
}

// One table, both directions. A guard that only over-blocks is not correct
// either: every path here that should stay editable is as load-bearing as
// every path that must be refused.
const CASES: Case[] = [
  // --- Migrations, written the plain way ---
  {
    path: "prisma/migrations/20260801120000_add_gauge/migration.sql",
    blocked: true,
    why: "a relative path straight into the migrations folder",
  },
  {
    path: "/Users/someone/code/app/prisma/migrations/20260801120000_add_gauge/migration.sql",
    blocked: true,
    why: "the absolute path the harness actually sends",
  },

  // --- Migrations, wearing a different case (the PR #44 hole) ---
  {
    path: "prisma/Migrations/20260801120000_add_gauge/migration.sql",
    blocked: true,
    why: "a capitalised folder that is the same folder on a Mac",
  },
  {
    path: "PRISMA/MIGRATIONS/20260801120000_add_gauge/migration.sql",
    blocked: true,
    why: "shouting the whole path is still the same folder",
  },

  // --- Migrations, reached by a path that does not read like one ---
  // The first six all reach a migration without ever spelling the protected
  // folder literally, and every one of them returned exit 0 until 3 August 2026.
  // Two of the shapes are what the review on PR #44 found; the rest are the
  // variants that fall out of the same trick. The seventh row is a migration
  // path climbing out to the secrets file: it was already refused before that
  // fix, by the migration pattern, and is here because normalizing changes which
  // pattern catches it (now the .env one) and it must stay refused either way.
  //
  // The folder names below are illustrative, not real, and the hook never
  // touches the disk, so what a row proves is what the guard does with a string.
  // That these shapes genuinely reach the real file was checked separately by
  // comparing inodes, with one exception worth naming rather than glossing:
  // the prisma/schema/../ row does NOT resolve in this repo, because `..` needs
  // every component before it to exist and there is no prisma/schema folder.
  // It is kept because the shape is the bypass, and a repo that does have such a
  // folder is one `mkdir` away.
  {
    path: "prisma//migrations/20260801120000_add_gauge/migration.sql",
    blocked: true,
    why: "a double slash, which any tool joining a folder and a name makes for free",
  },
  {
    path: "prisma/./migrations/20260801120000_add_gauge/migration.sql",
    blocked: true,
    why: "a here-segment in the middle of the path",
  },
  {
    path: "prisma/schema/../migrations/20260801120000_add_gauge/migration.sql",
    blocked: true,
    why: "a step sideways and back, which never spells the protected folder literally",
  },
  {
    path: "prisma///migrations//20260801120000_add_gauge/migration.sql",
    blocked: true,
    why: "several redundant slashes at once",
  },
  {
    path: "PRISMA//Migrations/20260801120000_add_gauge/migration.sql",
    blocked: true,
    why: "case and a double slash combined, so neither fix covers it alone",
  },
  {
    path: "/Users/someone/code/app//prisma/./migrations/20260801120000_add_gauge/migration.sql",
    blocked: true,
    why: "an absolute path carrying both tricks",
  },
  {
    path: "prisma/migrations/20260801120000_add_gauge/../../../.env",
    blocked: true,
    why: "climbing out of migrations and landing on the secrets file",
  },

  // --- Migrations, spelled with a letter the filesystem folds away ---
  // Same defect class as the capitalised folder above, one layer deeper: APFS
  // compares folded, so a character that merely folds to an ASCII letter names
  // the same file. Confirmed on this machine by inode, not by reasoning.
  {
    path: "priſma/migrations/20260801120000_add_gauge/migration.sql",
    blocked: true,
    why: "a long s, which this filesystem treats as an ordinary s",
  },
  {
    path: "prisma/migrationſ/20260801120000_add_gauge/migration.sql",
    blocked: true,
    why: "that same fold one folder along",
  },
  {
    path: "PRIſMA//Migrations/./20260801120000_add_gauge/migration.sql",
    blocked: true,
    why: "a fold, a case change and two path tricks at once",
  },

  // --- Secrets files ---
  { path: ".env", blocked: true, why: "the secrets file itself" },
  { path: ".env.local", blocked: true, why: "a local override of it" },
  {
    path: "/Users/someone/code/app/.env.production",
    blocked: true,
    why: "the production one, absolute",
  },
  {
    path: ".ENV.local",
    blocked: true,
    why: "the same file shouting, which a Mac cannot tell apart",
  },
  {
    path: "config/../.env.local",
    blocked: true,
    why: "a secrets file reached by stepping back a folder",
  },
  {
    path: ".env.example.local",
    blocked: true,
    why: "a real secrets file whose name merely starts like the example one",
  },

  // --- Files that must stay editable ---
  {
    path: "prisma/schema.prisma",
    blocked: false,
    why: "the schema is the legitimate way to evolve the model",
  },
  {
    path: "prisma/migrations/20260801120000_add_gauge/../../schema.prisma",
    blocked: false,
    why: "a path that reads like a migration but writes the schema",
  },
  {
    path: "docs/build-notes.md",
    blocked: false,
    why: "an ordinary docs file",
  },
  {
    path: "src/lib/orbit/normalize.ts",
    blocked: false,
    why: "ordinary product code",
  },
  {
    path: "node_modules/@prisma/migrations/index.js",
    blocked: false,
    why: "a package whose name only ends in prisma",
  },
  {
    path: "node_modules/@prisma//migrations/index.js",
    blocked: false,
    why: "that same package with a stray slash, which must not become a match",
  },
  {
    path: ".env.example",
    blocked: false,
    why: "the committed placeholder file, which holds no secrets",
  },
  {
    path: ".ENV.EXAMPLE",
    blocked: false,
    why: "the placeholder file shouting, still no secrets",
  },
  {
    path: "/Users/someone/code/app/.env.example",
    blocked: false,
    why: "the placeholder file, absolute",
  },
  {
    path: "config/.//.env.example",
    blocked: false,
    why: "the placeholder file reached by a scruffy path",
  },
]

describe("the protect-paths hook", () => {
  for (const testCase of CASES) {
    const verb = testCase.blocked ? "refuses" : "allows"
    it(`${verb} ${testCase.path}, ${testCase.why}`, () => {
      const { status } = runHookOnPath(testCase.path)
      expect(status).toBe(testCase.blocked ? 2 : 0)
    })
  }

  it("says why it refused, and names the way forward, on stderr", () => {
    const { status, stderr } = runHookOnPath(
      "prisma/migrations/20260801120000_add_gauge/migration.sql"
    )
    expect(status).toBe(2)
    expect(stderr).toContain(
      "prisma/migrations/20260801120000_add_gauge/migration.sql"
    )
    expect(stderr).toContain("protected file")
    expect(stderr).toContain("schema.prisma is editable")
  })

  it("names the real file when the path it was given hides it", () => {
    const { status, stderr } = runHookOnPath(
      "prisma/schema/../migrations/20260801120000_add_gauge/migration.sql"
    )
    expect(status).toBe(2)
    expect(stderr).toContain(
      "prisma/migrations/20260801120000_add_gauge/migration.sql"
    )
  })

  it("still refuses when the path arrives as something other than a string", () => {
    // A guard may fail open on input it cannot understand, but it must decide
    // to, not crash into it. Anything that reads as a protected path once
    // stringified is still a protected path.
    const { status } = runHook(
      JSON.stringify({
        tool_input: {
          file_path: ["prisma/migrations/20260801120000_add_gauge/migration.sql"],
        },
      })
    )
    expect(status).toBe(2)
  })

  it("stays out of the way when the input is not JSON at all", () => {
    expect(runHook("not json").status).toBe(0)
  })

  it("stays out of the way when the tool call carries no file path", () => {
    expect(runHook(JSON.stringify({ tool_input: {} })).status).toBe(0)
  })

  it("stays out of the way when the file path is empty", () => {
    expect(runHookOnPath("").status).toBe(0)
  })
})
