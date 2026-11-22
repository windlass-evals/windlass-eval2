import { text } from "../content.ts"
import type { ModelOffer } from "../engine/engine.ts"
import type { Projection } from "../message/message.ts"
import type { ModelRequest } from "../request/request.ts"

const PREFERRED_TITLE_MODEL = "gpt-6-luna"

function titleRank(model: ModelOffer): number {
  if (model.id === PREFERRED_TITLE_MODEL) return 0
  if (/\b(?:fast(?:er|est)?|cheap(?:er|est)?|affordable|low[ -]cost|cost[ -](?:effective|efficient)|lightweight|(?:simple|easy|easier) tasks?)\b/i.test(model.description ?? "")) return 1
  const name = `${model.id} ${model.name ?? ""}`
  if (/\bnano\b/i.test(name)) return 2
  if (/\b(?:mini|small)\b/i.test(name)) return 3
  return 4
}

/** Equal ranks keep the catalog's order. The catalog supplies no per-model prices. */
export function chooseTitleModel(models: readonly ModelOffer[], configured: string | null): string | null {
  const offered = models.filter((model) => model.supportedInApi !== false && model.id.trim() !== "")
  if (configured !== null) return offered.find((model) => model.id === configured)?.id ?? null
  return offered.toSorted((a, b) => titleRank(a) - titleRank(b))[0]?.id ?? null
}

/** Keep a bounded UTF-16 prefix without splitting the last Unicode character. */
export function titleExcerpt(prompt: string): string {
  return prompt.slice(0, 1000).replace(/[\uD800-\uDBFF]$/, "")
}

/** No baseline, history, tools, attachments or session cache key belongs to this independent call. */
export function titleRequest(prompt: string, model: string): ModelRequest {
  return {
    params: { model, reasoningEffort: model === PREFERRED_TITLE_MODEL ? "low" : null, textVerbosity: null, parallelToolCalls: false, cacheKey: null },
    instructions: "Name this session from the user's request. Return just a title of a few words, at most 60 characters, on one line without quotes or trailing punctuation.",
    input: [{ type: "message", role: "user", content: text(titleExcerpt(prompt)) }],
    tools: [],
    toolChoice: "none",
  }
}

/** Rebuild the independent call from the excerpt delivered under this message ID. */
export function storedTitleRequest(state: Projection, messageId: string, model: string): ModelRequest {
  const first = state.messages.find((message) => message.kind === "user")
  if (first?.id !== messageId || first.titlePrompt === undefined) throw new Error("the first prompt has no title excerpt")
  return titleRequest(first.titlePrompt, model)
}

export function cleanTitle(answer: string): string {
  const line = answer.trim().split(/[\r\n\u2028\u2029]/u, 1)[0]!
    .replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").replace(/^[\s"'`\p{Pi}\p{Pf}]+/u, "")
  return Array.from(line).slice(0, 60).join("").replace(/[\p{P}\s`]+$/gu, "")
}
