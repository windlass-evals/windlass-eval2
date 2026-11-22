import { describe, expect, test } from "bun:test"
import {
  DecodeError,
  array,
  branded,
  extensible,
  integer,
  json,
  literal,
  nullable,
  object,
  oneOf,
  safeDecode,
  string,
  variant,
} from "../src/validate.ts"

const shape = variant("kind", {
  circle: object({ kind: literal("circle"), radius: integer(0) }),
  label: object({ kind: literal("label"), text: string, tags: array(oneOf(["a", "b"])), note: nullable(string) }),
})

describe("validate", () => {
  test("returns the decoded value", () => {
    const input: unknown = { kind: "label", text: "hi", tags: ["a", "b"], note: null }
    const decoded = shape(input, "")
    expect(decoded).toEqual({ kind: "label", text: "hi", tags: ["a", "b"], note: null })
    expect(decoded).not.toBe(input as never)
  })

  test("rejects an unknown key instead of dropping it", () => {
    const result = safeDecode(shape, { kind: "circle", radius: 1, colour: "red" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.path).toBe("colour")
  })

  test("rejects a missing key; absent values must be explicit null", () => {
    const result = safeDecode(shape, { kind: "label", text: "hi", tags: [] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.path).toBe("note")
  })

  test("reports the path of a nested failure", () => {
    const result = safeDecode(object({ items: array(shape) }), { items: [{ kind: "circle", radius: -1 }] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toBe("items[0].radius: expected integer >= 0, got -1")
  })

  test("rejects an unknown variant tag", () => {
    expect(() => shape({ kind: "square" }, "")).toThrow(DecodeError)
    expect(() => shape({}, "")).toThrow(DecodeError)
    expect(() => shape({ kind: "toString" }, "")).toThrow(DecodeError)
  })

  test("integer rejects fractions, unsafe values and other types", () => {
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, "1", null])
      expect(() => integer()(bad, "n")).toThrow(DecodeError)
    expect(integer()(-3, "n")).toBe(-3)
  })

  test("json accepts JSON and rejects everything else, deeply", () => {
    const value = { a: [1, "x", null, { b: true }] }
    expect(json(value, "")).toEqual(value)
    for (const bad of [undefined, Number.NaN, new Date(0), { a: [undefined] }, { a: () => 1 }, new Map()])
      expect(() => json(bad, "")).toThrow(DecodeError)
  })

  test("objects reject arrays, null and class instances", () => {
    for (const bad of [[], null, new Date(0), "x"]) expect(() => object({})(bad, "")).toThrow(DecodeError)
  })

  test("an extensible object checks the keys it knows and keeps the others as they are", () => {
    const report = extensible({ name: string, count: integer(0), inner: object({ ok: literal(true) }) })
    const input = { name: "a", count: 2, inner: { ok: true }, added: { by: ["a later build", 1, null] }, flag: false }
    const decoded = report(input, "")
    expect(decoded).toEqual(input as never)
    expect(decoded).not.toBe(input as never)
    // The keys it knows are held to their types, and the ones it needs are needed.
    expect(() => report({ ...input, count: -1 }, "at")).toThrow("at.count: expected integer >= 0")
    expect(() => report({ name: "a", inner: { ok: true }, added: 1 }, "")).toThrow("count: expected a value")
    // An object inside it is as strict as it was declared.
    expect(() => report({ ...input, inner: { ok: true, more: 1 } }, "")).toThrow("inner.more: expected no such key")
    // A key it does not know holds JSON.
    expect(() => report({ ...input, added: { at: new Date(0) } }, "")).toThrow("added.at: expected JSON value")
    for (const bad of [[], null, "x"]) expect(() => report(bad, "")).toThrow(DecodeError)
  })

  test("branded validates the underlying string", () => {
    const id = branded<string & { readonly __id: "thing" }>()
    expect(id("abc", "")).toBe("abc" as never)
    expect(() => id("", "")).toThrow(DecodeError)
  })

  test("safeDecode lets errors that are not DecodeError through", () => {
    expect(() =>
      safeDecode(() => {
        throw new RangeError("bug")
      }, 1),
    ).toThrow(RangeError)
  })
})
