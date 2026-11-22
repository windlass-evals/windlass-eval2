/**
 * Required checks in the step loop (`verify/required.ts`): the checks that
 * whoever starts the harness names, in the user's own configuration file or,
 * as a client does, for one session (`setRequiredChecks`).
 *
 * What is shown here: they run and gate a turn whatever the project's file
 * says about `checks` and `verify`, also when the file is rewritten in the
 * middle of the session; the project's own checks run besides them; under a
 * name both have, the required check runs; a turn keeps the required checks
 * it started under; a subagent's turn runs none and its parent's runs them;
 * where they cannot run at all the turn ends unresolved at once, without the
 * model being sent back; a turn in which one failed ends as done only on a
 * state the check stands on, and says which; and a session without any
 * behaves as it always did. The checks are scripted: real
 * commands, their output in the evidence, the real configuration files and
 * where a required check runs are in
 * `packages/acp/test/required-checks.e2e.test.ts`.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { type CheckConfig, type ConfigFile, mergeConfigFiles, resolveConfig } from "../../src/config/schema.ts"
import type { ApprovalSetup } from "../../src/engine/approval.ts"
import type { EngineEvent } from "../../src/engine/channel.ts"
import type { StoredEvent, VerificationOutcome } from "../../src/event/durable.ts"
import type { SessionId } from "../../src/id.ts"
import type { Json } from "../../src/json.ts"
import type { CommandSandbox } from "../../src/sandbox/command.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { requiredCheckRefOf } from "../../src/verify/required.ts"
import { CHECK_OUTPUT, FakeWorkspace, Harness, type HarnessOptions, START_ERROR, converse, removeHarnessDirectories } from "./harness.ts"

afterAll(removeHarnessDirectories)

const check = (name: string, command: string, extra: Partial<CheckConfig> = {}): CheckConfig => ({ name, command, timeoutSeconds: 120, when: null, ...extra })
const TEST = check("test", "bun test")
const USER: ConfigFile = { requiredChecks: [{ name: "test", command: "bun test" }] }

const call = (name: string, input: Json, callId = "call_1") => [script.toolCall(callId, name, input)]
const write = (path: string, content: string) => call("write", { path, content })
const say = (value: string) => [script.text(value)]
const of = <T extends StoredEvent["type"]>(h: Harness, type: T) => h.log().filter((item) => item.type === type) as unknown as StoredEvent<T>[]
/** The gate outcome of each execution that ended as done, in order. */
const outcomes = (h: Harness): VerificationOutcome[] => of(h, "execution.succeeded").map((item) => item.data.verification)
const reports = (h: Harness) => of(h, "synthetic.appended").filter((item) => item.data.origin === "check_report")
/** The text of a harness message. */
const textOf = (content: StoredEvent<"synthetic.appended">["data"]["content"]) => content.map((part) => (part.type === "text" ? part.text : "")).join("")
const notices = (h: Harness) => h.seenEvents.flatMap((item) => (item.type === "notice" ? [item as Extract<EngineEvent, { type: "notice" }>] : []))
/** What the evidence says of each check, without what varies. */
const said = (outcome: VerificationOutcome | undefined) => {
  if (outcome === undefined || !("evidence" in outcome)) throw new Error("the turn ended without evidence")
  return outcome.evidence.checks.map(({ name, command, status, origin, required }) => ({ name, command, status, origin, required }))
}

/** Puts the two files on the scripted disk as the loader reads them: apart, and merged with the project's on top. */
function disk(h: Harness, user: ConfigFile | null, project: ConfigFile | null) {
  h.files = { user, project }
  h.config = resolveConfig(mergeConfigFiles(user, project))
}

async function withProject(run: (h: Harness) => Promise<void>, files: { readonly user?: ConfigFile | null; readonly project?: ConfigFile | null } = {}, options: HarnessOptions = {}) {
  const user = files.user ?? null
  const project = files.project ?? null
  const h = new Harness({ userConfig: user ?? {}, ...(project === null ? {} : { config: project }), workspace: new FakeWorkspace({ "a.ts": "1\n", "README.md": "hi\n" }), ...options })
  disk(h, user, project)
  // The scripted write tool changes the workspace, like the real one.
  const writes = (input: Record<string, unknown>) => {
    h.workspace?.files.set(String(input.path), String(input.content))
    return `Wrote ${String(input.path)}`
  }
  h.tools.on("write", ...Array.from({ length: 8 }, () => writes))
  try {
    await run(h)
    h.verify()
  } finally {
    await h.dispose()
  }
}

describe("whoever starts the harness names required checks", () => {
  test("a client names them for a session with no file anywhere: they run, and the evidence says whose they are", () =>
    withProject(async (h) => {
      h.provider.enqueue(write("a.ts", "2\n"), say("Done."))
      h.checks.on("test", "passed").on("types", "passed")
      const session = h.create()
      session.setRequiredChecks([TEST, check("types", "tsc", { when: ["**/*.ts"] })])
      session.send("Change a.ts.")
      await h.settled()
      expect(of(h, "checks.started")[0]!.data).toEqual({ run: 1, checks: ["test", "types"] })
      expect(said(outcomes(h)[0])).toEqual([
        { name: "test", command: "bun test", status: "passed", origin: "session", required: true },
        { name: "types", command: "tsc", status: "passed", origin: "session", required: true },
      ])
      expect(outcomes(h)[0]).toMatchObject({ status: "passed", evidence: { changedFiles: ["a.ts"], checks: [{ files: ["a.ts"], outputTail: null }, { files: ["a.ts"], outputTail: null }] } })
      // The model can say that it cannot fix one: the tool is in the list from the first request.
      expect(h.provider.requests[0]!.tools.map((tool) => tool.name)).toContain("report_check_failure")
      expect(notices(h)).toEqual([])
    }))

  test("the user's own file names them, the client adds its own, and a name in both is the client's", () =>
    withProject(
      async (h) => {
        h.provider.enqueue(write("a.ts", "2\n"), say("Done."))
        h.checks.on("test", "passed").on("types", "passed").on("build", "passed")
        const session = h.create()
        session.setRequiredChecks([check("test", "make test"), check("build", "make")])
        session.send("Change a.ts.")
        await h.settled()
        expect(said(outcomes(h)[0])).toEqual([
          { name: "types", command: "tsc", status: "passed", origin: "user", required: true },
          { name: "test", command: "make test", status: "passed", origin: "session", required: true },
          { name: "build", command: "make", status: "passed", origin: "session", required: true },
        ])
      },
      { user: { requiredChecks: [{ name: "test", command: "bun test" }, { name: "types", command: "tsc" }] } },
    ))

  test("a required check applies like any check: only to a turn that changed a file its patterns cover", () =>
    withProject(async (h) => {
      h.provider.enqueue(say("It is 1."), write("README.md", "hello\n"), say("Updated."), write("a.ts", "2\n"), say("Changed."))
      h.checks.on("types", "passed")
      const session = h.create()
      session.setRequiredChecks([check("types", "tsc", { when: ["**/*.ts"] })])
      session.send("What is in a.ts?")
      await h.settled()
      session.send("Update the readme.")
      await h.settled()
      expect(h.checks.ran).toEqual([])
      // Each ending says why no check ran, and names the session's required checks.
      const types = requiredCheckRefOf({ ...check("types", "tsc", { when: ["**/*.ts"] }), under: "" })
      expect(outcomes(h)).toEqual([
        { status: "not_needed", reason: "turn_unchanged", since: { seq: of(h, "snapshot.taken")[0]!.seq, run: null }, requiredChecks: [types] },
        { status: "not_needed", reason: "not_covered", since: { seq: of(h, "execution.succeeded")[0]!.seq, run: null }, requiredChecks: [types] },
      ])
      session.send("Change a.ts.")
      await h.settled()
      expect(h.checks.ran).toEqual(["types"])
      expect(outcomes(h)[2]).toMatchObject({ status: "passed", evidence: { changedFiles: ["a.ts"] } })
    }))
})

describe("what a project's file cannot do to them", () => {
  test("its own checks run besides them, each reported as whose it is", () =>
    withProject(
      async (h) => {
        h.provider.enqueue(write("a.ts", "2\n"), say("Done."))
        h.checks.on("test", "passed").on("lint", "passed")
        h.create().send("Change a.ts.")
        await h.settled()
        expect(h.checks.ran).toEqual(["test", "lint"])
        expect(said(outcomes(h)[0])).toEqual([
          { name: "test", command: "bun test", status: "passed", origin: "user", required: true },
          { name: "lint", command: "bun lint", status: "passed", origin: "project", required: false },
        ])
      },
      // The user's plain list is replaced by the project's, as ever; the required one is not.
      { user: { ...USER, checks: [{ name: "style", command: "bun style" }] }, project: { checks: [{ name: "lint", command: "bun lint" }] } },
    ))

  test("an empty list and verify off there run nothing of the project's, and the required checks still gate the turn", () =>
    withProject(
      async (h) => {
        h.provider.enqueue(write("a.ts", "2\n"), say("Done."), write("a.ts", "3\n"), say("Fixed."))
        h.checks.on("test", "failed", "passed")
        h.create().send("Change a.ts.")
        await h.settled()
        expect(h.checks.ran).toEqual(["test", "test"])
        // The model was sent back with the report, which says that the check is not the project's to switch off.
        expect(reports(h)).toHaveLength(1)
        expect(JSON.stringify(reports(h)[0]!.data.content)).toContain("This session requires test: no file of the project replaces a required check or switches it off.")
        const runs = of(h, "checks.finished").map((item) => item.data.evidence)
        expect(runs.map((evidence) => evidence.run)).toEqual([1, 2])
        // The failing run carries the end of what the check printed; the passing one nothing.
        expect(runs[0]!.checks).toMatchObject([{ name: "test", status: "failed", origin: "user", required: true, outputTail: { text: CHECK_OUTPUT, truncated: false } }])
        expect(runs[1]!.checks).toMatchObject([{ name: "test", status: "passed", origin: "user", required: true, outputTail: null }])
        expect(outcomes(h)).toMatchObject([{ status: "passed", evidence: { run: 2 } }])
        // The acknowledgement tool is offered although the project's file says off.
        expect(h.provider.requests[0]!.tools.map((tool) => tool.name)).toContain("report_check_failure")
      },
      { user: { ...USER, checks: [{ name: "style", command: "bun style" }] }, project: { checks: [], verify: { mode: "off" } } },
    ))

  test("the file rewritten in the middle of the session changes nothing for them, in that turn or the next", () =>
    withProject(
      async (h) => {
        h.provider.enqueue(
          () => {
            // The agent's own edit of the project's file, while the first turn runs.
            disk(h, USER, { checks: [], verify: { mode: "off" }, requiredChecks: [] })
            return write("a.ts", "2\n")
          },
          say("Done."),
          write("a.ts", "3\n"),
          say("Done again."),
        )
        h.checks.on("test", "passed", "passed").on("lint", "passed")
        h.create().send("Change a.ts.")
        await h.settled()
        // The turn in progress runs under what it read when it started: the project's check too.
        expect(h.checks.ran).toEqual(["test", "lint"])
        h.session.send("Again.")
        await h.settled()
        // The next turn reads the file again: the project's check is gone, as the file says, and the required one is not.
        expect(h.checks.ran).toEqual(["test", "lint", "test"])
        expect(said(outcomes(h)[1])).toEqual([{ name: "test", command: "bun test", status: "passed", origin: "user", required: true }])
      },
      { user: USER, project: { checks: [{ name: "lint", command: "bun lint" }] } },
    ))

  test("a check there with a required check's name is not run: under that name the required check is, and the user is told", () =>
    withProject(
      async (h) => {
        h.provider.enqueue(write("a.ts", "2\n"), say("Done."))
        const commands: string[] = []
        h.checks.on("test", (config) => {
          commands.push(config.command)
          return "passed"
        })
        h.checks.on("lint", "passed")
        h.create().send("Change a.ts.")
        await h.settled()
        expect(commands).toEqual(["bun test"])
        expect(said(outcomes(h)[0])).toEqual([
          { name: "test", command: "bun test", status: "passed", origin: "user", required: true },
          { name: "lint", command: "bun lint", status: "passed", origin: "project", required: false },
        ])
        expect(notices(h).map(({ kind, message }) => ({ kind, message }))).toEqual([
          { kind: "approval_ignored", message: "The project's configuration names a check with the name of a required check and was not followed: test. Under that name the required check runs." },
        ])
      },
      { user: USER, project: { checks: [{ name: "test", command: "true" }, { name: "lint", command: "bun lint" }] } },
    ))

  test("requiredChecks there names nothing: the key is not followed, and the user is told once", () =>
    withProject(
      async (h) => {
        h.provider.enqueue(write("a.ts", "2\n"), say("Done."), write("a.ts", "3\n"), say("Done again."))
        h.create().send("Change a.ts.")
        await h.settled()
        h.session.send("Again.")
        await h.settled()
        expect(h.checks.ran).toEqual([])
        expect(outcomes(h)).toEqual([{ status: "not_configured" }, { status: "not_configured" }])
        expect(notices(h).map(({ kind, message }) => ({ kind, message }))).toEqual([
          {
            kind: "approval_ignored",
            message:
              "The project's configuration names required checks and was not followed: requiredChecks (fake). Only your own configuration file, or the program that opens the session for you, names checks that a project cannot change.",
          },
        ])
      },
      { project: { requiredChecks: [{ name: "fake", command: "true" }] } },
    ))

  test("its maxRounds is not theirs: a failing required check sends the model back as often as the user's own file says", () =>
    withProject(
      async (h) => {
        h.provider.enqueue(write("a.ts", "2\n"), say("Done."), write("a.ts", "3\n"), say("Done."), write("a.ts", "4\n"), say("Done."))
        h.checks.on("test", "failed", "failed", "failed").on("lint", "passed", "passed", "passed")
        h.create().send("Change a.ts.")
        await h.settled()
        expect(reports(h)).toHaveLength(3)
        expect(outcomes(h)).toMatchObject([{ status: "unresolved", reason: "max_rounds", failing: ["test"], evidence: { run: 3 } }])
      },
      { user: { ...USER, verify: { maxRounds: 2 } }, project: { checks: [{ name: "lint", command: "bun lint" }], verify: { maxRounds: 1 } } },
    ))

  test("report mode there records a failure of its own check without sending the model back, and a failing required check still does", () =>
    withProject(
      async (h) => {
        h.provider.enqueue(write("a.ts", "2\n"), say("Done."), write("a.ts", "3\n"), say("Fixed."))
        h.checks.on("test", "failed", "passed").on("lint", "failed", "failed")
        h.create().send("Change a.ts.")
        await h.settled()
        // Sent back once, for the required check; the project's own failure alone ends the turn as its mode says.
        expect(reports(h)).toHaveLength(2)
        expect(outcomes(h)).toMatchObject([{ status: "unresolved", reason: "report_mode", failing: ["lint"], evidence: { run: 2 } }])
      },
      { user: USER, project: { checks: [{ name: "lint", command: "bun lint" }], verify: { mode: "report" } } },
    ))
})

describe("for how long they hold", () => {
  test("a turn keeps the checks it started under; what a client names in the middle of one applies from the next", () =>
    withProject(async (h) => {
      h.provider.enqueue(
        () => {
          h.session.setRequiredChecks([check("build", "make")])
          return write("a.ts", "2\n")
        },
        say("Done."),
        write("a.ts", "3\n"),
        say("Done again."),
        write("a.ts", "4\n"),
        say("And again."),
      )
      h.checks.on("test", "passed").on("build", "passed")
      const session = h.create()
      session.setRequiredChecks([TEST])
      session.send("Change a.ts.")
      await h.settled()
      expect(h.checks.ran).toEqual(["test"])
      session.send("Again.")
      await h.settled()
      expect(h.checks.ran).toEqual(["test", "build"])
      // An empty list takes them back; with none named and no file, nothing is configured.
      session.setRequiredChecks([])
      session.send("Once more.")
      await h.settled()
      expect(h.checks.ran).toEqual(["test", "build"])
      expect(outcomes(h).map((outcome) => outcome.status)).toEqual(["passed", "passed", "not_configured"])
    }))

  test("they are not stored with the session: after a restart the user's file's are there, and the client's once it names them again", () =>
    withProject(
      async (h) => {
        h.provider.enqueue(write("a.ts", "2\n"), say("Done."), write("a.ts", "3\n"), say("Done again."), write("a.ts", "4\n"), say("And again."))
        h.checks.on("test", "passed", "passed", "passed").on("build", "passed", "passed")
        h.create().setRequiredChecks([check("build", "make")])
        h.session.send("Change a.ts.")
        await h.settled()
        expect(h.checks.ran).toEqual(["test", "build"])
        await h.engine.close()
        h.kill()
        const reopened = h.restart()
        reopened.send("Again.")
        await h.settled()
        expect(h.checks.ran).toEqual(["test", "build", "test"])
        reopened.setRequiredChecks([check("build", "make")])
        reopened.send("Once more.")
        await h.settled()
        expect(h.checks.ran).toEqual(["test", "build", "test", "test", "build"])
      },
      { user: USER },
    ))

  test("a fork is a session of its own: the user's file's checks are its checks, and the client's when it is opened with them", () =>
    withProject(
      async (h) => {
        h.provider.enqueue(write("a.ts", "2\n"), say("Done."), write("a.ts", "3\n"), say("Done in the fork."))
        h.checks.on("test", "passed", "passed").on("build", "passed", "passed")
        h.create().setRequiredChecks([check("build", "make")])
        h.session.send("Change a.ts.")
        await h.settled()
        const fork = await h.engine.forkSession(h.session.id)
        fork.setRequiredChecks([check("build", "make")])
        fork.send("Change it again.")
        await fork.settled()
        expect(h.checks.ran).toEqual(["test", "build", "test", "build"])
        const ending = h.store.readEvents(fork.id).findLast((item) => item.type === "execution.succeeded") as StoredEvent<"execution.succeeded">
        expect(said(ending.data.verification)).toEqual([
          { name: "test", command: "bun test", status: "passed", origin: "user", required: true },
          { name: "build", command: "make", status: "passed", origin: "session", required: true },
        ])
      },
      { user: USER },
    ))

  test("a subagent's turn runs none of them and says its work is left to its parent, whose turn runs them once the work is in", async () => {
    const workspace = new FakeWorkspace({ "a.ts": "1\n" })
    const h = new Harness({ spawn: {}, userConfig: USER, workspace })
    disk(h, USER, null)
    try {
      const scripted = converse(h.provider, {
        "Fix a": [[script.toolCall("call_1", "subagent", { task: "Fix module a" })], [script.text("Fixed by the subagent.")]],
        "Fix module a": [[script.toolCall("call_1", "write", { path: "a.ts", content: "2\n" })], [script.text("a.ts is fixed.")]],
      })
      h.tools.on("write", () => {
        workspace.files.set("a.ts", "2\n")
        return "written"
      })
      h.checks.on("test", "passed").on("build", "passed")
      h.create().setRequiredChecks([check("build", "make")])
      h.session.send("Fix a.ts with a subagent.")
      await h.settled()
      expect(scripted.unused()).toBe(0)
      const work = of(h, "spawn.started")[0]!.data.work
      if (work.kind !== "subagent") throw new Error("the parent started no subagent")
      const child = h.store.readEvents(work.sessionId as SessionId)
      expect(child.filter((item) => item.type === "checks.started")).toEqual([])
      expect((child.find((item) => item.type === "execution.succeeded") as StoredEvent<"execution.succeeded">).data.verification).toEqual({ status: "left_to_parent" })
      // The subagent is not offered the acknowledgement tool: it has no check to report on.
      expect(h.checks.ran).toEqual(["test", "build"])
      expect(said(outcomes(h)[0])).toEqual([
        { name: "test", command: "bun test", status: "passed", origin: "user", required: true },
        { name: "build", command: "make", status: "passed", origin: "session", required: true },
      ])
    } finally {
      await h.dispose()
    }
  })
})

describe("where they cannot run", () => {
  const unavailable: CommandSandbox = {
    state: { available: false, reason: "bubblewrap (bwrap) is not installed.", remedy: null },
    temp: (sessionId) => ({ dir: `/sandbox-tmp/${sessionId}`, alias: "/tmp" }),
    plan: () => {
      throw new Error("there is no sandbox to plan for")
    },
    policy: () => {
      throw new Error("there is no sandbox to plan for")
    },
  }
  const setup = (mode: "auto" | "full"): ApprovalSetup => ({ sandbox: unavailable, secrets: [], home: "/Users/user", user: { mode } })

  test("with commands sandboxed and no sandbox, a required check is recorded as not started and the turn does not end as done; the project's own is not run, as before", () =>
    withProject(
      async (h) => {
        h.provider.enqueue(write("a.ts", "2\n"), say("Done."))
        h.create().send("Change a.ts.")
        await h.settled()
        expect(h.checks.ran).toEqual([])
        expect(of(h, "checks.started")).toHaveLength(1)
        expect(of(h, "checks.started")[0]!.data).toEqual({ run: 1, checks: ["test"] })
        const reason = "the checks run only in the sandbox in this mode, and the sandbox is unavailable (bubblewrap (bwrap) is not installed.)"
        expect(outcomes(h)).toMatchObject([
          {
            status: "unresolved",
            reason: "not_started",
            failing: ["test"],
            acknowledgement: null,
            evidence: { run: 1, checks: [{ name: "test", status: "could_not_start", exitCode: null, origin: "user", required: true, startError: reason, outputPath: null }] },
          },
        ])
        // The model was not sent back: it answered once after its call, and nothing it could change starts a check.
        expect(h.provider.requests).toHaveLength(2)
        // What it is told, for whoever continues: why the check did not start, that this says nothing about the code,
        // and nothing about fixing the code or reporting a failure.
        expect(reports(h)).toHaveLength(1)
        const told = textOf(reports(h)[0]!.data.content)
        expect(told).toBe(
          `Checks run by the harness after your changes: 1 could not start.\n\ncould not start: test (bun test): ${reason}\n\nThis check was not started, so it says nothing about your changes, and no change to the code makes it start. Nothing is asked of you: the turn ends with it recorded as not started, and the reason above goes to the user.\nThis session requires test: no file of the project replaces a required check or switches it off.\n`,
        )
        expect(told).not.toContain("Fix the code")
        expect(notices(h).filter((item) => item.kind === "checks_not_run").map((item) => item.message)).toEqual([
          "The checks were not run: they run only in the sandbox in this mode, and the sandbox is unavailable (bubblewrap (bwrap) is not installed.). Mode full runs them without it. The required checks (test) are recorded as not started, so a turn that changed what they cover does not end as done.",
        ])
      },
      { user: USER, project: { checks: [{ name: "lint", command: "bun lint" }] } },
      { approval: setup("auto") },
    ))

  test("a project's stricter approval mode on such a machine cannot make the turn end as done either", () =>
    withProject(
      async (h) => {
        h.provider.enqueue(write("a.ts", "2\n"), say("Done."))
        h.create().send("Change a.ts.")
        await h.settled()
        expect(outcomes(h)).toMatchObject([{ status: "unresolved", reason: "not_started", failing: ["test"], evidence: { checks: [{ status: "could_not_start", required: true }] } }])
      },
      // The user chose `full`, where checks run without a sandbox; the project's file tightens the mode.
      { user: USER, project: { approval: { mode: "auto" } } },
      { approval: setup("full"), attended: true },
    ))

  test("in mode full they run without it", () =>
    withProject(
      async (h) => {
        h.provider.enqueue(write("a.ts", "2\n"), say("Done."))
        h.checks.on("test", "passed")
        h.create().send("Change a.ts.")
        await h.settled()
        expect(outcomes(h)).toMatchObject([{ status: "passed" }])
      },
      { user: USER },
      { approval: setup("full") },
    ))
})

describe("a check that was never started", () => {
  test("a plain check too: the turn ends unresolved at once, in any mode, and the model is not sent back", async () => {
    for (const mode of ["gate", "report"] as const)
      await withProject(
        async (h) => {
          h.provider.enqueue(write("a.ts", "2\n"), say("Done."))
          h.checks.on("lint", "could_not_start")
          h.create().send("Change a.ts.")
          await h.settled()
          expect(outcomes(h)).toMatchObject([{ status: "unresolved", reason: "not_started", failing: ["lint"], evidence: { checks: [{ name: "lint", status: "could_not_start", exitCode: null, required: false, startError: START_ERROR }] } }])
          expect(h.provider.requests).toHaveLength(2)
          expect(textOf(reports(h)[0]!.data.content)).toBe(
            `Checks run by the harness after your changes: 1 could not start.\n\ncould not start: lint (bun lint): ${START_ERROR}\n\nThis check was not started, so it says nothing about your changes, and no change to the code makes it start. Nothing is asked of you: the turn ends with it recorded as not started, and the reason above goes to the user.\n`,
          )
        },
        { project: { checks: [{ name: "lint", command: "bun lint" }], verify: { mode } } },
      )
  })

  test("beside one that failed on the code: the model is sent back for the one that failed, told to leave the other, and the turn ends on the other once the first passes", () =>
    withProject(
      async (h) => {
        h.provider.enqueue(write("a.ts", "2\n"), say("Done."), write("a.ts", "3\n"), say("Fixed."))
        h.checks.on("test", "failed", "passed").on("lint", "could_not_start", "could_not_start")
        h.create().send("Change a.ts.")
        await h.settled()
        expect(h.checks.ran).toEqual(["test", "lint", "test", "lint"])
        // Sent back once, for the check that ran and failed; the other is named apart.
        expect(reports(h)).toHaveLength(2)
        const first = textOf(reports(h)[0]!.data.content)
        expect(first).toContain("Fix the code so that test passes, or, if you cannot, call report_check_failure with its name and the reason.")
        expect(first).toContain("lint was not started, so it says nothing about your changes, and no change to the code makes it start: leave it, and do not name it to report_check_failure.")
        expect(first).toContain(`could not start: lint (bun lint): ${START_ERROR}`)
        // With `test` passing, every check that did not pass is one that was not started: the turn ends there.
        expect(outcomes(h)).toMatchObject([{ status: "unresolved", reason: "not_started", failing: ["lint"], evidence: { run: 2, checks: [{ name: "test", status: "passed" }, { name: "lint", status: "could_not_start" }] } }])
        expect(textOf(reports(h)[1]!.data.content)).not.toContain("Fix the code")
      },
      { user: USER, project: { checks: [{ name: "lint", command: "bun lint" }] } },
    ))

  test("beside one that failed on the code: the model acknowledges by naming the one that failed, and the ending names both", () =>
    withProject(
      async (h) => {
        h.provider.enqueue(write("a.ts", "2\n"), say("Done."), call("report_check_failure", { checks: ["test"], reason: "The test is wrong." }, "call_2"), say("It cannot pass."))
        h.checks.on("test", "failed").on("lint", "could_not_start")
        h.create().send("Change a.ts.")
        await h.settled()
        expect(outcomes(h)).toMatchObject([{ status: "unresolved", reason: "acknowledged", failing: ["test", "lint"], acknowledgement: { checks: ["test"] } }])
      },
      { user: USER, project: { checks: [{ name: "lint", command: "bun lint" }] } },
    ))
})

describe("a turn that ends as done after a required check failed in it", () => {
  const ref = (item: CheckConfig) => requiredCheckRefOf({ ...item, under: "" })
  const finished = (h: Harness) => of(h, "checks.finished")

  test("the model put the files back as they were when the check passed in an earlier turn: no run is needed, and the ending says which state and which run", () =>
    withProject(
      async (h) => {
        h.provider.enqueue(write("a.ts", "2\n"), say("Done."), write("a.ts", "broken\n"), say("Faster."), write("a.ts", "2\n"), say("Put back."))
        h.checks.on("test", "passed", "failed")
        h.create().send("Change a.ts.")
        await h.settled()
        expect(outcomes(h)[0]).toMatchObject({ status: "passed", evidence: { run: 1, requiredChecks: [ref(TEST)], since: { seq: of(h, "snapshot.taken")[0]!.seq, run: null } } })
        h.session.send("Speed it up.")
        await h.settled()
        // The check ran once in the second turn and failed; then the workspace was the first turn's again.
        expect(h.checks.ran).toEqual(["test", "test"])
        expect(reports(h)).toHaveLength(1)
        const passed = finished(h)[0]!
        expect(outcomes(h)[1]).toEqual({ status: "not_needed", reason: "state_unchanged", since: { seq: passed.seq, run: { seq: passed.seq, run: 1 } }, requiredChecks: [ref(TEST)] })
        // The last run on record is the failed one, and the ending is what says why it does not stand.
        expect(finished(h).at(-1)!.data.evidence.checks[0]).toMatchObject({ name: "test", status: "failed", required: true })
      },
      { user: USER },
    ))

  test("in a session's first turn the state it goes back to is the one the session started from, which no run has passed on, and the ending says so", () =>
    withProject(
      async (h) => {
        h.provider.enqueue(write("a.ts", "broken\n"), say("Done."), write("a.ts", "1\n"), say("Put back."))
        h.checks.on("test", "failed")
        h.create().send("Change a.ts.")
        await h.settled()
        expect(h.checks.ran).toEqual(["test"])
        expect(outcomes(h)).toEqual([{ status: "not_needed", reason: "state_unchanged", since: { seq: of(h, "snapshot.taken")[0]!.seq, run: null }, requiredChecks: [ref(TEST)] }])
      },
      { user: USER },
    ))

  test("a check that passed under another command does not stand: named again with a new command, it is run on the state the files went back to", () =>
    withProject(async (h) => {
      h.provider.enqueue(write("a.ts", "2\n"), say("Done."), write("a.ts", "broken\n"), say("Faster."), write("a.ts", "2\n"), say("Put back."))
      h.checks.on("test", "passed", "failed", "passed")
      const session = h.create()
      session.setRequiredChecks([TEST])
      session.send("Change a.ts.")
      await h.settled()
      // The client opens the session again and names the check with another command.
      const renamed = check("test", "make test")
      session.setRequiredChecks([renamed])
      session.send("Speed it up.")
      await h.settled()
      // The workspace is what `bun test` passed on. `make test` never ran on it, so it runs: three runs, not two.
      expect(h.checks.ran).toEqual(["test", "test", "test"])
      expect(outcomes(h)[1]).toMatchObject({ status: "passed", evidence: { run: 2, changedFiles: [], checks: [{ name: "test", command: "make test", status: "passed", files: [] }], requiredChecks: [ref(renamed)] } })
      // From that run on it stands: the same thing again needs no run.
      h.provider.enqueue(write("a.ts", "broken\n"), say("Faster."), write("a.ts", "2\n"), say("Put back."))
      h.checks.on("test", "failed")
      session.send("Try again.")
      await h.settled()
      expect(h.checks.ran).toEqual(["test", "test", "test", "test"])
      const stood = finished(h).findLast((item) => item.data.evidence.checks.every((result) => result.status === "passed"))!
      expect(outcomes(h)[2]).toEqual({ status: "not_needed", reason: "state_unchanged", since: { seq: stood.seq, run: { seq: stood.seq, run: 2 } }, requiredChecks: [ref(renamed)] })
    }))

  test("a required check named later does not stand on what was verified without it: it runs with the next turn that changes a file, whatever the file, and not for a turn that changes none", () =>
    withProject(async (h) => {
      const types = check("types", "tsc", { when: ["**/*.ts"] })
      const build = check("build", "make", { when: ["src/**"] })
      h.provider.enqueue(write("a.ts", "2\n"), say("Done."), say("It is 2."), write("README.md", "hello\n"), say("Updated."), write("README.md", "hello again\n"), say("Updated again."))
      h.checks.on("types", "passed").on("build", "passed")
      const session = h.create()
      session.setRequiredChecks([types])
      session.send("Change a.ts.")
      await h.settled()
      expect(h.checks.ran).toEqual(["types"])
      session.setRequiredChecks([types, build])
      // A question changes no file: nothing runs, and the ending does not make `build` stand.
      session.send("What is in a.ts?")
      await h.settled()
      expect(h.checks.ran).toEqual(["types"])
      // The ending names the required check that stands on the state it leaves, not the one named since.
      const first = finished(h)[0]!
      expect(outcomes(h)[1]).toEqual({ status: "not_needed", reason: "turn_unchanged", since: { seq: first.seq, run: { seq: first.seq, run: 1 } }, requiredChecks: [ref(types)] })
      expect(h.session.projection().session.verification.verified?.requiredChecks).toEqual([ref(types)])
      // A file neither check covers: `types` stands and is not run, `build` does not and is.
      session.send("Update the readme.")
      await h.settled()
      expect(h.checks.ran).toEqual(["types", "build"])
      expect(outcomes(h)[2]).toMatchObject({ status: "passed", evidence: { changedFiles: ["README.md"], checks: [{ name: "build", status: "passed", files: [] }] } })
      expect(h.session.projection().session.verification.verified?.requiredChecks).toEqual([ref(types), ref(build)])
      // Now both stand, and such a change needs no check.
      session.send("Update it again.")
      await h.settled()
      expect(h.checks.ran).toEqual(["types", "build"])
      expect(outcomes(h)[3]).toMatchObject({ status: "not_needed", reason: "not_covered" })
    }))
})

describe("a session without any", () => {
  test("is verified as it always was: a project's list replaces the user's, off runs nothing, and the evidence says whose each check is", () =>
    withProject(
      async (h) => {
        h.provider.enqueue(write("a.ts", "2\n"), say("Done."), write("a.ts", "3\n"), say("Done again."), write("a.ts", "4\n"), say("And again."))
        h.checks.on("lint", "passed").on("style", "passed")
        h.create().send("Change a.ts.")
        await h.settled()
        expect(h.checks.ran).toEqual(["lint"])
        expect(said(outcomes(h)[0])).toEqual([{ name: "lint", command: "bun lint", status: "passed", origin: "project", required: false }])

        // Without the project's list the user's own applies, and is reported as the user's.
        disk(h, { checks: [{ name: "style", command: "bun style" }] }, null)
        h.session.send("Again.")
        await h.settled()
        expect(h.checks.ran).toEqual(["lint", "style"])
        expect(said(outcomes(h)[1])).toEqual([{ name: "style", command: "bun style", status: "passed", origin: "user", required: false }])

        // The project's file switches verification off: nothing runs.
        disk(h, { checks: [{ name: "style", command: "bun style" }] }, { verify: { mode: "off" } })
        h.session.send("Once more.")
        await h.settled()
        expect(h.checks.ran).toEqual(["lint", "style"])
        expect(outcomes(h)[2]).toEqual({ status: "not_configured" })
        expect(notices(h)).toEqual([])
      },
      { user: { checks: [{ name: "style", command: "bun style" }] }, project: { checks: [{ name: "lint", command: "bun lint" }] } },
    ))
})
