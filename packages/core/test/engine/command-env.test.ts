/**
 * The environment of a session's commands in the loop (`sandbox/config.ts`):
 * who names the variables its commands are not given and the
 * credential-looking ones they are, what the sandbox is told and when, what
 * the user is told about a project's file that names some, and that the
 * model is told nothing.
 *
 * The sandbox is a stand-in that records what it is told; the real one, with
 * real commands, is in `test/sandbox/command-env.e2e.test.ts`.
 */
import { afterAll, describe, expect, test } from "bun:test"
import type { ConfigFile } from "../../src/config/schema.ts"
import type { SessionId } from "../../src/id.ts"
import type { CommandSandbox } from "../../src/sandbox/command.ts"
import { type CommandEnv, resolveCommandEnv } from "../../src/sandbox/config.ts"
import { script } from "../../src/testing/fake-provider.ts"
import type { RunCheckOptions } from "../../src/verify/run.ts"
import { FakeWorkspace, Harness, type HarnessOptions, converse, removeHarnessDirectories } from "./harness.ts"

afterAll(removeHarnessDirectories)

const USER: ConfigFile = { sandbox: { withholdEnv: ["SENTRY_DSN"], passEnv: ["DEPLOY_KEY"] } }
const NONE: CommandEnv = { withhold: [], pass: [] }

/** A sandbox that plans nothing. `told` is every `environment.use` it got; a command without the sandbox gets `{ withheld: <names> }` in place of an environment. */
function standIn() {
  const told: (readonly [string, CommandEnv])[] = []
  const now = new Map<string, CommandEnv>()
  const sandbox: CommandSandbox = {
    state: { available: true },
    temp: (sessionId) => ({ dir: `/sandbox-tmp/${sessionId}`, alias: "/tmp" }),
    plan: () => {
      throw new Error("a scripted tool spawns nothing")
    },
    policy: () => {
      throw new Error("a scripted tool spawns nothing")
    },
    environment: {
      use: (sessionId, names) => {
        told.push([sessionId, names])
        now.set(sessionId, names)
      },
      unsandboxed: (sessionId) => {
        const withheld = now.get(sessionId)?.withhold ?? []
        return withheld.length === 0 ? undefined : { withheld: withheld.join(",") }
      },
    },
  }
  return { told, now, sandbox }
}

async function withHarness(sandbox: CommandSandbox, options: HarnessOptions, run: (h: Harness) => Promise<void>) {
  const h = new Harness({ approval: { sandbox, secrets: [], home: "/Users/user" }, ...options })
  try {
    await run(h)
    h.verify()
  } finally {
    await h.dispose()
  }
}

const notices = (h: Harness) => h.seenEvents.flatMap((item) => (item.type === "notice" ? [[item.kind, item.message]] : []))
const turn = async (h: Harness, session = h.create(), text = "Go.") => {
  h.provider.enqueue([script.text("Done.")])
  session.send(text)
  await h.settled()
  return session
}

describe("who names the variables", () => {
  test("the user's file and the client that opened the session, whose lists add up; a project's file names none", () => {
    const of = (user: ConfigFile | null, session: CommandEnv | null, project: ConfigFile | null) => resolveCommandEnv({ user: user?.sandbox, session, project: project?.sandbox })
    expect(of(null, null, null)).toEqual({ ...NONE, ignored: null })
    expect(of({ sandbox: { home: "session" } }, null, { sandbox: { home: "user" } })).toEqual({ ...NONE, ignored: null })
    expect(of(USER, null, null)).toEqual({ withhold: ["SENTRY_DSN"], pass: ["DEPLOY_KEY"], ignored: null })
    expect(of(null, { withhold: ["SENTRY_DSN"], pass: [] }, null)).toEqual({ withhold: ["SENTRY_DSN"], pass: [], ignored: null })
    expect(of(USER, { withhold: ["LOG_URL", "SENTRY_DSN"], pass: ["NPM_TOKEN"] }, null)).toEqual({ withhold: ["SENTRY_DSN", "LOG_URL"], pass: ["DEPLOY_KEY", "NPM_TOKEN"], ignored: null })
    // A client that names none takes nothing away from the file's.
    expect(of(USER, NONE, null)).toEqual({ withhold: ["SENTRY_DSN"], pass: ["DEPLOY_KEY"], ignored: null })
    // A project's file can neither let a credential through nor take a variable away from the user's own hooks and checks.
    expect(of(null, null, { sandbox: { passEnv: ["DEPLOY_KEY", "NPM_TOKEN"] } })).toEqual({ ...NONE, ignored: "sandbox.passEnv (DEPLOY_KEY, NPM_TOKEN)" })
    expect(of(USER, null, { sandbox: { withholdEnv: ["STRICT"], passEnv: ["NPM_TOKEN"] } })).toEqual({
      withhold: ["SENTRY_DSN"],
      pass: ["DEPLOY_KEY"],
      ignored: "sandbox.withholdEnv (STRICT) and sandbox.passEnv (NPM_TOKEN)",
    })
    expect(of(null, null, { sandbox: { withholdEnv: [], passEnv: [] } })).toEqual({ ...NONE, ignored: null })
  })
})

describe("the environment of a session's commands in the loop", () => {
  test("with nothing named the sandbox is told of no name, and neither the user nor the model is told anything", () => {
    const { told, now, sandbox } = standIn()
    return withHarness(sandbox, { userConfig: {} }, async (h) => {
      const session = await turn(h)
      expect(told.every(([id, names]) => id === session.id && names.withhold.length === 0 && names.pass.length === 0)).toBe(true)
      expect(sandbox.environment!.unsandboxed(session.id)).toBeUndefined()
      expect(now.get(session.id)).toEqual(NONE)
      expect(notices(h)).toEqual([])
      expect(h.log().filter((item) => item.type === "instruction.appended")).toEqual([])
    })
  })

  test("named in the user's file: the sandbox is told before the first command, and the model is sent no word about it", () => {
    const { told, sandbox } = standIn()
    return withHarness(sandbox, { userConfig: USER }, async (h) => {
      const session = await turn(h)
      expect(told.length).toBeGreaterThan(0)
      expect(told.every(([id, names]) => id === session.id && names.withhold.join() === "SENTRY_DSN" && names.pass.join() === "DEPLOY_KEY")).toBe(true)
      expect(notices(h)).toEqual([])
      expect(JSON.stringify(h.provider.requests)).not.toContain("SENTRY_DSN")
      expect(JSON.stringify(h.provider.requests)).not.toContain("DEPLOY_KEY")
    })
  })

  test("the client that opened the session names some without a file, they add to the file's, and they are the file's again when it names none", () => {
    const { told, sandbox } = standIn()
    return withHarness(sandbox, { userConfig: USER }, async (h) => {
      const session = h.create()
      session.setCommandEnv({ withhold: ["LOG_URL"], pass: [] })
      // Told when the client says so, before any turn.
      expect(told.at(-1)).toEqual([session.id, { withhold: ["SENTRY_DSN", "LOG_URL"], pass: ["DEPLOY_KEY"] }])
      await turn(h, session)
      expect(told.at(-1)).toEqual([session.id, { withhold: ["SENTRY_DSN", "LOG_URL"], pass: ["DEPLOY_KEY"] }])
      session.setCommandEnv(null)
      expect(told.at(-1)).toEqual([session.id, { withhold: ["SENTRY_DSN"], pass: ["DEPLOY_KEY"] }])
      expect(notices(h)).toEqual([])
    })
  })

  test("a project's file that names any is not followed, and the user is told once, with the names", () => {
    const { told, sandbox } = standIn()
    return withHarness(sandbox, { userConfig: { sandbox: { withholdEnv: ["SENTRY_DSN"] } }, config: { sandbox: { withholdEnv: ["STRICT"], passEnv: ["DEPLOY_KEY"] } } }, async (h) => {
      const session = await turn(h)
      await turn(h, session, "Again.")
      expect(told.every(([id, names]) => id === session.id && names.withhold.join() === "SENTRY_DSN" && names.pass.length === 0)).toBe(true)
      expect(notices(h)).toEqual([
        [
          "approval_ignored",
          "The project's configuration names environment variables for commands and was not followed: sandbox.withholdEnv (STRICT) and sandbox.passEnv (DEPLOY_KEY). Only your own configuration file, or the program that opens the session for you, says which of your variables commands get.",
        ],
      ])
    })
  })

  test("a subagent's commands are the session's: the sandbox is told the same names for it", async () => {
    const { told, sandbox } = standIn()
    const h = new Harness({ spawn: {}, approval: { sandbox, secrets: [], home: "/Users/user" } })
    try {
      converse(h.provider, {
        "Hand it over": [[script.toolCall("call_1", "subagent", { task: "Do the part" } as never)], [script.text("Handed over.")]],
        "Do the part": [[script.text("Did it.")]],
      })
      const session = h.create()
      session.setCommandEnv({ withhold: ["SENTRY_DSN"], pass: ["DEPLOY_KEY"] })
      session.send("Hand it over.")
      await h.settled()
      const child = "ses_2" as SessionId
      expect(told.filter(([id]) => id === child).length).toBeGreaterThan(0)
      expect(told.filter(([id]) => id === child).every(([, names]) => names.withhold.join() === "SENTRY_DSN" && names.pass.join() === "DEPLOY_KEY")).toBe(true)
    } finally {
      await h.dispose()
    }
  })

  test("the project's checks, where they run without the sandbox, are given the session's environment and not the harness's own", async () => {
    const { sandbox } = standIn()
    const seen: RunCheckOptions[] = []
    const h = new Harness({
      approval: { sandbox, secrets: [], home: "/Users/user" },
      userConfig: { sandbox: { withholdEnv: ["SENTRY_DSN"] } },
      config: { checks: [{ name: "test", command: "bun test" }] },
      workspace: new FakeWorkspace({ "a.ts": "1\n" }),
    })
    try {
      h.tools.on("write", (input: Record<string, unknown>) => {
        h.workspace?.files.set(String(input.path), String(input.content))
        return "Wrote a.ts"
      })
      h.checks.on("test", (_check, options) => {
        seen.push(options)
        return "passed"
      })
      h.provider.enqueue([script.toolCall("call_1", "write", { path: "a.ts", content: "2\n" } as never)], [script.text("Changed.")])
      const session = h.create()
      session.setApproval({ mode: "full" })
      session.send("Change a.ts.")
      await h.settled()
      expect(seen.map((options) => [options.sandbox, options.env])).toEqual([[undefined, { withheld: "SENTRY_DSN" }]])
    } finally {
      await h.dispose()
    }
  })

  test("when the session is closed the sandbox holds none of its names", () => {
    const { now, sandbox } = standIn()
    return withHarness(sandbox, {}, async (h) => {
      const session = h.create()
      session.setCommandEnv({ withhold: ["SENTRY_DSN"], pass: [] })
      await turn(h, session)
      expect(now.get(session.id)).toEqual({ withhold: ["SENTRY_DSN"], pass: [] })
      await session.close()
      expect(now.get(session.id)).toEqual(NONE)
    })
  })
})
