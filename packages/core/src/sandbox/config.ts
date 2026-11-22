/**
 * The `sandbox` configuration section, in the style of `config/schema.ts`
 * (every key optional, unknown keys rejected).
 *
 *   "sandbox": { "home": "session", "withholdEnv": ["SENTRY_DSN"], "passEnv": ["DEPLOY_KEY"] }
 *
 * - `home` (default `"user"`): what a sandboxed command finds at the home
 *   directory's path. `"user"`: the user's home, read-only. `"session"`: on
 *   Linux a home of the session's own, with the user's entries read-only in
 *   it (`bwrap.ts`, `homeArgs`).
 * - `withholdEnv` (default none): names of environment variables that no
 *   command of the session is given, whatever the name looks like, sandboxed
 *   or not (`command.ts`, `CommandEnvironments`).
 * - `passEnv` (default none): names that look like credentials
 *   (`isCredentialName`) and that a sandboxed command is given all the same.
 *   A name in both lists is withheld.
 *
 * Both lists hold names only: the values are in the environment already.
 *
 * Who may say what: with a session's home, a write under the home that would
 * fail succeeds and is kept for the session only, and every command starts
 * slower by a time that grows with the home. That is the user's to choose, as
 * the approval mode is, so only the user's own file, or the client that
 * opens the session for the user, turns it on; a project's file can only
 * turn it off (`"home": "user"`).
 *
 * The two lists say which of the user's variables the commands of a
 * repository get, so they are the user's as well, and a project's file sets
 * neither. `passEnv` there would let a repository hand itself the user's
 * credentials. `withholdEnv` there looks like it could only take away, and
 * does not: the user's own hooks and checks run in the same environment, and
 * one that reads a variable to decide (a hook that refuses a call while
 * `STRICT` is set) would be switched off by a repository that withholds it.
 */
import { ConfigError } from "../config/schema.ts"
import { SANDBOX_HOME_KEY } from "./command.ts"

export const sandboxHomeChoices = ["user", "session"] as const
export type SandboxHomeChoice = (typeof sandboxHomeChoices)[number]

export interface SandboxConfigSection {
  readonly home?: SandboxHomeChoice
  readonly withholdEnv?: readonly string[]
  readonly passEnv?: readonly string[]
}

/** What of the environment the commands of a session get besides the rule: the names no command is given, and the credential-looking names a sandboxed one is. */
export interface CommandEnv {
  readonly withhold: readonly string[]
  readonly pass: readonly string[]
}

const KEYS = ["home", "withholdEnv", "passEnv"]
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
/** More names than any environment has variables worth naming; a longer list is a mistake. */
export const MAX_ENV_NAMES = 256

/** A list of environment variable names, without repeats, or `null` when `value` is not one. */
export function envNames(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_ENV_NAMES) return null
  if (!value.every((name): name is string => typeof name === "string" && ENV_NAME.test(name))) return null
  return [...new Set(value)]
}

/** Validates the value of the `sandbox` key of one file. Throws `ConfigError` naming the file and path. */
export function parseSandboxSection(value: unknown, file: string): SandboxConfigSection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ConfigError(file, "sandbox", "expected an object")
  const record = value as Record<string, unknown>
  const unknown = Object.keys(record).find((key) => !KEYS.includes(key))
  if (unknown !== undefined) throw new ConfigError(file, `sandbox.${unknown}`, `unknown key "${unknown}"; known keys: ${KEYS.join(", ")}`)
  if (record.home !== undefined && !(sandboxHomeChoices as readonly unknown[]).includes(record.home)) throw new ConfigError(file, SANDBOX_HOME_KEY, `expected one of: ${sandboxHomeChoices.join(", ")}`)
  const names = (key: "withholdEnv" | "passEnv") => {
    if (record[key] === undefined) return {}
    const list = envNames(record[key])
    if (list === null) throw new ConfigError(file, `sandbox.${key}`, `expected a list of at most ${MAX_ENV_NAMES} environment variable names (letters, digits and _)`)
    return { [key]: list }
  }
  return { ...(record.home === undefined ? {} : { home: record.home as SandboxHomeChoice }), ...names("withholdEnv"), ...names("passEnv") }
}

/**
 * Whether a session's sandboxed commands get a home of the session's own.
 * `user` is the user file's section, `session` what the client that opened
 * the session chose for it (it counts as the user's and goes on top), and
 * `project` the project file's, which can only turn the home off. `ignored`
 * is set when the project's file asked for a session's home that the user
 * did not: one line for the user.
 */
export function resolveSandboxHome(sections: {
  readonly user: SandboxConfigSection | undefined
  readonly session: SandboxHomeChoice | null
  readonly project: SandboxConfigSection | undefined
}): { readonly home: SandboxHomeChoice; readonly ignored: string | null } {
  const chosen = sections.session ?? sections.user?.home ?? "user"
  if (chosen === "user")
    return { home: "user", ignored: sections.project?.home === "session" ? `${SANDBOX_HOME_KEY} "session" (yours is "user")` : null }
  return { home: sections.project?.home === "user" ? "user" : "session", ignored: null }
}

/**
 * What of the environment a session's commands get besides the rule. `user`
 * is the user file's section and `session` what the client that opened the
 * session named for it: both count as the user's, and their lists add up.
 * `project` is the project file's, which sets neither list. `ignored` is set
 * when it names any: one line for the user.
 */
export function resolveCommandEnv(sections: {
  readonly user: SandboxConfigSection | undefined
  readonly session: CommandEnv | null
  readonly project: SandboxConfigSection | undefined
}): CommandEnv & { readonly ignored: string | null } {
  const named = (["withholdEnv", "passEnv"] as const).flatMap((key) => {
    const names = sections.project?.[key] ?? []
    return names.length === 0 ? [] : [`sandbox.${key} (${names.join(", ")})`]
  })
  return {
    withhold: [...new Set([...(sections.user?.withholdEnv ?? []), ...(sections.session?.withhold ?? [])])],
    pass: [...new Set([...(sections.user?.passEnv ?? []), ...(sections.session?.pass ?? [])])],
    ignored: named.length === 0 ? null : named.join(" and "),
  }
}
