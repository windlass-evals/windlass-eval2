/**
 * `scripts/export-markdown.ts` as a user runs it: a hand-written session in a temporary data directory, the script
 * started as a process, its stdout and exit code read.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brand } from "../../src/brand.ts"
import { event } from "../../src/event/durable.ts"
import type { CallId, ExecutionId, MessageId, SessionId } from "../../src/id.ts"
import { openSessionDirectory } from "../../src/store/directory.ts"
import { E2E_TIMEOUT_MS } from "../../src/testing/wait.ts"

// End-to-end: a process starts here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

const script = join(import.meta.dir, "..", "..", "..", "..", "scripts", "export-markdown.ts")
const dataDir = mkdtempSync(join(tmpdir(), `${brand.directory}-markdown-`))
afterAll(() => rmSync(dataDir, { recursive: true, force: true }))

const id = "ses_markdown_1" as SessionId
const m = (value: string) => value as MessageId
const usage = { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningTokens: 0 }

const directory = openSessionDirectory({ dataDir })
const store = directory.create(id)
store.append(id, [
  event("session.created", { cwd: "/work/demo", title: "Fix the date bug", lineage: null, settings: { model: "gpt-test", reasoningEffort: "low" } }),
  event("baseline.set", { instructions: "SYSTEM PROMPT TEXT", tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object" } }], sources: [] }),
  event("inbox.enqueued", { messageId: m("u1"), origin: null, delivery: "steer", content: [{ type: "text", text: "Why is the date wrong?" }] }),
  event("execution.started", { executionId: "x1" as ExecutionId }),
  event("inbox.delivered", { messageId: m("u1") }),
  event("step.started", { messageId: m("a1"), attempt: 1, model: "gpt-test" }),
  event("reasoning.ended", { messageId: m("a1"), text: "PRIVATE REASONING", providerData: null }),
  event("text.ended", { messageId: m("a1"), text: "Let me look.", providerData: null }),
  event("tool.called", { messageId: m("a1"), callId: "c1" as CallId, name: "read", input: '{"path":"src/date.ts"}', providerData: null }),
  event("tool.started", { messageId: m("a1"), callId: "c1" as CallId, effect: "read" }),
  event("tool.settled", { messageId: m("a1"), callId: "c1" as CallId, outcome: "success", output: "TOOL RESULT TEXT", truncation: null, attachments: [], display: null }),
  event("step.ended", { messageId: m("a1"), finish: "tool_calls", usage }),
  event("step.started", { messageId: m("a2"), attempt: 1, model: "gpt-test" }),
  event("text.ended", { messageId: m("a2"), text: "It subtracts a day.", providerData: null }),
  event("step.ended", { messageId: m("a2"), finish: "stop", usage }),
  event("execution.succeeded", { executionId: "x1" as ExecutionId, verification: { status: "not_configured" } }),
])
directory.close()

async function run(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const child = Bun.spawn(["bun", script, ...args, "--data-dir", dataDir], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, code }
}

describe("scripts/export-markdown.ts", () => {
  test("writes the conversation with speaker headings and nothing else", async () => {
    const result = await run(id)
    expect(result.code).toBe(0)
    expect(result.stdout).toBe("# Fix the date bug\n\n## User\n\nWhy is the date wrong?\n\n## Assistant\n\nLet me look.\n\nIt subtracts a day.\n")
    for (const hidden of ["PRIVATE REASONING", "TOOL RESULT TEXT", "SYSTEM PROMPT TEXT", "src/date.ts"]) expect(result.stdout).not.toContain(hidden)
  })

  test("takes a unique prefix of the ID and can leave the title out", async () => {
    const result = await run("ses_markdown", "--no-title")
    expect(result.code).toBe(0)
    expect(result.stdout.startsWith("## User\n")).toBe(true)
  })

  test("an unknown session is an error on stderr and nothing on stdout", async () => {
    const result = await run("ses_nope")
    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("ses_nope")
  })

  test("--list shows the session", async () => {
    const result = await run("--list")
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`${id}  `)
    expect(result.stdout).toContain("Fix the date bug")
  })
})
