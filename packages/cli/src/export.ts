/** Markdown transcript of the saved conversation, independent of the engine. */
import { type AssistantPart, type ContentPart, type Message, StoreError, brand, readStoredMessages } from "@windlass/core"
import { dataDir } from "@windlass/core/auth/chatgpt"
import type { Io } from "./main.ts"

export function runExport(io: Pick<Io, "env" | "stdout" | "stderr">, session: string): number {
  let messages: readonly Message[]
  try {
    messages = readStoredMessages(dataDir(io.env), session)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    io.stderr.write(`${brand.binary}: ${reason}\n`)
    return error instanceof StoreError && (error.code === "session_not_found" || error.code === "ambiguous_session") ? 2 : 1
  }
  const markdown = transcript(messages)
  if (markdown !== "") io.stdout.write(markdown)
  return 0
}

function transcript(messages: readonly Message[]): string {
  const sections: string[] = []
  for (const message of messages) {
    if (message.excluded !== null) continue
    if (message.kind === "user") {
      const command = message.command
      const text = command === undefined ? textOf(message.content) : `/${command.name}${command.arguments === "" ? "" : ` ${command.arguments}`}`
      if (text !== "") sections.push(`## User\n\n${text}`)
    } else if (message.kind === "assistant") {
      const text = textOf(message.parts)
      if (text !== "") sections.push(`## Assistant\n\n${text}`)
    }
  }
  return sections.length === 0 ? "" : `${sections.join("\n\n")}\n`
}

/** Only public text parts, without reflowing Markdown or touching provider metadata. */
function textOf(parts: readonly (ContentPart | AssistantPart)[]): string {
  return parts.flatMap((part) => part.type === "text" && part.text.trim() !== "" ? [part.text] : []).join("\n\n")
}
