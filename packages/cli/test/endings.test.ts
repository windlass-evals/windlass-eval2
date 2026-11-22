/**
 * How the line CLI says a turn ended: nothing to check (with a hint when
 * checked files changed outside the turn), a subagent's checks left to its
 * parent, the notice of a turn without a closing answer, and a turn's model
 * requests counted as its steps plus the summary calls of its compactions.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { type SessionId, brand, event } from "@windlass/core"
import { FakeProvider, script } from "@windlass/core/testing"
import { c, executionStarted, m, opening, stepEnded, stepStarted } from "@windlass/core/testing/scenarios"
import { SUMMARY } from "../../core/test/scenarios/script.ts"
import { createAcpEngine } from "../src/acp-engine.ts"
import { UNVERIFIED_HINT } from "../src/agents.ts"
import { helpText, parseArgs } from "../src/args.ts"
import { JsonSink } from "../src/renderer.ts"
import { render, runCli, stored } from "./helpers.ts"
import { REVIEWER, call, compactionEnded, compactionStarted, settle, succeeded, todo, typedSessions } from "./typed.ts"

setDefaultTimeout(40_000)

describe("what the renderer says", () => {
  test("a turn's model requests are its steps and the summary calls of its compactions, in words and in the --json summary", () => {
    const inTurn = render(
      stored([...opening(), stepStarted("a1"), stepEnded("a1", "tool_calls"), compactionStarted("k1", "auto"), compactionEnded("k1", 2), stepStarted("a2"), stepEnded("a2"), succeeded({ status: "not_configured" })]),
    )
    expect(inTurn).toMatch(/✓ done · no checks configured · 2 steps \+ 2 summary calls · /)

    // The line a script reads after a turn says the same in numbers.
    let json = ""
    const sink = new JsonSink(
      (text) => (json += text),
      () => {},
    )
    for (const item of stored([executionStarted(), stepStarted("a1"), stepEnded("a1"), compactionStarted("k1", "auto"), compactionEnded("k1", 2), succeeded({ status: "not_configured" })])) sink.event(item)
    expect(JSON.parse(json.trim().split("\n").at(-1)!)).toMatchObject({ type: "cli.summary", steps: 1, summaryCalls: 2, requests: 3 })
  })

  test("endings: nothing to check with the hint when checked files changed outside the turn; a subagent's checks are its parent's; no closing answer", () => {
    const unverified = render(stored([...opening(), stepStarted("a1"), stepEnded("a1"), succeeded({ status: "not_needed", unverified: true })]), { columns: () => 300 })
    expect(unverified).toMatch(/✓ done · nothing to check · 1 step · /)
    expect(unverified).toContain(`  ${UNVERIFIED_HINT}\n`)
    const plain = render(stored([...opening(), stepStarted("a1"), stepEnded("a1"), succeeded({ status: "not_needed" })]))
    expect(plain).toMatch(/✓ done · nothing to check · 1 step · /)
    expect(plain).not.toContain("outside this turn")
    const child = render(stored([...opening(), stepStarted("a1"), stepEnded("a1"), succeeded({ status: "left_to_parent" })]))
    expect(child).toMatch(/✓ done · its checks are left to its parent's turn · 1 step · /)
    // The turn changed files and they are back as they were in a verified state: said under the ending, with which state.
    const since = { seq: 12, run: { seq: 12, run: 1 } }
    const back = render(stored([...opening(), stepStarted("a1"), stepEnded("a1"), succeeded({ status: "not_needed", reason: "state_unchanged", since })]), { columns: () => 300 })
    expect(back).toMatch(/✓ done · nothing to check · 1 step · /)
    expect(back).toContain("  The files are as they were when the checks last passed, so the checks were not run again.\n")
    const start = render(stored([...opening(), stepStarted("a1"), stepEnded("a1"), succeeded({ status: "not_needed", reason: "state_unchanged", since: { seq: 4, run: null } })]), { columns: () => 300 })
    expect(start).toContain("  The files are as they were when the session started. No check has run on that state.\n")
    // The other reasons are the ending they were.
    for (const reason of ["turn_unchanged", "not_covered"] as const) expect(render(stored([...opening(), stepStarted("a1"), stepEnded("a1"), succeeded({ status: "not_needed", reason, since })]))).not.toContain("The files are")
    const silent = render([
      ...stored([...opening(), stepStarted("a1"), stepEnded("a1")]),
      { type: "notice", sessionId: "ses_test" as SessionId, kind: "no_closing_answer", message: "The model returned an empty response twice after its work, so the turn ended without a closing answer." },
    ])
    expect(silent).toContain("⚠ no closing answer: The model returned an empty response twice after its work,\n  so the turn ended without a closing answer.\n")
  })

  test("checks that were never started are not called failing: the ending says they could not be started, and why", () => {
    const check = { name: "test", command: "sh test.sh", status: "could_not_start" as const, exitCode: null, signal: null, durationMs: 0, files: [], fingerprint: "f", reusedFromSeq: null, outputPath: null, outputBytes: 0, outputLines: 0, origin: "session" as const, required: true, outputTail: { text: "", truncated: false }, startError: "the sandbox is unavailable (bubblewrap (bwrap) is not installed.)" }
    const ending = succeeded({ status: "unresolved", reason: "not_started", failing: ["test"], acknowledgement: null, evidence: { run: 1, afterSeq: 5, changedFiles: ["a.txt"], checks: [check] } })
    const shown = render(stored([...opening(), stepStarted("a1"), stepEnded("a1"), ending]), { columns: () => 300 })
    expect(shown).toContain("✗ stopped with checks that could not be started: test")
    expect(shown).toContain("  not started, so nothing was verified and the agent was not sent back: no change to the code starts a check. test: the sandbox is unavailable (bubblewrap (bwrap) is not installed.)\n")
    expect(shown).not.toContain("failing checks")
    // A turn that ended on checks that failed says what it always said.
    const failed = succeeded({ status: "unresolved", reason: "max_rounds", failing: ["test"], acknowledgement: null, evidence: { run: 1, afterSeq: 5, changedFiles: ["a.txt"], checks: [{ ...check, status: "failed", exitCode: 1 }] } })
    expect(render(stored([...opening(), stepStarted("a1"), stepEnded("a1"), failed]))).toContain("✗ stopped with failing checks: test")
  })
})
