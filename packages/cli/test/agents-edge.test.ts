import { describe, expect, test } from "bun:test"
import type { AgentInfo, AgentsResult, TaskItem } from "@windlass/acp/extensions"
import type { AgentRecord, Json } from "@windlass/core"
import { agentLines, agentProblemLines, agentRefused, agentSwitchText, compactText, firstSentence, requestsText, taskLines, tasksOf, tasksProgress } from "../src/agents.ts"

const agent: AgentInfo = { name: "docs", description: "Writes docs.", path: "/w/docs.md", scope: "project", model: null, effort: null, restrictions: "", tag: null }
const result: AgentsResult = { available: true, agents: [], problems: [], default: null, ignored: [], current: null }
const record: AgentRecord = { name: "docs", path: "/w/docs.md", scope: "project", definition: "fingerprint", instructions: "Write docs.", restrictions: { effects: null, tools: null, deniedTools: [], approval: null }, model: null, effort: null }

describe("agent listing edge cases", () => {
  test("an unavailable engine does not show stale agents or diagnostics", () => {
    expect(agentLines({ ...result, available: false, agents: [agent], current: "gone", ignored: ["agents.default"] })).toEqual([
      { text: "this engine offers no agents", tone: "dim", indent: 0 },
    ])
  })

  test("an empty listing still warns about a retained definition and ignored settings", () => {
    expect(agentLines({ ...result, current: "gone", ignored: ["agents.default"] })).toEqual([
      { text: "No agents are defined here. A definition is a Markdown file in .claude/agents (or the user's agents directory): a name, a description, and what the agent may do.", tone: "dim", indent: 0 },
      { text: "This session runs as gone, whose definition is no longer among them; it keeps the one it was given.", tone: "warn", indent: 0 },
      { text: "not followed: agents.default", tone: "warn", indent: 2 },
    ])
  })

  test("an unmarked agent omits the metadata row and ignores effort without a model", () => {
    expect(agentLines({ ...result, agents: [{ ...agent, effort: "high" }] })).toEqual([
      { text: "Agents (this session runs as no agent):", tone: "bold", indent: 0 },
      { text: "  docs  Writes docs.", tone: "plain", indent: 2, hang: 8 },
      { text: "/w/docs.md", tone: "dim", indent: 6, path: true },
      { text: "/agent <name> switches to one", tone: "dim", indent: 0 },
    ])
  })

  test("current and default are independent, and unequal names share a description column", () => {
    const lines = agentLines({ ...result, agents: [agent, { ...agent, name: "reviewer", tag: "read only", model: "test-model", effort: "high" }], current: "docs", default: "reviewer" })
    expect(lines).toEqual([
      { text: "Agents (this session runs as docs):", tone: "bold", indent: 0 },
      { text: "* docs      Writes docs.", tone: "accent", indent: 2, hang: 12 },
      { text: "/w/docs.md", tone: "dim", indent: 6, path: true },
      { text: "  reviewer  Writes docs.", tone: "plain", indent: 2, hang: 12 },
      { text: "read only · model test-model high · the default for new sessions", tone: "dim", indent: 6 },
      { text: "/w/docs.md", tone: "dim", indent: 6, path: true },
      { text: "/agent <name> switches to another · /agent none switches it off", tone: "dim", indent: 0 },
    ])
  })

  test("a missing current definition is reported even when other agents remain", () => {
    const lines = agentLines({ ...result, agents: [agent], current: "gone" })
    expect(lines.at(-1)).toEqual({ text: "This session runs as gone, whose definition is no longer among them; it keeps the one it was given.", tone: "warn", indent: 0 })
    expect(lines.some((line) => line.tone === "accent")).toBe(false)
  })

  test("all problem severities preserve their paths, reasons, order and tones", () => {
    expect(agentProblemLines({ problems: [
      { path: "/skipped.md", severity: "skipped", reason: "missing description", name: null },
      { path: "/shadowed.md", severity: "shadowed", reason: "project wins", name: "docs" },
      { path: "/warning.md", severity: "warning", reason: "unknown field", name: "reviewer" },
    ], ignored: ["project default", "project directories"] })).toEqual([
      { text: "Definitions with problems:", tone: "warn", indent: 0 },
      { text: "/skipped.md", tone: "warn", indent: 2, path: true },
      { text: "not loaded: missing description", tone: "warn", indent: 4 },
      { text: "/shadowed.md", tone: "dim", indent: 2, path: true },
      { text: "hidden by another agent of the same name: project wins", tone: "dim", indent: 4 },
      { text: "/warning.md", tone: "dim", indent: 2, path: true },
      { text: "loaded, with a warning: unknown field", tone: "dim", indent: 4 },
      { text: "not followed: project default", tone: "warn", indent: 2 },
      { text: "not followed: project directories", tone: "warn", indent: 2 },
    ])
    expect(agentProblemLines(result)).toEqual([])
    expect(agentProblemLines({ problems: [], ignored: ["setting"] })).toEqual([{ text: "not followed: setting", tone: "warn", indent: 2 }])
  })
})

describe("agent switch edge cases", () => {
  test("no agent to no agent has no restriction detail", () => {
    expect(agentSwitchText(null, null)).toEqual({ head: "no agent", detail: null })
  })

  test("unrestricted selection, replacement and reselection omit restriction detail", () => {
    expect(agentSwitchText(null, record)).toEqual({ head: "working as the agent docs", detail: null })
    expect(agentSwitchText("reviewer", record)).toEqual({ head: "agent reviewer → docs", detail: null })
    expect(agentSwitchText("docs", record)).toEqual({ head: "the agent docs was selected again with its changed definition", detail: null })
  })

  test("reselecting a restricted definition shows its new restrictions", () => {
    expect(agentSwitchText("docs", { ...record, restrictions: { ...record.restrictions, deniedTools: ["shell"] } })).toEqual({
      head: "the agent docs (restricted) was selected again with its changed definition", detail: "Never these tools: shell.",
    })
  })

  test("a refusal preserves the engine's text verbatim, including empty text", () => {
    for (const text of ["", "First reason.\n  More detail (unchanged)."])
      expect(agentRefused("docs", { text })).toEqual({ head: "refused by the docs agent", reason: text })
  })
})

describe("task payload validation", () => {
  const invalid: Json[] = [
    null, false, 0, "todo", [], {},
    { todo: null }, { todo: true }, { todo: "items" }, { todo: [] }, { todo: {} },
    { todo: { items: null } }, { todo: { items: {} } }, { todo: { items: "tasks" } },
  ]
  test.each(invalid.map((display) => ({ display })))("rejects malformed envelopes: %j", ({ display }) => {
    expect(tasksOf(display)).toBeNull()
  })

  const invalidItems: Json[] = [null, false, 1, "task", [], {}, { text: "task" }, { status: "done" }, { text: 1, status: "done" }, { text: "task", status: "complete" }, { text: "task", status: null }]
  test.each(invalidItems.map((item) => ({ item })))("rejects the entire list, not a valid prefix: %j", ({ item }) => {
    expect(tasksOf({ todo: { items: [{ text: "valid", status: "done" }, item] } })).toBeNull()
  })

  test("accepts an empty list and projects valid tasks without extra fields", () => {
    expect(tasksOf({ todo: { items: [] } })).toEqual([])
    const display = { todo: { items: [{ text: "", status: "pending", extra: true }, { text: "working", status: "in_progress" }, { text: "finished", status: "done" }] }, other: true } as const satisfies Json
    expect(tasksOf(display)).toEqual([{ text: "", status: "pending" }, { text: "working", status: "in_progress" }, { text: "finished", status: "done" }])
    expect(display.todo.items[0]).toEqual({ text: "", status: "pending", extra: true })
  })
})

describe("task and request formatting boundaries", () => {
  const tasks: readonly TaskItem[] = [{ text: "queued", status: "pending" }, { text: "working", status: "in_progress" }, { text: "finished", status: "done" }]

  test("empty, single, all-done and mixed progress", () => {
    expect(tasksProgress([])).toBe("cleared")
    expect(tasksProgress([tasks[0]!])).toBe("0 of 1 done")
    expect(tasksProgress([tasks[2]!])).toBe("all 1 done")
    expect(tasksProgress([tasks[2]!, tasks[2]!])).toBe("all 2 done")
    expect(tasksProgress(tasks)).toBe("1 of 3 done")
  })

  test("checklists preserve order and apply default or explicit indentation to every status", () => {
    expect(taskLines([])).toEqual([])
    for (const indent of [0, 4]) expect(taskLines(tasks, indent)).toEqual([
      { text: "○ queued", tone: "plain", indent },
      { text: "▸ working", tone: "bold", indent },
      { text: "✓ finished", tone: "dim", indent },
    ])
    expect(taskLines(tasks)).toEqual(taskLines(tasks, 0))
  })

  test.each([
    [0, 0, "0 steps"], [1, 0, "1 step"], [2, 0, "2 steps"],
    [0, 1, "0 steps + 1 summary call"], [1, 2, "1 step + 2 summary calls"], [2, 1, "2 steps + 1 summary call"],
  ] as const)("%i steps and %i summary calls", (steps, summaries, expected) => {
    expect(requestsText(steps, summaries)).toBe(expected)
  })
})

describe("sentence and compaction boundaries", () => {
  test.each([
    ["", ""], ["  (aside)  ", ""], ["  No punctuation  ", "No punctuation"],
    ["Ready? Next.", "Ready?"], ["Stop!\nNext.", "Stop!"],
    ["Use v1.2 and example.com. Next.", "Use v1.2 and example.com."],
    ["One (aside) sentence (another aside). Next.", "One sentence."],
  ])("first sentence of %j", (input, expected) => {
    expect(firstSentence(input)).toBe(expected)
  })

  test("nothing may have an empty sentence, but failure text is never shortened", () => {
    expect(compactText({ kind: "nothing", message: " (aside) " })).toEqual({ text: "", tone: "info" })
    expect(compactText({ kind: "failed", message: "Failed (detail). Try again!" })).toEqual({ text: "Failed (detail). Try again!", tone: "warn" })
  })

  test.each(["repaired", "fallback"] as const)("successful %s compaction has no extra message", (source) => {
    expect(compactText({ kind: "compacted", tokensBefore: 10, tokensAfter: 5, source, detail: "Recovered without a summary model." })).toBeNull()
  })
})
