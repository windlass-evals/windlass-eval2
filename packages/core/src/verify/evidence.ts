/**
 * What one run of checks showed, as a record the step loop can attach to a
 * durable event (for example the turn's completion) so that "done" can be shown
 * to rest on something.
 *
 * The evidence is a report of what a run found, and the one stored shape a
 * later build may add keys to (`extensible`): a key this build does not know
 * is kept as it is and written back unchanged, so a session whose runs a
 * later build recorded more about still opens here. That holds for the
 * evidence of a run, each check in it and the end of a check's output, and
 * for nothing else in the log. A key is added to them only when it adds to
 * what the others say: what a reader must act on to keep the session's state
 * right (a new status, anything the gate decides from) is not added this way.
 */
import type { CheckConfig } from "../config/schema.ts"
import { type OutputLimits, cutTail } from "../tool/cap.ts"
import { type Infer, array, boolean, extensible, integer, nonEmptyString, nullable, object, optional, string } from "../validate.ts"
import { type CheckStanding, type RequiredCheckRef, checkOrigin, requiredCheckRefs } from "./required.ts"
import { filesFor } from "./select.ts"
import type { CheckOutput, CheckResult } from "./run.ts"
import { checkStatus, isFailure } from "./status.ts"

/**
 * How much of a check's output the evidence itself carries: its last lines,
 * where a test runner prints which tests failed and the totals. The evidence
 * is in the log three times for a turn's last run (`checks.finished`, the
 * execution's ending, the turn's) and goes to a client with every turn
 * ending, so the tail is a few dozen lines, not the report's 50 KiB: enough
 * to say what failed without reaching into the machine for the file that
 * `outputPath` names, which still holds all of it.
 */
export const OUTPUT_TAIL_LIMITS: OutputLimits = { maxBytes: 4096, maxLines: 60 }

const decoder = new TextDecoder()

/**
 * The end of a check's output within `limits`, from a line start (or, inside
 * one line longer than the limit, from a character boundary that splits no
 * redaction placeholder). `truncated`: the output has more before it.
 */
export function outputTailOf(output: CheckOutput, limits: OutputLimits = OUTPUT_TAIL_LIMITS): OutputTail {
  const { tail, tailAtLineStart, totalBytes } = output.source
  const start = cutTail(tail, tailAtLineStart, limits.maxBytes, limits.maxLines)
  return { text: decoder.decode(tail.subarray(start)), truncated: tail.length - start < totalBytes }
}

/**
 * The end of a check's output, as the evidence of a run carries it. `text` is
 * the last lines of the output (at most 4096 bytes and 60 lines), redacted
 * like the output itself. `truncated` says that the output has more before
 * it: all of it is in the file the check's `outputPath` names.
 */
export const outputTail = extensible({ text: string, truncated: boolean })
export type OutputTail = Infer<typeof outputTail>

/**
 * One check of a run. `origin` is who named the check: the user's own
 * configuration file (`user`), the client that opened the session
 * (`session`), or the project's file (`project`). `required` is whether it
 * is a required check, which a project's file can neither replace nor switch
 * off. `outputTail` is the end of the output when the check ran in this run
 * and did not pass, or passed and its configuration asks for it
 * (`outputTail: "always"`), and `null` otherwise. `startError` is why the
 * command could not be started at all. A record written before these four
 * existed has none of them; `origin` is also absent where the engine was
 * handed a configuration without the files it came from.
 */
export const checkEvidence = extensible({
  name: nonEmptyString,
  command: string,
  status: checkStatus,
  exitCode: nullable(integer()),
  signal: nullable(string),
  durationMs: integer(0),
  /** The changed files that selected this check, sorted. */
  files: array(string),
  /** `fingerprintCheck` at the time the check ran. */
  fingerprint: nonEmptyString,
  /**
   * `null` when the check ran in this run. Otherwise it did not: it passed
   * in an earlier run, recorded by the `checks.finished` at this `seq`, and
   * what it depends on is byte for byte what it was then (the same
   * `fingerprint`), so that result was carried over. Only a pass is ever carried.
   */
  reusedFromSeq: nullable(integer(1)),
  /** The full output, named by its content. */
  outputPath: nullable(string),
  outputBytes: integer(0),
  outputLines: integer(0),
  /**
   * Who named the check (`required.ts`): the user's own configuration file, the client that opened the session, or
   * the project's file. Absent in a record written before origins were recorded, and where the engine was handed
   * a configuration without the files it came from.
   */
  origin: optional(checkOrigin),
  /** Whether the check is a required one, which a project's file can neither replace nor switch off. Absent in a record written before there were any. */
  required: optional(boolean),
  /**
   * The end of the output, when the check ran in this run and did not pass, or passed and asks for it
   * (`outputTail: "always"` in its configuration); `null` otherwise. Absent in a record written before tails were kept.
   */
  outputTail: optional(nullable(outputTail)),
  /** Why the command could not be started at all, when that is how the check ended (`could_not_start` with no exit code). */
  startError: optional(nonEmptyString),
})
export type CheckEvidence = Infer<typeof checkEvidence>

/**
 * The verified state that changes are measured from, as a record names it. `seq` is where in the log that state
 * was recorded: the session's first snapshot, a run of checks that passed (its `checks.finished`), or an ending
 * that needed no check. `run` is the run of checks that last passed on the way to it, by the `seq` of its
 * `checks.finished` and its number in its turn: nothing the checks cover changed between that run and the state.
 * `run` is `null` when no run has passed up to it: the state is then what the session started from, give or take
 * files no check covers, and no check has verified it. `run` is absent where the state was recorded before runs
 * were kept with it.
 */
export const verifiedState = object({ seq: integer(1), run: optional(nullable(object({ seq: integer(1), run: integer(1) }))) })
export type VerifiedState = Infer<typeof verifiedState>

/**
 * The evidence of one run of checks. `changedFiles` is every file that differs from the verified state `since`
 * names; `checks` is the checks that ran or whose earlier pass was carried over. `requiredChecks` is the
 * session's required checks when the run was made, in their order, run or not: a required check that is not in
 * `checks` covers none of `changedFiles` and stands on the state `since` names. `since` and `requiredChecks`
 * are absent in a record written before they were kept; `requiredChecks` also when the session has none.
 */
export const verificationEvidence = extensible({
  /** 1 for the first run of checks in the turn, then 2, ... */
  run: integer(1),
  /** The `seq` of the latest durable event of the session when the checks started. */
  afterSeq: integer(0),
  /** Every file changed since the last fully passing verification, sorted. */
  changedFiles: array(string),
  checks: array(checkEvidence),
  /** The verified state `changedFiles` is measured from. Absent in a record written before it was kept, and where no state was verified yet. */
  since: optional(verifiedState),
  /** The session's required checks when the run was made, run or not (`required.ts`). Absent when it has none, and in a record written before they were kept. */
  requiredChecks: optional(requiredCheckRefs),
})
export type VerificationEvidence = Infer<typeof verificationEvidence>

export function buildEvidence(input: {
  readonly run: number
  readonly afterSeq: number
  readonly changedFiles: readonly string[]
  readonly checks: readonly (CheckConfig & CheckStanding)[]
  readonly results: readonly CheckResult[]
  /** By check name, computed when the run started. */
  readonly fingerprints: Readonly<Record<string, string>>
  /** Checks that were not run because their last pass still stands, with the `seq` that pass was recorded at. */
  readonly reused?: readonly { readonly check: CheckConfig & CheckStanding; readonly fromSeq: number }[]
  /**
   * The harness's redaction of tool output, for what the evidence carries of a check's output. The output is
   * redacted as it arrives where the runner was handed the redaction; this covers a value known only since.
   */
  readonly redact?: (text: string) => string
  /** The verified state `changedFiles` is measured from, when there is one. */
  readonly since?: VerifiedState
  /** The session's required checks, run or not. */
  readonly requiredChecks?: readonly RequiredCheckRef[]
}): VerificationEvidence {
  const redact = input.redact ?? ((text: string) => text)
  const standing = (check: (CheckConfig & CheckStanding) | undefined) => ({
    ...(check?.origin == null ? {} : { origin: check.origin }),
    required: check?.required === true,
  })
  const carried = (input.reused ?? []).map(({ check, fromSeq }): CheckEvidence => ({
    name: check.name,
    command: check.command,
    status: "passed" as const,
    exitCode: 0,
    signal: null,
    durationMs: 0,
    files: filesFor(check, input.changedFiles),
    fingerprint: input.fingerprints[check.name] ?? "",
    reusedFromSeq: fromSeq,
    outputPath: null,
    outputBytes: 0,
    outputLines: 0,
    ...standing(check),
    outputTail: null,
  }))
  const order = new Map(input.checks.map((check, index) => [check.name, index]))
  return verificationEvidence(
    {
      run: input.run,
      afterSeq: input.afterSeq,
      changedFiles: [...new Set(input.changedFiles)].sort(),
      checks: input.results.map((result): CheckEvidence => {
        const config = input.checks.find((check) => check.name === result.name)
        const shown = isFailure(result.status) || (result.status === "passed" && config?.outputTail === "always")
        const tail = shown ? outputTailOf(result.output) : null
        return {
          name: result.name,
          command: result.command,
          status: result.status,
          exitCode: result.exitCode,
          signal: result.signal,
          durationMs: result.durationMs,
          files: config === undefined ? [] : filesFor(config, input.changedFiles),
          fingerprint: input.fingerprints[result.name] ?? "",
          reusedFromSeq: null,
          outputPath: result.output.path,
          outputBytes: result.output.totalBytes,
          outputLines: result.output.totalLines,
          ...standing(config),
          outputTail: tail === null ? null : { ...tail, text: redact(tail.text) },
          ...(result.startError === null || result.startError === "" ? {} : { startError: redact(result.startError) }),
        }
      })
        .concat(carried)
        // The configuration's order, whether a check ran or was carried over.
        .sort((a, b) => (order.get(a.name) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.name) ?? Number.MAX_SAFE_INTEGER)),
      ...(input.since === undefined ? {} : { since: input.since }),
      ...(input.requiredChecks === undefined || input.requiredChecks.length === 0 ? {} : { requiredChecks: input.requiredChecks }),
    },
    "evidence",
  )
}
