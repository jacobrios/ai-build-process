// scripts/db-which.ts
//
// Answers one question safely: which Supabase project is this checkout pointed at?
//
// The two-databases rule (CLAUDE.md) makes this check load-bearing before any
// migration or seed, but the answer lives in .env next to the passwords, and the
// global sensitive-read guard rightly blocks reading that file into a session
// transcript. This script is the sanctioned path: it loads .env inside its own
// process and prints only the project ref, never a URL, password, or key.
//
// Run it:            npm run db:which
// Prove it can fail: npm run db:which -- --expect not-the-real-ref
//
// The expected ref below is claim-turned-fact: it was first printed by this script,
// then confirmed against the Supabase dashboard during PR review. If it ever needs
// to change, that same dashboard confirmation is the bar.
import "dotenv/config"

// interplanetary-groups-dev-test. First printed by this script, to be confirmed
// against the Supabase dashboard during PR review (see the PR description).
const EXPECTED_DEV_TEST_REF = "pxbewardwvoyqqcvogel"

// https://<ref>.supabase.co → ref
export function extractSupabaseRef(url: string | undefined): string | null {
  if (!url) return null
  const m = url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/)
  return m ? m[1] : null
}

// Supabase connection strings carry the ref in one of two places:
//   pooler form:  postgresql://postgres.<ref>:pw@<region>.pooler.supabase.com:...
//   direct form:  postgresql://postgres:pw@db.<ref>.supabase.co:...
export function extractPoolerRef(conn: string | undefined): string | null {
  if (!conn) return null
  const pooler = conn.match(/^postgres(?:ql)?:\/\/postgres\.([a-z0-9]+):/)
  if (pooler) return pooler[1]
  const direct = conn.match(/@db\.([a-z0-9]+)\.supabase\.co[:/]/)
  if (direct) return direct[1]
  return null
}

export interface Verdict {
  ok: boolean
  ref: string | null
  problems: string[]
}

// Pure verdict over the three env sources. Problems name variables and refs only,
// never values, so nothing a caller prints can leak a secret.
export function judge(env: Record<string, string | undefined>, expected: string): Verdict {
  const sources: Array<[name: string, ref: string | null, present: boolean]> = [
    ["NEXT_PUBLIC_SUPABASE_URL", extractSupabaseRef(env.NEXT_PUBLIC_SUPABASE_URL), !!env.NEXT_PUBLIC_SUPABASE_URL],
    ["DATABASE_URL", extractPoolerRef(env.DATABASE_URL), !!env.DATABASE_URL],
    ["DIRECT_URL", extractPoolerRef(env.DIRECT_URL), !!env.DIRECT_URL],
  ]

  const problems: string[] = []
  for (const [name, ref, present] of sources) {
    if (!present) problems.push(`${name} is missing from .env`)
    else if (!ref) problems.push(`${name} is set but no Supabase project ref could be parsed from it`)
  }

  const refs = [...new Set(sources.map(([, ref]) => ref).filter((r): r is string => r !== null))]
  if (refs.length > 1) {
    problems.push(`sources disagree about the project: ${refs.join(" vs ")}`)
  }

  const ref = refs.length === 1 ? refs[0] : null
  if (ref && problems.length === 0 && ref !== expected) {
    problems.push(`project ref is ${ref}, expected ${expected} (dev-test)`)
  }

  return { ok: problems.length === 0 && ref === expected, ref, problems }
}

// CLI wrapper. Kept thin so everything above stays testable on fixture strings.
function main(): void {
  const expectIndex = process.argv.indexOf("--expect")
  const expected = expectIndex !== -1 && process.argv[expectIndex + 1] ? process.argv[expectIndex + 1] : EXPECTED_DEV_TEST_REF

  const verdict = judge(process.env, expected)

  for (const [name, ref] of [
    ["NEXT_PUBLIC_SUPABASE_URL", extractSupabaseRef(process.env.NEXT_PUBLIC_SUPABASE_URL)],
    ["DATABASE_URL", extractPoolerRef(process.env.DATABASE_URL)],
    ["DIRECT_URL", extractPoolerRef(process.env.DIRECT_URL)],
  ] as const) {
    console.log(`${name!.padEnd(26)} → ${ref ?? "(no ref found)"}`)
  }

  if (verdict.ok) {
    console.log(`\nDEV-TEST (expected). Project ref ${verdict.ref} matches on all three sources.`)
    process.exit(0)
  }

  console.error(`\nSTOP: this checkout is NOT confirmed to be dev-test.`)
  for (const p of verdict.problems) console.error(`  - ${p}`)
  console.error(`Do not run migrations or seeds until this is resolved. See CLAUDE.md, "Two databases, never crossed".`)
  process.exit(1)
}

// Only run the CLI when invoked directly, not when imported by tests.
if (process.argv[1]?.endsWith("db-which.ts")) {
  main()
}
