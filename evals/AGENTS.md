# Eval development

## Quick commands
- From the repository root, run `bun test evals` after grader or runner changes.
- From the same directory, use `bun evals/run-check.ts <id>` to grade an untouched workspace; expect FAIL.
- Then run `bun evals/run-check.ts <id> --solve` to grade the reference solution; expect PASS.

## Key files
- `run-check.ts` prepares a workspace copy, optionally applies the reference solution, and grades the result.
- `graders.e2e.test.ts` checks that graders reject untouched workspaces and accept reference solutions.
- `alternatives.e2e.test.ts` checks acceptance of other correct solutions and rejection of wrong ones.
- `run-agent.ts` runs tasks through the CLI, grades the resulting workspace, and records event-stream metrics.
- `gate.ts` compares results with the committed baseline to detect regressions.

## Non-obvious patterns
- Reuse `prepareWorkspace(id)` and `grade(id, dir)` rather than duplicating workspace setup and grading in a runner.
- Use `--keep` with `run-check.ts` when you need to inspect the temporary workspace after grading.
- A task's `prompts` array shares one session across turns; its timeout covers the entire run, not each prompt.
- Follow the [offline grader rules](README.md#writing-a-fair-grader): grade the outcome without network access and use a fixed seed for generated inputs.
- Every grader fix needs a regression case in `alternatives.e2e.test.ts`: cover a correct solution the old grader rejected and, when tightening a grader, the wrong solution it must now reject.
- For live runs, set `--out` to a directory outside the repository; never commit run results or traces.

## See also
- [Root agent guide](../AGENTS.md) for the workspace check policy and the full typecheck command.
