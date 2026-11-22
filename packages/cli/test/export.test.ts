import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type SessionId, brand, event, openSessionDirectory } from "@windlass/core"
import {
  Driver, SCRIPTS, baselineSet, created, deliver, enqueue, exchange, executionStarted, executionSucceeded, forked,
  stepEnded, stepStarted, textEnded,
} from "../../core/test/store/scripted.ts"
import { runCli } from "./helpers.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function paths() {
  const root = mkdtempSync(join(tmpdir(), "session-export-"))
  roots.push(root)
  return { env: { XDG_DATA_HOME: root }, dataDir: join(root, brand.directory) }
}

function markdown(...messages: readonly [speaker: "User" | "Assistant", text: string][]): string {
  return messages.map(([speaker, text]) => `## ${speaker}\n\n${text}\n`).join("\n")
}

test("exports text in order beside an open writer, with no tools, reasoning, or attachments", async () => {
  const { env, dataDir } = paths()
  const directory = openSessionDirectory({ dataDir })
  const id = "ses_sample_tools" as SessionId
  const store = directory.create(id)
  try {
    SCRIPTS.tools!(store, "ses_sample")
    const d = new Driver(store, id)
    const prompt = "**Use this snippet:**\n\n```ts\n  const n = 42\n```"
    d.add(enqueue("u2", prompt), executionStarted("exe_2"), deliver("u2"), stepStarted("a4"))
    d.add(textEnded("a4", "I can use it."), textEnded("a4", "- First\n- Second"), stepEnded("a4"), executionSucceeded("exe_2"))
    // A queued draft isn't part of the conversation yet.
    d.add(enqueue("waiting", "Not yet delivered.", "queue"))
    const seq = d.lastSeq
    const legacy = join(dataDir, "sessions.db")
    writeFileSync(legacy, "not a session database") // a normal directory open would move this aside
    expect(await runCli(["export", "ses_sample"], { env })).toEqual({
      code: 0, err: "", out: markdown(
        ["User", "Why does this page look broken?"],
        ["Assistant", "Let me read the two files."],
        ["Assistant", "The flex rule hides the header."],
        ["User", prompt],
        ["Assistant", "I can use it.\n\n- First\n- Second"],
      ),
    })
    expect(existsSync(legacy)).toBe(true)
    expect(d.lastSeq).toBe(seq)
  } finally {
    directory.close()
  }
})

test("exports older compacted messages and a slash invocation, but not checkpoint text or undone turns", async () => {
  const { env, dataDir } = paths()
  const directory = openSessionDirectory({ dataDir })
  const id = "ses_sample_compaction" as SessionId
  const store = directory.create(id)
  try {
    SCRIPTS.compaction!(store, "ses_sample")
    const d = new Driver(store, id)
    exchange(d, "4", "Undo this question.", "Undo this answer too.")
    d.add(event("history.reverted", { fromSeq: d.seqOf("u4"), restore: null }))
    const queued = enqueue("u5", "The model's expanded prompt.")
    d.batch(queued, event("command.expanded", {
      messageId: queued.data.messageId, name: "review", arguments: "the tests", path: "/work/review.md",
      scope: "project", fingerprint: "test", missing: [], unused: [], unsupported: [],
    }))
    d.add(executionStarted("exe_5"), deliver("u5"), stepStarted("a5"), textEnded("a5", "Reviewed."), stepEnded("a5"), executionSucceeded("exe_5"))
    expect(await runCli(["export", id], { env })).toEqual({
      code: 0, err: "", out: markdown(
        ["User", "Fix the typo in README.md."], ["Assistant", "Fixed."],
        ["User", "Now run the tests."], ["Assistant", "All 40 tests pass."],
        ["User", "Add a CHANGELOG entry."], ["Assistant", "Added."],
        ["User", "/review the tests"], ["Assistant", "Reviewed."],
      ),
    })
  } finally {
    directory.close()
  }
})

test("a fork exports inherited messages even without the parent's database", async () => {
  const { env, dataDir } = paths()
  const directory = openSessionDirectory({ dataDir })
  const parent = "ses_parent" as SessionId
  const child = "ses_child" as SessionId
  try {
    const from = new Driver(directory.create(parent), parent)
    from.add(created(), baselineSet())
    exchange(from, "1", "First question.", "First answer.")
    const point = from.lastSeq
    exchange(from, "2", "Only on the parent.", "Not inherited.")
    const fork = new Driver(directory.create(child), child)
    fork.add(forked(parent, point))
    exchange(fork, "3", "On the fork.", "Fork answer.")
    from.store.close()
    unlinkSync(directory.pathOf(parent))
    expect(await runCli(["export", child], { env })).toEqual({
      code: 0, err: "", out: markdown(
        ["User", "First question."], ["Assistant", "First answer."],
        ["User", "On the fork."], ["Assistant", "Fork answer."],
      ),
    })
  } finally {
    directory.close()
  }
})

test("help, usage errors, missing and ambiguous IDs do not start the engine", async () => {
  const { env, dataDir } = paths()
  const io = { env, engine: () => { throw new Error("export should not start the engine") } }
  const help = await runCli(["export", "--help"], io)
  expect(help.code).toBe(0)
  expect(help.out).toStartWith(`Usage: ${brand.binary} export <session-id>`)
  for (const args of [[], ["a", "b"], ["--json"], [""]]) {
    expect(await runCli(["export", ...args], io)).toMatchObject({ code: 2, out: "", err: expect.stringContaining("export --help") })
  }
  expect(await runCli(["export", "ses_missing"], io)).toEqual({ code: 2, out: "", err: `${brand.binary}: there is no session ses_missing\n` })
  expect(existsSync(dataDir)).toBe(false)

  const directory = openSessionDirectory({ dataDir })
  try {
    for (const id of ["ses_empty", "ses_empty_other"] as SessionId[]) directory.create(id).append(id, [created()])
    expect(await runCli(["export", "ses_emp"], io)).toMatchObject({ code: 2, out: "", err: expect.stringContaining("2 sessions start with ses_emp") })
    expect(await runCli(["export", "ses_empty"], io)).toEqual({ code: 0, out: "", err: "" })
  } finally {
    directory.close()
  }
})
