import { describe, expect, test } from "bun:test"
import type { MessageId } from "../../src/id.ts"
import type { AssistantMessage, Message, UserMessage } from "../../src/message/message.ts"
import { conversationTurns, renderMarkdown } from "../../src/transcript/markdown.ts"

let seq = 0
const base = () => ({ id: `m${++seq}` as MessageId, seq, time: seq, excluded: null })

const user = (text: string, extra: Partial<UserMessage> = {}): Message => ({
  kind: "user",
  ...base(),
  content: [{ type: "text", text }],
  delivery: "steer",
  ...extra,
})

const assistant = (parts: AssistantMessage["parts"], extra: Partial<AssistantMessage> = {}): Message => ({
  kind: "assistant",
  ...base(),
  model: "m",
  attempt: 1,
  status: "completed",
  parts,
  finish: null,
  usage: null,
  error: null,
  refusal: null,
  lastRetry: null,
  endedAt: null,
  ...extra,
})

const say = (text: string): AssistantMessage["parts"][number] => ({ type: "text", text, providerData: null })
const think = (text: string): AssistantMessage["parts"][number] => ({ type: "reasoning", text, providerData: null })
const call = (name: string, output: string): AssistantMessage["parts"][number] => ({
  type: "tool_call",
  callId: `c${seq}` as never,
  name,
  input: '{"path":"secret.txt"}',
  providerData: null,
  state: { status: "settled", outcome: "success", output, truncation: null, attachments: [], display: null },
})

describe("renderMarkdown", () => {
  test("alternates speaker headings in order", () => {
    const out = renderMarkdown([user("Fix the bug"), assistant([say("Done.")]), user("Thanks"), assistant([say("Welcome.")])])
    expect(out).toBe("## User\n\nFix the bug\n\n## Assistant\n\nDone.\n\n## User\n\nThanks\n\n## Assistant\n\nWelcome.\n")
  })

  test("leaves out tool calls, tool results and reasoning", () => {
    const out = renderMarkdown([
      user("read it"),
      assistant([think("hidden thoughts"), say("Reading."), call("read", "FILE CONTENTS")]),
      assistant([say("It says hello.")]),
    ])
    expect(out).not.toContain("hidden thoughts")
    expect(out).not.toContain("FILE CONTENTS")
    expect(out).not.toContain("secret.txt")
    expect(out).toContain("Reading.\n\nIt says hello.")
  })

  test("steps of one turn are one reply, and a step with no text adds nothing", () => {
    const turns = conversationTurns([user("go"), assistant([call("shell", "x")]), assistant([say("a")]), assistant([call("shell", "y")]), assistant([say("b")])])
    expect(turns).toEqual([
      { speaker: "user", text: "go" },
      { speaker: "assistant", text: "a\n\nb" },
    ])
  })

  test("leaves out harness messages, compactions and excluded messages", () => {
    const messages: Message[] = [
      user("kept"),
      { kind: "synthetic", ...base(), origin: "wake", content: [{ type: "text", text: "SYNTHETIC" }], delivery: null },
      { kind: "instruction", ...base(), source: "agents", text: "INSTRUCTION", fingerprint: null },
      assistant([say("reply")]),
      user("rewound", { excluded: "reverted" }),
      assistant([say("refused")], { excluded: "refused", status: "refused" }),
    ]
    const out = renderMarkdown(messages)
    expect(out).toBe("## User\n\nkept\n\n## Assistant\n\nreply\n")
  })

  test("names media instead of embedding it", () => {
    const out = renderMarkdown([user("x", { content: [{ type: "text", text: "see" }, { type: "media", blob: { hash: "ab", mediaType: "image/png" } }] })])
    expect(out).toContain("see\n\n_[attachment: image/png]_")
  })

  test("closes a code fence left open so later headings stay headings", () => {
    const out = renderMarkdown([assistant([say("```ts\nconst a = 1")]), user("next")])
    expect(out).toBe("## Assistant\n\n```ts\nconst a = 1\n```\n\n## User\n\nnext\n")
    expect(renderMarkdown([assistant([say("````\n```\ninner\n```")])])).toContain("inner\n```\n````")
    expect(renderMarkdown([assistant([say("```\nok\n```")])])).toBe("## Assistant\n\n```\nok\n```\n")
    expect(renderMarkdown([assistant([say("use ```inline``` here")])])).toBe("## Assistant\n\nuse ```inline``` here\n")
  })

  test("title, custom names and an empty conversation", () => {
    expect(renderMarkdown([user("hi")], { title: "My\nsession", names: { user: "Me", assistant: "Agent" } })).toBe("# My session\n\n## Me\n\nhi\n")
    expect(renderMarkdown([])).toBe("")
  })
})
