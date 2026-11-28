# Working in this repository

## Setup

- Start at the repository root with Bun 1.4; CI pins 1.4.0.
- Install workspace dependencies with `bun install`.
- To reproduce CI dependency resolution, run `bun install --frozen-lockfile` at the root.
- `prefixlens` is a root development dependency used by prompt-cache tests; no global install is needed.
- The root workspace includes the packages under `packages/`.
- No model sign-in is needed for the CI unit or end-to-end suites.

## Checks by change

- For TypeScript changes, run `bun run typecheck` from the root: it checks both `tsconfig.json` and `evals/tsconfig.json`.
- For in-process changes, use `bun run test:unit`: it preloads `test/unit-preload.ts` and excludes `*.e2e.test.ts`.
- For process-level changes, `bun run test:e2e` selects the `.e2e.test.ts` files.
- For a focused iteration, pass the changed test path to `bun test` from the root instead of running the whole suite.
- For durable event changes, update the reducer and the request builder if the model should see the event. Describe the expected behavior in `packages/core/test/scenarios/`, not by editing the reducer test runner or overriding conformance expectations derived from those definitions.
- When scenario definitions change, regenerate their document section with `bun scripts/scenario-doc.ts --write`.
- After adding slow end-to-end tests, refresh `test/e2e-timings.json` from the root with `bun run test:e2e --timings=test/e2e-timings.json --update-timings`.
- For grader changes, run `bun test evals` from the root; graders must reject untouched workspaces and accept reference solutions.
- Name any test file that starts a process, even indirectly, `*.e2e.test.ts` and set `setDefaultTimeout(E2E_TIMEOUT_MS)`.

## Leave to CI

- Leave the full Linux x64, Linux arm64, and macOS unit matrix to [CI](./.github/workflows/ci.yml) after focused local tests.
- Leave full end-to-end sharding to CI: it runs three shards per runner using `test/e2e-timings.json`.
- CI provisions Linux bubblewrap for sandbox coverage and adds tmux on macOS for terminal coverage.
- Use the [stress workflow](./.github/workflows/stress.yml) for repeated end-to-end runs under CPU load, not as a routine local check.
- Let CI build and smoke-test native release executables on their target platforms.
- Leave version tags and publishing to the maintainer and the [release workflow](./.github/workflows/release.yml); see [releasing](./docs/releasing.md).
- Expect CI hygiene checks to catch tracked session data, traces, and credential-like files or content; keep them out of the change.

## Handoff

- Start with the [architecture](./docs/architecture.md) and keep the owner rules in [CLAUDE.md](./CLAUDE.md) in view.
- Use synthetic, hand-written fixtures; never include real sessions, traces, or credentials.
- If committing, use a one-line conventional commit message with no co-author lines.
- For user-visible headless changes, use the [harness testing procedure](./.claude/skills/harness-testing/SKILL.md).
- For user-visible full-screen changes, use the [tmux testing procedure](./.claude/skills/tui-tmux-testing/SKILL.md).
- Report the focused tests run separately from the CI matrix coverage still to come.

## Terms

- **Projection:** state derived by folding durable events through the reducer.
- **Baseline:** the stored instructions and frozen tool list copied into a model request in stored order.
- **Prefix break:** a model request that does not extend its predecessor; permitted at compaction, revert, refusal, or settings change.
