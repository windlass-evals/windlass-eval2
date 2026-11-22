/** Host tools: which declarations a session can use, and how a call reaches the client and comes back. */
import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { createToolRuntime } from "../../src/tool/runtime.ts"
import { noBlobStore } from "../../src/tool/tool.ts"
import { type HostAnswer, type HostToolDeclaration, type HostTools, hostTool, hostToolsProblem } from "../../src/tools/host.ts"
import { context, removeTempDirs, tempDir } from "./helpers.ts"

afterEach(removeTempDirs)

const READ: HostToolDeclaration = { name: "ticket_read", description: "Read a ticket.", inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] }, effect: "read", untrustedResult: true }
const POST: HostToolDeclaration = { ...READ, name: "ticket_post", effect: "network", untrustedResult: false }

describe("declarations", () => {
  const taken = new Set(["read", "mcp_call"])
  test("tools with names of their own and object schemas are taken", () => {
    expect(hostToolsProblem([READ, POST], taken)).toBeNull()
  })

  test("a name of the engine's, a name twice, a name a provider refuses, or a schema that is not an object's is refused with a sentence", () => {
    expect(hostToolsProblem([{ ...READ, name: "mcp_call" }], taken)).toBe(`the host tool "mcp_call" has the name of one of this agent's own tools; give it another name`)
    expect(hostToolsProblem([READ, READ], taken)).toBe(`the host tool "ticket_read" is declared twice`)
    expect(hostToolsProblem([{ ...READ, name: "ticket/read" }], taken)).toContain("is not 1 to 64 letters")
    expect(hostToolsProblem([{ ...READ, inputSchema: { type: "string" } }], taken)).toContain('is not a JSON Schema of type "object"')
  })

  test("a time limit of its own is whole seconds from 1 to an hour", () => {
    expect(hostToolsProblem([{ ...READ, timeoutSeconds: 1 }, { ...POST, timeoutSeconds: 3600 }], taken)).toBeNull()
    for (const timeoutSeconds of [0, -5, 1.5, 3601, Number.NaN])
      expect(hostToolsProblem([{ ...READ, timeoutSeconds }], taken)).toBe(`the timeoutSeconds of the host tool "ticket_read" is not a whole number of seconds from 1 to 3600`)
  })
})

describe("a call", () => {
  /** Runs one call of `declaration` through the tool runtime, with a client that answers as `call` does and a clock whose limit fires when `late` resolves. */
  const run = (declaration: HostToolDeclaration, call: HostTools["call"], late: Promise<void> = new Promise(() => {}), signal?: AbortSignal) => {
    const root = tempDir()
    const slept: number[] = []
    const sleep = (ms: number, stop: AbortSignal) => {
      slept.push(ms)
      // As the engine's clocks do: a signal that has already fired ends the sleep at once.
      if (stop.aborted) return Promise.resolve()
      return Promise.race([late, new Promise<void>((resolve) => stop.addEventListener("abort", () => resolve(), { once: true }))])
    }
    const runtime = createToolRuntime({ tools: [hostTool(declaration, call, sleep)], spillDir: join(root, "spill"), putBlob: noBlobStore })
    const base = context(root)
    return { slept, outcome: runtime.run({ name: declaration.name, argumentsText: '{"id":7}', context: signal === undefined ? base : { ...base, signal } }) }
  }

  test("the client is sent the validated input and its answer is the result, marked as the declaration says", async () => {
    const asked: unknown[] = []
    const { outcome, slept } = run(READ, async (request) => (asked.push(request.input), { status: "success", output: "Ticket 7." }))
    expect((await outcome).settlement).toMatchObject({ outcome: "success", output: "Ticket 7.", display: { host: { untrusted: true } } })
    expect(asked).toEqual([{ id: 7 }])
    // The MCP call limit, as no limit of its own was declared.
    expect(slept).toEqual([60_000])
  })

  test("a declared time limit replaces the MCP one, in what it waits and in what the model reads", async () => {
    const { outcome, slept } = run({ ...READ, timeoutSeconds: 900 }, () => new Promise<HostAnswer>(() => {}), Promise.resolve())
    expect((await outcome).settlement.output).toBe("The client did not answer the call to ticket_read within 900 s, and it was cancelled.")
    expect(slept).toEqual([900_000])
  })

  test("a client that cannot run it gives an error the model reads", async () => {
    const { outcome } = run(POST, async () => {
      throw new Error("the tracker is down")
    })
    expect((await outcome).settlement).toMatchObject({ outcome: "error", output: "The client could not run ticket_post: the tracker is down", display: { host: { untrusted: false } } })
  })

  test("no answer within the limit: the request is cancelled and the error is the harness's own text", async () => {
    let aborted = false
    const { outcome } = run(READ, (_request, signal) => new Promise<HostAnswer>(() => signal.addEventListener("abort", () => (aborted = true))), Promise.resolve())
    expect((await outcome).settlement).toMatchObject({ outcome: "error", output: "The client did not answer the call to ticket_read within 60 s, and it was cancelled.", display: { host: { untrusted: false } } })
    expect(aborted).toBe(true)
  })

  test("a call stopped while it waits ends at once, and says it may have taken effect when it is not a read", async () => {
    const stop = new AbortController()
    const { outcome } = run(POST, () => new Promise<HostAnswer>(() => stop.abort()), undefined, stop.signal)
    expect((await outcome).settlement).toMatchObject({ outcome: "error", output: "The call to ticket_post was stopped before the client answered. It may or may not have taken effect; check before calling it again." })
  })
})
