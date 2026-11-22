/**
 * Turn endings in the real `App`: nothing to check (with a hint when checked
 * files changed outside the turn), a subagent's checks left to its parent,
 * the notice of a turn without a closing answer, and a turn's model requests
 * counted as its steps plus the summary calls of its compactions.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { type NewEvent, type SessionId, type StoredEvent, event } from "@windlass/core"
import { UNVERIFIED_HINT } from "../src/cli.ts"
import { Transcript } from "../src/transcript.ts"
import { AGENTS, REVIEWER, TASKS, type Task, c, call, flat, m, settle, started, step, succeeded, todo } from "./builders.ts"
import { CLOCK_START, type Mounted, ScriptBackend, mount } from "./helpers.ts"

let mounted: Mounted | null = null
afterEach(async () => {
  await mounted?.dispose()
  mounted = null
})


async function open(width = 130, height = 44) {
  const backend = new ScriptBackend()
  mounted = await mount({ width, height, backend })
  return { backend, session: backend.session!, mounted }
}

async function enter(text: string) {
  await mounted!.setup.mockInput.typeText(text)
  mounted!.setup.mockInput.pressEnter()
  await mounted!.settle()
}

describe("turn endings", () => {
  test("a turn's ending counts the summary calls of its compactions with its steps", async () => {
    const { session } = await open()
    session.emit(
      started("exe_3"),
      ...step("a1"),
      event("compaction.started", { messageId: m("k2"), trigger: "auto", mode: "normal", keepFromSeq: 1, prompt: "Summarise.", tokensBefore: 9000 }),
      event("compaction.ended", { messageId: m("k2"), summary: "A checkpoint.", source: "model", detail: null, tokensAfter: 1200, usage: null, calls: 2 }),
      ...step("a2"),
      succeeded({ status: "not_configured" }, "exe_3"),
    )
    await mounted!.settle()
    expect(flat(await mounted!.frame())).toContain("done · no checks configured · 2 steps + 2 summary calls")
  })

  test("nothing to check, with the hint when checked files changed outside the turn; a subagent's checks are its parent's; no closing answer", async () => {
    const { session } = await open(150, 44)
    session.emit(started(), ...step("a1"), succeeded({ status: "not_needed", unverified: true }))
    await mounted!.settle()
    const unverified = flat(await mounted!.frame())
    expect(unverified).toContain("done · nothing to check · 1 step")
    expect(unverified).toContain(UNVERIFIED_HINT.slice(0, 60))
    session.emit(started("exe_2"), ...step("a2"), succeeded({ status: "left_to_parent" }, "exe_2"))
    session.emit({ type: "notice", sessionId: session.id as SessionId, kind: "no_closing_answer", message: "The model returned an empty response twice after its work, so the turn ended without a closing answer." })
    await mounted!.settle()
    const frame = flat(await mounted!.frame())
    expect(frame).toContain("done · its checks are left to its parent's turn · 1 step")
    expect(frame).toContain("no closing answer: The model returned an empty response twice after its work")
  })

  test("a turn that put its files back as they were needs no check and says which state that is; checks that were never started are not called failing", async () => {
    const { session } = await open(190, 44)
    session.emit(started(), ...step("a1"), succeeded({ status: "not_needed", reason: "state_unchanged", since: { seq: 12, run: { seq: 12, run: 1 } } }))
    await mounted!.settle()
    const back = flat(await mounted!.frame())
    expect(back).toContain("done · nothing to check · 1 step")
    expect(back).toContain("The files are as they were when the checks last passed, so the checks were not run again.")
    const check = { name: "test", command: "sh test.sh", status: "could_not_start" as const, exitCode: null, signal: null, durationMs: 0, files: [], fingerprint: "f", reusedFromSeq: null, outputPath: null, outputBytes: 0, outputLines: 0, origin: "session" as const, required: true, outputTail: { text: "", truncated: false }, startError: "the sandbox is unavailable" }
    session.emit(started("exe_2"), ...step("a2"), succeeded({ status: "unresolved", reason: "not_started", failing: ["test"], acknowledgement: null, evidence: { run: 1, afterSeq: 5, changedFiles: ["a.txt"], checks: [check] } }, "exe_2"))
    await mounted!.settle()
    const frame = flat(await mounted!.frame())
    expect(frame).toContain("unresolved · checks that could not be started: test")
    expect(frame).toContain("not started, so nothing was verified and the agent was not sent back: no change to the code starts a check. test: the sandbox is")
    expect(frame).not.toContain("failing checks: test")
  })
})

describe("moving between turns", () => {
  test("Alt-PageUp selects the ending of the turn before, Alt-PageDown the one after, over the rows between them", async () => {
    const { session } = await open(130, 30)
    // Three turns of several tool calls each: reaching an earlier ending with Alt-Up takes a key per call.
    for (const turn of [1, 2, 3]) {
      const calls = [1, 2, 3, 4, 5].flatMap((n) => [call(`a${turn}`, `c${turn}${n}`, "read", { path: `src/file${n}.ts` }), settle(`a${turn}`, `c${turn}${n}`, "success", "x")])
      session.emit(started(`exe_${turn}`), event("step.started", { messageId: m(`a${turn}`), attempt: 1, model: "gpt-test" }), ...calls, event("step.ended", { messageId: m(`a${turn}`), finish: "stop", usage: null }), succeeded({ status: "not_configured" }, `exe_${turn}`))
    }
    await mounted!.settle()
    const app = mounted!.app
    const turnOf = () => {
      const row = app.conversation.selectedRow()
      return row?.kind === "outcome" ? row.turn : row?.kind ?? null
    }
    const altPage = (key: "\u001b[5;3~" | "\u001b[6;3~") => mounted!.setup.mockInput.pressKey(key)
    altPage("\u001b[5;3~")
    await mounted!.settle()
    expect(turnOf()).toBe(3)
    altPage("\u001b[5;3~")
    await mounted!.settle()
    expect(turnOf()).toBe(2)
    expect(await mounted!.frame()).toMatch(/▌.*○ done · .*turn 2/)
    altPage("\u001b[5;3~")
    altPage("\u001b[5;3~")
    await mounted!.settle()
    expect(turnOf()).toBe(1)
    altPage("\u001b[6;3~")
    await mounted!.settle()
    expect(turnOf()).toBe(2)
    // From a tool call inside turn 3, up is the ending of turn 2 and down that of turn 3.
    mounted!.setup.mockInput.pressArrow("down", { meta: true })
    mounted!.setup.mockInput.pressArrow("down", { meta: true })
    await mounted!.settle()
    expect(turnOf()).toBe("tool")
    altPage("\u001b[6;3~")
    await mounted!.settle()
    expect(turnOf()).toBe(3)
  })
})
