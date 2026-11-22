/**
 * Whether a turn may end. Pure: the step loop calls it each time the model
 * stops without tool calls, and does what it says.
 *
 * Definitions the loop keeps:
 * - `selected`: `selectChecks(config.checks, files changed since the last
 *   verification in which every selected check passed)`, by name.
 * - `latest`: the results of the most recent run of checks in this turn, in run
 *   order; empty when none has run.
 * - `changedSinceLatest`: whether the model changed a file after `latest` was produced.
 * - `reportsSent`: how many times this turn the model was sent a failing report
 *   (`report_and_continue`). This, not the number of runs, is what `maxRounds` bounds:
 *   every run follows a change, and every change after the first run follows a report,
 *   so a turn runs checks at most `maxRounds + 1` times.
 * - `acknowledgement`: see `acknowledge.ts`.
 * - `required`: the required checks of the session (`required.ts`), when it has any. `mode` and `maxRounds` are
 *   the merged configuration's, a project's file included, and say what is done with the configuration's own
 *   checks; a required check is gated whatever they say. So the loop leaves the configuration's checks out of
 *   `selected` when `mode` is `off`, and with a required check the gate goes on where it would have stopped:
 *   a failing required check sends the model back also in mode `report`, and as often as `required.maxRounds`
 *   says, not as `maxRounds` does.
 *
 * Results that were interrupted say nothing about the code, so `latest` with an
 * interrupted result is treated as if the checks had not run.
 *
 * A check that was never started says nothing about the code either (`neverStarted`: the harness could not start
 * its command at all, for example because commands run only in a sandbox here and there is none), and no change
 * to the code makes it start. So the model is never sent back for one. When every check that did not pass is one
 * of those, the turn ends unresolved at once (`not_started`), whatever the mode and the rounds say, and nothing is
 * left for the model to acknowledge. When others failed on the code, the gate decides from those alone: they are
 * what the model is sent back for, what an acknowledgement has to name, and what decides whether a required
 * check is among them; `failing` still names every check that did not pass.
 */
import type { VerifyMode } from "../config/schema.ts"
import type { Acknowledgement } from "./acknowledge.ts"
import { type CheckStatus, isFailure, neverStarted } from "./status.ts"

export interface GateInput {
  readonly mode: VerifyMode
  readonly maxRounds: number
  readonly selected: readonly string[]
  /** `exitCode` is `null` for a check that was never started (`neverStarted`). */
  readonly latest: readonly { readonly name: string; readonly status: CheckStatus; readonly exitCode?: number | null }[]
  readonly changedSinceLatest: boolean
  readonly reportsSent: number
  readonly acknowledgement: Acknowledgement | null
  /** Absent: the session has no required check, and the decision is the one `mode` and `maxRounds` give. */
  readonly required?: { readonly names: readonly string[]; readonly maxRounds: number }
}

export type GateDecision =
  /** End the turn. Either nothing needed checking or every check passed. */
  | { readonly kind: "finish" }
  /** Run these checks now, then call `decideGate` again with their results. */
  | { readonly kind: "run_checks"; readonly checks: readonly string[] }
  /** Send `renderReport(latest)` to the model as a message and continue the turn. */
  | { readonly kind: "report_and_continue"; readonly failing: readonly string[] }
  /** End the turn with these checks recorded as failing. */
  | { readonly kind: "finish_unresolved"; readonly reason: UnresolvedReason; readonly failing: readonly string[] }

/**
 * - `acknowledged`: the model reported, with the acknowledgement tool, every failing check as one it cannot fix.
 * - `max_rounds`: the model was already sent `maxRounds` failing reports this turn.
 * - `report_mode`: mode `report` records failures but never sends the model back.
 */
export type UnresolvedReason = "acknowledged" | "max_rounds" | "report_mode" | "not_started"

export function decideGate(input: GateInput): GateDecision {
  const required = input.required?.names ?? []
  if (input.mode === "off" && required.length === 0) return { kind: "finish" }
  const current = input.latest.length > 0 && !input.changedSinceLatest && !input.latest.some((result) => result.status === "interrupted")
  if (!current) return input.selected.length === 0 ? { kind: "finish" } : { kind: "run_checks", checks: input.selected }
  // With `off` only required checks ran; a result of any other says nothing the mode lets the gate act on.
  const failed = input.latest.filter((result) => isFailure(result.status) && (input.mode !== "off" || required.includes(result.name)))
  const failing = failed.map((result) => result.name)
  if (failing.length === 0) return { kind: "finish" }
  // What the model can do something about: the checks that ran and did not pass.
  const fixable = failed.filter((result) => !neverStarted(result)).map((result) => result.name)
  if (fixable.length === 0) return { kind: "finish_unresolved", reason: "not_started", failing }
  const requiredFails = fixable.some((name) => required.includes(name))
  if (!requiredFails && input.mode !== "gate") return { kind: "finish_unresolved", reason: "report_mode", failing }
  if (acknowledges(input.acknowledgement, fixable)) return { kind: "finish_unresolved", reason: "acknowledged", failing }
  if (input.reportsSent >= (requiredFails ? input.required!.maxRounds : input.maxRounds)) return { kind: "finish_unresolved", reason: "max_rounds", failing }
  return { kind: "report_and_continue", failing }
}

/**
 * An acknowledgement counts only when it names every failing check; naming
 * more is harmless. The report shows a check as `name (command)`, and a model
 * copies what it is shown, so a check is also named by that whole label:
 * `test (bun test)` names `test`. Check names contain no space or bracket, so
 * the prefix cannot be mistaken for another check's name.
 */
function acknowledges(acknowledgement: Acknowledgement | null, failing: readonly string[]) {
  if (acknowledgement === null) return false
  const named = acknowledgement.checks.map((given) => given.trim())
  return failing.every((name) => named.some((given) => given === name || given.startsWith(`${name} (`)))
}
