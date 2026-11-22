/**
 * The environment of a session's commands over the protocol: a client names,
 * with `withholdEnv` and `passEnv` in `_meta[<ns>]` when it opens a session,
 * the variables no command of it is given and the credential-looking ones its
 * sandboxed commands are, with no configuration file anywhere. The real shell
 * tool and the real sandbox, with a scripted model.
 *
 * The variables are made up and set in this process before the server is
 * made, as a program that starts the server sets them.
 */
import { afterAll, afterEach, expect, test, setDefaultTimeout } from "bun:test"
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { methods } from "@agentclientprotocol/sdk"
import { createCommandSandbox } from "@windlass/core"
import { E2E_TIMEOUT_MS, script } from "@windlass/core/testing"
import { EXT, META } from "../src/extensions.ts"
import { EXTENSION_CAPABILITIES } from "../src/server.ts"
import { type Harness, startHarness } from "./helpers.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

const NS = META.capabilities
/** Where commands can be sandboxed at all. */
const sandboxed = createCommandSandbox().state.available

const VARIABLES = { ACME_DSN: "dsn-made-up-1", ACME_DEPLOY_KEY: "deploy-made-up-2", ACME_OTHER_TOKEN: "other-made-up-3" }
Object.assign(process.env, VARIABLES)
const root = realpathSync(mkdtempSync(join(existsSync("/var/tmp") ? "/var/tmp" : homedir(), "wl-acp-env-")))
afterAll(() => {
  for (const name of Object.keys(VARIABLES)) delete process.env[name]
  rmSync(root, { recursive: true, force: true })
})

const sandbox = () => createCommandSandbox({ tempBase: join(root, "session-temp") })
const command = 'echo "dsn=${ACME_DSN:-none} key=${ACME_DEPLOY_KEY:-none} other=${ACME_OTHER_TOKEN:-none}"'
const NAMES = { withholdEnv: ["ACME_DSN"], passEnv: ["ACME_DEPLOY_KEY"] }

let h: Harness | null = null
afterEach(async () => {
  const violations = h?.violations ?? []
  await h?.close()
  h = null
  expect(violations).toEqual([])
})

const open = (harness: Harness, meta: Record<string, unknown>) => harness.connection.agent.request(methods.agent.session.new, { cwd: harness.workspace, mcpServers: [], _meta: { [NS]: { attended: false, ...meta } } })
const prompt = (harness: Harness, sessionId: string, text: string) => harness.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] })
/** A turn of one command and a closing word. */
const turn = [[script.toolCall("c1", "shell", { command })], [script.text("Looked.")]] as const
/** What the model was sent after the command of the `n`th turn. */
const shown = (harness: Harness, n: number) => JSON.stringify(harness.provider.calls[n * 2 - 1]!.request.input)

test("the keys are ones a client is told about, and a value that is not a list of names is refused without being repeated", async () => {
  h = await startHarness({ engine: { approval: { sandbox: sandbox() } } })
  await h.initialize()
  expect(EXTENSION_CAPABILITIES.openMeta).toContain("withholdEnv")
  expect(EXTENSION_CAPABILITIES.openMeta).toContain("passEnv")
  for (const bad of ["ACME_DSN", ["ACME_DSN=dsn-made-up-1"], [7], { ACME_DSN: true }]) {
    await expect(open(h, { withholdEnv: bad })).rejects.toMatchObject({ code: -32602 })
    await expect(open(h, { passEnv: bad })).rejects.toMatchObject({ code: -32602 })
  }
  expect(JSON.stringify(h.wire)).not.toContain("dsn-made-up-1")
})

test.skipIf(!sandboxed)("a session opened with the two lists: a sandboxed command is not given the withheld name and is given the passed credential, whose value the model does not see; one opened without them is as it always was", async () => {
  h = await startHarness({ engine: { approval: { sandbox: sandbox() } }, responses: [...turn, ...turn] })
  await h.initialize()
  const named = await open(h, NAMES)
  expect((await prompt(h, named.sessionId, "Look.")).stopReason).toBe("end_turn")
  expect(shown(h, 1)).toContain("dsn=none key=[REDACTED:env] other=none")
  // The model was sent no word about the lists, and no value.
  expect(JSON.stringify(h.provider.calls[0]!.request)).not.toContain("ACME_")
  expect(JSON.stringify(h.provider.calls.map((call) => call.request))).not.toContain("deploy-made-up-2")
  expect(h.ext.filter((item) => item.method === EXT.notice)).toEqual([])

  const plain = await open(h, {})
  expect((await prompt(h, plain.sessionId, "Look.")).stopReason).toBe("end_turn")
  expect(shown(h, 2)).toContain("dsn=dsn-made-up-1 key=none other=none")
})

test("a command that runs without the sandbox is not given the withheld name either, and is given every credential as before", async () => {
  h = await startHarness({ engine: { approval: { sandbox: sandbox() } }, responses: [...turn, ...turn] })
  await h.initialize()
  const named = await open(h, { approval: "full", ...NAMES })
  expect((await prompt(h, named.sessionId, "Look.")).stopReason).toBe("end_turn")
  expect(shown(h, 1)).toContain("dsn=none key=[REDACTED:env] other=[REDACTED:env]")
  const plain = await open(h, { approval: "full" })
  expect((await prompt(h, plain.sessionId, "Look.")).stopReason).toBe("end_turn")
  expect(shown(h, 2)).toContain("dsn=dsn-made-up-1 key=[REDACTED:env] other=[REDACTED:env]")
})

test.skipIf(!sandboxed)("the lists are said again when the session is opened again, as a client that starts a process for each turn does: `session/resume` with them keeps them, and with empty ones the rule alone decides", async () => {
  h = await startHarness({ engine: { approval: { sandbox: sandbox() } }, responses: [...turn, ...turn, ...turn] })
  await h.initialize()
  const created = await open(h, NAMES)
  expect((await prompt(h, created.sessionId, "Look.")).stopReason).toBe("end_turn")
  await h.connection.agent.request(methods.agent.session.resume, { sessionId: created.sessionId, cwd: h.workspace, mcpServers: [], _meta: { [NS]: { attended: false, ...NAMES } } })
  expect((await prompt(h, created.sessionId, "Again.")).stopReason).toBe("end_turn")
  await h.connection.agent.request(methods.agent.session.resume, { sessionId: created.sessionId, cwd: h.workspace, mcpServers: [], _meta: { [NS]: { attended: false, withholdEnv: [], passEnv: [] } } })
  expect((await prompt(h, created.sessionId, "And now?")).stopReason).toBe("end_turn")
  const last = JSON.stringify(h.provider.calls.at(-1)!.request.input)
  expect(last.split("dsn=none key=[REDACTED:env] other=none").length - 1).toBe(2)
  expect(last.split("dsn=dsn-made-up-1 key=none other=none").length - 1).toBe(1)
})
