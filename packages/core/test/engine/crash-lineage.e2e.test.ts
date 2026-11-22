/**
 * Crash recovery with a real process, for forks, replays and spawned work.
 * A child process runs the real assembly with a scripted model and kills
 * itself with SIGKILL at a named point (`fixtures/lineage-child.ts`); this
 * process then opens the same data directory and checks what is there and
 * what recovery makes of it.
 */
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Harness, createHarness } from "../../src/assembly.ts"
import type { EngineSession } from "../../src/engine/engine.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
import type { SessionId } from "../../src/id.ts"
import { FakeProvider, type ScriptedResponse, script } from "../../src/testing/fake-provider.ts"
import { E2E_TIMEOUT_MS, waitFor } from "../../src/testing/wait.ts"
import { expectRebuildEqualsLive } from "../store/consistency.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

const FIXTURE = join(import.meta.dir, "fixtures", "lineage-child.ts")
const directories: string[] = []
const harnesses: Harness[] = []
const children: Bun.Subprocess[] = []
afterAll(async () => {
  for (const harness of harnesses) await harness.close()
  for (const child of children) child.kill("SIGKILL")
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})

const of = <T extends StoredEvent["type"]>(events: readonly StoredEvent[], type: T) => events.filter((item) => item.type === type) as unknown as StoredEvent<T>[]
const types = (events: readonly StoredEvent[]) => events.map((item) => item.type)
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const sh = (cwd: string, command: string) => {
  const done = Bun.spawnSync(["bash", "-c", command], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })
  if (done.exitCode !== 0) throw new Error(`${command}: ${done.stderr.toString()}`)
  return done.stdout.toString()
}

/** Runs the child until it kills itself. */
async function crash(name: string, git = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-lineage-crash-")))
  directories.push(root)
  const workspace = join(root, "workspace")
  const data = join(root, "data")
  mkdirSync(workspace)
  mkdirSync(data)
  writeFileSync(join(workspace, "a.txt"), "alpha\n")
  writeFileSync(join(workspace, "b.txt"), "old\n")
  if (git) sh(workspace, "git init -q -b main && git add -A && git commit -q -m first")
  const child = Bun.spawn([process.execPath, FIXTURE, data, workspace, name], { stdout: "ignore", stderr: "pipe" })
  children.push(child)
  await child.exited
  if (child.signalCode !== "SIGKILL") throw new Error(`the child was not killed in ${name} (exit ${child.exitCode}): ${await new Response(child.stderr).text()}`)
  return { root, data, workspace, parent: readFileSync(join(data, "parent.id"), "utf8") as SessionId }
}

/** The next process on the same data directory. */
function reopen(data: string, responses: readonly ScriptedResponse[] = []) {
  const provider = new FakeProvider([...responses])
  const harness = createHarness({ dataDir: data, provider, log: () => {}, engine: { approval: null, loadConfig: null, discover: () => [] } })
  harnesses.push(harness)
  return { harness, provider }
}

const until = (check: () => boolean) => waitFor(check, { timeoutMs: 15_000 }).then(() => {})

/** Runs the `background` script until the child kills itself, and waits until what it had started is gone too. */
async function crashWithBackgroundWork() {
  const crashed = await crash("background")
  const pids = ["command.pid", "child.pid"].map((name) => Number(readFileSync(join(crashed.workspace, name), "utf8")))
  // The guard of each command killed its process group when the harness died.
  await until(() => pids.every((pid) => !alive(pid)))
  return crashed
}

/** What holds however the session was opened: both are recorded as lost, and the subagent's turn is ended. Returns the subagent's session. */
function expectBothLost(harness: Harness, session: EngineSession): SessionId {
  expect(of(session.readEvents(), "spawn.ended").map((item) => item.data.outcome)).toEqual(["lost", "lost"])
  const child = session.projection().session.spawned!.children[0]!
  const childLog = harness.engine.readEvents(child)
  expect(types(childLog).slice(-3)).toEqual(["execution.resumed", "execution.interrupt_requested", "execution.interrupted"])
  expect(of(childLog, "tool.settled").at(-1)!.data.outcome).toBe("effect_unknown")
  expect(harness.engine.getSession(child)?.session.execution).toBeNull()
  return child
}

/** The harness's messages about lost work, as the model is sent them: the command's and the subagent's. */
const LOST = {
  tag: '<harness origin="spawn_lost">',
  command: /^<harness origin="spawn_lost">\nBackground command bg_\w+ is gone: the harness restarted while it ran/,
  subagent: /^<harness origin="spawn_lost">\nThe subagent did not finish its task\. It was cut off when the harness restarted\./,
}
/** The text of each message in the latest request, in the request's order. */
const said = (provider: FakeProvider) =>
  provider.requests.at(-1)!.input.flatMap((item) => (item.type === "message" ? [item.content.map((part) => (part.type === "text" ? part.text : "")).join("")] : []))

describe("a process that dies", () => {
  test("during a fork: no half-made session is listed, the parent is as it was, and the fork can be made again", async () => {
    const { root, data, parent } = await crash("fork")
    const { harness, provider } = reopen(data, [[script.text("In the fork.")]])
    const engine = harness.engine
    // The copy was made; the session was not. Nothing lists it and nothing refers to it.
    expect(existsSync(join(root, "fork-copy", "b.txt"))).toBe(true)
    expect(engine.listSessions({ includeArchived: true }).map((summary) => summary.session.id)).toEqual([parent])
    expect(readdirSync(join(data, "sessions")).filter((name) => name.endsWith(".db"))).toEqual([`${parent}.db`])
    const before = engine.readEvents(parent)
    const fork = await engine.forkSession(parent, { workspace: { copyTo: join(root, "fork-copy") } })
    fork.send("Go on.")
    await fork.settled()
    expect(engine.readEvents(parent)).toEqual(before)
    expect(fork.projection().session.lineage).toMatchObject({ kind: "fork", parentSessionId: parent, copied: { from: join(root, "workspace") } })
    expect(readFileSync(join(root, "fork-copy", "b.txt"), "utf8")).toBe("new\n")
    expect(provider.requests).toHaveLength(1)
    harness.sessions.read(fork.id, (store) => expectRebuildEqualsLive(store as never, fork.id))
  })

  test("during a replay: the replay session is consistent and ends as incomplete; nothing is taken up, nothing ran", async () => {
    const { data, workspace, parent } = await crash("replay")
    const replayId = readFileSync(join(data, "replay.id"), "utf8") as SessionId
    // The recording wrote b.txt; the replay answered the same call from the recording and wrote nothing.
    writeFileSync(join(workspace, "b.txt"), "by hand\n")
    const { harness, provider } = reopen(data)
    const before = harness.engine.readEvents(replayId)
    expect(of(before, "replay.call").map((item) => item.data.result)).toEqual(["matched", "matched"])
    expect(harness.engine.getSession(replayId)?.session.execution?.status).toBe("running")
    const session = harness.engine.openSession(replayId)
    await session.settled()
    const log = session.readEvents()
    // The step the process died in is closed as crashed, like any; then the replay is given up, not resumed.
    expect(types(log.slice(before.length))).toEqual(["step.failed", "synthetic.appended", "execution.resumed", "execution.failed", "replay.ended"])
    expect(of(log, "execution.failed")[0]!.data.cause).toBe("replay")
    expect(session.projection().session.replay?.ended).toMatchObject({ outcome: "incomplete" })
    expect(session.projection().session.execution).toBeNull()
    expect(provider.requests).toHaveLength(0)
    expect(readFileSync(join(workspace, "b.txt"), "utf8")).toBe("by hand\n")
    harness.sessions.read(replayId, (store) => expectRebuildEqualsLive(store as never, replayId))
    // The recording itself is untouched and can be replayed again.
    expect(harness.engine.getSession(parent)?.session.execution).toBeNull()
  })

  test("with a background command and a background subagent running, opened as a client opens it: both die with it, both are recorded as lost, the subagent's turn is ended, and the model is told with the user's next message", async () => {
    const { data, parent } = await crashWithBackgroundWork()
    const { harness, provider } = reopen(data, [[script.text("Both were lost in the restart.")]])
    expect(harness.engine.getSession(parent)?.session.spawned?.running.map((entry) => entry.kind).sort()).toEqual(["command", "subagent"])
    const before = harness.engine.readEvents(parent).length
    // The parent's turn was cut off too: it had answered and was waiting for its subagent. Opened as the command
    // line and the ACP server open a session, that turn is taken up when the user says something, not before.
    const session = harness.engine.openSession(parent, { resume: "wait" })
    await until(() => session.projection().session.spawned?.running.length === 0)
    const child = expectBothLost(harness, session)
    // Nothing works on the session, so nothing takes the two messages up: they wait, the command's first (it is
    // recorded as the session is opened, the subagent's once its turn was ended).
    expect(types(session.readEvents().slice(before))).toEqual(["execution.resumed", "spawn.ended", "inbox.enqueued", "spawn.ended", "inbox.enqueued"])
    expect(session.projection().inbox.map((item) => item.origin)).toEqual(["spawn_lost", "spawn_lost"])
    expect(provider.requests).toHaveLength(0)
    session.send("What happened?")
    await session.settled()
    // One request tells the model of both, and then what the user said.
    expect(provider.requests).toHaveLength(1)
    expect(said(provider).slice(-3)).toEqual([expect.stringMatching(LOST.command), expect.stringMatching(LOST.subagent), "What happened?"])
    expect(session.projection().inbox).toEqual([])
    expect(types(session.readEvents()).at(-1)).toBe("execution.succeeded")
    harness.sessions.read(parent, (store) => expectRebuildEqualsLive(store as never, parent))
    harness.sessions.read(child, (store) => expectRebuildEqualsLive(store as never, child))
  })

  test("with a background command and a background subagent running, opened to be worked on at once: the turn that was cut off is taken up, and does not end before the model was told of both, once", async () => {
    const { data, parent } = await crashWithBackgroundWork()
    // The message about the command is there when the turn is taken up; the one about the subagent arrives once
    // its turn was ended. Whether that is before the turn's first request is not decided, and need not be: the
    // model is told of both in one request, or of one in each of two, and answers each.
    const answer: ScriptedResponse = [script.text("That work was lost in the restart.")]
    const { harness, provider } = reopen(data, [answer, answer, answer])
    const before = harness.engine.readEvents(parent).length
    // The engine's own default: the turn that was cut off is worked on as the session is opened.
    const session = harness.engine.openSession(parent)
    await session.settled()
    // The turn is over, and the end of both was recorded in it: it did not end while the subagent was still looked at.
    const appended = session.readEvents().slice(before)
    expect([types(appended)[0], types(appended).at(-1)]).toEqual(["execution.resumed", "execution.succeeded"])
    expect(session.projection().session.spawned?.running).toEqual([])
    const child = expectBothLost(harness, session)
    // Each message was delivered once, in this turn, and nothing waits.
    const told = of(appended, "inbox.enqueued")
    expect(told.map((item) => item.data.origin)).toEqual(["spawn_lost", "spawn_lost"])
    expect(of(appended, "inbox.delivered").map((item) => item.data.messageId)).toEqual(told.map((item) => item.data.messageId))
    expect(session.projection().inbox).toEqual([])
    expect(session.projection().session.execution).toBeNull()
    // The model was asked once or twice, and its latest request holds each message once.
    const requests = provider.requests.length
    expect([1, 2]).toContain(requests)
    expect(of(appended, "step.ended")).toHaveLength(requests)
    expect(said(provider).filter((text) => text.startsWith(LOST.tag))).toEqual([expect.stringMatching(LOST.command), expect.stringMatching(LOST.subagent)])
    // The next prompt starts a turn of its own, and tells the model nothing a second time.
    session.send("What happened?")
    await session.settled()
    expect(provider.requests).toHaveLength(requests + 1)
    expect(said(provider).filter((text) => text.startsWith(LOST.tag))).toHaveLength(2)
    expect(said(provider).at(-1)).toBe("What happened?")
    expect(of(session.readEvents().slice(before), "execution.started")).toHaveLength(1)
    expect(types(session.readEvents()).at(-1)).toBe("execution.succeeded")
    harness.sessions.read(parent, (store) => expectRebuildEqualsLive(store as never, parent))
    harness.sessions.read(child, (store) => expectRebuildEqualsLive(store as never, child))
  })

  test("during a worktree merge: the merge is finished at the next start, the files are all there, and the repository is otherwise as the user left it", async () => {
    const { data, workspace, parent } = await crash("merge", true)
    // The first file was written and the process died: the workspace is half merged right now, and the worktree and its branch still exist.
    expect([readFileSync(join(workspace, "a.txt"), "utf8"), readFileSync(join(workspace, "b.txt"), "utf8")]).toEqual(["alpha changed\n", "old\n"])
    expect(sh(workspace, "git worktree list --porcelain | grep -c '^worktree '").trim()).toBe("2")
    const { harness } = reopen(data, [[script.text("The subagent's changes are merged.")], [script.text("Noted.")]])
    const session = harness.engine.openSession(parent)
    await until(() => session.projection().session.spawned?.running.length === 0)
    await session.settled()
    const ended = of(session.readEvents(), "spawn.ended")[0]!
    expect(ended.data).toMatchObject({ outcome: "completed", merge: { status: "merged", files: ["a.txt", "b.txt"], kept: false } })
    expect([readFileSync(join(workspace, "a.txt"), "utf8"), readFileSync(join(workspace, "b.txt"), "utf8")]).toEqual(["alpha changed\n", "new\n"])
    // The worktree and the harness's branch are cleaned up; the user's branch and index never moved.
    expect(sh(workspace, "git worktree list --porcelain | grep -c '^worktree '").trim()).toBe("1")
    expect(sh(workspace, "git branch --list").trim()).toBe("* main")
    expect(sh(workspace, "git diff --cached --name-only").trim()).toBe("")
    expect(sh(workspace, "git status --porcelain | cut -c4- | sort").trim().split("\n")).toEqual(["a.txt", "b.txt"])
    expect(of(session.readEvents(), "inbox.enqueued").at(-1)!.data.origin).toBe("subagent_result")
    expect(types(session.readEvents()).at(-1)).toBe("execution.succeeded")
    harness.sessions.read(parent, (store) => expectRebuildEqualsLive(store as never, parent))
  })
})
