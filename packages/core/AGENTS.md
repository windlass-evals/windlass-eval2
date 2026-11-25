# Core package

## Quick commands

- Working directory: repository root. Run `bun run typecheck` after changes to the event schema or reducer.
- Working directory: repository root. After changing the durable event schema, run `bun scripts/event-log-doc.ts --write` to regenerate `docs/event-log.md`.

## Key files

- [`packages/core/package.json`](./package.json) defines the package and its public subpath exports, including the testing entry points.
- [`packages/core/src/event/durable.ts`](./src/event/durable.ts) defines the versioned durable event schema.
- [`packages/core/src/message/reducer.ts`](./src/message/reducer.ts) folds events into projected state and rejects illegal appends.
- [`packages/core/src/request/build.ts`](./src/request/build.ts) renders stored state into a model request without consulting the environment or the clock.

## Non-obvious patterns

- Put derived state in the projection, not in an event payload; leave streaming deltas ephemeral.
- Add fields as optional keys so existing records still decode. If a schema change makes existing records invalid, bump the event's `v`, retain the old decoder, and convert old records to the new shape in `decodeEvent` in `packages/core/src/event/decode.ts`.
- Keep baseline instructions and tools in stored order, and replay settled tool output byte for byte.

## See also

- [Root guide](../../AGENTS.md) for setup and check selection.
