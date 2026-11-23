import { describe, expect, test } from "bun:test"
import type { SessionSummary } from "../src/engine.ts"
import { filterSessions } from "../src/session-list.ts"

const row = (id: string, updatedAt: number): SessionSummary => ({
  id: id as SessionSummary["id"],
  title: id,
  cwd: "/work",
  updatedAt,
  model: "test-model",
})

describe("filterSessions", () => {
  const sessions = [row("ses_old", 1_000), row("ses_new", 9_000), row("ses_middle", 5_000)]

  test("returns sessions newest first and applies the since cutoff and limit", () => {
    expect(filterSessions(sessions, { sinceMs: 5_000, limit: 1 }, 10_000).map(({ id }) => String(id))).toEqual(["ses_new"])
  })

  test("includes a session exactly on the since cutoff and handles no limit", () => {
    expect(filterSessions(sessions, { sinceMs: 5_000, limit: null }, 10_000).map(({ id }) => String(id))).toEqual(["ses_new", "ses_middle"])
    expect(filterSessions(sessions, { sinceMs: null, limit: null }, 10_000).map(({ id }) => String(id))).toEqual(["ses_new", "ses_middle", "ses_old"])
  })
})
