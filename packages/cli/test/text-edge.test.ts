import { describe, expect, test } from "bun:test"
import { displayWidth, flatten, hardWrap, paint, renderLine, renderWrapped, seg, stripAnsi, truncate, wrap, wrapKeeping, wrapWhole } from "../src/text.ts"

describe("empty text", () => {
  test("has no width, styling or control characters", () => {
    expect(displayWidth("")).toBe(0)
    expect(paint(true, ["bold", "red"], "")).toBe("")
    expect(flatten("")).toBe("")
    expect(stripAnsi("")).toBe("")
    expect(seg("")).toEqual({ text: "" })
  })

  test("stays empty when truncated, including at zero columns", () => {
    expect(truncate("", 10)).toBe("")
    expect(truncate("", 0)).toBe("")
  })

  test("preserves each wrapper's empty-row convention", () => {
    for (const width of [0, 10]) {
      expect(wrap("", width)).toEqual([])
      expect(wrapWhole("", width)).toEqual([""])
      expect(wrapKeeping("", width)).toEqual([""])
      expect(hardWrap("", width)).toEqual([""])
    }
  })

  test("renders empty segment lists and styled empty segments without ANSI codes", () => {
    for (const width of [0, 10]) {
      for (const parts of [[], [seg("", "red")]]) {
        expect(renderLine(parts, width, true)).toBe("")
        expect(renderWrapped(parts, width, true)).toEqual([""])
      }
    }
  })
})

describe("display columns and graphemes", () => {
  test("counts wide characters, combining marks and ANSI styles by terminal width", () => {
    expect(displayWidth("界")).toBe(2)
    expect(displayWidth("👩‍💻")).toBe(2)
    expect(displayWidth("e\u0301")).toBe(1)
    expect(displayWidth("\u0301")).toBe(0)
    expect(displayWidth("\u200b")).toBe(0)
    expect(displayWidth(paint(true, ["bold", "cyan"], "界e\u0301"))).toBe(3)
    expect(displayWidth("\x1b[31m\x1b[39m")).toBe(0)
  })

  test("keeps an exact fit and reserves a column for the ellipsis when cutting", () => {
    expect(truncate("界界", 4)).toBe("界界")
    expect(truncate("界界", 3)).toBe("界…")
    expect(truncate("界界", 2)).toBe("…")
    expect(truncate("界", 1)).toBe("…")
  })

  test("never splits combining sequences or joined emoji when truncating", () => {
    expect(truncate("e\u0301xy", 2)).toBe("e\u0301…")
    expect(truncate("👩‍💻xy", 3)).toBe("👩‍💻…")
  })

  test("hard-wraps whole graphemes without losing text", () => {
    expect(hardWrap("界界a", 2)).toEqual(["界", "界", "a"])
    expect(hardWrap("e\u0301x", 1)).toEqual(["e\u0301", "x"])
    expect(hardWrap("👩‍💻x", 2)).toEqual(["👩‍💻", "x"])
  })

  test("wraps wide prose by columns rather than string length", () => {
    for (const reflow of [wrap, wrapWhole, wrapKeeping]) {
      expect(reflow("界 界", 4)).toEqual(["界", "界"])
    }
    expect(wrap("界界界", 3)).toEqual(["界…"])
    expect(wrapWhole("界界界", 4)).toEqual(["界界", "界"])
    expect(wrapKeeping("界界界", 4)).toEqual(["界界界"])
  })

  test("accounts for wide styled segments before rendering later segments", () => {
    const parts = [seg("界", "red"), seg("ab", "bold"), seg("ignored")]
    const rendered = renderLine(parts, 3, true)
    expect(rendered).toBe(`${paint(true, "red", "界")}${paint(true, "bold", "…")}`)
    expect(stripAnsi(rendered)).toBe("界…")
    expect(displayWidth(rendered)).toBe(3)
  })
})

describe("zero column limits", () => {
  test("truncation and line rendering emit nothing for visible input", () => {
    for (const text of ["abc", "界", "👩‍💻"]) {
      expect(truncate(text, 0)).toBe("")
      expect(renderLine([seg(text, "bold")], 0, true)).toBe("")
    }
    expect(wrap("one two", 0)).toEqual([])
  })

  test("lossless wrappers use at least one column and keep their word policy", () => {
    expect(hardWrap("ab", 0)).toEqual(["a", "b"])
    expect(wrapWhole("ab cd", 0)).toEqual(["a", "b", "c", "d"])
    expect(wrapKeeping("ab cd", 0)).toEqual(["ab", "cd"])
  })

  test("zero-width text is retained when it already fits", () => {
    for (const text of ["\u0301", "\u200b"]) {
      expect(truncate(text, 0)).toBe(text)
      expect(hardWrap(text, 0)).toEqual([text])
    }
  })
})
