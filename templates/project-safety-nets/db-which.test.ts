// scripts/db-which.test.ts
//
// Unit tests for the db:which identity check. Everything here runs on fixture
// strings with fake refs; no test reads the real .env, because keeping secrets
// out of test output is the entire point of the tool under test.
import { describe, it, expect } from "vitest"
import { extractSupabaseRef, extractPoolerRef, judge } from "./db-which"

const REF = "abcdefghijklmnopqrst"
const OTHER = "zzzzzzzzzzzzzzzzzzzz"

describe("extractSupabaseRef", () => {
  it("pulls the project ref out of a Supabase project URL", () => {
    expect(extractSupabaseRef(`https://${REF}.supabase.co`)).toBe(REF)
  })

  it("returns null for a non-Supabase URL", () => {
    expect(extractSupabaseRef("https://example.com")).toBeNull()
  })

  it("returns null when the variable is missing", () => {
    expect(extractSupabaseRef(undefined)).toBeNull()
  })
})

describe("extractPoolerRef", () => {
  it("pulls the ref from a pooler connection string (username carries it)", () => {
    expect(
      extractPoolerRef(`postgresql://postgres.${REF}:secret@aws-1-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true`)
    ).toBe(REF)
  })

  it("pulls the ref from a direct connection string (host carries it)", () => {
    expect(extractPoolerRef(`postgresql://postgres:secret@db.${REF}.supabase.co:5432/postgres`)).toBe(REF)
  })

  it("returns null for a non-Supabase connection string", () => {
    expect(extractPoolerRef("postgresql://user:pw@localhost:5432/dev")).toBeNull()
  })

  it("returns null when the variable is missing", () => {
    expect(extractPoolerRef(undefined)).toBeNull()
  })
})

describe("judge", () => {
  const goodEnv = {
    NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co`,
    DATABASE_URL: `postgresql://postgres.${REF}:secret@aws-1-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true`,
    DIRECT_URL: `postgresql://postgres.${REF}:secret@aws-1-us-east-1.pooler.supabase.com:5432/postgres`,
  }

  it("passes when all three sources agree and match the expected ref", () => {
    const v = judge(goodEnv, REF)
    expect(v.ok).toBe(true)
    expect(v.ref).toBe(REF)
    expect(v.problems).toEqual([])
  })

  it("fails when the agreed ref is not the expected one", () => {
    const v = judge(goodEnv, OTHER)
    expect(v.ok).toBe(false)
    expect(v.problems.join(" ")).toMatch(/expected/i)
  })

  it("fails when auth and database point at different projects (mixed .env)", () => {
    const v = judge({ ...goodEnv, NEXT_PUBLIC_SUPABASE_URL: `https://${OTHER}.supabase.co` }, REF)
    expect(v.ok).toBe(false)
    expect(v.problems.join(" ")).toMatch(/disagree/i)
  })

  it("fails when a variable is missing entirely", () => {
    const v = judge({ ...goodEnv, DIRECT_URL: undefined }, REF)
    expect(v.ok).toBe(false)
    expect(v.problems.join(" ")).toMatch(/DIRECT_URL/)
  })

  it("never includes a password or full URL in its problems", () => {
    const v = judge(goodEnv, OTHER)
    const all = v.problems.join(" ")
    expect(all).not.toContain("secret")
    expect(all).not.toContain("postgresql://")
  })
})
