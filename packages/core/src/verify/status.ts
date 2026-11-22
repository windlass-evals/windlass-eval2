/**
 * How one check ended. Declared apart from the code that runs checks, so the
 * durable event schema can name a check's status without importing the shell tool.
 */
import { type Infer, oneOf } from "../validate.ts"

export const checkStatus = oneOf(["passed", "failed", "timed_out", "could_not_start", "interrupted"])
export type CheckStatus = Infer<typeof checkStatus>

/** A status that means the check did not pass. `interrupted` is not one: the check did not finish. */
export function isFailure(status: CheckStatus): boolean {
  return status === "failed" || status === "timed_out" || status === "could_not_start"
}

/**
 * Whether a check's result is that it was never started: the harness could not start its command at all, so
 * there is no exit code. A command the shell could not find or execute (exit code 126 or 127) has the same
 * status and is not one of these: the shell ran, and what it did not find may be the code's to provide.
 */
export function neverStarted(result: { readonly status: CheckStatus; readonly exitCode?: number | null }): boolean {
  return result.status === "could_not_start" && result.exitCode === null
}
