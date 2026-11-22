/**
 * The home of the session's own in the loop (`sandbox/config.ts`): who turns
 * it on, what the sandbox is told, what the user is told once, and what the
 * model is told, in a stored message and in the note under a failed command.
 *
 * The sandbox is a stand-in that records what it is told and says what the
 * test makes it say; the real one is in `test/sandbox/`.
 */
import { afterAll, describe, expect, test } from "bun:test"
import type { ConfigFile } from "../../src/config/schema.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
import type { CommandSandbox } from "../../src/sandbox/command.ts"
import { resolveSandboxHome } from "../../src/sandbox/config.ts"
import { SESSION_HOME_KEY, SESSION_HOME_TEXT, sessionHomeUpdate } from "../../src/sandbox/home-note.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { Harness, type HarnessOptions, failed, removeHarnessDirectories } from "./harness.ts"

afterAll(removeHarnessDirectories)

const SESSION: ConfigFile = { sandbox: { home: "session" } }
const USER: ConfigFile = { sandbox: { home: "user" } }

/** A sandbox that plans nothing. `told` is every `sessionHome.use` it got; `state` is what it says about a session whose home is on. */
function standIn(state: { used: boolean; notice: string | null } = { used: true, notice: null }) {
  const told: (readonly [string, boolean])[] = []
  const sandbox: CommandSandbox = {
    state: { available: true },
    temp: (sessionId) => ({ dir: `/sandbox-tmp/${sessionId}`, alias: "/tmp" }),
    plan: () => {
      throw new Error("a scripted tool spawns nothing")
    },
    policy: () => {
      throw new Error("a scripted tool spawns nothing")
    },
    sessionHome: { use: (sessionId, on) => void told.push([sessionId, on]), state: () => state },
  }
  return { told, sandbox }
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

const notes = (h: Harness) => h.log().filter((item): item is StoredEvent<"instruction.appended"> => item.type === "instruction.appended" && item.data.source === SESSION_HOME_KEY)
const notices = (h: Harness) => h.seenEvents.flatMap((item) => (item.type === "notice" ? [[item.kind, item.message]] : []))
const outputs = (h: Harness) => h.log().flatMap((item) => (item.type === "tool.settled" ? [item.data.output] : []))
const refused = () => ({ ...failed("touch: cannot touch '/Users/user/.cache/x': Read-only file system\n[Exit code 1]"), display: { exitCode: 1 } })
const failing = (h: Harness) => {
  h.provider.enqueue([script.toolCall("call_1", "shell", { command: "touch ~/.cache/x" })], [script.text("Done.")])
  h.tools.on("shell", refused)
}

describe("who turns the session's home on", () => {
  test("the user's file or the client that opened the session; a project's file can only turn it off", () => {
    const of = (user: ConfigFile | null, session: "user" | "session" | null, project: ConfigFile | null) => resolveSandboxHome({ user: user?.sandbox, session, project: project?.sandbox })
    expect(of(null, null, null)).toEqual({ home: "user", ignored: null })
    expect(of(SESSION, null, null)).toEqual({ home: "session", ignored: null })
    expect(of(null, "session", null)).toEqual({ home: "session", ignored: null })
    // The client's choice for the session is the user's, and goes on top of the file.
    expect(of(SESSION, "user", null)).toEqual({ home: "user", ignored: null })
    expect(of(USER, "session", null)).toEqual({ home: "session", ignored: null })
    expect(of(SESSION, null, USER)).toEqual({ home: "user", ignored: null })
    expect(of(null, "session", USER)).toEqual({ home: "user", ignored: null })
    expect(of(null, null, SESSION)).toEqual({ home: "user", ignored: 'sandbox.home "session" (yours is "user")' })
    expect(of(USER, null, SESSION)).toEqual({ home: "user", ignored: 'sandbox.home "session" (yours is "user")' })
    expect(of(SESSION, null, SESSION)).toEqual({ home: "session", ignored: null })
  })

  test("what the model is told: once when the commands get the home, nothing when it knows, and a withdrawal when they no longer do", () => {
    const told = sessionHomeUpdate(undefined, true)
    expect(told?.text).toBe(SESSION_HOME_TEXT.used)
    expect(sessionHomeUpdate(told?.fingerprint, true)).toBeNull()
    expect(sessionHomeUpdate(told?.fingerprint, false)).toEqual({ text: SESSION_HOME_TEXT.gone, fingerprint: null })
    expect(sessionHomeUpdate(null, false)).toBeNull()
    expect(sessionHomeUpdate(undefined, false)).toBeNull()
    expect(sessionHomeUpdate(null, true)?.text).toBe(SESSION_HOME_TEXT.used)
  })
})

describe("the session's home in the loop", () => {
  test("off, as it is unless something turns it on: the sandbox is told nothing, the model no message, and a failed command's note is the one it always was", () => {
    const { told, sandbox } = standIn()
    return withHarness(sandbox, { userConfig: {} }, async (h) => {
      failing(h)
      h.create().send("Make the cache.")
      await h.settled()
      expect(told).toEqual([])
      expect(notes(h)).toEqual([])
      expect(notices(h)).toEqual([])
      expect(outputs(h)[0]).toContain("This command ran in the sandbox (no network, and writes only inside the workspace and the temp directory), and its output shows")
      expect(JSON.stringify(h.provider.requests)).not.toContain("home directory of this session's own")
    })
  })

  test("on in the user's file: the sandbox is told before the first command, the model is told in a message that is stored once, and the note under a failed command names the home", () => {
    const { told, sandbox } = standIn()
    return withHarness(sandbox, { userConfig: SESSION }, async (h) => {
      failing(h)
      const session = h.create()
      session.send("Make the cache.")
      await h.settled()
      expect(told).toEqual([[session.id, true]])
      expect(notes(h).map((item) => item.data.text)).toEqual([SESSION_HOME_TEXT.used])
      expect(notices(h)).toEqual([])
      expect(outputs(h)[0]).toContain(
        "This command ran in the sandbox (no network, and writes only inside the workspace, the temp directory and this session's own home, where what the user already has is read-only), and its output shows",
      )
      // The first request already carries the message; a second turn adds none.
      expect(JSON.stringify(h.provider.requests[0])).toContain("Commands that run in the sandbox have a home directory of this session's own")
      h.provider.enqueue([script.text("Nothing more.")])
      session.send("Anything else?")
      await h.settled()
      expect(notes(h).length).toBe(1)
      expect(told.every(([id, on]) => id === session.id && on)).toBe(true)
    })
  })

  test("on, and the session gets none or not all of it: the user is told once what was left as it was, and the model is told nothing of a home its commands do not have", () => {
    const { sandbox } = standIn({ used: false, notice: "the home has too many entries" })
    return withHarness(sandbox, { userConfig: SESSION }, async (h) => {
      failing(h)
      const session = h.create()
      session.send("Make the cache.")
      await h.settled()
      h.provider.enqueue([script.text("Nothing more.")])
      session.send("Anything else?")
      await h.settled()
      expect(notices(h)).toEqual([["session_home", "the home has too many entries"]])
      expect(notes(h)).toEqual([])
      expect(outputs(h)[0]).toContain("writes only inside the workspace and the temp directory)")
    })
  })

  test("a project's file that asks for it is not followed, and the user is told; one that turns the user's off is", async () => {
    const asking = standIn()
    await withHarness(asking.sandbox, { config: SESSION }, async (h) => {
      h.provider.enqueue([script.text("Done.")])
      h.create().send("Go.")
      await h.settled()
      expect(asking.told).toEqual([])
      expect(notes(h)).toEqual([])
      expect(notices(h)).toEqual([
        ["approval_ignored", 'The project\'s configuration asks for a home of the session\'s own for sandboxed commands and was not followed: sandbox.home "session" (yours is "user"). A project file can only turn it off.'],
      ])
    })
    const refusing = standIn()
    await withHarness(refusing.sandbox, { userConfig: SESSION, config: USER }, async (h) => {
      h.provider.enqueue([script.text("Done.")])
      h.create().send("Go.")
      await h.settled()
      expect(refusing.told).toEqual([])
      expect(notes(h)).toEqual([])
      expect(notices(h)).toEqual([])
    })
  })

  test("the client that opened the session turns it on without a file, and off again: the model is told each time, in a message appended at the next step", () => {
    const { told, sandbox } = standIn()
    return withHarness(sandbox, {}, async (h) => {
      const session = h.create()
      session.setSandboxHome("session")
      h.provider.enqueue([script.text("Done.")])
      session.send("Go.")
      await h.settled()
      // Told when the client says so, and again when the turn starts.
      expect(told.length).toBeGreaterThan(0)
      expect(told.every(([id, on]) => id === session.id && on)).toBe(true)
      expect(notes(h).map((item) => item.data.text)).toEqual([SESSION_HOME_TEXT.used])

      session.setSandboxHome("user")
      failing(h)
      session.send("Make the cache.")
      await h.settled()
      expect(told.at(-1)).toEqual([session.id, false])
      expect(notes(h).map((item) => [item.data.text, item.data.fingerprint === null])).toEqual([
        [SESSION_HOME_TEXT.used, false],
        [SESSION_HOME_TEXT.gone, true],
      ])
      expect(outputs(h).at(-1)).toContain("writes only inside the workspace and the temp directory)")
    })
  })
})
