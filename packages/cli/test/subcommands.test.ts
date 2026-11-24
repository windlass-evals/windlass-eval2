import { describe, expect, test } from "bun:test"
import { brand } from "@windlass/core"
import { EngineUnavailable, type Engine, type EngineEvent } from "../src/engine.ts"
import { forkUsage, parseSubcommand, ReplayProgressLines, replayUsage, runFork, runReplay, type SubcommandIo } from "../src/subcommands.ts"

describe("subcommands", () => {
  test("usage and command selection", () => {
    expect(forkUsage()).toContain(`Usage: ${brand.binary} fork`)
    expect(replayUsage()).toContain(`Usage: ${brand.binary} replay`)
    expect(parseSubcommand([])).toEqual({ kind: "error", message: "unknown subcommand undefined" })
    expect(parseSubcommand(["help"])).toEqual({ kind: "error", message: "unknown subcommand help" })
    expect(parseSubcommand(["fork", "--help"])).toEqual({ kind: "help", text: forkUsage() })
    expect(parseSubcommand(["replay", "-h"])).toEqual({ kind: "help", text: replayUsage() })
  })

  test("fork parsing, defaults, validation and typo suggestions", () => {
    expect(parseSubcommand(["fork"])).toMatchObject({ kind: "fork", options: { session: null, turn: null, throughSeq: null, copy: null, engine: "acp" } })
    expect(parseSubcommand(["fork", "ses", "--turn", "3", "--copy-to", "/tmp/new", "-m", "model", "--json"])).toMatchObject({ kind: "fork", options: { session: "ses", turn: 3, throughSeq: null, copy: { copyTo: "/tmp/new" }, model: "model", json: true } })
    for (const args of [["fork", "a", "b"], ["fork", "--thruogh", "3"], ["fork", "--through", "0"], ["fork", "--through", "1e2"], ["fork", "--copy-to", "relative"], ["fork", "--turn", "0"], ["fork", "--turn", "1", "--through", "2"], ["fork", "--engine", "bad"]]) expect(parseSubcommand(args).kind).toBe("error")
    expect(parseSubcommand(["fork", "--thruogh", "3"])).toMatchObject({ message: "fork: unknown option --thruogh; did you mean --through?" })
  })

  test("replay parsing and malformed options", () => {
    expect(parseSubcommand(["replay", "ses", "--policy", "execute", "--strict", "--tool-description", "read=a=b", "--effort", "default", "-q"])).toMatchObject({ kind: "replay", options: { session: "ses", policy: "execute", strict: true, toolDescriptions: [{ tool: "read", file: "a=b" }], quiet: true } })
    for (const args of [["replay", "a", "b"], ["replay", "--policy", "bad"], ["replay", "--tool-description", "=file"], ["replay", "--tool-description", "read="], ["replay", "--json", "--quiet"]]) expect(parseSubcommand(args).kind).toBe("error")
    expect(parseSubcommand(["replay", "--engine", "direct", "--through", "12"])).toMatchObject({ kind: "replay", options: { engine: "direct", throughSeq: 12 } })
  })

  const ioFor = () => {
    const out: string[] = [], err: string[] = [], signals: (() => void)[] = []
    const io: SubcommandIo = { cwd: "/work", stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, onSignal: (_signal, _handler) => { signals.push(() => {}); return () => { signals.pop() } } }
    return { io, out, err, signals }
  }

  test("runFork handles unavailable, refusal, JSON, and human-readable result", async () => {
    const { io, out, err } = ioFor()
    expect(await runFork(io, {} as Engine, {} as never, "/work")).toBe(1)
    expect(err.join("")).toContain("fork is not available")
    const options = { session: "s", throughSeq: null, turn: null, copy: null, model: null, effort: null, title: null, cwd: null, json: true, engine: "acp" as const }
    const result = { sessionId: "new", parentSessionId: "parent", throughSeq: 4, cwd: "/work", copiedFrom: null, title: null, model: "m", effort: null, named: "parent" }
    const engine = { fork: async () => result } as unknown as Engine
    expect(await runFork(io, engine, options, "/work")).toBe(0)
    expect(JSON.parse(out.join(""))).toMatchObject({ sessionId: "new" })
    const plain = ioFor()
    await runFork(plain.io, engine, { ...options, json: false, throughSeq: 4 }, "/work")
    expect(plain.out.join("")).toContain("after event 4")
    const refusal = { fork: async () => { throw new EngineUnavailable("no", "usage") } } as unknown as Engine
    expect(await runFork(plain.io, refusal, options, "/work")).toBe(2)
    const boom = { fork: async () => { throw Error("boom") } } as unknown as Engine
    await expect(runFork(plain.io, boom, options, "/work")).rejects.toThrow("boom")
  })

  test("replay progress reports calls and divergence", () => {
    const lines: string[] = [], progress = new ReplayProgressLines((s) => lines.push(s))
    progress.started("r", "s")
    progress.event({ type: "step.started" } as EngineEvent)
    progress.event({ type: "tool.called", data: { messageId: "m", callId: "c", name: "read", input: '{"path":"a.txt"}' } } as EngineEvent)
    progress.event({ type: "replay.call", data: { messageId: "m", callId: "c", result: "matched" } } as EngineEvent)
    progress.event({ type: "replay.call", data: { messageId: "m", callId: "missing", result: "diverged", divergence: "arguments_changed" } } as EngineEvent)
    expect(lines.join("")).toContain("replaying s as r")
    expect(lines.join("")).toContain("read a.txt · as recorded")
    expect(lines.join("")).toContain("differs from the recording (arguments changed)")
  })

  test("runReplay reports missing capability and missing input files", async () => {
    const { io, err } = ioFor()
    const opts = parseSubcommand(["replay", "--system-prompt", "/definitely/missing"])
    expect(opts.kind).toBe("replay")
    if (opts.kind !== "replay") return
    expect(await runReplay(io, {} as Engine, opts.options, "/work")).toBe(1)
    const capable = { replay: async () => { throw new Error("should not run") } } as unknown as Engine
    expect(await runReplay(io, capable, opts.options, "/work")).toBe(2)
    expect(err.join("")).toContain("no such file")
  })
})
