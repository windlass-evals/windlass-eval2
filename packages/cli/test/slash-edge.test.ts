import { describe, expect, test } from "bun:test"
import { lookup } from "../src/slash.ts"

describe("slash lookup edge cases", () => {
  describe("whitespace", () => {
    test.each(["", " ", "\t\r\n", "\u00a0\u2003\u3000"])("leaves empty or whitespace-only input unchanged: %j", (entry) => {
      expect(lookup(entry)).toEqual({ kind: "message", text: entry })
    })

    test.each([" ", "\t", "\r\n", "\u00a0", "\u2003", "\u3000"])("accepts whitespace around a command: %j", (space) => {
      expect(lookup(`${space}/help${space}`)).toMatchObject({ kind: "command", command: { name: "help" }, rest: "" })
      expect(lookup(`/rename${space}new${space}title${space}`)).toMatchObject({ kind: "command", command: { name: "rename" }, rest: `new${space}title` })
    })

    test("trims only the edges of multiline arguments", () => {
      expect(lookup(" \t/queue\r\n  first line\n\n  second\tline  \r\n")).toMatchObject({
        kind: "command", command: { name: "queue" }, rest: "first line\n\n  second\tline",
      })
    })

    test.each(["  ordinary text \t", " \t/etc/hosts \n", "/ help", "/\thelp", "/\nhelp"])("preserves whitespace in non-command input: %j", (entry) => {
      expect(lookup(entry)).toEqual({ kind: "message", text: entry })
    })

    test("an escape drops leading whitespace and exactly one slash, preserving the rest", () => {
      expect(lookup(" \t///help  \n")).toEqual({ kind: "message", text: "//help  \n" })
    })
  })

  describe("unicode", () => {
    test.each(["/café", "/cafe\u0301", "/你好", "/🚀", "/ｈｅｌｐ", "/hеlp", "/help🚀", "/help\u200b"])("treats a non-ASCII name as literal text: %j", (entry) => {
      expect(lookup(entry)).toEqual({ kind: "message", text: entry })
    })

    test("does not treat a zero-width space as leading whitespace", () => {
      const entry = "\u200b/help"
      expect(lookup(entry)).toEqual({ kind: "message", text: entry })
    })

    test("preserves unicode arguments without normalizing them", () => {
      const rest = "café cafe\u0301  你好 🚀"
      expect(lookup(`/rename ${rest}`)).toMatchObject({ kind: "command", command: { name: "rename" }, rest })
    })
  })

  describe("very long input", () => {
    const long = "x".repeat(100_000)

    test("keeps a long argument intact, including internal whitespace", () => {
      const rest = `${long}\n  ${long}\tend`
      expect(lookup(`/queue  ${rest}  `)).toMatchObject({ kind: "command", command: { name: "queue" }, rest })
    })

    test("returns the complete unknown name without a suggestion", () => {
      expect(lookup(`/${long} ignored arguments`)).toEqual({ kind: "unknown", name: long, suggestion: null })
    })

    test("keeps a long path-like token as a message rather than matching a command prefix", () => {
      const entry = `/help${long}/file`
      expect(lookup(entry)).toEqual({ kind: "message", text: entry })
    })

    test("unescapes a long message without truncation", () => {
      expect(lookup(`//${long}`)).toEqual({ kind: "message", text: `/${long}` })
    })
  })
})
