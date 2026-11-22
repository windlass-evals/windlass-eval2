import { expect, setDefaultTimeout, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { E2E_TIMEOUT_MS } from "../../src/testing/wait.ts"
import { SUMMARY } from "../scenarios/script.ts"
import { fixture, tool } from "./prompt-cache-fixture.ts"

setDefaultTimeout(E2E_TIMEOUT_MS)

const isSummary = (body: Record<string, unknown>) => body.tool_choice === "none"

test("wire prefix at automatic compaction using growing real history", async () => {
  let markCheckpoint = () => {}
  const f = await fixture({ engine: { hooks: { probe(point) {
    if (point === "compaction.ended") markCheckpoint()
  } } } })
  try {
    let turnName = ""
    // Summary and checkpoint requests each consume one approved allowance.
    // Name the checkpoint phase at the real engine boundary, before it sends.
    markCheckpoint = () => f.recording.step(`${turnName}: checkpoint`)
    // The stand-in reports usage estimated from the actual outgoing JSON. Its
    // default tiny usage would hide the token threshold from the real policy.
    // No policy thresholds, history settings or model window are lowered.
    f.mapResponses(async (response, init) => {
      const inputTokens = Math.ceil(String(init.body).length / 4)
      const frames = (await response.text()).split("\n\n").map((frame) => {
        if (!frame.startsWith("data: {")) return frame
        const event = JSON.parse(frame.slice(6))
        if (event.type === "response.completed") event.response.usage = { input_tokens: inputTokens, output_tokens: 100, input_tokens_details: { cached_tokens: 0 } }
        return `data: ${JSON.stringify(event)}`
      })
      return new Response(frames.join("\n\n"), { headers: response.headers })
    })
    let large = true
    f.replyWith((request) => isSummary(request.body) ? SUMMARY : large ? "A synthetic resolved detail. ".repeat(1800) : "Continued.")
    for (let i = 0; i < 9; i++) {
      turnName = `automatic compaction history ${i + 1}`
      await f.turn(turnName, undefined, [])
    }
    large = false
    turnName = "continue after automatic compaction"
    await f.turn(turnName, undefined, [])
    const compactions = f.session.readEvents().filter((e) => e.type === "compaction.started")
    expect(compactions.some((e) => e.data.trigger === "auto")).toBe(true)
    expect(f.session.readEvents().some((e) => e.type === "compaction.ended" && e.data.source === "model")).toBe(true)
    f.finish({
      "automatic compaction history 6": "compaction",
      "automatic compaction history 6: checkpoint": "compaction",
      "automatic compaction history 9": "compaction",
      "automatic compaction history 9: checkpoint": "compaction",
    })
  } finally { await f.close() }
})

test("wire prefix at provider context overflow", async () => {
  const f = await fixture()
  try {
    for (let i = 0; i < 8; i++) await f.turn(`overflow history ${i + 1}`, undefined, ["A synthetic answered detail. ".repeat(900)])
    f.replyWith((request) => isSummary(request.body) ? SUMMARY : "Continued after overflow.")
    await f.turn("provider rejects context size", () => f.intercept(() => new Response(JSON.stringify({ error: { code: "context_length_exceeded", message: "Synthetic context overflow." } }), { status: 400 })), [])
    await f.turn("follow-up after overflow compaction", undefined, [])
    expect(f.session.readEvents().some((e) => e.type === "compaction.started" && e.data.trigger === "overflow")).toBe(true)
    f.finish({ "provider rejects context size": "compaction" })
  } finally { await f.close() }
})

test("wire prefix at image retirement during compaction", async () => {
  const f = await fixture()
  try {
    for (let i = 0; i < 8; i++) await f.turn(`image history ${i + 1}`, undefined, ["A synthetic answered detail. ".repeat(900)])
    for (let i = 1; i <= 3; i++) {
      await f.turn(`read image ${i}`, () => writeFileSync(join(f.cwd, `${i}.png`), Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001080600000000000000", "hex")), [tool("read", { path: `${i}.png` }), "Saw image."])
    }
    f.recording.step("compact and retire old images")
    f.replyWith(() => SUMMARY)
    expect(await f.session.compact()).toMatchObject({ kind: "compacted" })
    await f.turn("continue with retired image note")
    await f.turn("replay retired images unchanged")
    const retired = f.session.readEvents().flatMap((e) => e.type === "compaction.ended" ? e.data.retired ?? [] : [])
    expect(retired.length).toBeGreaterThan(0)
    expect(JSON.stringify(f.recording.requests.at(-1)!.body)).toContain("no longer attached")
    f.finish({
      "compact and retire old images": "compaction",
      "continue with retired image note": "compaction",
    })
  } finally { await f.close() }
})
