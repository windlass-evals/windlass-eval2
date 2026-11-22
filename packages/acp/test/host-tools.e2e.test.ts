/**
 * What a client brings to a session over the protocol: a message it admits
 * under its own ID (`_<ns>/admit`), marked untrusted when it is not the
 * user's own text, and tools it declares when it opens the session
 * (`hostTools`), whose calls it is sent as `_<ns>/host_call` once they are
 * approved by their declared effect. The real step loop and approval layer,
 * with a scripted model.
 */
import { afterEach, expect, test, setDefaultTimeout } from "bun:test"
import { methods } from "@agentclientprotocol/sdk"
import { E2E_TIMEOUT_MS, script } from "@windlass/core/testing"
import { EXT, META } from "../src/extensions.ts"
import { EXTENSION_CAPABILITIES } from "../src/server.ts"
import { type Harness, startHarness, until } from "./helpers.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

const NS = META.capabilities

let h: Harness | null = null
afterEach(async () => {
  const violations = h?.violations ?? []
  await h?.close()
  h = null
  expect(violations).toEqual([])
})

const TICKET_READ = { name: "ticket_read", description: "Read a ticket of the team's tracker.", inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] }, effect: "read", untrustedResult: false }
const TICKET_COMMENT = { name: "ticket_comment", description: "Comment on a ticket.", inputSchema: { type: "object", properties: { id: { type: "integer" }, text: { type: "string" } } }, effect: "network", untrustedResult: false }

const open = (harness: Harness, meta: Record<string, unknown>) =>
  harness.connection.agent.request(methods.agent.session.new, { cwd: harness.workspace, mcpServers: [], _meta: { [NS]: meta } })
const prompt = (harness: Harness, sessionId: string, text: string) => harness.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] })
const admit = (harness: Harness, params: Record<string, unknown>) => harness.connection.agent.request<{ outcome: string }>(EXT.admit, params)
const events = (harness: Harness, type: string) => harness.ext.filter((note) => note.method === EXT.event && (note.params.event as { type: string }).type === type).map((note) => (note.params.event as { data: Record<string, unknown> }).data)

test("both are advertised where a client looks for what this agent takes", async () => {
  h = await startHarness()
  const answer = (await h.initialize()) as { agentCapabilities: { _meta: Record<string, typeof EXTENSION_CAPABILITIES> } }
  const advertised = answer.agentCapabilities._meta[NS]!
  expect(advertised.methods).toContain(EXT.admit)
  expect(advertised.openMeta).toContain("hostTools")
})

test("an admitted message starts a turn once, however often it is sent, and one marked untrusted taints the session", async () => {
  h = await startHarness({ responses: [[script.text("I will look at the date parser.")]], clientCapabilities: { _meta: { [NS]: { events: true } } } })
  await h.initialize()
  const { sessionId } = await open(h, { attended: false })
  const message = { sessionId, messageId: "trk_7", origin: "tracker", text: "Ticket 7: the date parser drops the time zone.", start: true, untrusted: { source: "ticket 7" } }
  expect(await admit(h, message)).toEqual({ outcome: "admitted" })
  await until(() => h!.ext.some((note) => note.method === EXT.turn && note.params.sessionId === sessionId), 10_000, "the admitted message's turn to end")
  expect(await admit(h, message)).toEqual({ outcome: "duplicate" })
  expect(events(h, "inbox.enqueued")).toHaveLength(1)
  expect(events(h, "taint.noticed").map((data) => data.source)).toEqual([expect.objectContaining({ kind: "client-input", tool: "ticket 7" })])
  expect(h.ext.find((note) => note.method === EXT.taint)?.params).toMatchObject({ sessionId, tainted: true })
})

test("an admission under an origin of the agent's own, or with a field of the wrong kind, is a bad request and admits nothing", async () => {
  h = await startHarness()
  await h.initialize()
  const sessionId = await h.newSession()
  const base = { sessionId, messageId: "trk_8", origin: "tracker", text: "Ticket 8.", start: false }
  await expect(admit(h, { ...base, origin: "wake" })).rejects.toMatchObject({ code: -32602 })
  await expect(admit(h, { ...base, start: "yes" })).rejects.toMatchObject({ code: -32602 })
  await expect(admit(h, { ...base, untrusted: { source: "" } })).rejects.toMatchObject({ code: -32602 })
  expect(await admit(h, base)).toEqual({ outcome: "admitted" })
})

test("a declared tool's call goes to the client after approval by its effect, and the answer is the call's result", async () => {
  h = await startHarness({
    responses: [[script.toolCall("call_1", "ticket_read", { id: 7 })], [script.toolCall("call_2", "ticket_comment", { id: 7, text: "Fixed." })], [script.text("Done.")]],
    onPermission: () => ({ outcome: { outcome: "selected", optionId: "once" } }),
    onHostCall: (params) => ({ status: "success", output: params.name === "ticket_read" ? "Ticket 7: the date parser drops the time zone." : "Commented." }),
  })
  await h.initialize()
  const { sessionId } = await open(h, { approval: "auto", hostTools: [TICKET_READ, TICKET_COMMENT] })
  expect((await prompt(h, sessionId, "Read ticket 7 and say it is fixed.")).stopReason).toBe("end_turn")
  // The read ran without a question; the comment uses the network, so it was asked about first, like any network tool.
  expect(h.permissions.map((asked) => asked.toolCall.title)).toEqual(["Allow ticket_comment to use the network?"])
  const calls = h.of(sessionId, "tool_call") as { toolCallId: string }[]
  expect(h.hostCalls).toEqual([
    { sessionId, toolCallId: calls[0]!.toolCallId, name: "ticket_read", input: { id: 7 } },
    { sessionId, toolCallId: calls[1]!.toolCallId, name: "ticket_comment", input: { id: 7, text: "Fixed." } },
  ])
  // The model was offered the declared tools, and read the client's answers as the results.
  const request = h.provider.requests[1]!
  expect(request.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["ticket_read", "ticket_comment"]))
  expect(JSON.stringify(request.input)).toContain("the date parser drops the time zone")
})

test("a declaration with the name of one of the agent's own tools, or a time limit out of range, is refused at open with a sentence that names it", async () => {
  h = await startHarness()
  await h.initialize()
  await expect(open(h, { hostTools: [{ ...TICKET_READ, name: "read" }] })).rejects.toMatchObject({ code: -32602, message: `the host tool "read" has the name of one of this agent's own tools; give it another name` })
  await expect(open(h, { hostTools: [{ ...TICKET_READ, effect: "everything" }] })).rejects.toMatchObject({ code: -32602 })
  await expect(open(h, { hostTools: [{ ...TICKET_READ, timeoutSeconds: 7200 }] })).rejects.toMatchObject({ code: -32602, message: `the timeoutSeconds of the host tool "ticket_read" is not a whole number of seconds from 1 to 3600` })
  await expect(open(h, { hostTools: [{ ...TICKET_READ, timeoutSeconds: "long" }] })).rejects.toMatchObject({ code: -32602 })
  // Nothing was created by the refused opens.
  const listed = await h.connection.agent.request(methods.agent.session.list, {})
  expect(listed.sessions).toEqual([])
})

test("a session opened again declares its tools again, and its calls reach the client that opened it", async () => {
  h = await startHarness({
    responses: [[script.text("Ready.")], [script.toolCall("call_1", "ticket_read", { id: 7 })], [script.text("Read it.")]],
    onHostCall: () => ({ status: "success", output: "Ticket 7." }),
  })
  await h.initialize()
  const { sessionId } = await open(h, { hostTools: [TICKET_READ] })
  await prompt(h, sessionId, "Get ready.")
  await h.connection.agent.request(methods.agent.session.close, { sessionId })
  await h.connection.agent.request(methods.agent.session.resume, { sessionId, cwd: h.workspace, mcpServers: [], _meta: { [NS]: { hostTools: [TICKET_READ] } } })
  expect((await prompt(h, sessionId, "Read ticket 7.")).stopReason).toBe("end_turn")
  expect(h.hostCalls.map((call) => call.name)).toEqual(["ticket_read"])
})
