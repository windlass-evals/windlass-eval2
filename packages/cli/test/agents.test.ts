import { describe, expect, test } from "bun:test"
import type { AgentsResult, CompactResult, TaskItem } from "@windlass/acp/extensions"
import type { AgentRecord, Json } from "@windlass/core"
import {
  LEFT_TO_PARENT, TASK_MARK, TASK_TOOL, UNVERIFIED_HINT, agentLines, agentProblemLines,
  agentRefused, agentSwitchText, compactText, firstSentence, requestsText, taskLines, tasksOf, tasksProgress,
} from "../src/agents.ts"

type AgentInfo = AgentsResult["agents"][number]
const agent = (fields: Partial<AgentInfo> = {}): AgentInfo => ({
  name: "reviewer", description: "Reviews changes.", path: ".claude/agents/reviewer.md", scope: "project",
  model: null, effort: null, restrictions: "Only tools that read (effects: read).", tag: "read only", ...fields,
})
const record = (): AgentRecord => ({ name: "reviewer", path: ".claude/agents/reviewer.md", scope: "project", definition: "f".repeat(64), instructions: "Review.", model: null, effort: null, restrictions: { effects: ["read"], tools: null, deniedTools: [], approval: null } })
const empty = (fields: Partial<AgentsResult> = {}): AgentsResult => ({ available: true, agents: [], problems: [], default: null, ignored: [], current: null, ...fields })

describe("agent text and lines", () => {
  test("refusal attributes the engine's exact reason to the agent", () => {
    expect(agentRefused("reviewer", { text: "No writing." })).toEqual({ head: "refused by the reviewer agent", reason: "No writing." })
  })
  test("switch text covers turning off, starting, changing, reselecting and unrestricted agents", () => {
    expect(agentSwitchText(null, null)).toEqual({ head: "no agent", detail: null })
    expect(agentSwitchText("reviewer", null).detail).toBeNull()
    expect(agentSwitchText(null, record())).toEqual({ head: "working as the agent reviewer (read only)", detail: "Only tools that read (effects: read)." })
    expect(agentSwitchText("docs", record())).toEqual({ head: "agent docs → reviewer (read only)", detail: "Only tools that read (effects: read)." })
    expect(agentSwitchText("reviewer", record())).toMatchObject({ head: "the agent reviewer (read only) was selected again with its changed definition" })
    expect(agentSwitchText(null, { ...record(), restrictions: { effects: null, tools: null, deniedTools: [], approval: null } })).toEqual({ head: "working as the agent reviewer", detail: null })
  })
  test("lists unavailable, empty, populated, current-missing and problem states", () => {
    expect(agentLines(empty({ available: false }))).toEqual([{ text: "this engine offers no agents", tone: "dim", indent: 0 }])
    expect(agentLines(empty()).map((x) => x.text).join("\n")).toContain("No agents are defined here.")
    const lines = agentLines(empty({ agents: [agent({ model: "gpt-test", effort: "low" }), agent({ name: "docs", description: "Writes docs.", restrictions: "", tag: null })], current: "gone", default: "reviewer", ignored: ["legacy setting"], problems: [
      { name: null, path: "skip.md", severity: "skipped", reason: "invalid" }, { name: null, path: "shadow.md", severity: "shadowed", reason: "duplicate" }, { name: null, path: "warn.md", severity: "warning", reason: "odd" },
    ] }))
    expect(lines.map((x) => x.text)).toEqual([
      "Agents (this session runs as gone):", "  reviewer  Reviews changes.", "read only · model gpt-test low · the default for new sessions", ".claude/agents/reviewer.md",
      "  docs      Writes docs.", ".claude/agents/reviewer.md", "/agent <name> switches to another · /agent none switches it off",
      "This session runs as gone, whose definition is no longer among them; it keeps the one it was given.", "Definitions with problems:",
      "skip.md", "not loaded: invalid", "shadow.md", "hidden by another agent of the same name: duplicate", "warn.md", "loaded, with a warning: odd", "not followed: legacy setting",
    ])
    expect(lines[1]).toMatchObject({ tone: "plain", indent: 2, hang: 12 })
    expect(lines[0]?.tone).toBe("bold")
    expect(lines[9]?.tone).toBe("warn")
  })
  test("problem lines alone preserve severity-specific tones and path metadata", () => {
    expect(agentProblemLines({ problems: [], ignored: [] })).toEqual([])
    expect(agentProblemLines({ problems: [{ name: null, path: "x", severity: "skipped", reason: "bad" }], ignored: ["old"] })).toEqual([
      { text: "Definitions with problems:", tone: "warn", indent: 0 }, { text: "x", tone: "warn", indent: 2, path: true },
      { text: "not loaded: bad", tone: "warn", indent: 4 }, { text: "not followed: old", tone: "warn", indent: 2 },
    ])
  })
})

describe("task list helpers", () => {
  test("extracts only a well-formed todo payload; empty tasks are valid", () => {
    const tasks: TaskItem[] = [{ text: "one", status: "pending" }, { text: "two", status: "in_progress" }, { text: "three", status: "done" }]
    expect(tasksOf({ todo: { items: tasks } } as unknown as Json)).toEqual(tasks)
    expect(tasksOf({ todo: { items: [] } } as unknown as Json)).toEqual([])
    for (const value of [null, "x", 1, true, [], {}, { todo: null }, { todo: [] }, { todo: {} }, { todo: { items: {} } }, { todo: { items: [null] } }, { todo: { items: ["x"] } }, { todo: { items: [{ text: 1, status: "done" }] } }, { todo: { items: [{ text: "x", status: "invalid" }] } }, { todo: { items: [{ text: "ok", status: "done" }, {}] } }]) expect(tasksOf(value as Json)).toBeNull()
  })
  test("progress, marks, line tones and indentation cover empty and every status", () => {
    const tasks: TaskItem[] = [{ text: "done", status: "done" }, { text: "doing", status: "in_progress" }, { text: "later", status: "pending" }]
    expect(TASK_TOOL).toBe("todo")
    expect(TASK_MARK).toEqual({ done: "✓", in_progress: "▸", pending: "○" })
    expect(tasksProgress([])).toBe("cleared")
    expect(tasksProgress([{ text: "x", status: "done" }])).toBe("all 1 done")
    expect(tasksProgress(tasks)).toBe("1 of 3 done")
    expect(tasksProgress([{ text: "x", status: "pending" }])).toBe("0 of 1 done")
    expect(taskLines(tasks, 3)).toEqual([{ text: "✓ done", tone: "dim", indent: 3 }, { text: "▸ doing", tone: "bold", indent: 3 }, { text: "○ later", tone: "plain", indent: 3 }])
    expect(taskLines([])).toEqual([])
  })
})

describe("request and compaction wording", () => {
  test("formats singular and plural request counts", () => {
    expect(requestsText(1, 0)).toBe("1 step")
    expect(requestsText(2, 0)).toBe("2 steps")
    expect(requestsText(1, 1)).toBe("1 step + 1 summary call")
    expect(requestsText(3, 2)).toBe("3 steps + 2 summary calls")
    expect(requestsText(0, 1)).toBe("0 steps + 1 summary call")
  })
  test("handles all compaction outcomes", () => {
    expect(compactText({ kind: "nothing", message: "  Nothing to compact (aside). More." })).toEqual({ text: "Nothing to compact.", tone: "info" })
    expect(compactText({ kind: "failed", message: "Interrupted." })).toEqual({ text: "Interrupted.", tone: "warn" })
    expect(compactText({ kind: "compacted", tokensBefore: 10, tokensAfter: 4, source: "model", detail: null } as CompactResult)).toBeNull()
  })
  test("firstSentence removes parenthetical asides and handles missing endings", () => {
    expect(firstSentence(" First (aside) sentence. Then.")).toBe("First sentence.")
    expect(firstSentence("A sentence! Next?")).toBe("A sentence!")
    expect(firstSentence("No ending (removed)")).toBe("No ending")
    expect(firstSentence(" (only aside) ")).toBe("")
    expect(firstSentence("Wait... next")).toBe("Wait...")
  })
  test("exports stable hints", () => {
    expect(UNVERIFIED_HINT).toContain("Files the checks cover changed outside this turn")
    expect(LEFT_TO_PARENT).toBe("its checks are left to its parent's turn")
  })
})
