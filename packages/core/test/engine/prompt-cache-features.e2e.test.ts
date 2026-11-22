import { expect, setDefaultTimeout, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { HARNESS_ORIGIN } from "../../src/event/durable.ts"
import type { CommandSandbox } from "../../src/sandbox/command.ts"
import { E2E_TIMEOUT_MS, waitFor } from "../../src/testing/wait.ts"
import { exited, scriptedRunner } from "../hooks/helpers.ts"
import { fixture as languageServer } from "../lsp/helpers.ts"
import { fixtureServer } from "../mcp/helpers.ts"
import { fixture, tool, warm } from "./prompt-cache-fixture.ts"

setDefaultTimeout(E2E_TIMEOUT_MS)

test("wire prefix across MCP server arrival, catalogue updates and withdrawal", async () => {
  const f = await fixture({ engine: { mcp: { startWaitMs: 8000 } } })
  try {
    await warm(f)
    await f.turn("connect MCP server", () => f.config({ approval: { mode: "full" }, mcp: { servers: { fixture: fixtureServer(["--only", "echo,add_tool,remove_tool"]) } } }), [tool("mcp_search", { query: "echo" }), "Found echo."])
    await waitFor(() => f.session.mcp()?.servers[0]?.state === "ready", { what: "MCP fixture ready" })
    await f.turn("add MCP tool", undefined, [tool("mcp_call", { server: "fixture", tool: "add_tool", arguments: { name: "extra" } }), "Added."])
    await waitFor(() => f.session.mcp()?.servers[0]?.tools === 4, { what: "MCP list_changed notification" })
    await f.turn("publish changed MCP catalogue")
    await f.turn("clear taint and remove MCP tool", () => { expect(f.session.clearTaint()).toBe(true) }, [tool("mcp_call", { server: "fixture", tool: "remove_tool", arguments: { name: "extra" } }), "Removed."])
    await waitFor(() => f.session.mcp()?.servers[0]?.tools === 3, { what: "MCP tool withdrawal" })
    await f.turn("publish reduced MCP catalogue")
    await f.turn("withdraw MCP server", () => f.config({ approval: { mode: "full" } }))
    const updates = f.session.readEvents().filter((e) => e.type === "instruction.appended" && e.data.source === "mcp")
    expect(updates.length).toBeGreaterThanOrEqual(4)
    const last = updates.at(-1)!
    expect(last.type === "instruction.appended" && last.data.fingerprint === null).toBe(true)
    expect(f.session.readEvents().filter((e) => e.type === "tool.settled" && e.data.outcome !== "success")).toEqual([])
    f.finish()
  } finally { await f.close() }
})

test("wire prefix across session-home availability and withdrawal", async () => {
  // Platform adapter only: the real engine resolves configuration and appends
  // its home notices. No shell command is executed against this adapter.
  let used = false
  const sandbox: CommandSandbox = {
    state: { available: true },
    temp: (id) => ({ dir: `/tmp/cache-${id}`, alias: "/tmp" }),
    plan: () => { throw new Error("This scenario executes no sandboxed command") },
    policy: () => { throw new Error("This scenario executes no sandboxed command") },
    sessionHome: { use: (_, on) => { used = on }, state: () => ({ used, notice: null }) },
  }
  const f = await fixture({ engine: { approval: { sandbox, secrets: [] } } })
  try {
    await warm(f)
    await f.turn("enable session home", () => f.session.setSandboxHome("session"))
    await f.turn("read with session home", undefined, [tool("read", { path: "note.txt" }), "Read."])
    await f.turn("withdraw session home", () => f.session.setSandboxHome("user"))
    const updates = f.session.readEvents().filter((e) => e.type === "instruction.appended" && e.data.source === "session-home")
    expect(updates).toHaveLength(2)
    f.finish()
  } finally { await f.close() }
})

test("wire prefix across failing verification report and repair", async () => {
  const f = await fixture({ config: { approval: { mode: "full" } } })
  try {
    await warm(f)
    await f.turn("verification report and repair", () => f.config({ approval: { mode: "full" }, checks: [{ name: "fixture-check", command: "test -f passed.txt" }] }), [
      tool("write", { path: "note.txt", content: "Changed fixture.\n" }), "Changed it.",
      tool("write", { path: "passed.txt", content: "The check now passes.\n" }), "Fixed it.",
    ])
    await f.turn("follow-up after checks")
    expect(f.session.readEvents().some((e) => e.type === "synthetic.appended" && e.data.origin === HARNESS_ORIGIN.checkReport)).toBe(true)
    expect(f.session.readEvents().filter((e) => e.type === "checks.finished").length).toBeGreaterThanOrEqual(2)
    f.finish()
  } finally { await f.close() }
})

test("wire prefix across before-tool, after-tool and stop hooks", async () => {
  let stopCalls = 0
  const hooks = scriptedRunner({
    before: exited(2, "Do not read this fixture yet."),
    after: exited(2, "The read completed; check its contents."),
    stop: () => ++stopCalls === 1 ? exited(2, "Explain what you checked.") : exited(0),
  })
  const f = await fixture({ engine: { commandHooks: { runner: hooks.runner } } })
  try {
    await warm(f)
    await f.turn("before-tool refusal", () => f.config({ hooks: { beforeTool: [{ name: "before", tools: ["read"], command: "fixture-before" }] } }), [tool("read", { path: "note.txt" }), "The hook refused."])
    await f.turn("after-tool note", () => f.config({ hooks: { afterTool: [{ name: "after", tools: ["read"], command: "fixture-after" }] } }), [tool("read", { path: "note.txt" }), "The hook noted the read."])
    await f.turn("stop-hook reminder", () => f.config({ hooks: { stop: [{ name: "stop", command: "fixture-stop" }] } }), ["Done.", "I checked the fixture."])
    await f.turn("withdraw hook configuration", () => f.config({}))
    const records = f.session.readEvents().filter((e) => e.type === "hook.ran")
    for (const point of ["beforeTool", "afterTool", "stop"]) expect(records.some((e) => e.data.point === point)).toBe(true)
    expect(f.session.readEvents().some((e) => e.type === "synthetic.appended" && e.data.origin === HARNESS_ORIGIN.stopHook)).toBe(true)
    f.finish()
  } finally { await f.close() }
})

test("wire prefix across language-server diagnostics and configuration reload", async () => {
  const f = await fixture({ config: { approval: { mode: "full" } } })
  try {
    await warm(f)
    await f.turn("start language server by reading file", () => f.config({ approval: { mode: "full" }, lsp: { waitMs: 5000, servers: { fixture: languageServer() } } }), [tool("read", { path: "note.txt" }), "Read."])
    await waitFor(() => f.session.lsp()?.servers.some((s) => s.state === "ready"), { what: "language-server fixture ready" })
    await f.turn("edit adds diagnostic", undefined, [tool("write", { path: "note.txt", content: "call(ERROR(fetchUser))\n" }), "Edited."])
    await f.turn("remove diagnostic", undefined, [tool("write", { path: "note.txt", content: "call(fetchUser)\n" }), "Fixed."])
    await f.turn("withdraw language server", () => f.config({ approval: { mode: "full" } }))
    expect(f.session.readEvents().some((e) => e.type === "tool.settled" && e.data.diagnostics?.noteAdded)).toBe(true)
    f.finish()
  } finally { await f.close() }
})

test("wire prefix across image attachments, output capping and redaction", async () => {
  const secret = "synthetic-secret-for-redaction"
  const f = await fixture({ config: { approval: { mode: "full" } }, engine: { approval: { secrets: [secret] } } })
  try {
    await warm(f)
    // Synthetic PNG header, sufficient for the real read tool's image sniffing.
    const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001080600000000000000", "hex")
    await f.turn("read image attachment", () => writeFileSync(join(f.cwd, "image.png"), png), [tool("read", { path: "image.png" }), "Saw image."])
    await f.turn("cap large tool output", () => f.write(join(f.cwd, "large.txt"), Array.from({ length: 1000 }, (_, i) => `line ${i}: ${"synthetic content ".repeat(20)}\n`).join("")), [tool("read", { path: "large.txt" }), tool("shell", { command: "cat large.txt" }), "Read paged and capped text."])
    await f.turn("redact tool output", () => f.write(join(f.cwd, "secret.txt"), `Fixture value: ${secret}\n`), [tool("read", { path: "secret.txt" }), "Read redacted text."])
    await f.turn("replay stored results after source files change", () => {
      f.write(join(f.cwd, "large.txt"), "Replacement on disk.\n")
      f.write(join(f.cwd, "secret.txt"), "Replacement value.\n")
    })
    const results = f.session.readEvents().filter((e) => e.type === "tool.settled")
    expect(results.some((e) => e.data.attachments.length > 0)).toBe(true)
    expect(results.some((e) => e.data.truncation !== null)).toBe(true)
    expect(JSON.stringify(f.recording.requests)).not.toContain(secret)
    f.finish()
  } finally { await f.close() }
})

test("wire prefix across model-authored memory and expiry", async () => {
  const f = await fixture()
  try {
    await warm(f)
    await f.turn("save temporary project fact", undefined, [tool("memory_save", { text: "The fixture server uses port 9123.", kind: "fact", scope: "project", until: "2026-11-19" }), "Saved."])
    expect(f.session.memory()!.store.load().entries[0]?.provenance.author).toBe("model")
    await f.turn("expire memory note", () => f.advanceDays(2))
    await f.turn("search expired memory", undefined, [tool("memory_search", { query: "fixture", includeInactive: true }), "Found expired note."])
    const updates = f.session.readEvents().filter((e) => e.type === "instruction.appended" && e.data.source === "memory")
    // Production deliberately keeps a held note on expiry; search reflects its
    // new status, without rewriting the instruction that was already sent.
    expect(updates).toHaveLength(1)
    expect(f.session.readEvents().some((e) => e.type === "tool.settled" && e.data.output.includes("expired"))).toBe(true)
    f.finish()
  } finally { await f.close() }
})
