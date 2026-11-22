import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { type ContentBlock, methods } from "@agentclientprotocol/sdk"
import { type EngineOptions, SIGNED_IN_PROVIDER, type SessionId } from "@windlass/core"
import { E2E_TIMEOUT_MS, FakeProvider, type ScriptItem, script, waitFor } from "@windlass/core/testing"
import { parseConfigFile, resolveConfig } from "../../core/src/config/schema.ts"
import { exportSession } from "../../core/src/trace/export.ts"
import { EXT } from "../src/extensions.ts"
import { type Harness, startHarness } from "./helpers.ts"

setDefaultTimeout(E2E_TIMEOUT_MS)
const harnesses: Harness[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0).reverse()) {
    await h.close()
    expect(h.violations).toEqual([])
  }
})

const title = "Repair parser diagnostics"
async function start(options: {
  scripted?: boolean
  config?: object
  answer?: readonly ScriptItem[]
  dataDir?: string
  listModels?: EngineOptions["listModels"]
  debug?: (line: string) => void
} = {}) {
  const respond = (request: { tools: readonly unknown[] }) => request.tools.length
    ? [script.text("Turn finished.")]
    : options.answer ?? [script.text(`“${title}!”\nDo not show this line`), script.usage({ inputTokens: 37, outputTokens: 6 })]
  const provider = new FakeProvider(Array.from({ length: 10 }, () => respond))
  if (!options.scripted) Object.assign(provider, { id: SIGNED_IN_PROVIDER })
  const h = await startHarness({
    provider,
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    engine: {
      snapshots: null,
      approval: null,
      listModels: options.listModels ?? (async () => ["test-model", "small-test-model", "gpt-6-luna"]),
      ...(options.debug && { debug: options.debug }),
      loadConfig: async (cwd) => ({
        projectDir: cwd, config: resolveConfig(parseConfigFile(JSON.stringify(options.config ?? {}), "config.json")),
      }),
    },
  })
  harnesses.push(h)
  await h.initialize()
  return h
}
const prompt = (h: Harness, sessionId: string, input: string | ContentBlock[]) =>
  h.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: typeof input === "string" ? [{ type: "text", text: input }] : input })
const calls = (h: Harness) => h.provider.calls.filter((c) => c.request.tools.length === 0)
const state = (h: Harness, id: string) => h.backend.engine.getSession(id as SessionId)!.session
const rename = (h: Harness, sessionId: string, title: string) => h.connection.agent.request(EXT.rename, { sessionId, title })
const list = (h: Harness) => h.connection.agent.request(methods.agent.session.list, { cwd: h.workspace })

test("the generated title is published once, listed and persisted, then the user can claim the same title", async () => {
  const h = await start()
  const id = await h.newSession()
  await prompt(h, id, "Please investigate the parser")
  await waitFor(() => h.of(id, "session_info_update").some((u) => "title" in u && u.title === title), { what: "generated ACP title" })
  expect(state(h, id)).toMatchObject({ title, titleGenerated: true })
  expect((await list(h)).sessions[0]?.title).toBe(title)
  await prompt(h, id, "Another question")
  expect(calls(h)).toHaveLength(1)
  expect(h.of(id, "session_info_update").filter((u) => "title" in u && u.title === title)).toHaveLength(1)
  await rename(h, id, title)
  expect(state(h, id).titleGenerated).toBeFalsy()
  await rename(h, id, "My next task")
  expect((await list(h)).sessions[0]?.title).toBe("My next task")
})

test("an explicit title costs no call, and a rename while a title request is pending wins", async () => {
  const h = await start({ answer: [script.hang()] })
  const named = await h.newSession()
  await rename(h, named, "Mine")
  expect((await prompt(h, named, "First question")).stopReason).toBe("end_turn")
  expect(calls(h)).toHaveLength(0)
  const racing = await h.newSession()
  expect((await prompt(h, racing, "Second question")).stopReason).toBe("end_turn")
  await waitFor(() => calls(h)[0]?.hanging, { what: "background title request after the turn ended" })
  await rename(h, racing, "Also mine")
  await waitFor(() => calls(h)[0]?.outcome === "aborted", { what: "the rename to cancel the title request" })
  expect(state(h, named).title).toBe("Mine")
  expect(state(h, racing).title).toBe("Also mine")
  expect(calls(h)).toHaveLength(1)
})

test("two failed attempts keep the derived title through resume and never fail the turn", async () => {
  const h = await start({ answer: [script.fail("transport")] })
  const id = await h.newSession() as SessionId
  expect((await prompt(h, id, "Fix the parser\nDetails")).stopReason).toBe("end_turn")
  await waitFor(() => h.backend.sessions.read(id, (s) => s.lastRequest(id, "title")?.attempt === 2 && s.lastRequest(id, "title")?.outcome === "error"), { what: "one failed attempt and one retry" })
  expect(calls(h)).toHaveLength(2)
  expect(state(h, id).title).toBeNull()
  expect((await list(h)).sessions[0]?.title).toBe("Fix the parser")
  expect(h.of(id, "notice")).toEqual([])
  await h.disconnect()
  await h.backend.close()
  const resumed = await start({ dataDir: h.dataDir })
  await resumed.connection.agent.request(methods.agent.session.resume, { sessionId: id, cwd: h.workspace, mcpServers: [] })
  expect((await prompt(resumed, id, "Next question")).stopReason).toBe("end_turn")
  expect(calls(resumed)).toHaveLength(0)
})

test("only enabled signed-in sessions spend a call on a title", async () => {
  for (const options of [{ scripted: true }, { config: { titles: "off" } }, { config: { titles: "generate" } }]) {
    const h = await start(options)
    const id = await h.newSession()
    expect((await prompt(h, id, "Fix the parser")).stopReason).toBe("end_turn")
    if (options.config?.titles === "generate") await waitFor(() => state(h, id).title === title, { what: "enabled title" })
    expect(calls(h)).toHaveLength(options.config?.titles === "generate" ? 1 : 0)
  }
})

test("only bounded user text goes to the configured title model", async () => {
  const h = await start({ config: { titleModel: "small-test-model" }, answer: [script.text("x".repeat(90) + "!")] })
  const id = await h.newSession()
  const text = "Find the cause ".repeat(100)
  await prompt(h, id, [
    { type: "resource", resource: { uri: "file:///project/private.txt", text: "Attached file contents" } },
    { type: "text", text },
  ])
  const call = await waitFor(() => calls(h)[0], { what: "the title model request" })
  expect(call.request.params.model).toBe("small-test-model")
  expect(call.request.input).toEqual([{ type: "message", role: "user", content: [{ type: "text", text: text.slice(0, 1000) }] }])
  expect(JSON.stringify(call.request)).not.toContain("Attached file contents")
  await waitFor(() => state(h, id).title === "x".repeat(60), { what: "the bounded title" })
})

test("the session ledger records title usage on a separate request and trace lane", async () => {
  const h = await start()
  const id = await h.newSession() as SessionId
  await prompt(h, id, "Fix the parser")
  const usage = await waitFor(() => h.backend.sessions.read(id, (s) => s.lastRequest(id, "title"))?.usage, { what: "recorded title usage" })
  expect(usage).toMatchObject({ inputTokens: 37, outputTokens: 6 })
  const reported = await waitFor(() => h.ext.find((note) => note.method === EXT.usage && note.params.model === "gpt-6-luna"), { what: "ACP title usage" })
  expect(reported.params.usage).toEqual(usage)
  const trace = h.backend.sessions.read(id, (s) => exportSession(s, id))
  expect(trace.unverified).toEqual([])
  expect(trace.calls.find((c) => c.row.purpose === "title")?.record).toMatchObject({ model: "gpt-6-luna", lane: "title", usage: { input_tokens: 37, output_tokens: 6 } })
  expect(calls(h)[0]?.request.params.reasoningEffort).toBe("low")
})

test("the default picks the offered model described as fast and affordable", async () => {
  const h = await start({ listModels: async () => [
    { id: "flagship", description: "Advanced reasoning" },
    { id: "quick", description: "Fast and affordable model for easier tasks" },
    { id: "general", description: "General purpose" },
  ] })
  const id = await h.newSession()
  await prompt(h, id, "Investigate parser diagnostics")
  await waitFor(() => state(h, id).title === title, { what: "generated title" })
  expect(calls(h).map((c) => c.request.params.model)).toEqual(["quick"])
})

test("an account without luna gets a title from an offered smaller model", async () => {
  const h = await start({ listModels: async () => ["flagship", "model-mini", "model-nano"] })
  const id = await h.newSession()
  await prompt(h, id, "Investigate parser diagnostics")
  await waitFor(() => state(h, id).title === title, { what: "small-model title" })
  expect(calls(h).map((c) => c.request.params.model)).toEqual(["model-nano"])
})

test("unmarked models keep their catalog order", async () => {
  const h = await start({ listModels: async () => ["first-offer", "second-offer"] })
  const id = await h.newSession()
  await prompt(h, id, "Investigate parser diagnostics")
  await waitFor(() => state(h, id).title === title, { what: "fallback title" })
  expect(calls(h).map((c) => c.request.params.model)).toEqual(["first-offer"])
})

test("no suitable model keeps the derived title without a title call", async () => {
  const h = await start({ listModels: async () => [{ id: "gpt-6-luna", supportedInApi: false }] })
  const id = await h.newSession()
  await prompt(h, id, "Fix diagnostics")
  expect(calls(h)).toHaveLength(0)
  expect((await list(h)).sessions[0]?.title).toBe("Fix diagnostics")
})

test("an unlisted explicit title model costs no call and logs once at debug level", async () => {
  const debug: string[] = []
  const h = await start({ config: { titleModel: "unlisted" }, debug: (line) => debug.push(line) })
  const id = await h.newSession()
  await prompt(h, id, "Fix diagnostics")
  await prompt(h, id, "Add coverage")
  expect(calls(h)).toHaveLength(0)
  expect((await list(h)).sessions[0]?.title).toBe("Fix diagnostics")
  expect(debug).toHaveLength(1)
  expect(debug[0]).toContain("unlisted")
})

test("title retries and later turns share one model-list read per session", async () => {
  let reads = 0
  const h = await start({
    listModels: async () => ++reads === 1 ? ["test-model", "gpt-6-luna"] : ["next-offer", "test-model"],
    answer: [script.fail("transport")],
  })
  const id = await h.newSession() as SessionId
  await prompt(h, id, "Fix diagnostics")
  await waitFor(() => h.backend.sessions.read(id, (s) => s.lastRequest(id, "title")?.attempt === 2), { what: "title retry" })
  await prompt(h, id, "Add coverage")
  expect(calls(h).map((c) => c.request.params.model)).toEqual(["gpt-6-luna", "gpt-6-luna"])
  expect(reads).toBe(1)

  const next = await h.newSession() as SessionId
  await prompt(h, next, "Check the next parser")
  await waitFor(() => h.backend.sessions.read(next, (s) => s.lastRequest(next, "title")?.attempt === 2), { what: "second session's title retry" })
  expect(calls(h).slice(2).map((c) => c.request.params.model)).toEqual(["next-offer", "next-offer"])
  expect(reads).toBe(2)
})

test("an unreadable catalog keeps the derived title, including after resume", async () => {
  let reads = 0
  const listModels = async () => {
    reads++
    throw new Error("catalog offline")
  }
  const h = await start({ listModels })
  const id = await h.newSession()
  await prompt(h, id, "Fix diagnostics")
  expect(calls(h)).toHaveLength(0)
  await h.disconnect()
  await h.backend.close()
  const resumed = await start({ dataDir: h.dataDir, listModels })
  await resumed.connection.agent.request(methods.agent.session.resume, { sessionId: id, cwd: h.workspace, mcpServers: [] })
  await prompt(resumed, id, "Add coverage")
  expect((await list(resumed)).sessions[0]?.title).toBe("Fix diagnostics")
  expect(calls(resumed)).toHaveLength(0)
  expect(reads).toBe(1)
})
