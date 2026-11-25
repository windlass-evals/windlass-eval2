# Evals

- From the root, run `bun test evals` for eval tests. For runner changes, `run-agent.e2e.test.ts` uses the scripted stand-in agent instead of the live model.
- `run-check.ts` prepares and grades workspaces; `run-agent.ts` runs the agent; `baseline.json` is the reference for `gate.ts`.
- Keep run output and traces out of commits. The general baseline and nightly run exclude memory A/B tasks.
