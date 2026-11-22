/**
 * The one place the real harness is put together: the data directory, a
 * store per session in it (`store/directory.ts`), the ChatGPT-plan Responses
 * provider with the saved sign-in (or the access token another process hands
 * in, `auth/handed-in.ts`), the standard tools, the configuration
 * files and the defaults (the default model). The command-line interface and
 * the ACP server both call `createHarness()` and add only what is theirs:
 * arguments and a terminal, or a protocol.
 *
 * Nothing is opened until the engine is first used, so a process that only
 * prints help never touches the disk. Several harness processes share one
 * data directory: sessions are held one at a time, per session, and
 * everything else in the directory (blobs, spill files, snapshots, the
 * session index) is written so that several processes can do it at once.
 *
 * Every name, directory and binary comes from `brand`.
 */
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { AUTH_UNREACHABLE, AuthError, HANDED_IN_REJECTED, aboutHandedIn, accessToken as signInToken, dataDir as defaultDataDir, handedInRejected, handedInTokenFile, handedInTokenNow } from "./auth/chatgpt.ts"
import { brand } from "./brand.ts"
import { loadConfig } from "./config/load.ts"
import { environmentSecrets } from "./engine/approval.ts"
import { type Engine, type EngineOptions, type ModelOffer, createEngine } from "./engine/engine.ts"
import type { SessionSettings } from "./event/durable.ts"
import type { ProviderError } from "./provider/error.ts"
import { ModelListError, OpenAIResponsesProvider, listModels } from "./provider/openai-responses.ts"
import { type Provider, SIGNED_IN_PROVIDER } from "./provider/provider.ts"
import { type CommandSandbox, createCommandSandbox } from "./sandbox/command.ts"
import { type SessionDirectory, openSessionDirectory } from "./store/directory.ts"
import type { AnyTool } from "./tool/tool.ts"
import { createStandardTools } from "./tools/index.ts"

/** The model a new session uses when neither the caller nor the configuration names one. */
export const DEFAULT_MODEL = "gpt-6.1-sol"
/** The reasoning effort a new session uses when nothing names one: `null` is the model's own default. */
export const DEFAULT_EFFORT: string | null = null
/** Where tool output that is too long for the model is written in full, under the data directory. */
export const SPILL_DIRECTORY = "spill"
/**
 * A test setting, never a user's: an environment variable that lowers the
 * context window the compaction policy works with to the given number of
 * tokens, so that a test or an evaluation run compacts after tens of
 * thousands of tokens instead of hundreds of thousands. It can only lower
 * the window, the harness says so on its log when it is set, and no
 * configuration file has a key for it.
 */
export const TEST_CONTEXT_WINDOW_ENV = `${brand.envPrefix}TEST_CONTEXT_WINDOW`

/** The window `TEST_CONTEXT_WINDOW_ENV` asks for, or `null` when it is not set to a whole number of tokens. */
export function testContextWindow(env: Record<string, string | undefined> = process.env): number | null {
  const value = env[TEST_CONTEXT_WINDOW_ENV]
  if (value === undefined || !/^[1-9]\d{0,8}$/.test(value.trim())) return null
  return Number(value.trim())
}

/** One model the account offers. */
export interface ModelEntry extends ModelOffer {
  /** A name to show; the ID when the provider gives none. */
  readonly name: string
  /** Reasoning efforts the model accepts; empty when it has none. */
  readonly efforts: readonly string[]
  /** The effort the model uses when none is set, when the provider says. */
  readonly defaultEffort: string | null
  /** Context window in tokens, when the provider says. */
  readonly contextWindow: number | null
}

/**
 * `code`, when the sign-in is not usable: why, as the sign-in itself names it (`AuthError.code`: `signed_out`,
 * `invalid_grant`, or one of the codes of a handed-in token, `HandedInCode`), for a program to act on.
 */
export type SignInState = { readonly signedIn: true } | { readonly signedIn: false; readonly message: string; readonly code?: string }

export interface HarnessOptions {
  /** Defaults to `<data home>/<brand.directory>`, where the sign-in is kept too. */
  readonly dataDir?: string
  /** Instead of the ChatGPT-plan provider (tests, a scripted model). With one, the sign-in is not checked and no model is listed. */
  readonly provider?: Provider
  /** Instead of the standard tools. */
  readonly tools?: readonly AnyTool[]
  readonly defaultModel?: string
  readonly defaultEffort?: string | null
  /** One line of the engine's log, and notices about the data directory. Defaults to standard error, prefixed with the binary's name. */
  readonly log?: (line: string) => void
  /** Instead of reading the saved sign-in (or the file one is handed in through). */
  readonly signIn?: () => Promise<SignInState>
  /** Instead of asking the provider for the account's models. */
  readonly models?: (signal?: AbortSignal) => Promise<readonly ModelEntry[]>
  /** Passed through to the step loop (limits, clock, instruction discovery, hooks, ...). */
  readonly engine?: Partial<Omit<EngineOptions, "store" | "provider" | "tools" | "dataDir">>
}

export interface Harness {
  readonly dataDir: string
  readonly defaults: { readonly model: string; readonly effort: string | null }
  /**
   * The engine on the session directory, built on first use. Throws once the
   * harness is closed.
   */
  readonly engine: Engine
  /** The session directory under the engine: for a tool that reads sessions (an exporter), never for writing around the engine. */
  readonly sessions: SessionDirectory
  /** Whether a model call can be made: the saved ChatGPT sign-in, or the file one is handed in through, yields a token. Always signed in with a provider of the caller's. */
  readonly signIn: () => Promise<SignInState>
  /** The account's models, in the provider's order. Rejects with `ModelListError` when they cannot be listed. Empty with a provider of the caller's. */
  readonly listModels: (signal?: AbortSignal) => Promise<readonly ModelEntry[]>
  /**
   * The settings a new session in `cwd` starts with: what the caller asks
   * for, else what the configuration files that apply there name, else the
   * defaults. A configuration that cannot be read is not reported here: the
   * session's first execution fails with it, before anything is sent.
   */
  readonly settingsFor: (cwd: string, asked?: { readonly model?: string | null; readonly effort?: string | null }) => Promise<SessionSettings>
  /**
   * The shutdown every way out of a process goes through: every session is
   * stopped as a shutdown (it resumes later) and let go of, then the data
   * directory is. Safe to call more than once.
   */
  readonly close: () => Promise<void>
  readonly closed: boolean
}

/**
 * A sign-in failure of a process on a handed-in token, as the provider answered it: the token the file gave was
 * turned down. It says so itself, in its message and in its code (`HANDED_IN_REJECTED`), with the provider's own
 * answer inside the message. A failure the file gave (it names the variable, and has its own code) is left as it is.
 */
function rejectedHandedIn(error: ProviderError): ProviderError {
  if (error.kind !== "auth" || aboutHandedIn(error.message)) return error
  return { ...error, code: HANDED_IN_REJECTED, message: handedInRejected(error.code === null ? error.message : `${error.message}, ${error.code}`) }
}

/** `provider` for a process on a handed-in token: a rejection of the token is named as one (`rejectedHandedIn`). */
function onHandedInToken(provider: Provider): Provider {
  return {
    id: provider.id,
    stream: async function* (request, signal) {
      for await (const event of provider.stream(request, signal)) yield event.type === "error" ? { ...event, error: rejectedHandedIn(event.error) } : event
    },
  }
}

/**
 * The values removed from tool output in a process on a handed-in token: `known`, and every token the file `file`
 * has held when the list was read. The engine is given one list and reads through it each time it redacts (a
 * result, each piece of a running command's output), so this list looks at the file whenever it is read through:
 * the token that is in the file at that moment is in it, also one written a moment ago that no model call has read
 * yet. The look is `handedInTokenNow`, which never throws: a file that cannot be read adds nothing and fails nothing.
 *
 * "Read through" is the iteration every redaction starts with (`redact` and `unfinishedSecret` in
 * `approval/redact.ts`). A reader that only indexes the list sees the tokens found so far.
 */
function secretsWithTokenFile(known: readonly string[], file: string): string[] {
  const secrets = [...known]
  const values = Array.prototype[Symbol.iterator]
  Object.defineProperty(secrets, Symbol.iterator, {
    value: () => {
      const token = handedInTokenNow(file)
      if (token !== null && !secrets.includes(token)) secrets.push(token)
      return values.call(secrets)
    },
  })
  return secrets
}

/** The command sandbox, made (and the machine probed) the first time something asks about it. */
function lazySandbox(): CommandSandbox {
  let made: CommandSandbox | null = null
  const get = () => (made ??= createCommandSandbox())
  return {
    get state() {
      return get().state
    },
    temp: (sessionId) => get().temp(sessionId),
    plan: (input) => get().plan(input),
    policy: (input) => get().policy(input),
    sessionHome: {
      use: (sessionId, on) => get().sessionHome?.use(sessionId, on),
      state: (input) => get().sessionHome?.state(input) ?? { used: false, notice: null },
    },
    environment: {
      // A sandbox that was never asked about anything holds no session's names: it is not made to be told there are none.
      use: (sessionId, names) => {
        if (made !== null || names.withhold.length > 0 || names.pass.length > 0) get().environment?.use(sessionId, names)
      },
      unsandboxed: (sessionId) => made?.environment?.unsandboxed(sessionId),
    },
    confined: (input) => {
      const confined = get().confined
      if (confined === undefined) throw new Error("this sandbox cannot confine a process")
      return confined(input)
    },
  }
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const dataDir = options.dataDir ?? defaultDataDir()
  const log = options.log ?? ((line: string) => void process.stderr.write(`${brand.binary}: ${line}\n`))
  const defaults = {
    model: options.defaultModel ?? DEFAULT_MODEL,
    effort: options.defaultEffort === undefined ? DEFAULT_EFFORT : options.defaultEffort,
  }
  let running: { readonly sessions: SessionDirectory; readonly engine: Engine } | null = null
  let closing: Promise<void> | null = null
  // A handed-in access token is a secret this process reads from a file, not from its environment, and the file is
  // replaced while it runs: every token read joins the values removed from tool output, a list the engine reads
  // each time it redacts, and the list itself looks at the file then (`secretsWithTokenFile`).
  const tokenFile = options.provider === undefined ? handedInTokenFile() : null
  const secrets = tokenFile === null ? null : secretsWithTokenFile(options.engine?.approval?.secrets ?? environmentSecrets(process.env), tokenFile)
  const accessToken =
    secrets === null
      ? signInToken
      : async () => {
          const token = await signInToken()
          if (!secrets.includes(token)) secrets.push(token)
          return token
        }

  const accountModels = async (signal?: AbortSignal): Promise<readonly ModelEntry[]> => {
    if (options.models !== undefined) return options.models(signal)
    if (options.provider !== undefined) return []
    const models = await listModels({ accessToken, ...(signal === undefined ? {} : { signal }) }).catch((error: unknown) => {
      // A handed-in token the provider rejected: the listing says so, and not to sign in here.
      if (secrets === null || !(error instanceof ModelListError)) throw error
      throw new ModelListError(rejectedHandedIn(error.error))
    })
    return models.map((model) => ({
      id: model.slug,
      name: model.displayName,
      supportedInApi: model.supportedInApi,
      ...(model.description !== undefined && { description: model.description }),
      efforts: model.reasoningEfforts,
      defaultEffort: model.defaultReasoningEffort,
      contextWindow: model.contextWindow,
    }))
  }

  const start = () => {
    if (closing !== null) throw new Error(`${brand.name} is shutting down`)
    if (running !== null) return running
    mkdirSync(dataDir, { recursive: true })
    const sessions = openSessionDirectory({ dataDir, notice: log })
    const spillDir = join(dataDir, SPILL_DIRECTORY)
    // One sandbox for the decisions and for the shell tool that carries them out. Probed when a command first needs it.
    const sandbox = options.engine?.approval?.sandbox ?? lazySandbox()
    // The context window the compaction policy measures against: the provider's, per model, asked for once.
    let catalogue: Promise<readonly { readonly slug: string; readonly contextWindow: number | null }[]> | null = null
    const providerWindow = async (model: string) => {
      catalogue ??= listModels({ accessToken, listedOnly: false }).catch(() => [])
      return (await catalogue).find((entry) => entry.slug === model)?.contextWindow ?? null
    }
    const lowered = testContextWindow()
    if (lowered !== null) log(`${TEST_CONTEXT_WINDOW_ENV} is set: the context window is taken to be at most ${lowered} tokens (a test setting)`)
    const contextWindow = async (model: string) => {
      const real = options.provider === undefined ? await providerWindow(model) : ((await options.engine?.contextWindow?.(model)) ?? null)
      return lowered === null ? real : real === null ? lowered : Math.min(real, lowered)
    }
    const signedIn = () =>
      new OpenAIResponsesProvider({
        accessToken,
        readBlob: (ref) => {
          const blob = sessions.getBlob(ref.hash)
          if (blob === null) throw new Error(`blob ${ref.hash} is not in the blob store`)
          return blob.bytes
        },
      })
    const provider = options.provider ?? (secrets === null ? signedIn() : onHandedInToken(signedIn()))
    const engine = createEngine({
      ...(options.provider === undefined
        ? {
            // On a rejected sign-in the token is looked up once more (it is refreshed when it is due; a handed-in one is
            // read from its file again) before the step fails.
            refreshAuth: () =>
              accessToken().then(
                () => true,
                () => false,
              ),
          }
        : {}),
      ...(provider.id === SIGNED_IN_PROVIDER ? { listModels: accountModels } : {}),
      log,
      ...options.engine,
      // With a provider of the caller's the window is the caller's to give; the test setting lowers either.
      ...(options.provider === undefined || options.engine?.contextWindow !== undefined || lowered !== null ? { contextWindow } : {}),
      // Subagents and background work are part of the real harness; a caller that passes `spawn: null` builds one without them.
      ...(options.engine?.spawn === undefined ? { spawn: {} } : {}),
      // So are skills and MCP servers: their tools are in every session's list from its first baseline, whatever
      // exists then. A caller that passes `null` builds a harness without them.
      ...(options.engine?.skills === undefined ? { skills: {} } : {}),
      ...(options.engine?.mcp === undefined ? { mcp: {} } : {}),
      // Code mode: `run_code` in every session's list from its first baseline. `null` builds a harness without it.
      ...(options.engine?.codeMode === undefined ? { codeMode: {} } : {}),
      // Wake-ups: the tools everywhere; the scheduler and the webhook listener only in a process that asks for them
      // (`engine: { wake: { run: true } }`), which is what a long-lived server does and a one-prompt run does not.
      ...(options.engine?.wake === undefined ? { wake: {} } : {}),
      // Memory is behind its flag: the engine can offer it, and a session gets it only when `memory.enabled` is on.
      ...(options.engine?.memory === undefined ? { memory: {} } : {}),
      // Agents: a session can start as one, switch to one, and run a subagent as one. `null` builds a harness without them.
      ...(options.engine?.agents === undefined ? { agents: {} } : {}),
      // Slash commands: a client can list, look up, expand and send the command files of a session's directory.
      ...(options.engine?.commands === undefined ? { commands: {} } : {}),
      // Live telemetry is behind the user's own configuration: nothing is exported for a session whose `telemetry`
      // section does not turn it on, and a project's file can only turn it off. `null` builds a harness that never exports.
      ...(options.engine?.telemetry === undefined ? { telemetry: {} } : {}),
      // Hooks and language-server diagnostics: nothing of either exists for a session whose configuration names none
      // (its requests are those of a harness without them). `null` builds a harness that never runs or starts any.
      ...(options.engine?.commandHooks === undefined ? { commandHooks: {} } : {}),
      ...(options.engine?.lsp === undefined ? { lsp: {} } : {}),
      store: sessions,
      provider,
      tools: options.tools ?? createStandardTools({ spillDir, shell: { sandbox } }),
      dataDir,
      spillDir,
      // Safe by default: mode `auto` in the sandbox, nobody present until a client says so. `null` (tests) switches it off.
      ...(options.engine?.approval === null ? { approval: null } : { approval: { ...options.engine?.approval, sandbox, ...(secrets === null ? {} : { secrets }) } }),
    })
    running = { sessions, engine }
    return running
  }

  return {
    dataDir,
    defaults,
    get engine() {
      return start().engine
    },
    get sessions() {
      return start().sessions
    },
    get closed() {
      return closing !== null
    },
    signIn: async () => {
      if (options.signIn !== undefined) return options.signIn()
      if (options.provider !== undefined) return { signedIn: true }
      try {
        await accessToken()
        return { signedIn: true }
      } catch (error) {
        // The sign-in service could not be reached for a refresh: the sign-in is saved, and nothing says it is gone.
        // A model call then fails as the connection problem it is, and is tried again like one.
        if (error instanceof AuthError && error.code === AUTH_UNREACHABLE) return { signedIn: true }
        if (error instanceof AuthError) return { signedIn: false, message: error.message, code: error.code }
        throw error
      }
    },
    listModels: accountModels,
    settingsFor: async (cwd, asked = {}) => {
      // The same configuration the engine verifies with, so a test that switches it off switches this off too.
      const load = options.engine?.loadConfig === undefined ? (directory: string) => loadConfig({ cwd: directory }) : options.engine.loadConfig
      const config =
        load === null
          ? null
          : await load(cwd).then(
              (loaded) => loaded.config,
              () => null,
            )
      return {
        model: asked.model ?? config?.model ?? defaults.model,
        reasoningEffort: asked.effort ?? config?.effort ?? defaults.effort,
      }
    },
    close: () => {
      closing ??= (async () => {
        const current = running
        if (current === null) return
        await current.engine.close()
        current.sessions.close()
      })()
      return closing
    },
  }
}
