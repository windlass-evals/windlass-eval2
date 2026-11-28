import { afterAll, describe, expect, mock, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ReplayResult } from "@windlass/acp/extensions"
import { brand } from "@windlass/core"
import { EngineUnavailable, type Engine, type ForkOutcome } from "../src/engine.ts"
import { forkUsage, parseSubcommand, replayUsage, runFork, runReplay, type ForkOptions, type ReplayOptions, type SubcommandIo } from "../src/subcommands.ts"

const root = mkdtempSync(join(tmpdir(), "cli-subcommands-edge-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function forkOptions(args: string[] = []): ForkOptions {
  const parsed = parseSubcommand(["fork", ...args])
  if (parsed.kind !== "fork") throw new Error(JSON.stringify(parsed))
  return parsed.options
}

function replayOptions(args: string[] = []): ReplayOptions {
  const parsed = parseSubcommand(["replay", ...args])
  if (parsed.kind !== "replay") throw new Error(JSON.stringify(parsed))
  return parsed.options
}

function capture() {
  let out = ""
  let err = ""
  let interrupt: (() => void) | undefined
  const off = mock(() => {})
  const onSignal = mock((_signal: "SIGINT" | "SIGTERM", handler: () => void) => {
    interrupt = handler
    return off
  })
  const io: SubcommandIo = { cwd: "/io-cwd", stdout: { write: (text) => { out += text } }, stderr: { write: (text) => { err += text } }, onSignal }
  return { io, off, onSignal, interrupt: () => interrupt?.(), get out() { return out }, get err() { return err } }
}

function engine(methods: Partial<Engine> = {}): Engine {
  return { open: async () => { throw new Error("subcommands must not open a session") }, ...methods }
}

const forked: ForkOutcome = { named: "ses_named", sessionId: "ses_child", parentSessionId: "ses_parent", throughSeq: 12, cwd: "/work", copiedFrom: null, title: null, model: "test-model", effort: null }
const result: ReplayResult = { sourceSessionId: "ses_source", sessionId: "ses_replay", policy: "stop", workspace: null, requests: 1, usage: null, report: { status: "identical", reason: "same" }, text: "Report", compared: null, comparison: null }

describe("subcommand parsing edges", () => {
  test("missing and unknown subcommands are errors", () => {
    expect(parseSubcommand([])).toEqual({ kind: "error", message: "unknown subcommand undefined" })
    expect(parseSubcommand(["other"])).toEqual({ kind: "error", message: "unknown subcommand other" })
  })

  for (const command of ["fork", "replay"]) {
    test(`${command}: help precedes semantic validation, but not malformed flags`, () => {
      expect(parseSubcommand([command, "a", "b", "--through", "bad", "-h"])).toEqual({ kind: "help", text: command === "fork" ? forkUsage() : replayUsage() })
      expect(parseSubcommand([command, "--help", "--not-an-option"])).toHaveProperty("kind", "error")
      expect(parseSubcommand([command, "--model"])).toHaveProperty("kind", "error")
      expect(parseSubcommand([command, "--json=yes"])).toHaveProperty("kind", "error")
    })

    test(`${command}: option terminator allows a session starting with a dash`, () => {
      expect(parseSubcommand([command, "--", "--session-name"])).toMatchObject({ kind: command, options: { session: "--session-name" } })
    })

    test(`${command}: mistyped long options suggest the intended flag`, () => {
      expect(parseSubcommand([command, "--throug", "12"])).toEqual({ kind: "error", message: `${command}: unknown option --throug; did you mean --through?` })
      expect(parseSubcommand([command, "--zzzzzzzzzz"])).toEqual({ kind: "error", message: `${command}: unknown option --zzzzzzzzzz` })
    })

    for (const value of ["0", "-1", "1.5", "01", "+1", " 1", "1e2"]) {
      test(`${command}: --through rejects ${JSON.stringify(value)}`, () => {
        expect(parseSubcommand([command, `--through=${value}`])).toEqual({ kind: "error", message: `${command}: --through takes an event number, such as 12` })
      })
    }

    test(`${command}: invalid engines are rejected`, () => {
      expect(parseSubcommand([command, "--engine", "missing"])).toMatchObject({ kind: "error", message: expect.stringContaining("--engine must be one of:") })
    })
  }

  test("fork turn must be a positive decimal integer", () => {
    for (const value of ["0", "-2", "2.5", "02", "+2"]) {
      expect(parseSubcommand(["fork", `--turn=${value}`])).toEqual({ kind: "error", message: "fork: --turn takes a turn number, such as 3" })
    }
  })

  test("empty optional strings become null and repeated scalar options use the last value", () => {
    expect(forkOptions(["--model=first", "--model=", "--title=", "--effort=", "--cwd=", "--through=", "--turn=", "--copy-to="])).toEqual(forkOptions())
    expect(replayOptions(["--policy=", "--system-prompt=", "--workspace="])).toEqual(replayOptions())
    expect(forkOptions(["-m", "first", "--model=last"])).toHaveProperty("model", "last")
  })

  test("tool descriptions require both sides and split only at the first equals sign", () => {
    for (const value of ["", "=file", "read="]) {
      expect(parseSubcommand(["replay", `--tool-description=${value}`])).toEqual({ kind: "error", message: `replay: --tool-description takes <tool>=<file>, not ${value}` })
    }
    expect(replayOptions(["--tool-description=read=a=b.md", "--tool-description=read=c.md"]).toolDescriptions).toEqual([{ tool: "read", file: "a=b.md" }, { tool: "read", file: "c.md" }])
  })
})

describe("subcommand execution edges", () => {
  test("unsupported operations fail without registering signals or reading replay files", async () => {
    for (const command of ["fork", "replay"] as const) {
      const io = capture()
      const code = command === "fork"
        ? await runFork(io.io, engine(), forkOptions(), "/resolved")
        : await runReplay(io.io, engine(), replayOptions(["--system-prompt", join(root, "missing")]), "/resolved")
      expect(code).toBe(1)
      expect(io.out).toBe("")
      expect(io.err).toBe(`${brand.binary}: ${command} is not available with this engine\n`)
      expect(io.onSignal).not.toHaveBeenCalled()
    }
  })

  for (const kind of [null, "auth", "usage"] as const) {
    test(`engine refusal ${kind} preserves its exit code and cleans up replay signals`, async () => {
      const failure = new EngineUnavailable("cannot proceed", kind)
      const io = capture()
      expect(await runFork(io.io, engine({ fork: async () => { throw failure } }), forkOptions(), "/resolved")).toBe(kind === "usage" ? 2 : 1)
      expect(await runReplay(io.io, engine({ replay: async () => { throw failure } }), replayOptions(), "/resolved")).toBe(kind === "usage" ? 2 : 1)
      expect(io.err).toBe(`${brand.binary}: cannot proceed\n`.repeat(2))
      expect(io.out).toBe("")
      expect(io.off).toHaveBeenCalledTimes(1)
    })
  }

  test("unexpected engine errors propagate and replay still removes its handler", async () => {
    const failure = new Error("unexpected failure")
    const io = capture()
    await expect(runFork(io.io, engine({ fork: async () => { throw failure } }), forkOptions(), "/resolved")).rejects.toBe(failure)
    await expect(runReplay(io.io, engine({ replay: async () => { throw failure } }), replayOptions(), "/resolved")).rejects.toBe(failure)
    expect(io.off).toHaveBeenCalledTimes(1)
    expect(io.err).toBe("")
  })

  test("fork JSON omits the internal named field and forwards all options with the resolved cwd", async () => {
    const io = capture()
    const fork = mock(async () => forked)
    const options = forkOptions(["ses_named", "--turn=2", "--copy-to=/copy", "--model=other", "--effort=low", "--title=title", "--cwd=/option-cwd", "--json"])
    expect(await runFork(io.io, engine({ fork }), options, "/resolved")).toBe(0)
    expect(fork).toHaveBeenCalledWith({ cwd: "/resolved", session: "ses_named", throughSeq: null, turn: 2, copy: { copyTo: "/copy" }, model: "other", effort: "low", title: "title" })
    const { named, ...publicResult } = forked
    expect(io.out).toBe(`${JSON.stringify(publicResult)}\n`)
    expect(io.err).toBe("")
  })

  for (const flag of ["--system-prompt", "--tool-description"]) {
    test(`missing ${flag} file is a usage error before replay starts`, async () => {
      const file = join(root, "missing")
      const io = capture()
      const replay = mock(async () => result)
      const value = flag === "--tool-description" ? `read=${file}` : file
      expect(await runReplay(io.io, engine({ replay }), replayOptions([flag, value]), "/resolved")).toBe(2)
      expect(io.err).toBe(`${brand.binary}: ${flag} ${value}: no such file\nRun \`${brand.binary} replay --help\` for usage.\n`)
      expect(io.out).toBe("")
      expect(replay).not.toHaveBeenCalled()
      expect(io.onSignal).not.toHaveBeenCalled()
    })
  }

  test("replay reads overrides, trims descriptions, and lets the last duplicate tool win", async () => {
    const prompt = join(root, "prompt.txt")
    const first = join(root, "first.txt")
    const last = join(root, "last.txt")
    writeFileSync(prompt, "  prompt\n")
    writeFileSync(first, "first")
    writeFileSync(last, "  last\n")
    const replay = mock<NonNullable<Engine["replay"]>>(async () => result)
    const io = capture()
    const options = replayOptions(["ses_source", "--system-prompt", prompt, "--tool-description", `read=${first}`, "--tool-description", `read=${last}`, "--effort=default", "--model=other", "--strict", "--through=7", "--workspace=/copy", "--policy=execute", "--json"])
    expect(await runReplay(io.io, engine({ replay }), options, "/resolved")).toBe(0)
    expect(replay.mock.calls[0]?.[0]).toEqual({ cwd: "/resolved", session: "ses_source", params: { policy: "execute", systemPrompt: "  prompt\n", toolDescriptions: { read: "last" }, effort: null, model: "other", strict: true, throughSeq: 7, workspace: "/copy" } })
    expect(io.out).toBe(`${JSON.stringify(result, null, 2)}\n`)
    expect(io.err).toBe("")
    expect(io.off).toHaveBeenCalledTimes(1)
  })

  for (const status of ["identical", "diverged", "unsupported", "incomplete"]) {
    test(`quiet replay ${status} suppresses progress but prints the report`, async () => {
      const io = capture()
      const replay: NonNullable<Engine["replay"]> = async (request, progress) => {
        expect(request).toEqual({ cwd: "/resolved", session: null, params: { policy: "stop" } })
        progress.started("ses_replay", "ses_source", () => {})
        return { ...result, report: { status, reason: "test" } }
      }
      expect(await runReplay(io.io, engine({ replay }), replayOptions(["-q"]), "/resolved")).toBe(status === "identical" || status === "diverged" ? 0 : 1)
      expect(io.err).toBe("")
      expect(io.out).toBe("Report\n\n  replay session  ses_replay  (1 model call)\n")
      expect(io.off).toHaveBeenCalledTimes(1)
    })
  }

  test("the first interrupt cancels a started replay and returns its incomplete report", async () => {
    const io = capture()
    const cancel = mock(() => {})
    const replay: NonNullable<Engine["replay"]> = async (_request, progress) => {
      progress.started("ses_replay", "ses_source", cancel)
      io.interrupt()
      return { ...result, report: { status: "incomplete", reason: "cancelled" } }
    }
    expect(await runReplay(io.io, engine({ replay }), replayOptions(), "/resolved")).toBe(1)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(io.err).toBe(`replaying ses_source as ses_replay\n${brand.binary}: stopping the replay (it ends as incomplete)…\n`)
    expect(io.off).toHaveBeenCalledTimes(1)
  })
})
