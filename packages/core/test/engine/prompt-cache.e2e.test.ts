/**
 * Case A, exercised through the production assembly as well as its wire encoder.
 * No exported trace, rebuilt request, automatic break allowance, or real sign-in:
 * prefixlens sees exactly what OpenAIResponsesProvider passes to fetch.
 */
import { expect, setDefaultTimeout, test } from "bun:test"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { HARNESS_ORIGIN } from "../../src/event/durable.ts"
import type { MessageId } from "../../src/id.ts"
import { E2E_TIMEOUT_MS } from "../../src/testing/wait.ts"
import { fixture, tool } from "./prompt-cache-fixture.ts"

// Production snapshots start git processes.
setDefaultTimeout(E2E_TIMEOUT_MS)

test("wire prefix across instructions, catalogues, memory, input delivery and restart", async () => {
  const f = await fixture()
  try {
    await f.turn("first question and real tool result", undefined, [tool("read", { path: "note.txt" }), "Read it."])
    await f.turn("second user turn")
    await f.turn("reload root instructions", () => f.write(join(f.cwd, "AGENTS.md"), "Use bun test for this project.\n"))
    await f.turn("discover nested instructions", () => {
      f.write(join(f.cwd, "nested", "AGENTS.md"), "Keep nested files small.\n")
      f.write(join(f.cwd, "nested", "note.txt"), "Nested fixture.\n")
    }, [tool("read", { path: "nested/note.txt" }), "Read nested file."])
    await f.turn("remove known instructions", () => rmSync(join(f.cwd, "nested", "AGENTS.md")))
    await f.turn("date rollover", f.nextDay)
    const skill = join(f.cwd, ".claude", "skills", "review", "SKILL.md")
    await f.turn("add skill catalogue", () => f.write(skill, "---\nname: review\ndescription: Review a fixture\n---\nRead note.txt.\n"), [tool("skill", { name: "review" }), "Loaded skill."])
    await f.turn("reload skill catalogue", () => f.write(skill, "---\nname: review\ndescription: Review the updated fixture\n---\nRead nested/note.txt.\n"))
    await f.turn("withdraw skill catalogue", () => rmSync(skill))
    const agent = join(f.cwd, ".claude", "agents", "reviewer.md")
    await f.turn("add agent catalogue", () => f.write(agent, "---\nname: reviewer\ndescription: Review fixtures\n---\nReview carefully.\n"))
    await f.turn("switch agent instructions", () => { f.session.setAgent("reviewer") })
    await f.turn("reload agent catalogue", () => f.write(agent, "---\nname: reviewer\ndescription: Review updated fixtures\n---\nReview twice.\n"))
    await f.turn("leave agent and withdraw catalogue", () => { f.session.setAgent("none"); rmSync(agent) })
    let memoryId = ""
    await f.turn("save and recall memory", () => {
      const result = f.session.memory()!.store.save({ text: "Use bun test for fixtures.", kind: "fact", scope: "project", status: "active", provenance: { author: "user", session: f.session.id, message: null, call: null, seq: null, quote: null, untrusted: false } })
      if (result.outcome !== "saved") throw new Error(result.outcome)
      memoryId = result.entry.id
    })
    await f.turn("retract memory", undefined, [tool("memory_retract", { id: memoryId, reason: "The user asked to retract it.", userWords: "retract memory" }), "Retracted."])
    await f.turn("disable memory during session", () => f.config({ memory: { enabled: false } }), [tool("memory_search", { query: "fixtures" }), "Memory is off."])
    await f.turn("reenable memory during session", () => f.config({ memory: { enabled: true } }))
    const command = join(f.cwd, ".claude", "commands", "review.md")
    await f.turn("slash command and queued input", () => {
      f.write(command, "Review $ARGUMENTS.\n")
      f.beforeReply(() => { f.session.sendCommand("review", "note.txt"); f.session.queue("Then summarize.") })
    }, [tool("read", { path: "note.txt" }), "Reviewed.", "Summary."])
    await f.turn("steer while responding", () => f.beforeReply(() => { f.session.send("Also mention nested/note.txt.") }), [tool("read", { path: "note.txt" }), "Both mentioned."])
    // These are the public inbox path for notifications. The process/scheduler
    // producers have separate tests; here each origin must survive wire replay.
    for (const origin of [HARNESS_ORIGIN.backgroundCommand, HARNESS_ORIGIN.backgroundWatch, HARNESS_ORIGIN.subagentResult, HARNESS_ORIGIN.spawnLost, HARNESS_ORIGIN.wake, HARNESS_ORIGIN.wakeWebhook]) {
      await f.turn(`deliver ${origin}`, () => {
        f.beforeReply(() => f.session.admit({ messageId: `msg_cache_${origin}` as MessageId, origin, text: `Synthetic ${origin} notification.`, start: false }))
      }, ["Seen.", "Notification handled."])
    }
    await f.restart()
    await f.turn("resume stored conversation after restart")
    // Prove the scenario reached the production mutation paths, not just turns
    // whose titles claim they did so.
    const sources = f.session.readEvents().flatMap((e) => e.type === "instruction.appended" ? [e.data.source] : [])
    for (const source of ["date", "skills", "agent-index", "agent", "memory"]) expect(sources).toContain(source)
    const results = f.session.readEvents().filter((e) => e.type === "tool.settled")
    // Only the deliberately disabled memory search should fail.
    expect(results.filter((e) => e.data.outcome !== "success").map((e) => e.data.output)).toEqual([
      "Memory is turned off in the configuration that applies here. Nothing was read or saved.",
    ])
    expect(results.some((e) => e.data.output.startsWith(`Retracted ${memoryId}:`))).toBe(true)
    expect(f.recording.requests.length).toBeGreaterThan(30)
    f.finish()
  } finally { await f.close() }
})

test("wire prefix across empty-answer and step-limit reminders", async () => {
  const f = await fixture()
  try {
    await f.turn("first question")
    await f.turn("empty response nudge", undefined, ["", "Now answered."])
    // The production limit, not a lowered test limit: keep asking for read until
    // the loop makes its final request with tool_choice=none.
    const { ENGINE_LIMITS } = await import("../../src/engine/constants.ts")
    await f.turn("step limit reminder", undefined, [...Array.from({ length: ENGINE_LIMITS.stepLimit }, () => tool("read", { path: "note.txt" })), "Stopping."])
    for (let i = 0; i < 6; i++) await f.turn(`follow-up ${i + 1}`)
    const origins = f.session.readEvents().flatMap((e) => e.type === "synthetic.appended" ? [e.data.origin] : [])
    expect(origins).toContain(HARNESS_ORIGIN.emptyResponse)
    expect(origins).toContain(HARNESS_ORIGIN.stepLimit)
    f.finish()
  } finally { await f.close() }
})

test("wire prefix at manual compaction with production history settings", async () => {
  const f = await fixture()
  try {
    // Enough *real history*, not an invented token count or a lowered window,
    // for the production manual-compaction threshold and retained-tail budget.
    for (let i = 0; i < 8; i++) {
      await f.turn(`history turn ${i + 1}`, undefined, [`Fixture ${i}: ` + "A previously answered detail. ".repeat(900)])
    }
    await f.turn("manual compaction", () => {
      f.beforeReply(() => { void f.session.compact() })
    }, ["Ready to compact.", "A short synthetic summary.", "A short synthetic summary."])
    await f.turn("continue after compaction")
    expect(f.session.readEvents().some((e) => e.type === "compaction.ended")).toBe(true)
    // Approved individually by the user; each named step permits only one break.
    f.finish({ "manual compaction": "compaction", "continue after compaction": "compaction" })
  } finally { await f.close() }
})
