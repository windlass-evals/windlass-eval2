/**
 * The session's home over the protocol: a client turns it on for a session
 * with `sandboxHome` in `_meta[<ns>]` when it opens it, with no configuration
 * file anywhere. The real shell tool and the real sandbox, with a scripted
 * model, a home made for the test and a directory of the test's for the
 * sessions' homes.
 */
import { afterAll, afterEach, expect, test, setDefaultTimeout } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
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
const detected = createCommandSandbox().state.available
/** Where a session's home exists at all: bubblewrap on Linux. */
const linux = process.platform === "linux" && detected

const root = realpathSync(mkdtempSync(join(existsSync("/var/tmp") ? "/var/tmp" : homedir(), "wl-acp-home-")))
const home = join(root, "home")
const tempBase = join(root, "session-temp")
mkdirSync(join(home, ".config"), { recursive: true })
writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Configured User\n")
afterAll(() => rmSync(root, { recursive: true, force: true }))

const sandbox = () => createCommandSandbox({ home, tempBase, env: { ...process.env, HOME: home, XDG_CONFIG_HOME: undefined, XDG_CACHE_HOME: undefined, XDG_DATA_HOME: undefined, XDG_STATE_HOME: undefined } })
const command = "mkdir -p ~/.cache/tool && echo cached > ~/.cache/tool/file && cat ~/.cache/tool/file ~/.gitconfig"
const NOTE = "Commands that run in the sandbox have a home directory of this session's own"

let h: Harness | null = null
afterEach(async () => {
  const violations = h?.violations ?? []
  await h?.close()
  h = null
  expect(violations).toEqual([])
})

const open = (harness: Harness, meta: Record<string, unknown>) => harness.connection.agent.request(methods.agent.session.new, { cwd: harness.workspace, mcpServers: [], _meta: { [NS]: { attended: false, ...meta } } })
const prompt = (harness: Harness, sessionId: string, text: string) => harness.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] })

test("the key is one a client is told about, and a value that is neither `user` nor `session` is refused", async () => {
  h = await startHarness({ engine: { approval: { sandbox: sandbox() } } })
  await h.initialize()
  expect(EXTENSION_CAPABILITIES.openMeta).toContain("sandboxHome")
  await expect(open(h, { sandboxHome: "yes" })).rejects.toMatchObject({ code: -32602 })
  await expect(open(h, { sandboxHome: true })).rejects.toMatchObject({ code: -32602 })
})

test.skipIf(!linux)("a session opened with `sandboxHome: session` runs a tool that writes under the home, in a home of its own; one opened without it is as it always was", async () => {
  h = await startHarness({
    engine: { approval: { sandbox: sandbox() } },
    responses: [[script.toolCall("c1", "shell", { command })], [script.text("Cached.")], [script.toolCall("c1", "shell", { command })], [script.text("It failed.")]],
  })
  await h.initialize()
  const own = await open(h, { sandboxHome: "session" })
  expect((await prompt(h, own.sessionId, "Run the tool.")).stopReason).toBe("end_turn")
  const [first, second] = [JSON.stringify(h.provider.calls[0]!.request.input), JSON.stringify(h.provider.calls[1]!.request.input)]
  // The model is told before its first step, in a message of the session; the command wrote, and read the user's settings.
  expect(first).toContain(NOTE)
  expect(second).toContain("cached\\n[user]")
  expect(readFileSync(join(tempBase, `${own.sessionId}.home`, "shared", ".cache", "tool", "file"), "utf8")).toBe("cached\n")
  expect(readdirSync(home).sort()).toEqual([".config", ".gitconfig"])
  expect(h.ext.filter((item) => item.method === EXT.notice)).toEqual([])

  const plain = await open(h, {})
  expect((await prompt(h, plain.sessionId, "Run the tool.")).stopReason).toBe("end_turn")
  const [third, fourth] = [JSON.stringify(h.provider.calls[2]!.request.input), JSON.stringify(h.provider.calls[3]!.request.input)]
  expect(third).not.toContain(NOTE)
  expect(fourth).toContain("Read-only file system")
  expect(fourth).toContain("(no network, and writes only inside the workspace and the temp directory)")
  expect(existsSync(join(tempBase, `${plain.sessionId}.home`))).toBe(false)
  expect(readdirSync(home).sort()).toEqual([".config", ".gitconfig"])
})

test.skipIf(!linux)("it is said again when the session is opened again, as a client that starts a process for each turn does: `session/resume` with the key keeps the home, without it the home is off and the model is told", async () => {
  h = await startHarness({
    engine: { approval: { sandbox: sandbox() } },
    responses: [[script.toolCall("c1", "shell", { command })], [script.text("Cached.")], [script.toolCall("c1", "shell", { command: "cat ~/.cache/tool/file" })], [script.text("Still there.")], [script.text("Noted.")]],
  })
  await h.initialize()
  const created = await open(h, { sandboxHome: "session" })
  expect((await prompt(h, created.sessionId, "Run the tool.")).stopReason).toBe("end_turn")
  await h.connection.agent.request(methods.agent.session.resume, { sessionId: created.sessionId, cwd: h.workspace, mcpServers: [], _meta: { [NS]: { attended: false, sandboxHome: "session" } } })
  expect((await prompt(h, created.sessionId, "Read it.")).stopReason).toBe("end_turn")
  expect(JSON.stringify(h.provider.calls[3]!.request.input)).toContain("cached\\n")
  await h.connection.agent.request(methods.agent.session.resume, { sessionId: created.sessionId, cwd: h.workspace, mcpServers: [], _meta: { [NS]: { attended: false, sandboxHome: "user" } } })
  expect((await prompt(h, created.sessionId, "And now?")).stopReason).toBe("end_turn")
  expect(JSON.stringify(h.provider.calls[4]!.request.input)).toContain("no longer have a home directory of this session's own")
})
