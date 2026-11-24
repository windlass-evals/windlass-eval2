import { describe, expect, test } from "bun:test"
import {
  colorEnabled, displayWidth, flatten, formatBytes, formatDuration, hardWrap, nearest, paint, plural,
  renderLine, renderWrapped, seg, stripAnsi, truncate, wrap, wrapKeeping, wrapWhole,
} from "../src/text.ts"

describe("text helpers", () => {
  test("segments and paint support absent, single, and nested tones", () => {
    expect(seg("hello")).toEqual({ text: "hello" })
    expect(seg("hello", "red")).toEqual({ text: "hello", tone: "red" })
    expect(paint(false, "red", "x")).toBe("x")
    expect(paint(true, undefined, "x")).toBe("x")
    expect(paint(true, "red", "x")).toBe("\x1b[31mx\x1b[39m")
    expect(paint(true, ["bold", "cyan"], "x")).toBe("\x1b[36m\x1b[1mx\x1b[22m\x1b[39m")
    expect(paint(true, "red", "")).toBe("")
  })

  test("measure, truncate, flatten, and strip terminal escapes", () => {
    expect(displayWidth("界a")).toBe(3)
    expect(displayWidth("\x1b[31mred\x1b[39m")).toBe(3)
    expect(truncate("abc", 3)).toBe("abc")
    expect(truncate("abcdef", 4)).toBe("abc…")
    expect(truncate("界ab", 3)).toBe("界…")
    expect(truncate("abc", 0)).toBe("")
    expect(flatten("a\nb\tc\u0001")).toBe("a ⏎ b  c")
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red")
  })

  test("render styled lines to the available width", () => {
    expect(renderLine([seg("ab", "red"), seg("cd", "green")], 3, false)).toBe("ab…")
    expect(renderLine([seg("a\nb", "cyan")], 10, false)).toBe("a ⏎ b")
    expect(renderLine([seg("abcd", "red")], 3, true)).toBe("\x1b[31mab…\x1b[39m")
    expect(renderWrapped([seg("one two three", "red")], 7, false)).toEqual(["one two", "  three"])
  })

  test("word wrapping preserves, breaks, or keeps long words as specified", () => {
    expect(wrap("  one two three", 8)).toEqual(["  one", "two", "three"])
    expect(wrap("abcdefgh", 4)).toEqual(["abc…"])
    expect(wrapWhole("abcde xy", 3)).toEqual(["abc", "de", "xy"])
    expect(wrapKeeping("abcde xy", 3)).toEqual(["abcde", "xy"])
    expect(hardWrap("a\tb界", 4)).toEqual(["a   ", " b界"] )
    expect(hardWrap("abc", 0)).toEqual(["a", "b", "c"])
    expect(wrapWhole("", 0)).toEqual([""])
  })

  test("format counts and durations", () => {
    expect(plural(1, "file")).toBe("1 file")
    expect(plural(1200, "file", "files")).toBe("1,200 files")
    expect(formatDuration(-5)).toBe("0ms")
    expect(formatDuration(999)).toBe("999ms")
    expect(formatDuration(1500)).toBe("1.5s")
    expect(formatDuration(10_499)).toBe("10s")
    expect(formatDuration(61_500)).toBe("1m02s")
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(1024)).toBe("1.0 KB")
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB")
  })

  test("color policy and nearest candidate thresholds", () => {
    expect(colorEnabled(false, {})).toBe(false)
    expect(colorEnabled(true, {})).toBe(true)
    expect(colorEnabled(true, { NO_COLOR: "" })).toBe(true)
    expect(colorEnabled(true, { NO_COLOR: "0" })).toBe(false)
    expect(nearest("STATR", ["start", "status"])).toBe("start")
    expect(nearest("ab", ["ba"])).toBe("ba")
    expect(nearest("cat", ["dog"])).toBeNull()
    expect(nearest("anything", [])).toBeNull()
    expect(nearest("FOO", ["foo"])).toBe("foo")
    expect(nearest("x", ["a", "b"])).toBe("a")
  })
})
