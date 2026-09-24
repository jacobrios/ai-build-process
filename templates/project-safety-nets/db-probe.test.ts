// The probe answers one question before the full suite runs: is the database
// answering at all? It has to answer it through the same door the tests use,
// the `pg` driver with DATABASE_URL as the test runner sees it, because a
// pooler that is up but refusing logins is exactly the outage this exists for,
// and a check that only asked "is the server there" would call it healthy.
//
// Two layers, like the hooks' own tests. The pure pieces (where the URL comes
// from, which code gets printed) are tested directly. The script itself is run
// for real against an address nothing listens on, which is the only way to
// prove it gives up quickly and says why, rather than hanging the stop hook.

import { spawnSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { parse as dotenvParse } from "dotenv"
import { classifyProbe, errorCode, resolveDatabaseUrl } from "./db-probe.mjs"

const PROBE = fileURLToPath(new URL("./db-probe.mjs", import.meta.url))
const DEAD = "postgresql://nobody:nobody@127.0.0.1:1/none"

/** A partial environment, typed for the function that reads it. */
const env = (vars: Record<string, string> = {}) => vars as unknown as NodeJS.ProcessEnv

const cleanup: string[] = []
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true })
})
function dir() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "db-probe-")))
  cleanup.push(d)
  return d
}

describe("which DATABASE_URL the probe checks", () => {
  it("prefers the environment, the same way the test runner's dotenv does", () => {
    const root = dir()
    writeFileSync(join(root, ".env"), "DATABASE_URL=postgresql://from-file/db\n")
    expect(resolveDatabaseUrl(root, env({ DATABASE_URL: "postgresql://from-env/db" }), dotenvParse)).toBe(
      "postgresql://from-env/db"
    )
  })

  it("reads the project's .env exactly as dotenv does: quotes, comments, repeats", () => {
    // Found by review: a hand-rolled parser disagreed with dotenv on all four of
    // these, and disagreeing means probing a URL the tests never use, which is
    // the one way this probe can call a working database down.
    const root = dir()
    writeFileSync(
      join(root, ".env"),
      'DATABASE_URL=postgresql://first/db\nDATABASE_URL="postgresql://last/db" # pooler\n'
    )
    expect(resolveDatabaseUrl(root, env(), dotenvParse)).toBe(dotenvParse('DATABASE_URL="postgresql://last/db" # pooler').DATABASE_URL)
    expect(resolveDatabaseUrl(root, env(), dotenvParse)).toBe("postgresql://last/db")
  })

  it("reports none when neither has one, which means there is nothing to check", () => {
    expect(resolveDatabaseUrl(dir(), env(), dotenvParse)).toBeNull()
  })

  it("reports none when the project has no dotenv to read .env with", () => {
    const root = dir()
    writeFileSync(join(root, ".env"), "DATABASE_URL=postgresql://x/db\n")
    expect(resolveDatabaseUrl(root, env())).toBeNull()
  })
})

describe("the code the probe reports", () => {
  it("lifts the pooler's own code out of its message", () => {
    const err = new Error("(ECIRCUITBREAKER) too many authentication failures")
    expect(errorCode(err)).toBe("ECIRCUITBREAKER")
  })

  it("uses the driver's code when the message carries none", () => {
    expect(errorCode(Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }))).toBe(
      "ECONNREFUSED"
    )
  })

  it("never returns an empty code", () => {
    expect(errorCode(new Error("?"))).toBe("ERROR")
  })
})

describe("the probe, run for real", () => {
  it("says unreachable, with a code, quickly, when nothing answers", () => {
    const started = Date.now()
    const r = spawnSync(process.execPath, [PROBE], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: DEAD },
      encoding: "utf8",
    })
    expect(r.status).toBe(1)
    expect(r.stdout.trim()).toMatch(/^E[A-Z]+$/)
    expect(Date.now() - started).toBeLessThan(8_000)
  })

  it("steps aside when the project has no database driver to check with", () => {
    const root = dir()
    writeFileSync(join(root, "package.json"), "{}")
    const r = spawnSync(process.execPath, [PROBE], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: DEAD },
      encoding: "utf8",
    })
    expect(r.status).toBe(3)
  })

  it("steps aside when there is no DATABASE_URL at all", () => {
    const root = dir()
    const env = { ...process.env }
    delete env.DATABASE_URL
    const r = spawnSync(process.execPath, [PROBE], { cwd: root, env, encoding: "utf8" })
    expect(r.status).toBe(3)
  })
})

describe("reading the probe's answer", () => {
  // Found by review: treating every exit other than 0 and 3 as "down" meant a
  // crashing probe would silently switch the gate off. Only a clean "did not
  // answer" (exit 1 with a code) is an outage; anything else means the probe
  // itself is broken, and a broken probe must fall back to running the suite.
  it("calls it down only for exit 1 with a code", () => {
    expect(classifyProbe({ status: 1, stdout: "ECIRCUITBREAKER" })).toEqual({
      status: "down",
      code: "ECIRCUITBREAKER",
    })
  })
  it("calls it ok for exit 0", () => {
    expect(classifyProbe({ status: 0, stdout: "" })).toEqual({ status: "ok" })
  })
  it("steps aside on a crash with no code, rather than switching the gate off", () => {
    expect(classifyProbe({ status: 1, stdout: "" }).status).toBe("skipped")
  })
  it("steps aside when the probe was killed or never started", () => {
    expect(classifyProbe({ status: null, stdout: "" }).status).toBe("skipped")
  })
  it("steps aside on its own nothing-to-check exit", () => {
    expect(classifyProbe({ status: 3, stdout: "no pg driver" }).status).toBe("skipped")
  })
})
