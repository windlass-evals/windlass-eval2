import { expect, setDefaultTimeout, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { Reply } from "prefixlens/test"
import { quotedCommand } from "../../src/command-line.ts"
import { HARNESS_ORIGIN } from "../../src/event/durable.ts"
import { E2E_TIMEOUT_MS, waitFor } from "../../src/testing/wait.ts"
import { signWebhook } from "../../src/wake/webhook.ts"
import { manualClock, MINUTE } from "../wake/helpers.ts"
import { fixture, tool, warm } from "./prompt-cache-fixture.ts"

setDefaultTimeout(E2E_TIMEOUT_MS)

test("wire prefix across real background-command output watch and completion", async () => {
  const f = await fixture({ config: { approval: { mode: "full" } } })
  try {
    await warm(f)
    // File events let the test release each phase; no sleep guesses when the
    // background command has started or when a notification reached the model.
    f.write(join(f.cwd, "background.ts"), `
      import { existsSync, watch, writeFileSync } from "node:fs"
      const gate = (name: string) => new Promise<void>((resolve) => {
        const watcher = watch(".", () => { if (existsSync(name)) { watcher.close(); resolve() } })
        if (existsSync(name)) { watcher.close(); resolve() }
      })
      writeFileSync("booted", "yes")
      await gate("release-watch")
      console.log("CACHE_WATCH_READY")
      await gate("release-exit")
      console.log("Finished fixture command.")
    `)
    await f.turn("launch real background command", undefined, [tool("shell", { command: quotedCommand([process.execPath, "background.ts"]), background: true }), "Started."])
    await waitFor(() => existsSync(join(f.cwd, "booted")), { what: "background fixture startup" })
    const id = f.session.projection().session.spawned!.running[0]!.spawnId
    f.session.watchOutput(id, { pattern: "CACHE_WATCH_READY" })
    f.replyWith(() => "Handled background notification.")
    f.recording.step("background output watch fires")
    let calls = f.recording.requests.length
    f.write(join(f.cwd, "release-watch"), "go")
    await waitFor(() => f.recording.requests.length > calls && !f.session.working, { what: "watch-triggered model turn" })
    f.recording.step("background command completes")
    calls = f.recording.requests.length
    f.write(join(f.cwd, "release-exit"), "go")
    await waitFor(() => f.recording.requests.length > calls && !f.session.working, { what: "completion-triggered model turn" })
    await f.turn("follow-up after background completion")
    const origins = f.session.readEvents().flatMap((e) => e.type === "inbox.enqueued" ? [e.data.origin] : [])
    expect(origins).toContain(HARNESS_ORIGIN.backgroundWatch)
    expect(origins).toContain(HARNESS_ORIGIN.backgroundCommand)
    f.finish()
  } finally { await f.close() }
})

test("wire prefix across background subagent completion and follow-up", async () => {
  const f = await fixture()
  try {
    await warm(f)
    const parent = f.session.id
    const replies: Reply[] = [tool("subagent", { task: "Read note.txt and report its contents.", background: true }), "Waiting for the child."]
    const childCalls = new Map<string, number>()
    f.replyWith((request) => {
      const key = String(request.body.prompt_cache_key)
      if (key === parent) return replies.shift() ?? "Received the child result."
      const count = childCalls.get(key) ?? 0
      childCalls.set(key, count + 1)
      return count === 0 ? tool("read", { path: "note.txt" }) : "The child read the synthetic note."
    })
    await f.turn("launch and complete background subagent", undefined, [])
    await waitFor(() => f.session.readEvents().some((e) => e.type === "inbox.enqueued" && e.data.origin === HARNESS_ORIGIN.subagentResult) && !f.session.working, { what: "background subagent result delivered" })
    expect(childCalls.size).toBe(1)
    const [child] = childCalls.keys()
    expect(childCalls.get(child!)).toBeGreaterThanOrEqual(2)
    replies.push(tool("subagent", { session: child, task: "Confirm the same note once more." }), "Confirmed.")
    await f.turn("follow-up in existing subagent conversation", undefined, [])
    expect(replies).toEqual([])
    await f.turn("parent follow-up after subagent result", undefined, [])
    f.finish()
  } finally { await f.close() }
})

test("wire prefix across timer and check wake-up producers", async () => {
  const clock = manualClock()
  const f = await fixture({ engine: { wake: { run: true, listener: false, clock } }, config: { approval: { mode: "full" } } })
  try {
    await warm(f)
    const api = f.harness.engine.wake()!
    f.replyWith(() => "Handled scheduled wake-up.")
    f.recording.step("timer wake-up fires")
    const timer = api.create({ sessionId: f.session.id, message: "Timer fixture fired.", trigger: { kind: "after", delayMs: MINUTE } })
    expect(timer.ok).toBe(true)
    let calls = f.recording.requests.length
    clock.advance(MINUTE)
    await waitFor(() => f.recording.requests.length > calls && !f.session.working, { what: "timer model turn" })
    f.recording.step("check wake-up fires")
    calls = f.recording.requests.length
    const check = api.create({ sessionId: f.session.id, message: "Check fixture passed.", trigger: { kind: "check", command: "test -f note.txt", intervalMs: MINUTE, fire: "until" }, run: { kind: "unsandboxed" } })
    expect(check.ok).toBe(true)
    clock.advance(MINUTE)
    await waitFor(() => f.recording.requests.length > calls && !f.session.working, { what: "check model turn" })
    await f.turn("follow-up after scheduled notifications")
    expect(f.session.readEvents().filter((e) => e.type === "inbox.enqueued" && e.data.origin === HARNESS_ORIGIN.wake)).toHaveLength(2)
    f.finish()
  } finally { await f.close() }
})

test("wire prefix across signed local webhook delivery and taint", async () => {
  const f = await fixture({ engine: { wake: { run: true, port: 0 } } })
  try {
    await warm(f)
    const api = f.harness.engine.wake()!
    f.recording.step("signed webhook fires")
    f.replyWith(() => "Handled webhook notification.")
    const created = api.create({ sessionId: f.session.id, message: "Local fixture webhook.", trigger: { kind: "webhook" } })
    if (!created.ok) throw new Error(created.error)
    const body = JSON.stringify({ status: "synthetic-success" })
    const calls = f.recording.requests.length
    const url = api.webhookUrl(created.wake.id)
    expect(new URL(url).hostname).toBe("127.0.0.1")
    // Only loopback HTTP, to the harness's real webhook listener. Model requests
    // still use prefixlens.fetch and never reach a network provider.
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...signWebhook(created.secret!, body, Math.floor(Date.now() / 1000)) }, body })
    expect(response.status).toBe(202)
    await waitFor(() => f.recording.requests.length > calls && !f.session.working, { what: "webhook model turn" })
    await f.turn("follow-up after webhook taint")
    expect(f.session.readEvents().some((e) => e.type === "taint.noticed")).toBe(true)
    expect(JSON.stringify(f.recording.requests)).not.toContain(created.secret!)
    f.finish()
  } finally { await f.close() }
})
