import type { SessionSummary } from "./engine.ts"

/** Apply recency filters after any session-ID narrowing, with newest updates first. */
export function filterSessions(
  sessions: readonly SessionSummary[],
  options: { readonly limit: number | null; readonly sinceMs: number | null },
  now = Date.now(),
): SessionSummary[] {
  const cutoff = options.sinceMs === null ? null : now - options.sinceMs
  const recent = sessions
    .filter((session) => cutoff === null || session.updatedAt >= cutoff)
    .toSorted((left, right) => right.updatedAt - left.updatedAt)
  return options.limit === null ? recent : recent.slice(0, options.limit)
}
