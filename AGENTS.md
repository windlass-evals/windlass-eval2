# Working in Windlass

## Setup
- Use Bun from the repository root. Install workspace dependencies with `bun install`.
- For the same install mode as CI, use `bun install --frozen-lockfile`.
- CI pins Bun to 1.4.0; use that version when reproducing a CI result locally.
- `prefixlens` is a root dev dependency used by the prompt-cache tests; no separate global install is needed.
- Start with [the architecture overview](docs/architecture.md) and keep [the owner guidance](CLAUDE.md) in view.

## Checks by change
- Run the whole script: it checks both `tsconfig.json` and `evals/tsconfig.json`.
- For a focused change, use `bun test <path>` with the affected test file or directory.
- Set `setDefaultTimeout(E2E_TIMEOUT_MS)` in end-to-end files; leave unit tests on Bun's default timeout.
- For eval grader or runner changes, see [the eval guide](evals/AGENTS.md).

## Leave to CI
- Use focused local tests rather than repeating the full runner matrix.
- See the [CI workflow](.github/workflows/ci.yml) for the unit and sharded end-to-end jobs.
- After adding slow end-to-end tests, refresh `test/e2e-timings.json` using the [Shards step in CONTRIBUTING.md](CONTRIBUTING.md#tests-and-fixtures).
- Leave cross-platform executable builds and smoke tests to the [CI build job](.github/workflows/ci.yml).
- Use the stress workflow for repeated end-to-end runs when investigating flakes; ordinary CI does not retry tests.
- Leave tags and publishing to the maintainer and the Release workflow.

## Handoff
- Report which targeted commands actually ran and which checks remain for CI.
- Coordinate changes to the event schema, reducer, request builder, and engine rather than editing them in parallel.
- For a durable-event change, update the reducer, and update the request builder if the model should see the event.
- Update the step-loop scenarios with the event change and regenerate the scenario document with `bun scripts/scenario-doc.ts --write`.
- **Fixtures are synthetic and hand-written.** Never commit real session data, traces or credentials.
- For user-visible changes, use the existing headless or tmux testing procedure as appropriate.
- Keep commits one line, conventional style, with no co-author lines.
- **Stored text is never re-rendered.** Tool output is capped once when produced and replayed byte for byte.
- **No third-party CLIs, global installs or sudo** in scripts or tests.
- **`packages/core` has no runtime dependencies.**
- Keep new features in standalone modules with tests and a README explaining how the engine uses the module.

## Terms
- **Request prefix:** the portion of the model request that must remain stable as new messages append, apart from allowed breaks.
