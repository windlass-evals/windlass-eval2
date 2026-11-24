import { describe, expect, test } from "bun:test"
import type { EventData, VerificationOutcome } from "@windlass/core"
import {
  callArgument, checkLines, checksSummary, detailLines, diffStat, errorSummary, fileList, firstLine,
  mcpArguments, programLines, stateUnchangedNote, successSummary, unresolvedReason, unresolvedWhat,
} from "../src/tools.ts"

const settled = (output = "", display: unknown = null, outcome: "success" | "error" | "not_started" | "effect_unknown" = "success") =>
  ({ output, display, outcome } as EventData<"tool.settled">)
const check = (name: string, status: "passed" | "failed" | "timed_out" | "could_not_start" | "interrupted", extra: object = {}) =>
  ({ name, status, command: `run ${name}`, exitCode: status === "failed" ? 2 : null, signal: null, outputPath: null, startError: null, ...extra }) as unknown as Parameters<typeof checksSummary>[0][number]

describe("tool display helpers", () => {
  test("argument summaries use known fields, sensible defaults, and fallback input", () => {
    expect(callArgument("read", '{"path":"src/a.ts"}')).toBe("src/a.ts")
    expect(callArgument("ls", "{}" )).toBe(".")
    expect(callArgument("grep", '{"pattern":"foo","path":"src","glob":"*.ts"}')).toBe("foo in src (*.ts)")
    expect(callArgument("shell", '{"command":"bun test"}')).toBe("bun test")
    expect(callArgument("run_code", '{"code":"x"}')).toBe("")
    expect(callArgument("mcp_call", '{"server":"srv","tool":"lookup"}')).toBe("srv/lookup")
    expect(callArgument("subagent", JSON.stringify({ task: "  inspect this\nmore" }))).toBe("inspect this")
    expect(callArgument("report_check_failure", '{"checks":["typecheck",3],"reason":"broken"}')).toBe("typecheck: broken")
    expect(callArgument("other", '{"x":4,"y":"fallback"}')).toBe("fallback")
    expect(callArgument("read", "  malformed ")).toBe("malformed")
    expect(callArgument("read", "[]")).toBe("[]")
  })

  test("success and error outcomes summarize tool-specific results", () => {
    expect(successSummary("read", settled("a\nb", { lines: 2, totalLines: 10 }))).toBe("2 lines of 10")
    expect(successSummary("read", settled("", { image: { mediaType: "image/png", width: 4, height: 3, bytes: 1024 } }))).toBe("image · image/png · 4×3 · 1.0 KB")
    expect(successSummary("write", settled("", { created: true, bytes: 2 }))).toBe("created · 2 B")
    expect(successSummary("edit", settled("", { diff: "--- a\n+++ b\n+x\n-y", replacements: 2 }))).toBe("+1 -1 · 2 replacements")
    expect(successSummary("grep", settled("", { matches: 3, files: 2 }))).toBe("3 matches in 2 files")
    expect(successSummary("glob", settled("", { matches: 0 }))).toBe("no files")
    expect(successSummary("ls", settled("", { entries: 1 }))).toBe("1 entry")
    expect(successSummary("shell", settled("", { exitCode: 7 }))).toBe("exit 7")
    expect(successSummary("shell", settled("", { background: "job" }))).toBe("started in the background")
    expect(successSummary("mcp_search", settled("2 MCP tools found"))).toBe("2 tools")
    expect(successSummary("mcp_call", settled("Result of MCP tool x:\nanswer\nrest"))).toBe("answer")
    expect(successSummary("unknown", settled("\n result\nnext"))).toBe("result")
    expect(errorSummary("shell", settled("", { timedOut: true }, "error"))).toBe("timed out")
    expect(errorSummary("read", settled("oops", null, "error"))).toBe("failed")
  })

  test("program and detail lines handle truncation, outcomes, and shell statuses", () => {
    expect(programLines('{"code":"a\\nb\\nc\\nd"}', 3)).toEqual(["a", "b", "… 2 more lines"])
    expect(programLines('{"code":"  "}')).toEqual([])
    expect(detailLines("shell", settled("[Exit code 1]\na\nb\nc\nd\ne\nf\ng", { exitCode: 1 }, "error"))).toEqual(["… 3 earlier lines", "d", "e", "f", "g"])
    expect(detailLines("run_code", settled("a\nb\nc\nd\ne"))).toEqual(["a", "b", "c", "… 2 more lines"])
    expect(detailLines("read", settled("one\ntwo", null, "error"))).toEqual(["one", "two"])
    expect(detailLines("read", settled("x", null, "not_started"))).toEqual([])
    expect(detailLines("read", settled("x", null, "effect_unknown"))).toEqual([])
  })

  test("diffs and first lines", () => {
    expect(diffStat("--- a\n+++ b\n+x\n-y\n+z")).toEqual({ added: 2, removed: 1 })
    expect(firstLine(" \n  hello \nworld")).toBe("hello")
    expect(firstLine("\n")).toBe("")
  })

  test("checks are ordered, described, and verification wording is specific", () => {
    const checks = [check("ok", "passed"), check("bad", "failed"), check("slow", "timed_out"), check("missing", "could_not_start"), check("stop", "interrupted")]
    expect(checksSummary(checks)).toBe("1 failed, 1 timed out, 1 could not start, 1 stopped, 1 passed")
    expect(checksSummary([])).toBe("none ran")
    expect(checkLines(checks)).toEqual([
      { name: "bad", status: "exit 2", command: "run bad", output: null },
      { name: "slow", status: "timed out", command: "run slow", output: null },
      { name: "missing", status: "could not start", command: "run missing", output: null },
      { name: "stop", status: "stopped", command: "run stop", output: null },
    ])
    expect(unresolvedWhat({ status: "unresolved", reason: "not_started" } as Parameters<typeof unresolvedWhat>[0])).toBe("checks that could not be started")
    expect(unresolvedWhat({ status: "unresolved", reason: "report_mode" } as Parameters<typeof unresolvedWhat>[0])).toBe("failing checks")
    expect(unresolvedReason({ status: "unresolved", reason: "acknowledged", acknowledgement: { reason: "blocked" } } as Parameters<typeof unresolvedReason>[0])).toContain("cannot make them pass: blocked")
    expect(stateUnchangedNote({ status: "not_needed", reason: "state_unchanged", since: { run: null } } as VerificationOutcome)).toContain("session started")
    expect(stateUnchangedNote({ status: "not_needed", reason: "state_unchanged" } as VerificationOutcome)).toContain("last verified")
    expect(stateUnchangedNote({ status: "succeeded" } as unknown as VerificationOutcome)).toBeNull()
  })

  test("MCP argument truncation and file lists", () => {
    expect(mcpArguments('{"arguments":{"x":1}}')).toBe('{"x":1}')
    expect(mcpArguments('{"arguments":"abcdef"}', 3)).toBe('"ab… (5 more characters)')
    expect(mcpArguments("not json")).toBeNull()
    expect(fileList(["a", "b", "c"], 2)).toBe("a, b (+1 more)")
    expect(fileList(["a"], 2)).toBe("a")
  })
})
