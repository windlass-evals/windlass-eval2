/** Every branch of the gate decision, as a table. */
import { describe, expect, test } from "bun:test"
import { type CheckStatus, type GateDecision, type GateInput, decideGate } from "../../src/verify/index.ts"

const base: GateInput = {
  mode: "gate",
  maxRounds: 3,
  selected: ["typecheck", "test"],
  latest: [],
  changedSinceLatest: false,
  reportsSent: 0,
  acknowledgement: null,
}

const ran = (...statuses: [string, CheckStatus][]) => statuses.map(([name, status]) => ({ name, status }))
const failingTest = ran(["typecheck", "passed"], ["test", "failed"])

const cases: [string, Partial<GateInput>, GateDecision][] = [
  ["mode off finishes without running anything", { mode: "off", latest: failingTest }, { kind: "finish" }],
  ["nothing changed and nothing ran: finish", { selected: [] }, { kind: "finish" }],
  ["changes and no results yet: run the selected checks", {}, { kind: "run_checks", checks: ["typecheck", "test"] }],
  ["report mode also runs checks", { mode: "report" }, { kind: "run_checks", checks: ["typecheck", "test"] }],
  ["files changed after the latest results: run again", { latest: failingTest, changedSinceLatest: true, reportsSent: 1 }, { kind: "run_checks", checks: ["typecheck", "test"] }],
  [
    "an interrupted result counts as not run",
    { latest: ran(["typecheck", "passed"], ["test", "interrupted"]) },
    { kind: "run_checks", checks: ["typecheck", "test"] },
  ],
  ["stale results but no selected checks: finish", { selected: [], latest: failingTest, changedSinceLatest: true }, { kind: "finish" }],
  ["all passed: finish", { latest: ran(["typecheck", "passed"], ["test", "passed"]) }, { kind: "finish" }],
  ["a failure: send the report and continue", { latest: failingTest }, { kind: "report_and_continue", failing: ["test"] }],
  [
    "timed out and could not start are failures too",
    { latest: ran(["typecheck", "timed_out"], ["test", "could_not_start"]) },
    { kind: "report_and_continue", failing: ["typecheck", "test"] },
  ],
  ["unchanged and unacknowledged after a report: report again", { latest: failingTest, reportsSent: 2 }, { kind: "report_and_continue", failing: ["test"] }],
  ["after maxRounds reports: finish unresolved", { latest: failingTest, reportsSent: 3 }, { kind: "finish_unresolved", reason: "max_rounds", failing: ["test"] }],
  [
    "acknowledged: finish unresolved",
    { latest: failingTest, reportsSent: 1, acknowledgement: { checks: ["test"], reason: "needs a database" } },
    { kind: "finish_unresolved", reason: "acknowledged", failing: ["test"] },
  ],
  [
    "a check may be named by the label the report shows it with",
    { latest: failingTest, reportsSent: 1, acknowledgement: { checks: [" test (bun test) "], reason: "the fixture is not mine to change" } },
    { kind: "finish_unresolved", reason: "acknowledged", failing: ["test"] },
  ],
  [
    "a name that merely starts like a failing check's does not name it",
    { latest: failingTest, reportsSent: 1, acknowledgement: { checks: ["tests", "test-e2e (bun e2e)"], reason: "r" } },
    { kind: "report_and_continue", failing: ["test"] },
  ],
  [
    "an acknowledgement may name more checks than fail",
    { latest: failingTest, acknowledgement: { checks: ["typecheck", "test"], reason: "r" } },
    { kind: "finish_unresolved", reason: "acknowledged", failing: ["test"] },
  ],
  [
    "acknowledging only some failures is not enough",
    { latest: ran(["typecheck", "failed"], ["test", "failed"]), acknowledgement: { checks: ["test"], reason: "r" } },
    { kind: "report_and_continue", failing: ["typecheck", "test"] },
  ],
  [
    "acknowledgement wins over the round limit",
    { latest: failingTest, reportsSent: 3, acknowledgement: { checks: ["test"], reason: "r" } },
    { kind: "finish_unresolved", reason: "acknowledged", failing: ["test"] },
  ],
  ["report mode never sends the model back", { mode: "report", latest: failingTest }, { kind: "finish_unresolved", reason: "report_mode", failing: ["test"] }],
]

describe("decideGate", () => {
  for (const [name, input, expected] of cases) test(name, () => expect(decideGate({ ...base, ...input })).toEqual(expected))
})

/**
 * With a required check (`required.ts`): `typecheck` is the session's required check, sent back up to five times;
 * `test` is the configuration's own, under `mode` and `maxRounds` as before. The loop leaves the configuration's
 * checks out of `selected` when the mode is `off`.
 */
const required = { names: ["typecheck"], maxRounds: 5 }
const failingRequired = ran(["typecheck", "failed"], ["test", "passed"])
const bothFail = ran(["typecheck", "failed"], ["test", "failed"])

const requiredCases: [string, Partial<GateInput>, GateDecision][] = [
  ["mode off runs the required checks", { mode: "off", selected: ["typecheck"] }, { kind: "run_checks", checks: ["typecheck"] }],
  ["mode off with nothing selected: finish", { mode: "off", selected: [] }, { kind: "finish" }],
  ["mode off: a failing required check sends the model back", { mode: "off", selected: ["typecheck"], latest: ran(["typecheck", "failed"]) }, { kind: "report_and_continue", failing: ["typecheck"] }],
  ["mode off: a passing required check finishes", { mode: "off", selected: ["typecheck"], latest: ran(["typecheck", "passed"]) }, { kind: "finish" }],
  ["mode off: a result of a check that is not required is not acted on", { mode: "off", selected: ["typecheck"], latest: ran(["typecheck", "passed"], ["test", "failed"]) }, { kind: "finish" }],
  ["mode report: a failing required check sends the model back all the same", { mode: "report", latest: failingRequired }, { kind: "report_and_continue", failing: ["typecheck"] }],
  ["mode report: the report names every failing check", { mode: "report", latest: bothFail }, { kind: "report_and_continue", failing: ["typecheck", "test"] }],
  ["mode report: once only the configuration's check fails, the turn ends as report mode does", { mode: "report", latest: failingTest, reportsSent: 1 }, { kind: "finish_unresolved", reason: "report_mode", failing: ["test"] }],
  ["a failing required check is sent back past the configuration's rounds", { maxRounds: 1, latest: failingRequired, reportsSent: 4 }, { kind: "report_and_continue", failing: ["typecheck"] }],
  ["and not past its own", { maxRounds: 20, latest: failingRequired, reportsSent: 5 }, { kind: "finish_unresolved", reason: "max_rounds", failing: ["typecheck"] }],
  ["the configuration's check alone keeps the configuration's rounds", { maxRounds: 1, latest: failingTest, reportsSent: 1 }, { kind: "finish_unresolved", reason: "max_rounds", failing: ["test"] }],
  [
    "a required check is acknowledged like any other",
    { mode: "off", selected: ["typecheck"], latest: ran(["typecheck", "could_not_start"]), reportsSent: 1, acknowledgement: { checks: ["typecheck"], reason: "no sandbox here" } },
    { kind: "finish_unresolved", reason: "acknowledged", failing: ["typecheck"] },
  ],
  ["all passed: finish", { latest: ran(["typecheck", "passed"], ["test", "passed"]) }, { kind: "finish" }],
]

/** A check that was never started (no exit code), and one whose command the shell did not find (exit code 127). */
const unstarted = (name: string) => ({ name, status: "could_not_start" as const, exitCode: null })
const notFound = (name: string) => ({ name, status: "could_not_start" as const, exitCode: 127 })
const failed = (name: string) => ({ name, status: "failed" as const, exitCode: 1 })
const passed = (name: string) => ({ name, status: "passed" as const, exitCode: 0 })

const unstartedCases: [string, Partial<GateInput>, GateDecision][] = [
  ["the only check that did not pass was never started: unresolved at once, before any report", { latest: [passed("typecheck"), unstarted("test")] }, { kind: "finish_unresolved", reason: "not_started", failing: ["test"] }],
  ["none was started: unresolved at once", { latest: [unstarted("typecheck"), unstarted("test")] }, { kind: "finish_unresolved", reason: "not_started", failing: ["typecheck", "test"] }],
  ["in report mode too, and that is the reason given", { mode: "report", latest: [unstarted("test")] }, { kind: "finish_unresolved", reason: "not_started", failing: ["test"] }],
  ["a required one too, whatever its rounds", { required: { names: ["test"], maxRounds: 5 }, latest: [unstarted("test")] }, { kind: "finish_unresolved", reason: "not_started", failing: ["test"] }],
  ["with mode off, a required one that was never started", { mode: "off", required: { names: ["test"], maxRounds: 5 }, selected: ["test"], latest: [unstarted("test")] }, { kind: "finish_unresolved", reason: "not_started", failing: ["test"] }],
  ["a command the shell did not find is not one of these: the model is sent back, as it may be the code's to provide", { latest: [notFound("test")] }, { kind: "report_and_continue", failing: ["test"] }],
  ["beside one that failed: the model is sent back, and the report names both", { latest: [failed("typecheck"), unstarted("test")] }, { kind: "report_and_continue", failing: ["typecheck", "test"] }],
  [
    "beside one that failed: naming the one that failed acknowledges",
    { latest: [failed("typecheck"), unstarted("test")], reportsSent: 1, acknowledgement: { checks: ["typecheck"], reason: "r" } },
    { kind: "finish_unresolved", reason: "acknowledged", failing: ["typecheck", "test"] },
  ],
  ["beside one that failed: the rounds are the failed one's", { latest: [failed("typecheck"), unstarted("test")], reportsSent: 3 }, { kind: "finish_unresolved", reason: "max_rounds", failing: ["typecheck", "test"] }],
  [
    "a required check that was never started does not make a failing plain check a required failure: report mode ends as it does",
    { mode: "report", required: { names: ["test"], maxRounds: 5 }, latest: [failed("typecheck"), unstarted("test")] },
    { kind: "finish_unresolved", reason: "report_mode", failing: ["typecheck", "test"] },
  ],
  [
    "nor does it lend the failing plain check its rounds",
    { maxRounds: 1, required: { names: ["test"], maxRounds: 5 }, latest: [failed("typecheck"), unstarted("test")], reportsSent: 1 },
    { kind: "finish_unresolved", reason: "max_rounds", failing: ["typecheck", "test"] },
  ],
  ["an acknowledgement of a check that was never started is not needed and changes nothing", { latest: [unstarted("test")], acknowledgement: { checks: ["test"], reason: "r" } }, { kind: "finish_unresolved", reason: "not_started", failing: ["test"] }],
]

describe("decideGate with a check that was never started", () => {
  for (const [name, input, expected] of unstartedCases) test(name, () => expect(decideGate({ ...base, ...input })).toEqual(expected))
})

describe("decideGate with a required check", () => {
  for (const [name, input, expected] of requiredCases) test(name, () => expect(decideGate({ ...base, required, ...input })).toEqual(expected))

  test("without one the decision is what the mode and the rounds give, whatever the name", () => {
    for (const [, input, expected] of cases) expect(decideGate({ ...base, ...input, required: undefined })).toEqual(expected)
  })
})
