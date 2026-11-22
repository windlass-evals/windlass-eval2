import { expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertSessionStable, type RecordedRequest } from "prefixlens/test"
import { HARNESS_ORIGIN } from "../../src/event/durable.ts"
import type { SessionId } from "../../src/id.ts"
import { E2E_TIMEOUT_MS, waitFor } from "../../src/testing/wait.ts"
import { fixture, sse, tool, warm } from "./prompt-cache-fixture.ts"

setDefaultTimeout(E2E_TIMEOUT_MS)

test.each([
  ["model switch", { model: "gpt-4.1-mini" }],
  ["reasoning effort switch", { reasoningEffort: "high" }],
] as const)("wire prefix at %s", async (name, settings) => {
  const f = await fixture()
  try {
    await warm(f)
    await f.turn(name, () => { f.session.setSettings({ ...f.session.projection().session.settings, ...settings }) })
    await f.turn("follow-up after settings change")
    expect(f.session.readEvents().some((e) => e.type === "settings.changed")).toBe(true)
    f.finish({ [name]: "settings_change" })
  } finally { await f.close() }
})

test("wire prefix at revert and undo", async () => {
  const f = await fixture()
  try {
    await warm(f)
    await f.turn("revert latest turn", async () => { expect(await f.session.revert()).toMatchObject({ kind: "reverted" }) })
    await f.turn("revert then undo latest turn", async () => {
      expect(await f.session.revert()).toMatchObject({ kind: "reverted" })
      expect(await f.session.undoRevert()).toMatchObject({ kind: "reverted" })
    })
    f.finish({ "revert latest turn": "revert" })
  } finally { await f.close() }
})

test("wire prefix at provider refusal", async () => {
  const f = await fixture()
  try {
    await warm(f)
    await f.turn("provider refuses this turn", () => f.intercept(() => sse(
      { type: "response.refusal.done", refusal: "Synthetic refusal." },
      { type: "response.completed", response: { output: [] } },
    )), ["unused synthetic response"], true)
    await f.turn("continue after refused history is excluded")
    expect(f.session.readEvents().some((e) => e.type === "step.refused")).toBe(true)
    f.finish({ "continue after refused history is excluded": "refusal" })
  } finally { await f.close() }
})

test("wire prefix across transparent retries, auth refresh, partial output and output limit", async () => {
  let refreshed = 0
  const f = await fixture({ engine: { refreshAuth: async () => { refreshed++; return true } } })
  try {
    await warm(f)
    await f.turn("rate-limit retry", () => f.intercept(() => new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), { status: 429, headers: { "retry-after": "0" } })), ["replaced", "Retried."])
    await f.turn("auth refresh retry", () => f.intercept(() => new Response(JSON.stringify({ error: { code: "token_expired" } }), { status: 401 })), ["replaced", "Refreshed."])
    expect(refreshed).toBe(1)
    await f.turn("retry after partial output", () => f.intercept(() => sse(
      { type: "response.output_text.delta", delta: "I started the answer. " },
      { type: "response.failed", response: { error: { code: "server_error", message: "Synthetic interruption." } } },
    )), ["replaced", "And continued it."])
    await f.turn("output limit during tool arguments", () => f.intercept(() => sse(
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_limit", call_id: "call_limit", name: "read" } },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":' },
      { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } },
    )), ["replaced", "The incomplete call did not run."])
    await f.turn("follow-up after retry and limit notices", undefined, [tool("read", { path: "note.txt" }), "Read."])
    const origins = f.session.readEvents().flatMap((e) => e.type === "synthetic.appended" ? [e.data.origin] : [])
    expect(origins).toContain(HARNESS_ORIGIN.continuation)
    expect(origins).toContain(HARNESS_ORIGIN.outputLimit)
    expect(f.session.readEvents().filter((e) => e.type === "retry.scheduled").length).toBeGreaterThanOrEqual(2)
    f.finish()
  } finally { await f.close() }
})

test("wire prefix across interrupt with partial output and subsequent turn", async () => {
  const f = await fixture()
  try {
    await warm(f)
    let streamed = false
    f.session.subscribe((e) => { if (e.type === "text.delta" && e.text === "Partial answer.") streamed = true })
    const pending = f.turn("interrupt a running response", () => f.intercept(() => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"Partial answer."}\n\n')) },
    }), { headers: { "content-type": "text/event-stream" } })))
    await waitFor(() => streamed, { what: "the partial provider response" })
    f.session.interrupt()
    await pending
    await f.turn("continue after interrupt marker")
    expect(f.session.readEvents().some((e) => e.type === "synthetic.appended" && e.data.origin === HARNESS_ORIGIN.interrupt)).toBe(true)
    f.finish()
  } finally { await f.close() }
})

test.each(["tool", "background"] as const)("wire prefix across a killed process and %s recovery", async (kind) => {
  const scratch = mkdtempSync(join(tmpdir(), "prefixlens-crash-"))
  const report = join(scratch, "requests.json")
  const child = Bun.spawn([process.execPath, "test", join(import.meta.dir, "fixtures", "prompt-cache-crash.ts")], {
    env: { ...process.env, PREFIXLENS_CRASH_REPORT: report, PREFIXLENS_CRASH_KIND: kind }, stdout: "ignore", stderr: "pipe",
  })
  let f: Awaited<ReturnType<typeof fixture>> | undefined
  try {
    await child.exited
    expect(child.signalCode, await new Response(child.stderr).text()).toBe("SIGKILL")
    const saved = JSON.parse(readFileSync(report, "utf8")) as { root: string; id: SessionId; requests: RecordedRequest[] }
    // The real shell's guard kills its process group when its harness dies.
    // Recovery must still produce spawn_lost from the unfinished durable record.
    f = await fixture({ root: saved.root, resume: saved.id, reply: () => "Recovered.", step: "recover crashed execution" })
    await f.session.settled()
    await f.turn("follow-up after crash recovery")
    expect(f.session.readEvents().some((e) => e.type === "synthetic.appended" && e.data.origin === HARNESS_ORIGIN.interrupt)).toBe(true)
    if (kind === "background") expect(f.session.readEvents().some((e) => e.type === "inbox.enqueued" && e.data.origin === HARNESS_ORIGIN.spawnLost)).toBe(true)
    const requests = [...saved.requests, ...f.recording.requests]
    const steps = Object.fromEntries(requests.map((request, i) => [i + 1, request.step!]))
    f.finish()
    // Includes the last request actually sent by the dead process, not a
    // reconstruction of its request from the recovered event log.
    assertSessionStable(requests.map((request) => request.body), { steps })
  } finally {
    child.kill("SIGKILL")
    await child.exited
    await f?.close()
    if (existsSync(report)) {
      const saved = JSON.parse(readFileSync(report, "utf8")) as { root?: string }
      if (saved.root) {
        const pidFile = join(saved.root, "repo", "orphan.pid")
        if (existsSync(pidFile)) {
          try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGTERM") } catch { /* already exited */ }
        }
        rmSync(saved.root, { recursive: true, force: true })
      }
    }
    rmSync(scratch, { recursive: true, force: true })
  }
})
