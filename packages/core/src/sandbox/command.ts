/**
 * The sandbox as the shell tool and the check runner use it: the policy of a
 * command that runs in a session's working directory, and the session's temp
 * directory. `policy.ts` and the backends know nothing about sessions, git or
 * the harness's project directory; this file adds exactly that.
 *
 * What a sandboxed command gets on top of `defaultPolicy`:
 *
 * - The session's temp directory as its temp root: `/tmp` on Linux, `TMPDIR`
 *   on macOS. It outlives the command, so a file one command leaves there is
 *   there for the next, and it is the session's own (mode 0700, one per
 *   session), so nothing else on the machine is in it.
 * - Where the session asked for it (`sessionHome.use`, off until told), on
 *   Linux, a home of the session's own (`<temp base>/<session>.home`): the
 *   command sees it at the home directory's path with the user's entries
 *   read-only in it, so a tool that keeps a cache, settings or state under
 *   the home (`~/.npm`, `~/.cache/uv`, `~/.config/astro`) can write them, and
 *   the user's home is never changed. Like the temp directory it outlives the
 *   command. Nothing outside the sandbox reads it, so what a command leaves
 *   there cannot run later with the user's rights. Not when the home is, or
 *   lies in, a directory the command may write anyway: working there is the
 *   user's choice, and the files are the user's. And not for a command that
 *   may write the directory the session's home is kept in: it would reach
 *   the home under a second name, so that directory is hidden from it.
 * - The repository's git directory writable when it is not inside the working
 *   directory (a session in a subdirectory of a repository, a linked
 *   worktree): `git add` and `git commit` write there.
 * - `hooks` and `config` of that git directory, and the harness's project
 *   directory, read-only: a command may otherwise plant a hook, an alias or a
 *   check that runs later outside the sandbox. This is what breaks: anything
 *   that writes the repository's configuration or hooks (`git config`,
 *   `git remote add`, `git branch --set-upstream-to`, `git submodule init`,
 *   a package manager's hook installer such as husky). No access the user
 *   grants opens them; `sandboxHint` tells the model so when one is refused.
 * - With the network granted, Bun's install cache in the temp directory: a
 *   download needs a writable cache, and the user's own cache is what later
 *   installs outside the sandbox trust, so it stays read-only.
 * - Where the session named any (`environment.use`), the variables it is not
 *   given whatever their name, and the credential-looking ones it is given
 *   all the same. A command of the session that runs without the sandbox is
 *   not given the first either (`environment.unsandboxed`); it is the same
 *   user as the harness, though, and can read them from the harness's
 *   process, which a sandboxed command on Linux cannot see.
 *
 * Nothing else was needed for `bun test`, `bun run`, an offline `bun install`
 * from the lockfile, `tsc` and local git commits: they read the user's Bun
 * cache and git configuration, which the default policy leaves readable.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { ACCESS_TOKEN_FILE_ENV } from "../auth/handed-in.ts"
import { brand } from "../brand.ts"
import type { SandboxRun, TempDirectory } from "../tool/tool.ts"
import { HOME_BINDS, type HomeMounts, homeMounts, homeView } from "./bwrap.ts"
import { type SandboxDetection, detectSandbox } from "./detect.ts"
import { type SandboxPlan, type SandboxUnavailable, sandboxCommand } from "./index.ts"
import type { CommandEnv } from "./config.ts"
import { type SandboxPolicy, defaultPolicy, filterEnv } from "./policy.ts"

export interface CommandSandboxOptions {
  /** Where the sessions' temp directories are made. Default: `<os temp>/<brand.directory>-<uid>`. */
  readonly tempBase?: string
  /** The environment commands inherit from, before the policy filters it. Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Instead of `detectSandbox()`. */
  readonly detection?: SandboxDetection
  readonly home?: string
}

export interface CommandInput {
  readonly sessionId: string
  /** The session's working directory: the workspace. */
  readonly cwd: string
  readonly run: SandboxRun
  readonly command: string
  readonly shellPath?: string
}

export interface CommandSandbox {
  /** Whether commands can be sandboxed on this machine, and if not, why and what would fix it. */
  readonly state: { readonly available: true } | { readonly available: false; readonly reason: string; readonly remedy: string | null }
  /** The session's temp directory, created on first use. `alias` is where sandboxed commands see it. */
  readonly temp: (sessionId: string) => TempDirectory
  /** What to spawn for a command, or why it cannot be sandboxed. Never a plan that runs it unsandboxed. */
  readonly plan: (input: CommandInput) => SandboxPlan | SandboxUnavailable
  /** The policy `plan` applies, for a test or a person to look at. */
  readonly policy: (input: Pick<CommandInput, "sessionId" | "cwd" | "run">) => SandboxPolicy
  /**
   * What to spawn for a process that may change nothing but `root`, its own
   * directory: the command policy with the workspace read-only as well, no
   * network, no extra directory, and only the environment variables named
   * in `env` (the values are taken from `env` too). `root` is its temp
   * directory (`/tmp` on Linux, `TMPDIR` on macOS). For a program whose every
   * effect goes through the harness's tool calls (`codemode/`). Absent in a
   * stand-in that cannot confine a process: nothing is then run confined.
   */
  readonly confined?: (input: ConfinedInput) => SandboxPlan | SandboxUnavailable
  /** The homes of the sessions' own. Absent in a stand-in that has none: every command's home is then the user's, read-only. */
  readonly sessionHome?: SessionHomes
  /**
   * What of the environment the commands of a session get besides the rule.
   * Absent in a stand-in that keeps none: a sandboxed command then gets what
   * `plan` gives, and one without the sandbox the harness's own environment.
   */
  readonly environment?: CommandEnvironments
}

export interface CommandEnvironments {
  /**
   * The names for a session's commands, from the next one started:
   * `withhold` is given to none of them, sandboxed or not, and `pass` to the
   * sandboxed ones although the names look like credentials. A name in both
   * is withheld. Nothing is kept for a session nothing was said about.
   */
  readonly use: (sessionId: string, names: CommandEnv) => void
  /**
   * The environment of a command of the session that runs without the
   * sandbox: the one commands inherit from, without the withheld names.
   * `undefined` when the session withholds none: the caller's own
   * environment, as it is.
   */
  readonly unsandboxed: (sessionId: string) => Record<string, string> | undefined
}

export interface SessionHomes {
  /** Whether the sandboxed commands of a session get a home of the session's own, from the next one planned. Off for a session nothing was said about. */
  readonly use: (sessionId: string, on: boolean) => void
  /**
   * For a session whose home is on: whether a sandboxed command of it in
   * `cwd` gets the home now, and one message for the user when it gets none,
   * or one that does not hold all of the user's, saying what was left as it
   * was and why. `null`: there is nothing to say.
   */
  readonly state: (input: { readonly sessionId: string; readonly cwd: string }) => { readonly used: boolean; readonly notice: string | null }
}

export interface ConfinedInput {
  /** The directory the process runs in, outside the sandbox. Read-only like the rest, unless it is `root`. */
  readonly cwd: string
  readonly root: string
  /** The command, given the path the process sees `root` at (`/tmp` under bubblewrap). */
  readonly argv: (root: string) => readonly string[]
  readonly env: Readonly<Record<string, string>>
}

export function createCommandSandbox(options: CommandSandboxOptions = {}): CommandSandbox {
  const detection = options.detection ?? detectSandbox()
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const bwrap = detection.available && detection.backend === "bwrap"
  const temps = new Map<string, string>()
  /**
   * The sessions that were told to use a home of their own, each with whether it uses it now and with what its
   * running commands have mounted in it. An entry is kept when the home is turned off: a command that got the
   * home may still be running, and the next one that gets it is planned beside it.
   */
  const homes = new Map<string, { on: boolean; readonly mounts: HomeMounts }>()
  const homeOn = (sessionId: string) => homes.get(sessionId)?.on === true
  /** The sessions that named variables for their commands, each with the names in force now. */
  const environments = new Map<string, CommandEnv>()
  let base: string | null = null

  const sessionDirectory = (sessionId: string) => {
    base ??= privateDirectory(options.tempBase ?? join(tmpdir(), `${brand.directory}-${process.getuid?.() ?? 0}`))
    return join(base, sessionId.replace(/[^A-Za-z0-9_.-]/g, "_"))
  }
  const temp = (sessionId: string): TempDirectory => {
    let dir = temps.get(sessionId)
    if (dir === undefined) {
      dir = sessionDirectory(sessionId)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      temps.set(sessionId, dir)
    }
    // Under bubblewrap the directory is mounted at /tmp; sandbox-exec leaves paths as they are.
    return { dir, alias: bwrap ? "/tmp" : null }
  }
  /** The session's home, beside its temp directory and not inside it: no command sees it under a second name. Made for a session that uses it. */
  const homeRoot = (sessionId: string) => {
    const dir = `${sessionDirectory(sessionId)}.home`
    if (bwrap && homeOn(sessionId)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    return dir
  }
  const policy = (input: Pick<CommandInput, "sessionId" | "cwd" | "run">) =>
    workspacePolicy({
      cwd: input.cwd,
      tempRoot: temp(input.sessionId).dir,
      homeRoot: homeRoot(input.sessionId),
      ownHome: bwrap && homeOn(input.sessionId),
      ...(environments.has(input.sessionId) ? { commandEnv: environments.get(input.sessionId)! } : {}),
      run: input.run,
      home,
      env,
    })

  return {
    state: detection.available ? { available: true } : { available: false, reason: detection.reason, remedy: detection.remedy },
    temp,
    policy,
    sessionHome: {
      use: (sessionId, on) => {
        const known = homes.get(sessionId)
        if (known !== undefined) known.on = on
        else if (on) homes.set(sessionId, { on, mounts: homeMounts() })
      },
      state: (input) => {
        if (!homeOn(input.sessionId) || !detection.available) return { used: false, notice: null }
        if (!bwrap) return { used: false, notice: HOME_NOTICE.backend }
        const own = policy({ ...input, run: { network: false, writableRoots: [] } }).home
        const view = own === undefined ? null : homeView(own)
        if (own === undefined || view === null) return { used: false, notice: null }
        if (view.over !== null) return { used: false, notice: HOME_NOTICE.over(own.path, view.over) }
        const whole = view.layers.filter((layer) => layer.whole)
        return { used: true, notice: whole.length === 0 ? null : HOME_NOTICE.whole(whole.map((layer) => `${join(own.path, layer.directory)} (${layer.count} entries)`)) }
      },
    },
    environment: {
      use: (sessionId, names) => {
        if (names.withhold.length > 0 || names.pass.length > 0) environments.set(sessionId, { withhold: [...names.withhold], pass: [...names.pass] })
        else environments.delete(sessionId)
      },
      unsandboxed: (sessionId) => {
        const withheld = environments.get(sessionId)?.withhold ?? []
        return withheld.length === 0 ? undefined : filterEnv(env, { mode: "deny", names: withheld, stripCredentials: false })
      },
    },
    plan: (input) => {
      const mounts = homes.get(input.sessionId)?.mounts
      const plan = sandboxCommand(
        policy(input),
        { shell: input.command, cwd: input.cwd, ...(input.shellPath === undefined ? {} : { shellPath: input.shellPath }) },
        { env, detection, ...(mounts === undefined ? {} : { homeMounts: mounts }) },
      )
      if (plan.kind !== "ready" || !input.run.network) return plan
      // A download needs a cache it can write. The user's own stays read-only: what is in it runs outside the sandbox later.
      return { ...plan, env: { ...plan.env, BUN_INSTALL_CACHE_DIR: join(plan.env.TMPDIR ?? "/tmp", ".bun-install-cache") } }
    },
    confined: (input) => {
      // Under bubblewrap the root is mounted at /tmp; sandbox-exec leaves paths as they are.
      const seen = bwrap ? "/tmp" : input.root
      return sandboxCommand(confinedPolicy({ ...input, home }), { argv: input.argv(seen), cwd: input.cwd === input.root ? seen : input.cwd }, { env: input.env, detection })
    },
  }
}

/** The policy of `confined`: everything readable that a command may read, nothing writable but `root`, no network, only the named variables. */
export function confinedPolicy(input: Pick<ConfinedInput, "cwd" | "root" | "env"> & { readonly home?: string }): SandboxPolicy {
  const base = defaultPolicy({ workspace: input.cwd, tempRoot: input.root, network: { mode: "off" }, ...(input.home === undefined ? {} : { home: input.home }) })
  return { ...base, writableRoots: [], env: { mode: "allow", names: Object.keys(input.env) } }
}

/** The configuration key that turns a session's home on (`config.ts`), as a person writes it. */
export const SANDBOX_HOME_KEY = "sandbox.home"

/** What the user is told, once, about a session whose home is on and that gets none, or not all of it. */
const HOME_NOTICE = {
  backend: `${SANDBOX_HOME_KEY} is "session", and the sandbox of this machine cannot show a command another directory in place of your home: sandboxed commands see your home as it is, read-only.`,
  over: (path: string, entries: number) =>
    `${SANDBOX_HOME_KEY} is "session", and the session's home is not used: your home directory ${path} has ${entries} entries, and a session's home shows at most ${HOME_BINDS} of them, each by a mount made when a command starts. Sandboxed commands see your home as it is, read-only, and a tool that writes under it fails until you allow the directory.`,
  whole: (directories: readonly string[]) =>
    `${SANDBOX_HOME_KEY} is "session", and the session's home does not hold all of your home: it shows at most ${HOME_BINDS} of your entries one by one, each by a mount made when a command starts. Left as ${directories.length === 1 ? "it is" : "they are"}, yours and read-only as a whole, so that a command can add nothing there: ${directories.join(", ")}.`,
}

/** The policy of a command in `cwd`: the default one, with the session's temp directory and home, the access the decision granted, and the git hardening. */
export function workspacePolicy(input: {
  readonly cwd: string
  readonly tempRoot: string
  /** Where the session's home is kept (`SandboxHome.root`). Without it the command's home is the user's, read-only. */
  readonly homeRoot?: string
  /** `false`: the command's home is the user's, read-only, although the session has a directory for one. Default `true`. */
  readonly ownHome?: boolean
  /** The names the session's commands are not given, and the credential-looking ones they are. Without it the rule alone decides. */
  readonly commandEnv?: CommandEnv
  readonly run: SandboxRun
  readonly home?: string
  readonly env?: Readonly<Record<string, string | undefined>>
}): SandboxPolicy {
  const base = defaultPolicy({
    workspace: input.cwd,
    tempRoot: input.tempRoot,
    ...(input.homeRoot === undefined || input.ownHome === false ? {} : { homeRoot: input.homeRoot }),
    network: { mode: input.run.network ? "on" : "off" },
    ...(input.home === undefined ? {} : { home: input.home }),
    ...(input.env === undefined ? {} : { env: input.env }),
  })
  const git = gitLayout(input.cwd)
  const outside = git === null ? [] : [...new Set([git.gitDir, git.commonDir])].filter((path) => !within(input.cwd, path))
  const writableRoots = [...new Set([...base.writableRoots, ...input.run.writableRoots, ...outside])]
  // A home the command may write as it is stays the user's: the working directory is the home, or holds it.
  const homePath = base.home?.path
  // A command that may write where the session's home is kept would have it under a second name, where it could
  // rename the directories bound into the home: it gets no home of the session's, and that directory is hidden from it.
  const kept = input.homeRoot === undefined || !existsSync(input.homeRoot) ? null : real(input.homeRoot)
  const reached = kept !== null && writableRoots.some((root) => within(real(root), kept) || within(kept, real(root)))
  return {
    ...base,
    home: reached || (homePath !== undefined && writableRoots.some((root) => within(real(root), real(homePath)))) ? undefined : base.home,
    ...(reached ? { hiddenPaths: [...base.hiddenPaths, kept] } : {}),
    writableRoots,
    readOnlyPaths: [...(git === null ? [] : gitProtected(git)), join(input.cwd, `.${brand.directory}`)],
    // The variable that names the file a sign-in is handed in through is never passed: a sandboxed command is not told where that file is.
    ...(input.commandEnv === undefined ? {} : { env: { mode: "deny" as const, names: input.commandEnv.withhold, keep: input.commandEnv.pass.filter((name) => name !== ACCESS_TOKEN_FILE_ENV) } }),
  }
}

export interface GitLayout {
  /** The directory `.git` is, or points to (a linked worktree's own directory under the main repository's). */
  readonly gitDir: string
  /** Where objects, refs, hooks and the configuration are: `gitDir`, or the main repository's for a worktree. */
  readonly commonDir: string
}

/** The git directory of the repository `cwd` is in, found the way git finds it: `.git` here or in the nearest parent. */
export function gitLayout(cwd: string): GitLayout | null {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const entry = join(dir, ".git")
    const info = statOrNull(entry)
    if (info?.isDirectory()) return { gitDir: entry, commonDir: entry }
    if (info?.isFile()) {
      // A worktree or a submodule: `.git` is a file naming the real directory.
      const named = /^gitdir:\s*(.+)$/m.exec(readOrNull(entry) ?? "")?.[1]?.trim()
      if (named === undefined) return null
      const gitDir = isAbsolute(named) ? named : resolve(dir, named)
      const common = readOrNull(join(gitDir, "commondir"))?.trim()
      return { gitDir, commonDir: common === undefined || common === "" ? gitDir : isAbsolute(common) ? common : resolve(gitDir, common) }
    }
    if (dirname(dir) === dir) return null
  }
}

/** What stays read-only in a repository's git directory. The hooks directory is created when it is missing, so that it can be. */
function gitProtected(git: GitLayout): string[] {
  const hooks = join(git.commonDir, "hooks")
  try {
    mkdirSync(hooks)
  } catch {
    // It exists (the usual case), or the directory cannot be written: nothing to protect that is not protected already.
  }
  return [...new Set([hooks, join(git.commonDir, "config"), join(git.gitDir, "config"), join(git.gitDir, "config.worktree"), join(git.gitDir, "hooks")])]
}

/** `path` as a directory only this user can enter: made if missing, replaced by a fresh one when it is someone else's or open to others. */
function privateDirectory(path: string): string {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 })
    const info = lstatSync(path)
    const uid = process.getuid?.()
    if (info.isDirectory() && (uid === undefined || info.uid === uid)) {
      if ((info.mode & 0o077) !== 0) chmodSync(path, 0o700)
      return path
    }
  } catch {
    // Fall through to a directory of our own.
  }
  return mkdtempSync(join(tmpdir(), `${brand.directory}-`))
}

function within(root: string, path: string) {
  return path === root || path.startsWith(root === "/" ? "/" : `${root}/`)
}

function real(path: string) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function statOrNull(path: string) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

function readOrNull(path: string) {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}
