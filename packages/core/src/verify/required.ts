/**
 * Required checks, and whose each check of a session is. Pure.
 *
 * A project's file replaces the user's `checks` whole and sets `verify`, and
 * the agent can edit that file: `"checks": []` or `"verify": { "mode": "off" }`
 * there runs nothing from the next turn on. That is right for the checks a
 * project keeps for itself and wrong for the ones whoever starts the harness
 * needs to have run. Those are named apart, as required checks:
 *
 * - `requiredChecks` in the user's own configuration file;
 * - the checks the client that opens a session names for it (they count as
 *   the user's, as the session's home and its environment lists do). A name
 *   in both is the client's.
 *
 * A project's file names none: `requiredChecks` there is not followed
 * (`ignored`, one line for the user).
 *
 * What `planChecks` makes of the two kinds:
 *
 * - the required checks come first, the user's file's and then the client's,
 *   and after them the configuration's own (`checks`, a project's list
 *   replacing the user's, as ever). A configuration's check with the name of
 *   a required one is left out (`shadowed`): under that name the required
 *   check runs and is reported;
 * - `verify.mode` decides about the configuration's own checks only. With
 *   `off` they are not in the plan. A required check is gated whatever the
 *   mode says, in either file: it is taken out of the list to stop it;
 * - while a required check fails, the model is sent back as often as the
 *   user's own file says (`verify.maxRounds` there, else the default), never
 *   as the project's does (`required.maxRounds`, read by the gate).
 *
 * With no required check the plan is the configuration's checks under the
 * merged `verify`, which is what the step loop did before there were any.
 *
 * What the step loop must do with a required check besides running it: run
 * it in the session's working directory and match its `when` patterns there
 * (`under`), not in the project directory, which is wherever a project file
 * happens to be; and when it cannot run a required check at all (commands are
 * sandboxed here and there is no sandbox), record it as one that could not
 * start instead of ending the turn as done with nothing checked.
 *
 * And it must know which required checks stand on the state it selects
 * checks against (`stands`). Checks are selected by what changed since a
 * verified state, and a check that covers nothing that changed is not run:
 * its result on that state is taken to hold. That is true of a required
 * check only if it was a required check, with the command it has now, when
 * that state was recorded. A client may name other checks when it opens the
 * session again, and the user's file may change. So every record that moves
 * the verified state on (a run that passed, an ending that needed no check)
 * names the required checks that stand on the new state, and the loop keeps
 * to this: a required check that does not stand is run at the end of a turn
 * that changed a file, whatever the file, and stands from the run it passes
 * in; and an ending that needed no check names only those that stand.
 */
import { type CheckConfig, type Config, type ConfigFile, DEFAULT_VERIFY, type VerifyMode, checkList, resolveChecks } from "../config/schema.ts"
import { type Infer, array, nonEmptyString, object, oneOf } from "../validate.ts"

/**
 * Who named a check: the user's own configuration file (`user`), the client
 * that opened the session (`session`), or the project's file (`project`).
 */
export const checkOrigin = oneOf(["user", "session", "project"])
export type CheckOrigin = Infer<typeof checkOrigin>

/** What the step loop knows about a check beyond its configuration. Each is absent where a caller has only the configuration. */
export interface CheckStanding {
  /** `null`: not known (the engine was handed a configuration without the files it came from). */
  readonly origin?: CheckOrigin | null
  /** Whether a project's file can neither replace the check nor switch it off. */
  readonly required?: boolean
  /**
   * The directory the check's `when` patterns are relative to, as the prefix
   * it has in paths relative to the project directory (`""`, or `packages/a/`).
   * Set for a required check, whose patterns are relative to the session's
   * working directory.
   */
  readonly under?: string
}

/** A check as a session runs it. */
export type SessionCheck = CheckConfig & CheckStanding & { readonly origin: CheckOrigin | null; readonly required: boolean }

export interface CheckPlan {
  /** Every check that can apply to a turn, in the order they run and are reported. */
  readonly checks: readonly SessionCheck[]
  /** What is done with the configuration's own checks: the merged `verify`. */
  readonly mode: VerifyMode
  readonly maxRounds: number
  /** The names of the required checks and how often the model is sent back while one of them fails; `null` when there is none. */
  readonly required: { readonly names: readonly string[]; readonly maxRounds: number } | null
  /** What a project's file said that is not followed, for one line to the user; `null` when nothing. */
  readonly ignored: string | null
  /** The configuration's checks that are left out because a required check has their name. */
  readonly shadowed: readonly string[]
}

export function planChecks(input: {
  /** Both files merged, with the defaults. */
  readonly config: Pick<Config, "checks" | "verify">
  /** The files as written, apart; `null` when the caller has only the merged configuration. */
  readonly files: { readonly user: ConfigFile | null; readonly project: ConfigFile | null } | null
  /** The checks the client that opened the session named for it; `null` when it named none. */
  readonly session: readonly CheckConfig[] | null
}): CheckPlan {
  const session = input.session ?? []
  const fromUser = resolveChecks(input.files?.user?.requiredChecks).filter((check) => !session.some((other) => other.name === check.name))
  const required: SessionCheck[] = [
    ...fromUser.map((check) => ({ ...check, origin: "user" as const, required: true })),
    ...session.map((check) => ({ ...check, origin: "session" as const, required: true })),
  ]
  // The merge rule, said once: a project's list replaces the user's whole, so the list is all of one file's.
  const origin: CheckOrigin | null = input.files === null ? null : input.files.project?.checks !== undefined ? "project" : "user"
  const own = input.config.verify.mode === "off" ? [] : input.config.checks
  const shadowed = own.filter((check) => required.some((other) => other.name === check.name)).map((check) => check.name)
  const named = input.files?.project?.requiredChecks ?? []
  return {
    checks: [...required, ...own.filter((check) => !shadowed.includes(check.name)).map((check) => ({ ...check, origin, required: false }))],
    mode: input.config.verify.mode,
    maxRounds: input.config.verify.maxRounds,
    required: required.length === 0 ? null : { names: required.map((check) => check.name), maxRounds: input.files?.user?.verify?.maxRounds ?? DEFAULT_VERIFY.maxRounds },
    ignored: named.length === 0 ? null : `requiredChecks (${named.map((check) => check.name).join(", ")})`,
    shadowed,
  }
}

/**
 * The checks a client names when it opens a session, from what it sent: a
 * list written as `requiredChecks` is in a configuration file, with the same
 * keys, the same rules and the same defaults. Throws `DecodeError` with the
 * path of the value that is wrong.
 */
export function sessionChecks(value: unknown, path: string): CheckConfig[] {
  return resolveChecks(checkList(value, path))
}

/**
 * A required check of a session, as a record names it: its `name`, and `definition`, a digest (SHA-256, hex) of
 * what it runs: the command, the timeout, its patterns and the directory they are relative to. Two records name
 * the same check when both are the same.
 */
export const requiredCheckRef = object({ name: nonEmptyString, definition: nonEmptyString })
export type RequiredCheckRef = Infer<typeof requiredCheckRef>
export const requiredCheckRefs = array(requiredCheckRef)

/** How a record names the required check `check` (`requiredCheckRef`). What a fingerprint holds of a check apart from the files (`fingerprint.ts`). */
export function requiredCheckRefOf(check: CheckConfig & CheckStanding): RequiredCheckRef {
  const material = JSON.stringify(["v1", check.command, check.timeoutSeconds, check.when, check.under ?? ""])
  return { name: check.name, definition: new Bun.CryptoHasher("sha256").update(material).digest("hex") }
}

/**
 * The required checks that stand on a verified state: `null` for the state a session starts from, which every
 * check stands on (nothing of the agent's is in it), a list where a record says which, and `undefined` where the
 * state was recorded without saying, which none stands on (no check was required then, or the record was written
 * before this was kept).
 */
export type Standing = readonly RequiredCheckRef[] | null | undefined

/** Whether `check` stands on a verified state with `standing`. */
export function stands(standing: Standing, check: RequiredCheckRef): boolean {
  if (standing === null) return true
  return standing !== undefined && standing.some((other) => other.name === check.name && other.definition === check.definition)
}
