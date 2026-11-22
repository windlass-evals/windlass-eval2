/** Run only by prompt-cache-recovery.e2e.test.ts, in a disposable process. */
import { test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { quotedCommand } from "../../../src/command-line.ts"
import { fixture, tool, warm } from "../prompt-cache-fixture.ts"

test("capture the real wire requests, then die at a durable tool result", async () => {
  const report = process.env.PREFIXLENS_CRASH_REPORT!
  const background = process.env.PREFIXLENS_CRASH_KIND === "background"
  let armed = false
  const f = await fixture({ config: { approval: { mode: "full" } }, engine: { hooks: { probe: (point) => {
    if (!armed || point !== "tool.settled") return
    writeFileSync(report, JSON.stringify({ root: f.root, id: f.session.id, requests: f.recording.requests }))
    process.kill(process.pid, "SIGKILL")
  } } } })
  // Tell the parent where to clean up even if the setup fails before the kill.
  writeFileSync(report, JSON.stringify({ root: f.root }))
  await warm(f)
  if (background) f.write(join(f.cwd, "orphan.ts"), `
    import { watch, writeFileSync } from "node:fs"
    const watcher = watch(".", () => {})
    writeFileSync("orphan.pid", String(process.pid))
    process.on("SIGTERM", () => { watcher.close(); process.exit(0) })
  `)
  armed = true
  await f.turn(background ? "crash with running background command" : "crash after tool settlement", undefined, [
    background ? tool("shell", { command: `exec ${quotedCommand([process.execPath, "orphan.ts"])}`, background: true }) : tool("read", { path: "note.txt" }),
    "Unreachable.",
  ])
  throw new Error("The crash probe did not kill the process")
}, 30_000)
