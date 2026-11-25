# Working in this repository

Read `CLAUDE.md` for the existing owner rules and `docs/architecture.md` for the architecture. Use `CONTRIBUTING.md` for fixture and test conventions.

## Setup

- From the repository root, with Bun available, run `bun install`.
- CI uses Bun 1.4.0 and `bun install --frozen-lockfile`.

## Checks by change

- Behavior changes: `bun test <path>` for the affected tests. Use `bun run test:unit` for the process-free suite and `bun run test:e2e` for the process-starting suite.
- Durable events: update the reducer, the request builder if the model should see the event, and the scenarios. Regenerate the scenario document with `bun scripts/scenario-doc.ts --write`.
- Eval task or grader changes: `bun test evals`. For a single task, `bun evals/run-check.ts <id>` should fail and the same command with `--solve` should pass.

## Leave to CI

- Let CI cover the cross-platform unit matrix, sharded end-to-end matrix, and native executable build and smoke checks. Run the affected tests locally rather than repeating the full matrix.

## Handoff

- Report what changed, which commands ran and their outcomes, and what remains unverified.

## Terms
- **Reducer** — folds an event into the current projection.
