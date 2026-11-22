/**
 * OS-level sandbox for shell commands. `sandboxCommand` turns a policy and a
 * command into the argv and environment to spawn, or explains why this
 * machine cannot sandbox. It spawns nothing itself; see README.md for how the
 * shell tool is expected to use it.
 */
import { type HomeMounts, bwrapArgv, homeCommand } from "./bwrap.ts"
import { type SandboxBackend, type SandboxDetection, detectSandbox } from "./detect.ts"
import { type SandboxPolicy, assertValidPolicy, filterEnv } from "./policy.ts"
import { seatbeltArgv } from "./seatbelt.ts"

export { detectSandbox, type DetectOptions, type SandboxBackend, type SandboxDetection } from "./detect.ts"
export {
  type DefaultPolicyOptions,
  type EnvPolicy,
  type NetworkPolicy,
  type SandboxHome,
  type SandboxPolicy,
  defaultHiddenPaths,
  defaultPolicy,
  filterEnv,
  isCredentialName,
  sharedHomeDirectories,
} from "./policy.ts"
export { seatbeltProfile } from "./seatbelt.ts"
export { type HomeLayer, type HomeMounts, HOME_BINDS, homeMounts, homeView } from "./bwrap.ts"
export {
  type CommandEnvironments,
  type CommandInput,
  type CommandSandbox,
  type CommandSandboxOptions,
  type ConfinedInput,
  type GitLayout,
  type SessionHomes,
  confinedPolicy,
  createCommandSandbox,
  gitLayout,
  workspacePolicy,
} from "./command.ts"
export { type CommandEnv, type SandboxConfigSection, type SandboxHomeChoice, MAX_ENV_NAMES, envNames, parseSandboxSection, resolveCommandEnv, resolveSandboxHome, sandboxHomeChoices } from "./config.ts"

export type SandboxCommand =
  | { readonly argv: readonly string[]; readonly cwd: string }
  /** Run with `<shellPath> -c <shell>`. Default shell: `bash` from PATH, else `/bin/sh`. */
  | { readonly shell: string; readonly shellPath?: string; readonly cwd: string }

export type SandboxPlan = {
  readonly kind: "ready"
  readonly backend: SandboxBackend
  /** Spawn exactly this, detached (own process group), with `env` and `cwd`. */
  readonly argv: string[]
  readonly env: Record<string, string>
  readonly cwd: string
  /**
   * Whether a SIGTERM to the process group gives the command a grace period
   * (true), or kills the whole sandbox immediately (false: Linux without GNU
   * env). SIGKILL to the group always kills everything.
   */
  readonly gracefulTermination: boolean
  /**
   * Set for a command planned with `homeMounts` that got the home. The
   * caller says which process it spawned for the plan (`started`, right
   * after spawning it) and when that process has exited (`ended`); for a
   * plan it spawns nothing for, `ended` alone. The command counts as running
   * until then and until nothing of its sandbox is left, and the home keeps
   * the mounts it has. `ended` resolves when the command is over, or after a
   * moment when its sandbox is not empty yet (`homeCommand` in `bwrap.ts`).
   */
  readonly started?: (pid: number) => void
  readonly ended?: () => Promise<void>
}

export type SandboxUnavailable = {
  readonly kind: "unavailable"
  readonly backend: SandboxBackend | null
  readonly reason: string
  readonly remedy: string | null
  readonly detail: string | null
}

export interface SandboxCommandOptions {
  /** The environment to filter for the child. Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** A detection to use instead of `detectSandbox()` (which is cached). */
  readonly detection?: SandboxDetection
  /** Linux: the mode-000 file bound over hidden files. Default: one per user under the temp directory. */
  readonly maskFile?: string
  /** Linux: what the commands that run with `policy.home` have mounted in it, for a caller that runs several at a time (`HomeMounts` in `bwrap.ts`). */
  readonly homeMounts?: HomeMounts
}

export function sandboxCommand(policy: SandboxPolicy, command: SandboxCommand, options: SandboxCommandOptions = {}): SandboxPlan | SandboxUnavailable {
  assertValidPolicy(policy)
  const detection = options.detection ?? detectSandbox()
  if (!detection.available) return { kind: "unavailable", backend: detection.backend, reason: detection.reason, remedy: detection.remedy, detail: detection.detail }

  const argv = "argv" in command ? [...command.argv] : [command.shellPath ?? Bun.which("bash") ?? "/bin/sh", "-c", command.shell]
  const env = filterEnv(options.env ?? process.env, policy.env)
  if (detection.backend === "bwrap") {
    const mounts = options.homeMounts
    const running = mounts?.running ?? 0
    const wrapped = bwrapArgv(policy, argv, command.cwd, { bwrapPath: detection.bwrapPath, envPath: detection.envPath, maskFile: options.maskFile, ...(mounts === undefined ? {} : { homeMounts: mounts }) })
    return {
      kind: "ready",
      backend: "bwrap",
      argv: wrapped,
      // Inside, /tmp is the private tmpfs or the temp root; a host TMPDIR would point at a read-only or missing path.
      env: { ...env, TMPDIR: "/tmp" },
      cwd: command.cwd,
      gracefulTermination: detection.envPath !== null,
      // The command got the home: it is followed until its sandbox is empty.
      ...(mounts !== undefined && mounts.running > running ? homeCommand(mounts) : {}),
    }
  }
  return {
    kind: "ready",
    backend: "seatbelt",
    argv: seatbeltArgv(policy, argv, detection.sandboxExecPath),
    env: policy.tempRoot ? { ...env, TMPDIR: policy.tempRoot } : env,
    cwd: command.cwd,
    gracefulTermination: true,
  }
}
