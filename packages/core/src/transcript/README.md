# Transcript

A stored session as Markdown for notes: the user's messages and the model's replies in order, under a heading per
speaker. Tool calls, tool results, reasoning, instructions, harness messages and compaction checkpoints are left out;
so are messages a revert or a refusal excluded. Consecutive steps of the model in one turn read as one reply.

| File | What |
| --- | --- |
| `markdown.ts` | `renderMarkdown(messages, options)`, `conversationTurns(messages)` |

The command is `bun scripts/export-markdown.ts <session-id>`. The engine does nothing for it: it reads the messages
of a session's file (`store.readMessages`) and writes nothing.
