/**
 * Required checks over the protocol: a client names, with `requiredChecks`
 * in `_meta[<ns>]` when it opens a session, checks that run and gate the
 * session's turns whatever the project's file says, and reads from each
 * turn's ending whose every check was, whether it is required, and the end
 * of a failing check's output. The real step loop, the real tools, the real
 * check runner, the real configuration loader (on a home of the test's own)
 * and real snapshots, with a scripted model.
 *
 * The sessions run in mode `full`, where checks run without the sandbox, so
 * the tests do not depend on a sandbox being there.
 */
import { Database } from "bun:sqlite"
import { afterAll, afterEach, expect, test, setDefaultTimeout } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { methods } from "@agentclientprotocol/sdk"
import { brand } from "@windlass/core"
import { E2E_TIMEOUT_MS, type ScriptedResponse, script } from "@windlass/core/testing"
import { loadConfig, loadConfigSync } from "../../core/src/config/load.ts"
import { EXT, META } from "../src/extensions.ts"
import { EXTENSION_CAPABILITIES } from "../src/server.ts"
import { type Harness, startHarness } from "./helpers.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

const NS = META.capabilities
/** A made-up value under a credential-looking name, set before the server is made, as a program that starts the server sets it. */
const SECRET = { ACME_DEPLOY_TOKEN: "made-up-token-0123456789" }
Object.assign(process.env, SECRET)
const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-acp-required-")))
afterAll(() => {
  for (const name of Object.keys(SECRET)) delete process.env[name]
  rmSync(root, { recursive: true, force: true })
})

let h: Harness | null = null
let count = 0
afterEach(async () => {
  const violations = h?.violations ?? []
  await h?.close()
  h = null
  expect(violations).toEqual([])
})

/** A server whose engine reads the user's file from a home of this test's and the project's from the workspace, as the program does. */
async function start(responses: readonly ScriptedResponse[], user: Record<string, unknown> | null = null) {
  const home = join(root, `home-${++count}`)
  if (user !== null) put(join(home, ".config", brand.directory, "config.json"), JSON.stringify(user))
  h = await startHarness({
    responses,
    clientCapabilities: { _meta: { [NS]: { events: true } } },
    engine: { loadConfig: (cwd) => loadConfig({ cwd, home, env: {} }), loadConfigSync: (cwd) => loadConfigSync({ cwd, home, env: {} }) },
  })
  await h.initialize()
  return h
}

function put(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
const projectFile = (harness: Harness, content: Record<string, unknown>) => put(join(harness.workspace, `.${brand.directory}`, "config.json"), JSON.stringify(content))

type Check = { name: string; command: string; status: string; exitCode: number | null; origin?: string; required?: boolean; outputTail?: { text: string; truncated: boolean } | null; outputPath: string | null; outputBytes: number; startError?: string }
type Since = { seq: number; run?: { seq: number; run: number } | null }
type Turn = { outcome: string; verification: { status: string; reason?: string; failing?: string[]; since?: Since; requiredChecks?: { name: string; definition: string }[]; evidence?: { run: number; changedFiles: string[]; checks: Check[]; since?: Since; requiredChecks?: { name: string; definition: string }[] } } }

const open = (harness: Harness, meta: Record<string, unknown>, cwd = harness.workspace) =>
  harness.connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [], _meta: { [NS]: { attended: false, approval: "full", ...meta } } })
const prompt = async (harness: Harness, sessionId: string, text: string) =>
  (await harness.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] }))._meta?.[NS] as Turn
const events = (harness: Harness, sessionId: string, type: string) =>
  harness.ext.filter((note) => note.method === EXT.event && note.params.sessionId === sessionId && (note.params.event as { type: string }).type === type).map((note) => (note.params.event as { data: Record<string, unknown> }).data)
const said = (turn: Turn) => (turn.verification.evidence?.checks ?? []).map(({ name, status, origin, required }) => ({ name, status, origin, required }))

const write = (id: string, path: string, content: string) => [script.toolCall(id, "write", { path, content })]
const done = [script.text("Done.")]
const TEST = { name: "test", command: "test -f ok.txt" }

test("the key is one a client is told about, and a value that is not a list of checks is refused with the place of the fault", async () => {
  const harness = await start([])
  expect(EXTENSION_CAPABILITIES.openMeta).toContain("requiredChecks")
  const advertised = (harness.wire.find((message) => "result" in message && (message.result as { agentCapabilities?: unknown }).agentCapabilities !== undefined)!.result as { agentCapabilities: { _meta: Record<string, { openMeta: string[] }> } }).agentCapabilities._meta[NS]!.openMeta
  expect(advertised).toContain("requiredChecks")
  const bad: [unknown, string][] = [
    ["bun test", `_meta.${NS}.requiredChecks: expected array`],
    [[{ name: "test" }], `_meta.${NS}.requiredChecks[0].command: expected a value`],
    [[{ name: "test", command: "true", timeout: 3 }], `_meta.${NS}.requiredChecks[0].timeout: `],
    [[TEST, TEST], `_meta.${NS}.requiredChecks[1].name: expected a name not already used`],
  ]
  for (const [value, message] of bad) {
    const error = await open(harness, { requiredChecks: value }).then(
      () => null,
      (thrown: { code: number; message: string }) => thrown,
    )
    expect(error?.code, message).toBe(-32602)
    expect(error?.message, message).toContain(message)
  }
  // Nothing was created by the refused requests.
  expect((await harness.connection.agent.request(methods.agent.session.list, {})).sessions).toEqual([])
})

test("a session opened with required checks and no file anywhere: they run, gate the turn, and the turn's ending says whose they are; a failing run carries the end of its output, redacted", async () => {
  const harness = await start([write("c1", "a.txt", "1\n"), done, write("c2", "ok.txt", "ok\n"), [script.text("Fixed.")]])
  // The check fails until ok.txt is there, and prints a credential's value and more lines than the evidence carries.
  const command = 'if test -f ok.txt; then echo fine; else seq 1 400; echo "token=$ACME_DEPLOY_TOKEN"; echo "1 fail"; exit 1; fi'
  const { sessionId } = await open(harness, { requiredChecks: [{ name: "test", command }] })
  const turn = await prompt(harness, sessionId, "Write a.txt.")
  expect(turn).toMatchObject({ outcome: "succeeded", verification: { status: "passed", evidence: { run: 2 } } })
  expect(said(turn)).toEqual([{ name: "test", status: "passed", origin: "session", required: true }])
  expect(turn.verification.evidence!.checks[0]!.outputTail).toBeNull()

  // The failing run is in the log with its tail: the last lines only, with the value replaced.
  const runs = events(harness, sessionId, "checks.finished").map((data) => (data.evidence as { checks: Check[] }).checks[0]!)
  expect(runs.map((run) => [run.status, run.origin, run.required])).toEqual([["failed", "session", true], ["passed", "session", true]])
  const tail = runs[0]!.outputTail!
  expect(tail.truncated).toBe(true)
  expect(tail.text.endsWith("400\ntoken=[REDACTED:env]\n1 fail\n")).toBe(true)
  expect(tail.text.split("\n").length - 1).toBe(60)
  // The file with all of the output is still named, holds all of it, and is redacted too.
  expect(runs[0]!.outputBytes).toBeGreaterThan(tail.text.length)
  const full = readFileSync(runs[0]!.outputPath!, "utf8")
  expect(full.startsWith("1\n2\n3\n")).toBe(true)
  expect(full.endsWith(tail.text)).toBe(true)
  // The value is nowhere: not in what the client was sent, not in what the model was.
  expect(JSON.stringify(harness.wire)).not.toContain(SECRET.ACME_DEPLOY_TOKEN)
  expect(JSON.stringify(harness.provider.calls.map((call) => call.request))).not.toContain(SECRET.ACME_DEPLOY_TOKEN)
  // The model was sent back once, with a report that says the check is required.
  expect(JSON.stringify(harness.provider.calls[2]!.request.input)).toContain("This session requires test: no file of the project replaces a required check or switches it off.")
})

test("the project's own checks run besides them, each with its origin; its empty list and verify off run nothing of its own and the required check still gates, also when the agent writes that file in the middle of the session", async () => {
  const off = JSON.stringify({ checks: [], verify: { mode: "off" }, requiredChecks: [] })
  const harness = await start([
    write("c1", "ok.txt", "ok\n"),
    done,
    // The agent switches the project's checks off, and with them tries the required one.
    write("c2", `.${brand.directory}/config.json`, off),
    done,
    [script.toolCall("c3", "shell", { command: "rm ok.txt" })],
    done,
    [script.toolCall("c4", "report_check_failure", { checks: ["test"], reason: "ok.txt is gone." })],
    [script.text("It fails.")],
  ])
  projectFile(harness, { checks: [{ name: "lint", command: "true", outputTail: "always" }] })
  const { sessionId } = await open(harness, { requiredChecks: [TEST] })
  const first = await prompt(harness, sessionId, "Write ok.txt.")
  expect(said(first)).toEqual([
    { name: "test", status: "passed", origin: "session", required: true },
    { name: "lint", status: "passed", origin: "project", required: false },
  ])
  // A passing check carries its output where its configuration asks for it, and only there.
  expect(first.verification.evidence!.checks.map((check) => check.outputTail)).toEqual([null, { text: "", truncated: false }])

  // The turn that rewrites the file still runs under what it started with; the next one reads the file as it is now.
  const second = await prompt(harness, sessionId, "Switch the checks off.")
  expect(said(second)).toEqual([
    { name: "test", status: "passed", origin: "session", required: true },
    { name: "lint", status: "passed", origin: "project", required: false },
  ])
  expect(JSON.parse(readFileSync(join(harness.workspace, `.${brand.directory}`, "config.json"), "utf8"))).toEqual(JSON.parse(off))
  const third = await prompt(harness, sessionId, "Remove ok.txt.")
  expect(third).toMatchObject({ outcome: "unresolved", verification: { status: "unresolved", reason: "acknowledged", failing: ["test"] } })
  expect(said(third)).toEqual([{ name: "test", status: "failed", origin: "session", required: true }])
  // The empty `requiredChecks` the agent wrote there names nothing: it took nothing away, and there is nothing to tell.
  const notices = harness.ext.filter((note) => note.method === EXT.notice).map((note) => note.params as { kind: string; message: string })
  expect(notices.filter((note) => note.message.includes("requiredChecks"))).toEqual([])
})

test("a project's file that names required checks or a check with a required check's name is not followed, and the client is told", async () => {
  const harness = await start([write("c1", "ok.txt", "ok\n"), done])
  projectFile(harness, { checks: [{ name: "test", command: "false" }], requiredChecks: [{ name: "fake", command: "false" }] })
  const { sessionId } = await open(harness, { requiredChecks: [TEST] })
  const turn = await prompt(harness, sessionId, "Write ok.txt.")
  expect(turn.verification.status).toBe("passed")
  expect(turn.verification.evidence!.checks.map(({ name, command, origin, required }) => ({ name, command, origin, required }))).toEqual([{ name: "test", command: "test -f ok.txt", origin: "session", required: true }])
  const notices = harness.ext.filter((note) => note.method === EXT.notice).map((note) => note.params as { kind: string; message: string })
  expect(notices.map((note) => note.kind)).toEqual(["approval_ignored", "approval_ignored"])
  expect(notices[0]!.message).toContain("requiredChecks (fake)")
  expect(notices[1]!.message).toContain("with the name of a required check and was not followed: test")
})

test("the user's own file names required checks too; one opened by a client that sends no such key is verified as it always was", async () => {
  const harness = await start([write("c1", "ok.txt", "ok\n"), done, write("c2", "ok.txt", "ok\n"), done], { checks: [{ name: "style", command: "true" }] })
  projectFile(harness, { checks: [{ name: "lint", command: "true" }] })
  // No key: the project's list replaced the user's, and nothing is required.
  const plain = await open(harness, {})
  const before = await prompt(harness, plain.sessionId, "Write ok.txt.")
  expect(said(before)).toEqual([{ name: "lint", status: "passed", origin: "project", required: false }])
  expect(harness.ext.filter((note) => note.method === EXT.notice)).toEqual([])

  const other = await start([write("c1", "ok.txt", "ok\n"), done], { requiredChecks: [TEST], checks: [{ name: "style", command: "true" }] })
  projectFile(other, { checks: [], verify: { mode: "off" } })
  const { sessionId } = await open(other, {})
  expect(said(await prompt(other, sessionId, "Write ok.txt."))).toEqual([{ name: "test", status: "passed", origin: "user", required: true }])
  await harness.close()
})

test("the checks are said again when the session is opened again: `session/resume` without the key keeps them in a process that still has the session, and an empty list takes them back", async () => {
  const harness = await start([write("c1", "a.txt", "1\n"), done, write("c2", "a.txt", "2\n"), done, write("c3", "a.txt", "3\n"), done])
  const { sessionId } = await open(harness, { requiredChecks: [{ name: "test", command: "true" }] })
  expect((await prompt(harness, sessionId, "One.")).verification.status).toBe("passed")
  const resume = (meta: Record<string, unknown>) => harness.connection.agent.request(methods.agent.session.resume, { sessionId, cwd: harness.workspace, mcpServers: [], _meta: { [NS]: { attended: false, approval: "full", ...meta } } })
  await resume({})
  expect((await prompt(harness, sessionId, "Two.")).verification.status).toBe("passed")
  await resume({ requiredChecks: [] })
  expect((await prompt(harness, sessionId, "Three.")).verification.status).toBe("not_configured")
})

test("a required check runs in the session's working directory and its patterns are relative to it, wherever the project's file is; the project's own run in the project directory", async () => {
  const harness = await start([write("c1", "src/x.txt", "1\n"), done, write("c2", `.${brand.directory}/config.json`, JSON.stringify({ checks: [{ name: "where-project", command: "pwd", outputTail: "always" }] })), done, write("c3", "src/x.txt", "2\n"), done])
  // A repository with the project's file at its root, and a session that works in a package of it.
  mkdirSync(join(harness.workspace, ".git"), { recursive: true })
  const cwd = join(harness.workspace, "packages", "a")
  mkdirSync(join(cwd, "src"), { recursive: true })
  projectFile(harness, { checks: [{ name: "where-project", command: "pwd", outputTail: "always" }] })
  const { sessionId } = await open(harness, { requiredChecks: [{ name: "where-required", command: "pwd", when: ["src/**"], outputTail: "always" }] }, cwd)
  const places = (turn: Turn) => Object.fromEntries(turn.verification.evidence!.checks.map((check) => [check.name, check.outputTail?.text.trim()]))
  expect(places(await prompt(harness, sessionId, "Write src/x.txt."))).toEqual({ "where-required": cwd, "where-project": harness.workspace })
  // The agent puts a project file into the working directory: the project directory is now that directory, and
  // the required check runs where it ran, selected by the same paths.
  await prompt(harness, sessionId, "Add a project file here.")
  expect(places(await prompt(harness, sessionId, "Change src/x.txt."))).toEqual({ "where-required": cwd, "where-project": cwd })
})

test("a turn in which a required check failed and the agent put the file back ends as done without a run, and says which state and which run that rests on; named with another command, the check does not stand on that state and runs", async () => {
  const value = (id: string, content: string) => write(id, "value.txt", content)
  const harness = await start([value("c1", "5\n"), done, value("c2", "6\n"), [script.text("Faster.")], value("c3", "5\n"), [script.text("Put back.")], value("c4", "6\n"), [script.text("Faster.")], value("c5", "5\n"), [script.text("Put back.")]])
  const five = { name: "test", command: 'test "$(cat value.txt)" = 5' }
  const { sessionId } = await open(harness, { requiredChecks: [five] })
  const first = await prompt(harness, sessionId, "Write 5.")
  expect(first.verification).toMatchObject({ status: "passed", evidence: { run: 1, changedFiles: ["value.txt"] } })
  // The run names the state its changes are measured from (the session's start: no run before it) and the required checks.
  expect(first.verification.evidence!.since).toEqual({ seq: expect.any(Number), run: null })
  expect(first.verification.evidence!.requiredChecks).toEqual([{ name: "test", definition: expect.stringMatching(/^[0-9a-f]{64}$/) }])
  const finished = () => harness.ext.filter((note) => note.method === EXT.event && note.params.sessionId === sessionId && (note.params.event as { type: string }).type === "checks.finished").map((note) => note.params.event as { seq: number; data: { run: number; evidence: { checks: Check[] } } })
  const passedAt = finished()[0]!.seq

  const second = await prompt(harness, sessionId, "Make it faster.")
  // One run in this turn, which failed; the agent was sent back and wrote the file as it was.
  expect(finished().slice(1).map((run) => run.data.evidence.checks.map((check) => check.status))).toEqual([["failed"]])
  expect(second.outcome).toBe("succeeded")
  expect(second.verification).toEqual({ status: "not_needed", reason: "state_unchanged", since: { seq: passedAt, run: { seq: passedAt, run: 1 } }, requiredChecks: first.verification.evidence!.requiredChecks! })

  // The client opens the session again and names the check with another command: it never passed on this state.
  await harness.connection.agent.request(methods.agent.session.resume, { sessionId, cwd: harness.workspace, mcpServers: [], _meta: { [NS]: { attended: false, approval: "full", requiredChecks: [{ name: "test", command: "grep -qx 5 value.txt" }] } } })
  const third = await prompt(harness, sessionId, "Make it faster.")
  expect(finished().slice(2).map((run) => run.data.evidence.checks.map((check) => [check.command, check.status]))).toEqual([[["grep -qx 5 value.txt", "failed"]], [["grep -qx 5 value.txt", "passed"]]])
  expect(third.verification).toMatchObject({ status: "passed", evidence: { run: 2, changedFiles: [], checks: [{ name: "test", command: "grep -qx 5 value.txt", status: "passed", required: true }] } })
  expect(third.verification.evidence!.requiredChecks![0]!.definition).not.toBe(first.verification.evidence!.requiredChecks![0]!.definition)
})

test("a session a later version recorded more in: keys this version does not know in the evidence of a run are replayed and kept as they are; one anywhere else refuses the session, in a sentence that says so", async () => {
  const first = await start([write("c1", "ok.txt", "ok\n"), done, [script.text("Hello.")]])
  const dataDir = first.dataDir
  const workspace = first.workspace
  const { sessionId } = await open(first, { requiredChecks: [{ ...TEST, outputTail: "always" }] })
  expect((await prompt(first, sessionId, "Write ok.txt.")).verification.status).toBe("passed")
  await first.close({ keep: true })
  h = null

  // What a later version might have written, put into the stored records as it would have stored them. The log is
  // append-only by trigger, so the triggers are taken off for the edit and put back.
  const file = [...new Bun.Glob(`**/${sessionId}.db`).scanSync({ cwd: dataDir, absolute: true })][0]!
  const canonical = (value: unknown): string =>
    Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}` : JSON.stringify(value)
  const edit = (change: (type: string, data: Record<string, any>) => boolean, state: (value: Record<string, any>) => void) => {
    const db = new Database(file)
    const triggers = db.query("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all() as { name: string; sql: string }[]
    for (const trigger of triggers) db.run(`DROP TRIGGER ${trigger.name}`)
    for (const row of db.query("SELECT seq, type, data FROM event").all() as { seq: number; type: string; data: string }[]) {
      const data = JSON.parse(row.data) as Record<string, any>
      if (change(row.type, data)) db.run("UPDATE event SET data = ? WHERE seq = ?", [canonical(data), row.seq])
    }
    const stored = JSON.parse((db.query("SELECT state FROM session").get() as { state: string }).state) as Record<string, any>
    state(stored)
    db.run("UPDATE session SET state = ?", [canonical(stored)])
    for (const trigger of triggers) db.run(trigger.sql)
    db.close()
  }
  const more = (evidence: Record<string, any>) => {
    evidence.runner = { version: 3 }
    evidence.checks[0].retries = 2
    evidence.checks[0].outputTail.encoding = "utf-8"
  }
  edit(
    (type, data) => {
      const evidence = type === "checks.finished" ? data.evidence : (data.verification?.evidence ?? null)
      if (evidence === null) return false
      more(evidence)
      return true
    },
    (state) => more(state.verification.latest.evidence),
  )

  const restart = async (responses: readonly ScriptedResponse[]) => {
    h = await startHarness({ responses, dataDir, clientCapabilities: { _meta: { [NS]: { events: true } } } })
    await h.initialize()
    return h
  }
  const load = (harness: Harness) => harness.connection.agent.request(methods.agent.session.load, { sessionId, cwd: workspace, mcpServers: [], _meta: { [NS]: { attended: false, approval: "full", requiredChecks: [{ ...TEST, outputTail: "always" }] } } })
  const second = await restart([write("c2", "more.txt", "1\n"), done])
  await load(second)
  const replayed = second.ext.filter((note) => note.method === EXT.event && note.params.replay === true && (note.params.event as { type: string }).type === "checks.finished").map((note) => (note.params.event as { data: { evidence: Record<string, any> } }).data.evidence)
  expect(replayed).toHaveLength(1)
  expect(replayed[0]).toMatchObject({ runner: { version: 3 }, checks: [{ name: "test", status: "passed", origin: "session", required: true, retries: 2, outputTail: { text: "", truncated: false, encoding: "utf-8" } }] })
  // The session goes on, and what was stored is still there.
  expect((await prompt(second, sessionId, "Write more.txt.")).verification.status).toBe("passed")
  await second.close({ keep: true })
  h = null
  const kept = new Database(file, { readonly: true })
  expect((kept.query("SELECT data FROM event WHERE type = 'checks.finished' ORDER BY seq LIMIT 1").get() as { data: string }).data).toContain('"retries":2')
  kept.close()

  // A key of a later version where the session's state is decided from: the ending of a turn.
  edit(
    (type, data) => {
      if (type !== "execution.succeeded") return false
      data.verification.confidence = "high"
      return true
    },
    () => {},
  )
  const third = await restart([])
  const refused = await load(third).then(
    () => null,
    (error: { code: number; message: string; data?: Record<string, { reason: string; message: string }> }) => error,
  )
  expect(refused).toMatchObject({ code: -32603, data: { [NS]: { reason: "unreadable_session" } } })
  expect(refused!.message).toBe(
    `that session holds a record this version of ${brand.name} does not read (event execution.succeeded: data.verification.confidence: expected no such key, got "high"). A later version wrote it, or the file is damaged: open the session with the version that wrote it, or a later one.`,
  )
  expect(refused!.data![NS]!.message).toBe(refused!.message)
  await third.close()
  h = null
})

test("no hook stands between a required check and its run: one that refuses every command does not refuse the check, and one that is content with the turn's ending does not turn a failing check into done", async () => {
  const hooks = {
    beforeTool: [{ name: "no-commands", tools: ["shell"], command: "echo 'No commands here.'; exit 2" }],
    stop: [{ name: "content", command: "exit 0" }],
  }
  const harness = await start(
    [write("c1", "a.txt", "1\n"), [script.toolCall("c2", "shell", { command: "touch ok.txt" })], done, [script.toolCall("c3", "report_check_failure", { checks: ["test"], reason: "ok.txt cannot be made." })], [script.text("It fails.")]],
    { hooks, requiredChecks: [TEST] },
  )
  const { sessionId } = await open(harness, {})
  const turn = await prompt(harness, sessionId, "Write a.txt and make ok.txt.")
  // The model's own command was refused by the hook, so ok.txt is not there; the check ran all the same, and failed on that.
  expect(JSON.stringify(harness.provider.calls[2]!.request.input)).toContain("This call was not run: the hook")
  expect(events(harness, sessionId, "hook.ran").map((data) => [data.point, data.name])).toEqual([["beforeTool", "no-commands"], ["stop", "content"]])
  expect(turn).toMatchObject({ outcome: "unresolved", verification: { status: "unresolved", reason: "acknowledged", failing: ["test"] } })
  expect(turn.verification.evidence!.checks).toMatchObject([{ name: "test", status: "failed", exitCode: 1, origin: "user", required: true }])
})
