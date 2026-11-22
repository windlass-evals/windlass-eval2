/**
 * Required checks as pure functions: which checks a session has and whose
 * each is (`planChecks`), what a client may send (`sessionChecks`), how a
 * required check's patterns are matched and fingerprinted, what the evidence
 * carries of a check (its origin, whether it is required, the end of its
 * output), and the report's line about a failing required check.
 */
import { describe, expect, test } from "bun:test"
import { type CheckConfig, type ConfigFile, mergeConfigFiles, resolveConfig } from "../../src/config/schema.ts"
import { DecodeError } from "../../src/validate.ts"
import {
  OUTPUT_TAIL_LIMITS,
  buildEvidence,
  checkEvidence,
  couldNotStart,
  filesFor,
  fingerprintCheck,
  outputTailOf,
  planChecks,
  renderReport,
  requiredCheckRefOf,
  selectChecks,
  sessionChecks,
  stands,
  verificationEvidence,
} from "../../src/verify/index.ts"
import type { CheckOutput, CheckResult, CheckStatus } from "../../src/verify/run.ts"

const check = (name: string, command = "true", extra: Partial<CheckConfig> = {}): CheckConfig => ({ name, command, timeoutSeconds: 120, when: null, ...extra })
const plan = (user: ConfigFile | null, project: ConfigFile | null, session: readonly CheckConfig[] | null = null) =>
  planChecks({ config: resolveConfig(mergeConfigFiles(user, project)), files: { user, project }, session })
const names = (checks: readonly { readonly name: string }[]) => checks.map((item) => item.name)

function output(text: string): CheckOutput {
  const bytes = new TextEncoder().encode(text)
  const lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0)
  return { totalBytes: bytes.length, totalLines: lines, path: "/spill/check.log", savedBytes: bytes.length, source: { head: bytes, tail: bytes, tailAtLineStart: true, totalBytes: bytes.length, totalLines: lines } }
}

function result(config: CheckConfig, status: CheckStatus, text = ""): CheckResult {
  return { name: config.name, command: config.command, timeoutSeconds: config.timeoutSeconds, status, exitCode: status === "passed" ? 0 : 1, signal: null, interruptedBy: null, startError: null, durationMs: 3, output: output(text) }
}

describe("planChecks", () => {
  const USER: ConfigFile = { requiredChecks: [{ name: "test", command: "bun test" }], checks: [{ name: "lint", command: "bun lint" }] }

  test("without a required check the plan is the configuration's checks under the merged verify, and says whose they are", () => {
    expect(plan({ checks: [{ name: "lint", command: "bun lint" }] }, null)).toEqual({
      checks: [{ ...check("lint", "bun lint"), origin: "user", required: false }],
      mode: "gate",
      maxRounds: 3,
      required: null,
      ignored: null,
      shadowed: [],
    })
    // A project's list replaces the user's whole: every check of the list is then the project's.
    const replaced = plan({ checks: [{ name: "lint", command: "bun lint" }] }, { checks: [{ name: "unit", command: "make unit" }], verify: { mode: "report", maxRounds: 1 } })
    expect(replaced.checks).toEqual([{ ...check("unit", "make unit"), origin: "project", required: false }])
    expect(replaced).toMatchObject({ mode: "report", maxRounds: 1, required: null })
    // The origin is not known where only the merged configuration is.
    expect(planChecks({ config: resolveConfig({ checks: [{ name: "lint", command: "bun lint" }] }), files: null, session: null }).checks).toEqual([{ ...check("lint", "bun lint"), origin: null, required: false }])
  })

  test("the user's required checks come first, and a project's list replaces only the user's plain one", () => {
    const made = plan(USER, { checks: [{ name: "unit", command: "make unit" }] })
    expect(made.checks).toEqual([
      { ...check("test", "bun test"), origin: "user", required: true },
      { ...check("unit", "make unit"), origin: "project", required: false },
    ])
    expect(made.required).toEqual({ names: ["test"], maxRounds: 3 })
    // With no project file the user's own list follows the required ones.
    expect(names(plan(USER, null).checks)).toEqual(["test", "lint"])
  })

  test("a project's empty list and verify off leave the required checks, and its maxRounds is not theirs", () => {
    const made = plan({ ...USER, verify: { maxRounds: 5 } }, { checks: [], verify: { mode: "off", maxRounds: 1 } })
    expect(made.checks).toEqual([{ ...check("test", "bun test"), origin: "user", required: true }])
    expect(made).toMatchObject({ mode: "off", maxRounds: 1, required: { names: ["test"], maxRounds: 5 } })
    // Off takes the configuration's own checks out, whoever wrote it: a required check is taken out of its list to stop it.
    expect(names(plan({ ...USER, verify: { mode: "off" } }, null).checks)).toEqual(["test"])
  })

  test("the client's checks are required too and follow the user's; a name in both is the client's", () => {
    const made = plan({ requiredChecks: [{ name: "test", command: "bun test" }, { name: "types", command: "tsc" }] }, null, [check("test", "make test", { timeoutSeconds: 60 }), check("build", "make")])
    expect(made.checks).toEqual([
      { ...check("types", "tsc"), origin: "user", required: true },
      { ...check("test", "make test", { timeoutSeconds: 60 }), origin: "session", required: true },
      { ...check("build", "make"), origin: "session", required: true },
    ])
    expect(made.required?.names).toEqual(["types", "test", "build"])
    // With no file anywhere, the client's are all there is.
    expect(planChecks({ config: resolveConfig({}), files: { user: null, project: null }, session: [check("build", "make")] }).checks).toEqual([{ ...check("build", "make"), origin: "session", required: true }])
  })

  test("a project's check with a required check's name is left out, and its requiredChecks are not followed", () => {
    const made = plan(USER, { checks: [{ name: "test", command: "true" }, { name: "unit", command: "make unit" }], requiredChecks: [{ name: "unit", command: "true" }, { name: "extra", command: "true" }] })
    expect(made.checks).toEqual([
      { ...check("test", "bun test"), origin: "user", required: true },
      { ...check("unit", "make unit"), origin: "project", required: false },
    ])
    expect(made.shadowed).toEqual(["test"])
    expect(made.ignored).toBe("requiredChecks (unit, extra)")
    // A project that names required checks and nothing else has none.
    expect(plan(null, { requiredChecks: [{ name: "extra", command: "true" }] })).toMatchObject({ checks: [], required: null, ignored: "requiredChecks (extra)" })
  })
})

describe("sessionChecks", () => {
  test("a client's list is read as a file's is, with the defaults", () => {
    expect(sessionChecks([{ name: "test", command: "bun test" }, { name: "types", command: "tsc", timeoutSeconds: 30, when: ["src/**"], outputTail: "always" }], "requiredChecks")).toEqual([
      check("test", "bun test"),
      check("types", "tsc", { timeoutSeconds: 30, when: ["src/**"], outputTail: "always" }),
    ])
    expect(sessionChecks([], "requiredChecks")).toEqual([])
  })

  test("what a file refuses is refused, with the path of the bad value", () => {
    const bad: [unknown, string][] = [
      ["bun test", "requiredChecks: expected array"],
      [[{ name: "test" }], "requiredChecks[0].command: expected a value"],
      [[{ name: "a b", command: "true" }], "requiredChecks[0].name: expected a name of letters"],
      [[{ name: "test", command: "true", timeoutSeconds: 0 }], "requiredChecks[0].timeoutSeconds: expected integer"],
      [[{ name: "test", command: "true", when: [] }], "requiredChecks[0].when: expected at least one glob pattern"],
      [[{ name: "test", command: "true", outputTail: "never" }], 'requiredChecks[0].outputTail: expected "failure" | "always", got "never"'],
      [[{ name: "test", command: "true", sandbox: false }], "requiredChecks[0].sandbox: "],
      [[{ name: "test", command: "true" }, { name: "test", command: "false" }], 'requiredChecks[1].name: expected a name not already used (requiredChecks[0] is "test")'],
    ]
    for (const [value, message] of bad) {
      let thrown: unknown
      try {
        sessionChecks(value, "requiredChecks")
      } catch (error) {
        thrown = error
      }
      expect(thrown, message).toBeInstanceOf(DecodeError)
      expect((thrown as DecodeError).message, message).toStartWith(message)
    }
  })
})

describe("a required check's patterns", () => {
  const changed = ["README.md", "packages/a/src/x.ts", "packages/b/src/y.ts", "src/z.ts"]

  test("are matched in the session's working directory, as its prefix among the project's paths says", () => {
    const here = { ...check("test", "bun test", { when: ["src/**"] }), required: true, under: "packages/a/" }
    expect(filesFor(here, changed)).toEqual(["packages/a/src/x.ts"])
    // The same patterns without a prefix are the project directory's, as any check's are.
    expect(filesFor(check("test", "bun test", { when: ["src/**"] }), changed)).toEqual(["src/z.ts"])
    expect(selectChecks([here, { ...here, name: "docs", when: ["docs/**"] }], changed).map((item) => item.name)).toEqual(["test"])
    // Without patterns any change selects it.
    expect(filesFor({ ...here, when: null }, changed)).toEqual(changed)
  })

  test("are part of its fingerprint, with its being required: another check's pass never stands for it", async () => {
    const plain = check("test", "bun test", { when: ["src/**"] })
    const own = await fingerprintCheck(plain, [], "/nowhere")
    expect(await fingerprintCheck({ ...plain, origin: "project", required: false }, [], "/nowhere")).toBe(own)
    const required = await fingerprintCheck({ ...plain, required: true, under: "" }, [], "/nowhere")
    expect(required).not.toBe(own)
    expect(await fingerprintCheck({ ...plain, required: true, under: "packages/a/" }, [], "/nowhere")).not.toBe(required)
  })
})

describe("the end of a check's output", () => {
  test("is the whole output when it is short", () => {
    expect(outputTailOf(output("1 fail\n"))).toEqual({ text: "1 fail\n", truncated: false })
    expect(outputTailOf(output(""))).toEqual({ text: "", truncated: false })
  })

  test("is the last lines within the limits, from a line start, and says that there was more", () => {
    const lines = Array.from({ length: 500 }, (_, index) => `line ${index + 1} of the output`)
    const tail = outputTailOf(output(`${lines.join("\n")}\n`))
    expect(tail.truncated).toBe(true)
    expect(tail.text.endsWith("line 500 of the output\n")).toBe(true)
    expect(tail.text.startsWith("line ")).toBe(true)
    expect(tail.text.split("\n").length - 1).toBeLessThanOrEqual(OUTPUT_TAIL_LIMITS.maxLines)
    expect(new TextEncoder().encode(tail.text).length).toBeLessThanOrEqual(OUTPUT_TAIL_LIMITS.maxBytes)
    // Many short lines: the line limit decides. A few long ones: the byte limit does.
    expect(outputTailOf(output("x\n".repeat(1000))).text).toBe("x\n".repeat(OUTPUT_TAIL_LIMITS.maxLines))
    const long = outputTailOf(output(`${"y".repeat(3000)}\n`.repeat(4)))
    expect(long).toEqual({ text: `${"y".repeat(3000)}\n`, truncated: true })
  })

  test("inside one line longer than the limit, starts on a character and splits no redaction placeholder", () => {
    const tail = outputTailOf(output(`${"é".repeat(5000)}`))
    expect(tail.truncated).toBe(true)
    expect(tail.text).toBe("é".repeat(OUTPUT_TAIL_LIMITS.maxBytes / 2))
    // A placeholder across the cut is left out whole: the tail never begins with half of one.
    const split = outputTailOf(output(`${"a".repeat(1000)}[REDACTED:env]${"b".repeat(OUTPUT_TAIL_LIMITS.maxBytes - 5)}`))
    expect(split.text).toBe("b".repeat(OUTPUT_TAIL_LIMITS.maxBytes - 5))
  })
})

describe("the evidence of a run", () => {
  const checks = [
    { ...check("test", "bun test"), origin: "session" as const, required: true },
    { ...check("lint", "bun lint", { outputTail: "always" }), origin: "project" as const, required: false },
    { ...check("types", "tsc"), origin: "project" as const, required: false },
    { ...check("docs", "make docs", { when: ["docs/**"] }), origin: "user" as const, required: true },
  ]
  const fingerprints = { test: "f1", lint: "f2", types: "f3", docs: "f4" }

  test("says of each check whose it is and whether it is required, and carries the end of a failing output", () => {
    const evidence = buildEvidence({
      run: 1,
      afterSeq: 7,
      changedFiles: ["a.ts"],
      checks,
      results: [result(checks[0]!, "failed", "2 pass\n1 fail\n"), result(checks[1]!, "passed", "no problems\n"), result(checks[2]!, "passed", "checked 4 files\n")],
      fingerprints,
      reused: [{ check: checks[3]!, fromSeq: 4 }],
    })
    expect(evidence.checks.map(({ name, origin, required, outputTail, reusedFromSeq }) => ({ name, origin, required, outputTail, reusedFromSeq }))).toEqual([
      { name: "test", origin: "session", required: true, outputTail: { text: "2 pass\n1 fail\n", truncated: false }, reusedFromSeq: null },
      // A passing check's output is carried only when its configuration asks for it.
      { name: "lint", origin: "project", required: false, outputTail: { text: "no problems\n", truncated: false }, reusedFromSeq: null },
      { name: "types", origin: "project", required: false, outputTail: null, reusedFromSeq: null },
      // A pass carried over from an earlier run printed nothing in this one.
      { name: "docs", origin: "user", required: true, outputTail: null, reusedFromSeq: 4 },
    ])
    // The file that keeps all of the output is named as before.
    expect(evidence.checks[0]).toMatchObject({ outputPath: "/spill/check.log", outputBytes: 14, outputLines: 2 })
    expect(verificationEvidence(JSON.parse(JSON.stringify(evidence)), "")).toEqual(evidence)
  })

  test("what it carries of an output is redacted, and so is why a check could not start", () => {
    const redact = (text: string) => text.replaceAll("hunter2-made-up", "[REDACTED:env]")
    const evidence = buildEvidence({
      run: 1,
      afterSeq: 0,
      changedFiles: [],
      checks: checks.slice(0, 2),
      results: [result(checks[0]!, "failed", "login with hunter2-made-up failed\n"), couldNotStart(checks[1]!, "no directory /home/hunter2-made-up")],
      fingerprints,
      redact,
    })
    expect(evidence.checks[0]!.outputTail).toEqual({ text: "login with [REDACTED:env] failed\n", truncated: false })
    expect(evidence.checks[1]).toMatchObject({ status: "could_not_start", exitCode: null, startError: "no directory /home/[REDACTED:env]", outputTail: { text: "", truncated: false } })
    expect(JSON.stringify(evidence)).not.toContain("hunter2")
  })

  test("an interrupted check carries nothing, and a check of an engine without the files has no origin", () => {
    const plain = check("test", "bun test")
    const evidence = buildEvidence({ run: 1, afterSeq: 0, changedFiles: [], checks: [plain], results: [result(plain, "interrupted", "half\n")], fingerprints })
    expect(evidence.checks[0]).toMatchObject({ required: false, outputTail: null })
    expect(evidence.checks[0]).not.toHaveProperty("origin")
    expect(evidence.checks[0]).not.toHaveProperty("startError")
  })

  const old = { name: "test", command: "bun test", status: "failed", exitCode: 1, signal: null, durationMs: 12, files: ["a.ts"], fingerprint: "f", reusedFromSeq: null, outputPath: "/spill/x.log", outputBytes: 7, outputLines: 1 }

  test("a record written before any of this still decodes, as it is", () => {
    expect(checkEvidence(old, "")).toEqual(old as never)
    expect(() => checkEvidence({ ...old, origin: "repository" }, "")).toThrow(DecodeError)
    expect(() => checkEvidence({ ...old, outputTail: { text: "x" } }, "")).toThrow(DecodeError)
    const run = { run: 1, afterSeq: 3, changedFiles: ["a.ts"], checks: [old] }
    expect(verificationEvidence(run, "")).toEqual(run as never)
  })

  test("names the state its changed files are measured from and the session's required checks, run or not", () => {
    const required = [requiredCheckRefOf(checks[0]!), requiredCheckRefOf(checks[3]!)]
    const since = { seq: 12, run: { seq: 12, run: 2 } }
    const evidence = buildEvidence({ run: 1, afterSeq: 20, changedFiles: ["a.ts"], checks, results: [result(checks[0]!, "passed")], fingerprints, since, requiredChecks: required })
    expect(evidence.since).toEqual(since)
    // `docs` covers nothing that changed and was not run: it is named all the same.
    expect(evidence.requiredChecks).toEqual(required)
    expect(names(evidence.checks)).toEqual(["test"])
    expect(verificationEvidence(JSON.parse(JSON.stringify(evidence)), "")).toEqual(evidence)
    // A session without a required check, and one in which nothing was verified yet, say neither.
    const bare = buildEvidence({ run: 1, afterSeq: 20, changedFiles: ["a.ts"], checks: checks.slice(1, 3), results: [result(checks[1]!, "passed")], fingerprints, requiredChecks: [] })
    expect(bare).not.toHaveProperty("since")
    expect(bare).not.toHaveProperty("requiredChecks")
  })

  test("a record a later build wrote more into still decodes: keys this build does not know are kept as they are, and the ones it knows are checked as ever", () => {
    const later = {
      run: 2,
      afterSeq: 9,
      changedFiles: ["a.ts"],
      checks: [{ ...old, origin: "session", required: true, outputTail: { text: "1 fail\n", truncated: false, encoding: "utf-8" }, retries: 2, cache: { hit: false, key: ["a", 1, null] } }],
      since: { seq: 4, run: null },
      host: { os: "linux", cores: 2 },
      flaky: null,
    }
    const read = verificationEvidence(JSON.parse(JSON.stringify(later)), "")
    // Nothing was dropped or changed: written back, it is the record it was.
    expect(read).toEqual(later as never)
    expect(JSON.parse(JSON.stringify(read))).toEqual(later)
    // What this build reads of it is what it would read of its own.
    expect(read.checks[0]).toMatchObject({ name: "test", status: "failed", origin: "session", required: true, outputTail: { text: "1 fail\n", truncated: false } })
    // A key it knows is still held to its type, and one it needs is still needed, whatever else is there.
    expect(() => verificationEvidence({ ...later, checks: [{ ...later.checks[0], status: "skipped" }] }, "")).toThrow(/checks\[0\]\.status/)
    expect(() => verificationEvidence({ ...later, checks: [{ ...later.checks[0], required: "yes" }] }, "")).toThrow(/checks\[0\]\.required/)
    expect(() => verificationEvidence({ ...later, checks: [(({ status: _status, ...rest }) => rest)(later.checks[0]!)] }, "")).toThrow(/checks\[0\]\.status: expected a value/)
    // A key it does not know holds JSON, like everything stored.
    expect(() => verificationEvidence({ ...later, host: () => 1 }, "")).toThrow(/host: expected JSON value/)
    // The state a record names is not evidence: it stays strict.
    expect(() => verificationEvidence({ ...later, since: { seq: 4, run: null, turn: 2 } }, "")).toThrow(/since\.turn: expected no such key/)
  })
})

describe("which required checks stand on a verified state", () => {
  const types = { ...check("types", "tsc", { when: ["**/*.ts"] }), required: true, under: "" }
  const test_ = { ...check("test", "bun test"), required: true, under: "" }
  const [a, b] = [requiredCheckRefOf(types), requiredCheckRefOf(test_)]

  test("a check is named by its name and a digest of what it runs: the command, the timeout, the patterns and where they are relative to", () => {
    expect(a).toEqual({ name: "types", definition: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(requiredCheckRefOf({ ...types })).toEqual(a)
    for (const other of [{ ...types, command: "tsc --strict" }, { ...types, timeoutSeconds: 60 }, { ...types, when: ["src/**/*.ts"] }, { ...types, when: null }, { ...types, under: "packages/a/" }])
      expect(requiredCheckRefOf(other).definition).not.toBe(a.definition)
    // Whose it is and what the evidence carries of its output do not change what it runs.
    expect(requiredCheckRefOf({ ...types, origin: "user", outputTail: "always" })).toEqual(a)
    expect(requiredCheckRefOf({ ...types, name: "typecheck" })).toEqual({ name: "typecheck", definition: a.definition })
  })

  test("every check stands on the state a session starts from, the ones a record names on the state it moved to, and none where it names none", () => {
    expect(stands(null, a)).toBe(true)
    expect(stands(undefined, a)).toBe(false)
    expect(stands([b], a)).toBe(false)
    expect(stands([b, a], a)).toBe(true)
    // The same name with another command is another check.
    expect(stands([a], requiredCheckRefOf({ ...types, command: "tsc --strict" }))).toBe(false)
  })
})

describe("the report", () => {
  const failing = result(check("test", "bun test"), "failed", "1 fail\n")
  const other = result(check("lint", "bun lint"), "failed", "2 problems\n")

  test("says which failing checks the session requires, and is the text it was without one", () => {
    const plain = renderReport([failing, other])
    expect(renderReport([{ ...failing, required: false }, other])).toBe(plain)
    expect(plain).not.toContain("requires")
    const told = renderReport([{ ...failing, required: true }, other])
    expect(told).toBe(`${plain}This session requires test: no file of the project replaces a required check or switches it off.\n`)
    // A required check that passes is not mentioned.
    expect(renderReport([{ ...result(check("test", "bun test"), "passed"), required: true }, other])).not.toContain("requires")
  })

  const unstarted = couldNotStart(check("test", "bun test"), "the sandbox is unavailable")

  test("of a check that was never started says why, that it says nothing about the changes, and asks for nothing", () => {
    expect(renderReport([unstarted])).toBe(
      [
        "Checks run by the harness after your changes: 1 could not start.",
        "",
        "could not start: test (bun test): the sandbox is unavailable",
        "",
        "This check was not started, so it says nothing about your changes, and no change to the code makes it start. Nothing is asked of you: the turn ends with it recorded as not started, and the reason above goes to the user.",
        "",
      ].join("\n"),
    )
    const two = renderReport([{ ...unstarted, required: true }, couldNotStart(check("lint", "bun lint"), "the sandbox is unavailable")])
    expect(two).toContain("These checks were not started, so they say nothing about your changes, and no change to the code makes them start. Nothing is asked of you: the turn ends with them recorded as not started, and the reason above goes to the user.\nThis session requires test: no file of the project replaces a required check or switches it off.\n")
    expect(two).not.toContain("Fix the code")
    expect(two).not.toContain("report_check_failure")
  })

  test("keeps a check that was never started apart from one that failed: the code is to be fixed for the one that ran", () => {
    expect(renderReport([other, unstarted])).toBe(
      [
        "Checks run by the harness after your changes: 1 failed, 1 could not start.",
        "",
        "failed: lint (bun lint), exit code 1. Output:",
        "2 problems",
        "[end of lint output]",
        "",
        "could not start: test (bun test): the sandbox is unavailable",
        "",
        "Fix the code so that lint passes, or, if you cannot, call report_check_failure with its name and the reason.",
        "test was not started, so it says nothing about your changes, and no change to the code makes it start: leave it, and do not name it to report_check_failure.",
        "",
      ].join("\n"),
    )
    const more = renderReport([other, failing, unstarted, couldNotStart(check("build", "make"), "the sandbox is unavailable")])
    expect(more).toContain("Fix the code so that lint, test pass, or, if you cannot, call report_check_failure with the name of each of them and the reason.\ntest, build were not started, so they say nothing about your changes, and no change to the code makes them start: leave them, and do not name them to report_check_failure.\n")
  })

  test("a command the shell did not find is not one of those: it ran, and the report is the one it always was", () => {
    const missing = { ...result(check("test", "bun test"), "could_not_start", "bash: line 1: bun: command not found\n"), exitCode: 127 }
    expect(renderReport([missing])).toBe(
      [
        "Checks run by the harness after your changes: 1 could not start.",
        "",
        "could not start: test (bun test), exit code 127. Output:",
        "bash: line 1: bun: command not found",
        "[end of test output]",
        "",
        "Fix the code so that this check passes, or, if you cannot, call report_check_failure with the name of each failing check and the reason.",
        "",
      ].join("\n"),
    )
  })
})
