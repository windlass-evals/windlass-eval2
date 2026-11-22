/**
 * The real assembly (`createHarness`, the real Responses provider) on a saved sign-in that is due for its refresh
 * while the sign-in service cannot be reached. Every address is answered here, in the process: a request to the
 * token endpoint fails as a name lookup that got no answer does, and nothing reaches the network.
 *
 * - The sign-in is not reported as gone: it is saved, and nothing says otherwise.
 * - A turn fails as a connection problem, tried again within the step's attempt budget, and never as "signed out".
 * - Once the service answers again, the next turn refreshes and goes on.
 */
import { afterEach, expect, test, setDefaultTimeout } from "bun:test"
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type Harness, createHarness } from "../../src/assembly.ts"
import { AUTH_UNREACHABLE, CHATGPT_AUTH, type Credentials } from "../../src/auth/chatgpt.ts"
import { brand } from "../../src/brand.ts"
import { FAILURE_TEXT } from "../../src/engine/constants.ts"
import type { EngineSession } from "../../src/engine/engine.ts"
import { ModelListError, RESPONSES_BASE_URL } from "../../src/provider/openai-responses.ts"
import { removeTempDirs, tempDir } from "../sandbox/helpers.ts"
import { E2E_TIMEOUT_MS, waitFor } from "../../src/testing/wait.ts"

// End-to-end: the real harness starts processes (git for its snapshots, the sandbox's probe), so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

const MODEL = "gpt-test"
const LOOKUP_FAILED = "getaddrinfo ETIMEOUT auth.example.test"
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  removeTempDirs()
})

const frame = (type: string, rest: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`
const says = (text: string) =>
  frame("response.created", { response: {} }) +
  frame("response.output_item.done", { output_index: 0, item: { type: "message", id: "msg_TEST1", role: "assistant", content: [{ type: "output_text", text }] } }) +
  frame("response.completed", { response: { output: [] } })

interface Place {
  readonly harness: Harness
  readonly workspace: string
  readonly data: string
  /** Whether the token endpoint answers; while it does not, a request to it fails as a lookup does. */
  reachable: boolean
  /** Requests to the token endpoint, and the token each request to the provider carried. */
  readonly refreshes: { asked: number }
  readonly sent: (string | null)[]
}

/** The real harness on a saved sign-in that is due for its refresh, with the token endpoint and the provider answered in-process. */
function place(): Place {
  const root = realpathSync(tempDir("unreachable"))
  const data = join(root, "data", brand.directory)
  const workspace = join(root, "workspace")
  for (const directory of [data, workspace, join(root, "config")]) mkdirSync(directory, { recursive: true })
  const saved: Credentials = { hostId: "host", clientId: "client", account: { sub: "user_test" }, accessToken: "saved-access-0", refreshToken: "refresh-0", idToken: "id", scopes: [], expiresAt: Date.now() + 60_000 }
  writeFileSync(join(data, "auth.json"), JSON.stringify(saved))

  const env = { XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config") }
  const before = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]))
  const realFetch = globalThis.fetch
  cleanups.push(() => {
    globalThis.fetch = realFetch
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  Object.assign(process.env, env)
  // Few attempts, a millisecond apart: the backoff is not what is tested.
  const harness = createHarness({ log: () => {}, engine: { loadConfig: null, discover: () => [], limits: { attemptBudget: 3, retryBaseDelayMs: 1, retryMaxDelayMs: 1 } } })
  const at: Place = { harness, workspace, data, reachable: false, refreshes: { asked: 0 }, sent: [] }
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url === CHATGPT_AUTH.tokenUrl) {
      at.refreshes.asked += 1
      if (!at.reachable) throw new TypeError(LOOKUP_FAILED)
      return Response.json({ access_token: "saved-access-1", refresh_token: "refresh-1", expires_in: 3600 })
    }
    if (!url.startsWith(`${RESPONSES_BASE_URL}/`)) throw new Error(`a test reached ${url}`)
    at.sent.push(new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? null)
    if (url === `${RESPONSES_BASE_URL}/models`) return Response.json({ models: [{ slug: MODEL, display_name: "Test", visibility: "list", context_window: 200_000 }] })
    return new Response(says("Hello."), { headers: { "content-type": "text/event-stream" } })
  }) as typeof fetch
  cleanups.push(() => harness.close())
  return at
}

/** Sends one message and waits for the turn to end; the events of that turn. */
async function turn(session: EngineSession, text: string) {
  const from = session.readEvents().length
  session.send(text)
  await waitFor(() => ["execution.succeeded", "execution.failed"].includes(session.readEvents().at(-1)?.type ?? ""), { timeoutMs: 20_000, intervalMs: 5, what: "the turn to end", describe: () => session.readEvents().map((item) => item.type).join(", ") })
  return session.readEvents().slice(from)
}

test("a refresh that cannot reach the sign-in service fails the turn as a connection problem that was tried again, not as signed out; reachable again, the next turn goes on", async () => {
  const at = place()
  const message = `no usable access token: Could not reach the sign-in service at ${new URL(CHATGPT_AUTH.tokenUrl).host}: ${LOOKUP_FAILED}`
  // The sign-in is saved, and a failed lookup says nothing against it.
  expect(await at.harness.signIn()).toEqual({ signedIn: true })
  const session = at.harness.engine.createSession({ cwd: at.workspace, title: "Authentication test", settings: { model: MODEL, reasoningEffort: null } })
  const events = await turn(session, "Hi.")
  const retries = events.filter((item) => item.type === "retry.scheduled")
  expect(retries).toHaveLength(2)
  for (const retry of retries) expect(retry.data).toMatchObject({ error: { kind: "transport", reason: "connection", retryable: true, code: AUTH_UNREACHABLE, status: null, message } })
  expect(events.find((item) => item.type === "step.failed")?.data).toMatchObject({ error: { kind: "provider", error: { kind: "transport", code: AUTH_UNREACHABLE, message } } })
  const failed = events.at(-1)
  expect(failed).toMatchObject({ type: "execution.failed", data: { message: `The model call failed 3 times: ${message}` } })
  expect(JSON.stringify(events)).not.toContain(FAILURE_TEXT.signedOut)
  // Nothing was sent to the provider, and nothing of the sign-in is in the log.
  expect(at.sent).toEqual([])
  expect(JSON.stringify(events)).not.toContain("refresh-0")
  // The models cannot be listed either, for the same reason and not for the sign-in's.
  const listing = await at.harness.listModels().then(
    () => null,
    (error: unknown) => error,
  )
  expect(listing).toBeInstanceOf(ModelListError)
  expect((listing as ModelListError).error).toMatchObject({ kind: "transport", code: AUTH_UNREACHABLE })
  expect(readFileSync(join(at.data, "auth.json"), "utf8")).toContain("refresh-0")

  at.reachable = true
  const asked = at.refreshes.asked
  expect((await turn(session, "Hi again.")).at(-1)?.type).toBe("execution.succeeded")
  expect(at.refreshes.asked).toBe(asked + 1)
  expect(at.sent.at(-1)).toBe("saved-access-1")
  expect(readFileSync(join(at.data, "auth.json"), "utf8")).toContain("refresh-1")
})
