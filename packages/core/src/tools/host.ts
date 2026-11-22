/**
 * Host tools: tools the client that opens a session declares and runs
 * itself. The engine offers each to the model as a tool of its own; a call
 * is decided by the approval layer like any other (by the declared effect),
 * then handed to the client, and the client's answer is the call's result.
 *
 * - **The frozen list.** A session's tool list is frozen in its baseline, so
 *   the tools declared when its first baseline is built are the ones it is
 *   offered, until a compaction rebuilds the baseline (the engine's
 *   `offeredTools`). A declaration made later changes what a call runs, not
 *   what the model was told.
 * - **Names.** A declared name may not be one of the engine's own tools
 *   (built-in, MCP bridge, features): the session is refused at open rather
 *   than have one tool shadow another.
 * - **Time.** A call the client does not answer within its time limit ends
 *   with an error result that says so, and the request to the client is
 *   aborted. The limit is the MCP call limit (`DEFAULT_CALL_TIMEOUT_SECONDS`)
 *   unless the declaration names its own (`timeoutSeconds`), at most the MCP
 *   ceiling (`MAX_CALL_TIMEOUT_SECONDS`): a call holds its turn, and the
 *   session with it, for as long as it waits, and a client that is gone
 *   without closing the connection would hold them that long.
 * - **Taint.** `untrustedResult` says the client's answers carry content it
 *   does not vouch for: the result records that in its `display` (`host`,
 *   read by `approval/record.ts`, `hostResult`), and such a result is a taint
 *   source. Any other answer is the client's own.
 */
import type { MessageId, SessionId } from "../id.ts"
import type { Json } from "../json.ts"
import { DEFAULT_CALL_TIMEOUT_SECONDS, MAX_CALL_TIMEOUT_SECONDS } from "../mcp/config.ts"
import { SchemaError, compileSchema } from "../tool/schema.ts"
import type { AnyTool, ToolEffect, ToolResult } from "../tool/tool.ts"

/** One tool as a client declares it. */
export interface HostToolDeclaration {
  readonly name: string
  readonly description: string
  /** A JSON Schema of `type: "object"`, as for every tool. */
  readonly inputSchema: Json
  /** The strongest thing a call does: what approval decides by. */
  readonly effect: ToolEffect
  /** Whether what the client answers is content the harness does not control (a taint source). */
  readonly untrustedResult: boolean
  /** How long a call may wait for the client's answer, in whole seconds, 1 to `MAX_CALL_TIMEOUT_SECONDS`. Absent: the MCP call limit. */
  readonly timeoutSeconds?: number
}

/** One call, as the client is asked to run it. */
export interface HostCallRequest {
  readonly sessionId: SessionId
  readonly messageId: MessageId
  readonly callId: string
  readonly name: string
  readonly input: Json
}

/** The client's answer: `output` is the text the model reads, as an error when `status` is `error`. */
export interface HostAnswer {
  readonly status: "success" | "error"
  readonly output: string
}

/** The tools a client declares for a session, and how a call reaches it. */
export interface HostTools {
  readonly tools: readonly HostToolDeclaration[]
  /**
   * Sends one call to the client and resolves with its answer. `signal`
   * aborts when the call is stopped or its time is up; the promise may then
   * settle either way and is not waited for. Rejects, with a message the model
   * may read, when the client cannot run it.
   */
  readonly call: (request: HostCallRequest, signal: AbortSignal) => Promise<HostAnswer>
}


/** What a provider takes as a tool's name. */
const NAME = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Why a client's declarations cannot be used, in a sentence for the client,
 * or `null`. `taken` are the names of the engine's own tools.
 */
export function hostToolsProblem(tools: readonly HostToolDeclaration[], taken: ReadonlySet<string>): string | null {
  const seen = new Set<string>()
  for (const tool of tools) {
    if (!NAME.test(tool.name)) return `the host tool name ${JSON.stringify(tool.name)} is not 1 to 64 letters, digits, "_" or "-"`
    if (taken.has(tool.name)) return `the host tool ${JSON.stringify(tool.name)} has the name of one of this agent's own tools; give it another name`
    if (seen.has(tool.name)) return `the host tool ${JSON.stringify(tool.name)} is declared twice`
    seen.add(tool.name)
    const timeout = tool.timeoutSeconds
    if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_CALL_TIMEOUT_SECONDS))
      return `the timeoutSeconds of the host tool ${JSON.stringify(tool.name)} is not a whole number of seconds from 1 to ${MAX_CALL_TIMEOUT_SECONDS}`
    const schema = tool.inputSchema
    if (typeof schema !== "object" || schema === null || Array.isArray(schema) || (schema as { readonly type?: Json }).type !== "object")
      return `the inputSchema of the host tool ${JSON.stringify(tool.name)} is not a JSON Schema of type "object"`
    try {
      compileSchema(schema)
    } catch (error) {
      if (error instanceof SchemaError) return `the inputSchema of the host tool ${JSON.stringify(tool.name)} cannot be used: ${error.message}`
      throw error
    }
  }
  return null
}

/**
 * The tool that hands calls of one declaration to the client. `sleep` is the
 * engine's clock, so a test drives the time limit.
 */
export function hostTool(declaration: HostToolDeclaration, call: HostTools["call"], sleep: (ms: number, signal: AbortSignal) => Promise<void>): AnyTool {
  const { name, description, inputSchema, effect, untrustedResult } = declaration
  const seconds = declaration.timeoutSeconds ?? DEFAULT_CALL_TIMEOUT_SECONDS
  // What the client wrote is marked as the declaration says; a sentence of the harness's own never is.
  const result = (status: ToolResult["status"], output: string, fromClient: boolean): ToolResult => ({
    status,
    output,
    truncation: null,
    attachments: [],
    display: { host: { untrusted: fromClient && untrustedResult } },
  })
  return {
    name,
    description,
    inputSchema,
    effect,
    origin: "host",
    execute: async (input, context) => {
      const timeout = new AbortController()
      const signal = AbortSignal.any([context.signal, timeout.signal])
      const answer = call({ sessionId: context.sessionId, messageId: context.messageId, callId: context.callId, name, input }, signal).then(
        (value) => ({ kind: "answered" as const, value }),
        (error: unknown) => ({ kind: "failed" as const, message: error instanceof Error ? error.message : String(error) }),
      )
      const late = sleep(seconds * 1000, signal).then(() => ({ kind: "timed_out" as const }))
      const first = await Promise.race([answer, late])
      // A stop ends the wait and may also make the request fail: either way the call was stopped, not answered.
      const settled = first.kind !== "answered" && context.signal.aborted ? { kind: "stopped" as const } : first
      // Whichever came first, the other is let go of: the sleep ends, and an answer that comes later is dropped.
      timeout.abort()
      const unknown = effect === "read" ? "" : " It may or may not have taken effect; check before calling it again."
      if (settled.kind === "timed_out") return result("error", `The client did not answer the call to ${name} within ${seconds} s, and it was cancelled.${unknown}`, false)
      if (settled.kind === "stopped") return result("error", `The call to ${name} was stopped before the client answered.${unknown}`, false)
      if (settled.kind === "failed") return result("error", `The client could not run ${name}: ${settled.message}`, true)
      return result(settled.value.status, settled.value.output, true)
    },
  }
}
