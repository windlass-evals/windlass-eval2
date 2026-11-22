/**
 * Which checks to run for a set of changed files. Pure.
 *
 * Paths are relative to the project directory with `/` separators (the form
 * `when` patterns are written in). A check without `when` runs on any change;
 * with `when`, a changed path must match one of its patterns (Bun.Glob syntax,
 * so `*.ts` matches only top-level files and `**\/*.ts` matches at any depth).
 * The result keeps the configuration's order, so it does not depend on the
 * order in which files were changed.
 */
import type { CheckConfig } from "../config/schema.ts"
import type { CheckStanding } from "./required.ts"

/** What selecting reads of a check: its patterns and, for a required one, the directory they are relative to (`CheckStanding.under`). */
type Selectable = Pick<CheckConfig, "when"> & Pick<CheckStanding, "under">

export function selectChecks<C extends Selectable>(checks: readonly C[], changedFiles: readonly string[]): C[] {
  if (changedFiles.length === 0) return []
  return checks.filter((check) => filesFor(check, changedFiles).length > 0)
}

/**
 * The changed files that a check depends on: all of them without `when`, else those matching a pattern. Sorted and
 * unique. The patterns of a check with `under` are matched against the part of a path after that prefix, and a
 * path without the prefix matches none.
 */
export function filesFor(check: Selectable, changedFiles: readonly string[]): string[] {
  const unique = [...new Set(changedFiles)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const when = check.when
  if (when === null) return unique
  const under = check.under ?? ""
  const globs = when.map((pattern) => new Bun.Glob(pattern))
  return unique.filter((file) => {
    const path = file.startsWith("./") ? file.slice(2) : file
    return path.startsWith(under) && globs.some((glob) => glob.match(path.slice(under.length)))
  })
}
