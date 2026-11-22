/**
 * Writes a stored session to stdout as Markdown: the user's messages and the model's replies in order, under a
 * heading per speaker. No tool calls, tool results or reasoning (packages/core/src/transcript).
 *
 *   bun scripts/export-markdown.ts <session-id> [--data-dir <dir>] [--no-title]
 *   bun scripts/export-markdown.ts --list [--data-dir <dir>]
 *
 * Sessions are one database file each under the harness data directory (`$XDG_DATA_HOME/<brand>`, or
 * `~/.local/share/<brand>`); `--data-dir` names another one, and the session may be given by a unique prefix of its
 * ID. The session is read through a read-only connection that takes no lock, so one that is running can be exported.
 * Nothing from the sign-in is read. Exit codes: 0 written, 1 usage error or no such session.
 */
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { brand } from "../packages/core/src/brand.ts"
import { openSessionDirectory } from "../packages/core/src/store/directory.ts"
import { StoreError } from "../packages/core/src/store/store.ts"
import { renderMarkdown } from "../packages/core/src/transcript/markdown.ts"

const USAGE = `usage: bun scripts/export-markdown.ts <session-id> [--data-dir <dir>] [--no-title]
       bun scripts/export-markdown.ts --list [--data-dir <dir>]`

const { values, positionals } = (() => {
  try {
    return parseArgs({
      args: Bun.argv.slice(2),
      allowPositionals: true,
      options: {
        "data-dir": { type: "string" },
        "no-title": { type: "boolean" },
        list: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    })
  } catch (error) {
    fail(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
  }
})()

if (values.help) {
  console.log(USAGE)
  process.exit(0)
}
if (!values.list && positionals.length !== 1) fail(USAGE)

const dataDir = values["data-dir"] ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), brand.directory)
if (!existsSync(dataDir)) fail(`nothing at ${dataDir}`)
const sessions = openSessionDirectory({ dataDir })
process.on("exit", () => sessions.close())

if (values.list) {
  const entries = sessions.list({ includeArchived: true })
  if (entries.length === 0) console.error(`no sessions in ${dataDir}`)
  for (const entry of entries) console.log(`${entry.session.id}  ${new Date(entry.updatedAt).toISOString()}  ${entry.session.title ?? "(untitled)"}`)
  process.exit(0)
}

try {
  const id = sessions.resolve(positionals[0]!)
  const { title, messages } = sessions.read(id, (store) => ({ title: store.getSession(id)?.session.title ?? null, messages: store.readMessages(id) }))
  process.stdout.write(renderMarkdown(messages, title === null || title === "" || values["no-title"] ? {} : { title }))
} catch (error) {
  if (error instanceof StoreError) fail(`${error.message} in ${dataDir} (list them with --list)`)
  throw error
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}
