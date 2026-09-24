#!/usr/bin/env node
// Is the database answering? One connection, one `SELECT 1`, a short timeout.
// Run by full-suite-on-subagent-stop.mjs before it spends a whole suite run.
//
// Why it exists (23 Sept 2026): a paused dev-test database came back with its
// connection pooler refusing logins, and every turn that owed a run then fired
// about three hundred failed logins at it anyway. That plausibly kept the
// pooler's lockout alive, and it buried the one useful fact under a
// 295-failure wall. One login per turn is harmless; three hundred is not.
//
// It goes through the SAME door the tests use: the `pg` driver, resolved from
// the project, with DATABASE_URL as the test runner's dotenv would see it (the
// environment first, then the project's .env). A cheaper "is the server there"
// check would call a pooler that is up but refusing logins healthy, and that
// is precisely the outage this is for.
//
// Exit codes, read by the stop hook: 0 answered, 1 did not (the short reason
// printed on stdout), 3 nothing to check (no DATABASE_URL, or no `pg` in the
// project), which means behave exactly as before this file existed. It never
// throws a wall of its own: a timeout is reported as TIMEOUT rather than
// waited out for a nicer code, because the pooler's own auth timeout can run
// longer than this probe is allowed to.

import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"

export const PROBE_TIMEOUT_MS = 4_000

/** The project's own dotenv parser, or null when the project has none. */
function projectDotenvParse(root) {
  try {
    return createRequire(join(root, "package.json"))("dotenv").parse
  } catch {
    return null
  }
}

/**
 * DATABASE_URL the way the test runner will see it: the environment wins, then
 * the project's .env read by the project's OWN dotenv. Not a hand-rolled
 * parser: review found one disagreeing with dotenv on quotes, trailing
 * comments, backticks and repeated keys, and probing a URL the tests never use
 * is the one way this probe can call a working database down. No dotenv means
 * nothing to check, which runs the suite as before.
 */
export function resolveDatabaseUrl(root, env = process.env, parse = projectDotenvParse(root)) {
  if (env.DATABASE_URL) return env.DATABASE_URL
  if (!parse) return null
  let text
  try {
    text = readFileSync(join(root, ".env"), "utf8")
  } catch {
    return null
  }
  return parse(text).DATABASE_URL || null
}

/**
 * How the stop hook reads this script's exit. Only a clean "did not answer",
 * exit 1 WITH a code, is an outage. Anything else (a crash with no output, a
 * kill, a spawn that never started) means the probe itself is broken, and a
 * broken probe must fall back to running the suite rather than quietly
 * switching the gate off. Found by review.
 */
export function classifyProbe({ status, stdout }) {
  if (status === 0) return { status: "ok" }
  const code = String(stdout || "").trim()
  if (status === 1 && code) return { status: "down", code }
  return { status: "skipped" }
}

/** The short code worth printing: the pooler's own "(ECIRCUITBREAKER)", else the driver's code. */
export function errorCode(err) {
  const lifted = String((err && err.message) || "").match(/\((E[A-Z_]+)\)/)
  if (lifted) return lifted[1]
  if (err && err.code) return String(err.code)
  return "ERROR"
}

async function main() {
  const root = process.cwd()
  const url = resolveDatabaseUrl(root)
  if (!url) {
    process.stdout.write("no DATABASE_URL")
    process.exit(3)
  }

  let pg
  try {
    pg = createRequire(join(root, "package.json"))("pg")
  } catch {
    process.stdout.write("no pg driver")
    process.exit(3)
  }

  // A hard ceiling over the driver's own timeouts, so nothing it does can hold
  // the stop hook open past it. It prints TIMEOUT, so it reads as an outage.
  setTimeout(() => {
    process.stdout.write("TIMEOUT")
    process.exit(1)
  }, PROBE_TIMEOUT_MS + 500).unref()

  try {
    // Inside the try on purpose: a URL the driver cannot parse must report a
    // code, not crash silently. Found by review.
    const client = new pg.Client({
      connectionString: url,
      connectionTimeoutMillis: PROBE_TIMEOUT_MS,
      query_timeout: PROBE_TIMEOUT_MS,
    })
    await client.connect()
    await client.query("SELECT 1")
    await client.end().catch(() => {})
    process.exit(0)
  } catch (err) {
    process.stdout.write(errorCode(err))
    process.exit(1)
  }
}

if (process.argv[1] && process.argv[1].endsWith("db-probe.mjs")) {
  main()
}
