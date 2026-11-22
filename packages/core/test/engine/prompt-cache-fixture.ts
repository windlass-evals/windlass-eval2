/** Shared offline production assembly for the prompt-cache regression tests. */
import { expect } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { assertPrefixStable, recordRequests, type Reply, type ReplyScript, type StabilityOptions } from "prefixlens/test"
import { createHarness, type Harness } from "../../src/assembly.ts"
import { brand } from "../../src/brand.ts"
import { loadConfig, loadConfigSync } from "../../src/config/load.ts"
import type { ConfigFile } from "../../src/config/schema.ts"
import { systemClock } from "../../src/engine/clock.ts"
import type { EngineOptions } from "../../src/engine/engine.ts"
import type { SessionId } from "../../src/id.ts"
import { discoverSources } from "../../src/instructions/discover.ts"
import { OpenAIResponsesProvider } from "../../src/provider/openai-responses.ts"

export const tool = (name: string, args: Record<string, unknown>): Reply => ({ toolCalls: [{ name, args }] })

export async function fixture(options: { engine?: Partial<EngineOptions>; config?: ConfigFile; root?: string; resume?: SessionId; reply?: ReplyScript; step?: string } = {}) {
  const root = options.root ?? realpathSync(mkdtempSync(join(tmpdir(), "prompt-cache-")))
  const cwd = join(root, "repo")
  const configHome = join(root, "config")
  const configDir = join(configHome, brand.directory)
  const write = (path: string, content: string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  // This is a real repository, so nested instruction discovery and snapshots use
  // the same boundary as production. It contains only this test's fixtures.
  // Scripted replies here describe the conversation lane only.
  const config = (value: ConfigFile) => write(join(configDir, "config.json"), JSON.stringify({ titles: "off", ...value }))
  if (!options.resume) {
    write(join(cwd, "note.txt"), "A synthetic file for the cache regression.\n")
    write(join(cwd, "AGENTS.md"), "Use the project's tests.\n")
    const init = Bun.spawnSync(["git", "init", "-q", cwd])
    expect(init.exitCode).toBe(0)
    config({ memory: { enabled: true }, ...options.config })
  }
  let now = new Date(2026, 10, 18, 12).getTime()
  let replies: Reply[] = []
  let beforeReply: (() => void) | undefined
  let replyScript = options.reply
  type Intercept = (response: Response, init: RequestInit) => Response | Promise<Response>
  const intercepts: Intercept[] = []
  let mapResponses: Intercept | undefined
  const recording = recordRequests({ reply: (request) => {
    const action = beforeReply
    beforeReply = undefined
    action?.()
    const reply = replies.shift() ?? replyScript?.(request)
    if (reply === undefined) throw new Error("Unscripted model call in prompt-cache test")
    return reply
  } })
  if (options.step) recording.step(options.step)
  const sentHeaders: Headers[] = []
  let harness: Harness
  const provider = new OpenAIResponsesProvider({
    accessToken: async () => "synthetic-offline-token",
    readBlob: (ref) => {
      const blob = harness.sessions.getBlob(ref.hash)
      if (blob === null) throw new Error(`Missing test blob ${ref.hash}`)
      return blob.bytes
    },
    fetch: async (url, init) => {
      sentHeaders.push(new Headers(init.headers))
      const intercept = intercepts.shift()
      const response = await recording.fetch(url, init)
      const mapped = mapResponses ? await mapResponses(response, init) : response
      return intercept ? intercept(mapped, init) : mapped
    },
  })
  const load = (directory: string) => ({ cwd: directory, env: { XDG_CONFIG_HOME: configHome }, home: root })
  const boot = () => createHarness({
    dataDir: join(root, "data"), provider,
    engine: {
      clock: { ...systemClock, now: () => now },
      // Inject locations, not alternate prompts, tools, discovery or config logic.
      discover: (input) => discoverSources({ ...input, configDir, platform: process.platform, now: () => new Date(now) }),
      loadConfig: (directory) => loadConfig(load(directory)),
      loadConfigSync: (directory) => loadConfigSync(load(directory)),
      skills: { configDir, home: root }, agents: { configDir, home: root }, commands: { configDir, home: root },
      // Synthetic model metadata; the production compaction policy is unchanged.
      contextWindow: () => 128_000,
      approval: { secrets: [], home: root },
      ...options.engine,
    },
    log: () => {},
  })
  harness = boot()
  let session = options.resume ? harness.engine.openSession(options.resume) : harness.engine.createSession({ cwd, settings: { model: "gpt-4.1", reasoningEffort: null } })
  const turn = async (name: string, action: () => void | Promise<void> = () => {}, answers: Reply[] = ["Done."], expectedFailure = false) => {
    const before = session.readEvents().length
    recording.step(name)
    await action()
    replies.push(...answers)
    session.send(name)
    await session.settled()
    expect(replies, `unused replies in ${name}`).toEqual([])
    const failures = session.readEvents().slice(before).filter((e) => e.type === "execution.failed")
    if (expectedFailure) expect(failures.length).toBeGreaterThan(0)
    else expect(failures.map((e) => e.data)).toEqual([])
  }
  const finish = (allowBreakIn: StabilityOptions["allowBreakIn"] = {}) => {
    const policy = { allowBreakIn }
    // Do not let inferred lanes hide a changed prefix. Compare consecutive
    // requests separately for each actual session (including spawned children).
    const failures: unknown[] = []
    const used = new Set<string>()
    const previousBySession = new Map<unknown, Record<string, unknown>>()
    for (const request of recording.requests) {
      const previous = previousBySession.get(request.body.prompt_cache_key)
      previousBySession.set(request.body.prompt_cache_key, request.body)
      if (!previous) continue
      try { assertPrefixStable(previous, request.body) }
      catch (error) {
        const step = request.step!
        if (allowBreakIn[step] && !used.has(step)) {
          used.add(step)
          try { assertPrefixStable(previous, request.body, { allowBreak: allowBreakIn[step] }) }
          catch (allowedError) { failures.push(allowedError) }
        } else failures.push(error)
      }
    }
    const sessionIds = harness.engine.listSessions({ includeArchived: true, includeSpawned: true }).map((entry) => entry.session.id as string)
    for (const [i, request] of recording.requests.entries()) {
      expect(request.body.store).toBe(false)
      expect(request.body.previous_response_id).toBeUndefined()
      expect(request.body.conversation).toBeUndefined()
      expect(typeof request.body.prompt_cache_key).toBe("string")
      expect(sessionIds).toContain(request.body.prompt_cache_key as string)
      expect(sentHeaders[i]!.get("session-id")).toBe(request.body.prompt_cache_key as string)
    }
    recording.assertStable(policy)
    if (failures.length) throw failures[0]
  }
  return {
    root, cwd, configDir, write, config, recording, turn, finish,
    get session() { return session },
    get harness() { return harness },
    nextDay: () => { now += 86_400_000 },
    advanceDays: (days: number) => { now += days * 86_400_000 },
    replyWith: (script: ReplyScript | undefined) => { replyScript = script },
    intercept: (intercept: Intercept) => { intercepts.push(intercept) },
    mapResponses: (map: Intercept) => { mapResponses = map },
    beforeReply: (action: () => void) => { beforeReply = action },
    restart: async () => {
      const id = session.id
      await harness.close()
      harness = boot()
      session = harness.engine.openSession(id)
    },
    close: async () => {
      try { await harness.close() } finally { rmSync(root, { recursive: true, force: true }) }
    },
  }
}

/** Synthetic Responses SSE events, decoded by the real provider. */
export function sse(...events: Record<string, unknown>[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  })
}

export async function warm(f: Awaited<ReturnType<typeof fixture>>, turns = 8) {
  for (let i = 0; i < turns; i++) await f.turn(`warm-up ${i + 1}`)
}

