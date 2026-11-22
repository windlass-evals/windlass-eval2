/**
 * A conversation as Markdown, for notes: what the user said and what the model answered, in order. No tool calls,
 * no tool results, no reasoning, and nothing the harness said to the model (synthetic messages, instructions,
 * compaction checkpoints).
 *
 * Pure: messages in, text out. Messages a revert or a refusal left out of model history (`excluded`) are not part of
 * the conversation any more and are skipped; messages that a compaction folded away are still part of it and stay.
 */
import type { Content } from "../content.ts"
import type { Message } from "../message/message.ts"

export interface MarkdownOptions {
  /** The document's title line; none when absent. */
  readonly title?: string
  /** The speaker headings. */
  readonly names?: { readonly user: string; readonly assistant: string }
}

const DEFAULT_NAMES = { user: "User", assistant: "Assistant" } as const

type Speaker = keyof typeof DEFAULT_NAMES

/** The turns of a conversation: consecutive steps of the model are one turn, the way a reader sees one answer. */
export function conversationTurns(messages: readonly Message[]): readonly { readonly speaker: Speaker; readonly text: string }[] {
  const turns: { speaker: Speaker; text: string }[] = []
  const add = (speaker: Speaker, text: string) => {
    if (text.trim() === "") return
    const last = turns[turns.length - 1]
    if (last !== undefined && last.speaker === speaker && speaker === "assistant") last.text += `\n\n${text}`
    else turns.push({ speaker, text })
  }
  for (const message of messages) {
    if (message.excluded !== null) continue
    if (message.kind === "user") add("user", contentText(message.content))
    else if (message.kind === "assistant") {
      add("assistant", message.parts.flatMap((part) => (part.type === "text" && part.text.trim() !== "" ? [part.text.trim()] : [])).join("\n\n"))
    }
  }
  return turns
}

/** `messages` (in `seq` order) as a Markdown document: a heading per turn, the text as it was written under it. */
export function renderMarkdown(messages: readonly Message[], options: MarkdownOptions = {}): string {
  const names = options.names ?? DEFAULT_NAMES
  const parts = options.title === undefined ? [] : [`# ${options.title.replace(/\s+/g, " ").trim()}`]
  for (const turn of conversationTurns(messages)) parts.push(`## ${names[turn.speaker]}\n\n${closeFences(turn.text)}`)
  return parts.length === 0 ? "" : `${parts.join("\n\n")}\n`
}

/** The text of user content; media is named, never embedded. */
function contentText(content: Content): string {
  return content.map((part) => (part.type === "text" ? part.text : `_[attachment: ${part.blob.mediaType}]_`)).join("\n\n").trim()
}

/**
 * `text`, with a code fence closed if it was left open, so that it cannot swallow the headings after it.
 * A fence opens with three or more backticks or tildes and closes with the same character, at least as many.
 */
function closeFences(text: string): string {
  let open: { readonly char: string; readonly length: number } | null = null
  for (const line of text.split("\n")) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence === null) continue
    const run = fence[1]!
    const char = run[0]!
    if (open === null) {
      // A backtick fence's info string cannot contain a backtick: that line is inline code, not a fence.
      if (char === "`" && fence[2]!.includes("`")) continue
      open = { char, length: run.length }
    } else if (char === open.char && run.length >= open.length && fence[2]!.trim() === "") open = null
  }
  return open === null ? text : `${text}\n${open.char.repeat(open.length)}`
}
