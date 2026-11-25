# Engine tests

- From the root, use `bun test <path>` for the engine files you changed. Use `bun run test:e2e` for the full process-starting suite.
- `harness.ts` drives the real loop with temporary SQLite, a scripted provider and tools, and a manual clock.
- For in-process crash cases, close the store beneath the engine, then reopen the same file with a new store and engine; `crash.e2e.test.ts` covers actual process death.
