/**
 * The environment of a session's commands with real processes: the variables
 * a session names that none of its commands is given, and the
 * credential-looking ones its sandboxed commands are (`sandbox/config.ts`,
 * `CommandSandbox.environment`). Through the shell tool as the step loop
 * uses it, and through what else runs a command for a session: a check, a
 * hook, a wake-up's check, a program.
 *
 * The variables are made up and set in this process for the length of the
 * file. A process's environment as others read it (`/proc/<pid>/environ`) is
 * the one it was started with, so a process started here with the variables
 * stands for the harness, which is given them when it starts. The sandboxed
 * tests are skipped, visibly, where bubblewrap cannot run.
 */
import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { ACCESS_TOKEN_FILE_ENV } from "../../src/auth/handed-in.ts"
import { runProgram } from "../../src/codemode/index.ts"
import type { Hook } from "../../src/hooks/config.ts"
import { hookEvent } from "../../src/hooks/event.ts"
import { createHookRunner } from "../../src/hooks/run.ts"
import type { CallId, MessageId, SessionId } from "../../src/id.ts"
import { createInterrupt } from "../../src/interrupt.ts"
import { createCommandSandbox } from "../../src/sandbox/command.ts"
import { E2E_TIMEOUT_MS, waitFor } from "../../src/testing/wait.ts"
import { type BackgroundCommand, type SandboxRun, noBlobStore } from "../../src/tool/tool.ts"
import { shellTool } from "../../src/tools/shell.ts"
import { runCheck } from "../../src/verify/run.ts"
import { createCheckRunner } from "../../src/wake/check.ts"
import { hooks } from "../hooks/helpers.ts"
import { removeTempDirs, skipReason, tempDir } from "./helpers.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

const VARIABLES = { ACME_DSN: "dsn-made-up-1", ACME_DEPLOY_KEY: "deploy-made-up-2", ACME_OTHER_TOKEN: "other-made-up-3" }
/** A process of this user that was started with the variables, as the harness is. */
let holder: Bun.Subprocess | null = null
beforeAll(() => {
  Object.assign(process.env, VARIABLES)
  holder = Bun.spawn(["sleep", "600"], { env: { ...VARIABLES, PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdin: "ignore", stdout: "ignore", stderr: "ignore" })
})
afterAll(() => {
  holder?.kill("SIGKILL")
  for (const name of Object.keys(VARIABLES)) delete process.env[name]
  removeTempDirs()
})

const NOTHING: SandboxRun = { network: false, writableRoots: [] }
/** A session nothing was said about, and one that withholds a plain name and passes one credential. */
const PLAIN = "ses_env_plain" as SessionId
const NAMED = "ses_env_named" as SessionId
const NAMES = { withhold: ["ACME_DSN"], pass: ["ACME_DEPLOY_KEY"] }

const base = tempDir("command-env")
const workspace = join(base, "workspace")
mkdirSync(workspace, { recursive: true })
const sandbox = createCommandSandbox({ tempBase: join(base, "session-temp") })
sandbox.environment!.use(NAMED, NAMES)
const tool = shellTool({ spillDir: join(base, "spill"), sandbox, graceMs: 500 })
let calls = 0

/** What a command has of the three variables. */
const SHOW = 'echo "dsn=${ACME_DSN:-none} key=${ACME_DEPLOY_KEY:-none} other=${ACME_OTHER_TOKEN:-none}"'
const ALL = "dsn=dsn-made-up-1 key=deploy-made-up-2 other=other-made-up-3\n"
/** How many processes a command can see that have the withheld variable in their environment. */
const SEEN = "cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n' | grep -c '^ACME_DSN=' || true"

/** Runs a command through the shell tool as the step loop does: sandboxed with `access`, or without the sandbox (`null`). */
async function sh(session: SessionId, command: string, access: SandboxRun | null) {
  const result = await tool.execute(
    { command, timeout: 60 },
    { sessionId: session, messageId: "msg_1" as MessageId, callId: `call_${++calls}` as CallId, cwd: workspace, signal: new AbortController().signal, progress: () => {}, putBlob: noBlobStore, sandbox: access },
  )
  return result.output
}

describe("with nothing named, a command's environment is what it always was", () => {
  test("the policy is the default one, and a command without the sandbox gets the harness's own environment as it is", async () => {
    expect(sandbox.policy({ sessionId: PLAIN, cwd: workspace, run: NOTHING }).env).toEqual({ mode: "deny" })
    expect(sandbox.environment!.unsandboxed(PLAIN)).toBeUndefined()
    expect(await sh(PLAIN, SHOW, null)).toBe(ALL)
  })

  test.skipIf(skipReason !== null)("a sandboxed command gets every variable but the ones whose names look like credentials", async () => {
    expect(await sh(PLAIN, SHOW, NOTHING)).toBe("dsn=dsn-made-up-1 key=none other=none\n")
  })

  test("names that are taken back leave nothing behind", () => {
    const session = "ses_env_taken_back" as SessionId
    sandbox.environment!.use(session, NAMES)
    expect(sandbox.policy({ sessionId: session, cwd: workspace, run: NOTHING }).env).toEqual({ mode: "deny", names: ["ACME_DSN"], keep: ["ACME_DEPLOY_KEY"] })
    sandbox.environment!.use(session, { withhold: [], pass: [] })
    expect(sandbox.policy({ sessionId: session, cwd: workspace, run: NOTHING }).env).toEqual({ mode: "deny" })
    expect(sandbox.environment!.unsandboxed(session)).toBeUndefined()
  })
})

describe("a session that withholds a name and passes a credential", () => {
  test.skipIf(skipReason !== null)("a sandboxed command is not given the withheld name, is given the passed credential, and no other credential", async () => {
    expect(await sh(NAMED, SHOW, NOTHING)).toBe("dsn=none key=deploy-made-up-2 other=none\n")
    // With the network and another directory granted it is the same command environment.
    expect(await sh(NAMED, SHOW, { network: true, writableRoots: [base] })).toBe("dsn=none key=deploy-made-up-2 other=none\n")
  })

  test.skipIf(skipReason !== null)("a sandboxed command cannot read the variable from a process that has it either: it sees no process but its own", async () => {
    expect(await sh(NAMED, SEEN, NOTHING)).toBe("0\n")
    expect(await sh(NAMED, `test -e /proc/${holder!.pid}/environ && echo there || echo hidden`, NOTHING)).toBe("hidden\n")
  })

  test("a command without the sandbox is not given the withheld name, and is given every credential as before", async () => {
    expect(await sh(NAMED, SHOW, null)).toBe("dsn=none key=deploy-made-up-2 other=other-made-up-3\n")
  })

  test.skipIf(process.platform !== "linux")("without the sandbox that is a courtesy: the command is the same user and reads the variable from the process that has it", async () => {
    expect(await sh(NAMED, `tr '\\0' '\\n' < /proc/${holder!.pid}/environ | grep -c '^ACME_DSN=dsn-made-up-1$'`, null)).toBe("1\n")
  })

  test("the variable that names the file a sign-in is handed in through is never passed", () => {
    const session = "ses_env_token_file" as SessionId
    sandbox.environment!.use(session, { withhold: [], pass: [ACCESS_TOKEN_FILE_ENV, "ACME_DEPLOY_KEY"] })
    expect(sandbox.policy({ sessionId: session, cwd: workspace, run: NOTHING }).env).toEqual({ mode: "deny", names: [], keep: ["ACME_DEPLOY_KEY"] })
  })

  test.skipIf(skipReason !== null)("a command in the background gets the same environment", async () => {
    let started: BackgroundCommand | null = null
    const context = { sessionId: NAMED, messageId: "msg_1" as MessageId, callId: "call_background" as CallId, cwd: workspace, signal: new AbortController().signal, progress: () => {}, putBlob: noBlobStore }
    await tool.execute({ command: SHOW, background: true }, { ...context, sandbox: NOTHING, background: { command: (work) => ((started = work), { id: "bg_1" }) } })
    await waitFor(() => started !== null)
    expect((await started!.exited).output).toBe("dsn=none key=deploy-made-up-2 other=none\n")
    started = null
    await tool.execute({ command: SHOW, background: true }, { ...context, callId: "call_background_plain" as CallId, sandbox: null, background: { command: (work) => ((started = work), { id: "bg_2" }) } })
    await waitFor(() => started !== null)
    expect((await started!.exited).output).toBe("dsn=none key=deploy-made-up-2 other=other-made-up-3\n")
  })
})

describe("what else runs a command for the session", () => {
  const read = async (path: string | null) => (path === null ? "" : await Bun.file(path).text())

  test.skipIf(skipReason !== null)("a check in the sandbox", async () => {
    const result = await runCheck(
      { name: "show", command: SHOW, timeoutSeconds: 60, when: null },
      { cwd: workspace, spillDir: join(base, "checks"), signal: createInterrupt().signal, sandbox: { sandbox, run: NOTHING, sessionId: NAMED } },
    )
    expect(await read(result.output.path)).toBe("dsn=none key=deploy-made-up-2 other=none\n")
  })

  test("a check without the sandbox, given the session's environment", async () => {
    const result = await runCheck({ name: "show-plain", command: SHOW, timeoutSeconds: 60, when: null }, { cwd: workspace, spillDir: join(base, "checks"), signal: createInterrupt().signal, env: sandbox.environment!.unsandboxed(NAMED)! })
    expect(await read(result.output.path)).toBe("dsn=none key=deploy-made-up-2 other=other-made-up-3\n")
  })

  test("a hook, in the sandbox and without it", async () => {
    const hook: Hook = hooks({ user: { stop: [{ name: "h", command: `${SHOW}; exit 2`, timeoutSeconds: 30 }] } }).stop[0]!
    const runner = createHookRunner({ spillDir: join(base, "hooks"), sandbox, graceMs: 200 })
    const event = hookEvent({ point: "stop", sessionId: NAMED, cwd: workspace, hook, round: 1, maxRounds: 3, lastText: "done" })
    const request = { hook, event, cwd: workspace, sessionId: NAMED, signal: new AbortController().signal }
    expect(await runner({ ...request, sandbox: null })).toMatchObject({ kind: "exited", stdout: "dsn=none key=deploy-made-up-2 other=other-made-up-3\n" })
    if (skipReason === null) expect(await runner({ ...request, sandbox: NOTHING })).toMatchObject({ kind: "exited", stdout: "dsn=none key=deploy-made-up-2 other=none\n" })
  })

  test("a wake-up's check, in the sandbox and without it", async () => {
    const run = createCheckRunner({ spillDir: join(base, "wake"), sandbox })
    const request = { name: "wk_env", command: SHOW, cwd: workspace, timeoutMs: 30_000, sessionId: NAMED, signal: new AbortController().signal }
    expect(await run({ ...request, run: { kind: "unsandboxed" } })).toMatchObject({ kind: "exited", output: "dsn=none key=deploy-made-up-2 other=other-made-up-3\n" })
    if (skipReason === null) expect(await run({ ...request, run: { kind: "sandboxed", network: false, writableRoots: [] } })).toMatchObject({ kind: "exited", output: "dsn=none key=deploy-made-up-2 other=none\n" })
  })

  test("a program is given a handful of variables and none that is withheld", async () => {
    const session = "ses_env_program" as SessionId
    sandbox.environment!.use(session, { withhold: ["ACME_DSN", "TZ"], pass: [] })
    const source = 'return { dsn: process.env.ACME_DSN ?? null, key: process.env.ACME_DEPLOY_KEY ?? null, tz: process.env.TZ ?? null, path: process.env.PATH !== undefined }'
    const program = (env: Readonly<Record<string, string | undefined>>) =>
      runProgram({ source, tools: [], host: { call: async () => ({ status: "error", output: "no calls" }) }, signal: new AbortController().signal, dir: join(base, `program-${++calls}`), confine: null, env })
    expect((await program({ ...process.env, TZ: "Europe/Vienna" })).end).toEqual({ kind: "returned", value: JSON.stringify({ dsn: null, key: null, tz: "Europe/Vienna", path: true }, null, 2) })
    process.env.TZ = "Europe/Vienna"
    try {
      expect((await program(sandbox.environment!.unsandboxed(session)!)).end).toEqual({ kind: "returned", value: JSON.stringify({ dsn: null, key: null, tz: null, path: true }, null, 2) })
    } finally {
      delete process.env.TZ
    }
  })
})
