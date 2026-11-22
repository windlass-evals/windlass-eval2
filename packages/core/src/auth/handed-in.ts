// A sign-in handed in from outside. Several processes can run on one ChatGPT-plan sign-in without sharing a data
// directory (each in a sandbox of its own, on machines of their own): refresh tokens rotate, so a copied `auth.json`
// signs the other copies out at its first refresh. Instead one process holds the sign-in and does all the
// refreshing, and hands the others its short-lived access token (`login token`), which they read from a file.
//
// This is the reading side: the variable that names the file, and the file's two forms. It is not an API key and
// not another provider: the token is the access token of a ChatGPT-plan sign-in that another process holds.

import { readFileSync, statSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { brand } from "../brand.ts"

/** Names the file an access token is handed in through. Set and not empty: the saved sign-in is not used at all. */
export const ACCESS_TOKEN_FILE_ENV = `${brand.envPrefix}ACCESS_TOKEN_FILE`

/** What to do about a handed-in token that cannot be used. Every message about one ends with it. */
export const HAND_IN_ADVICE = `Hand in a new token: write the output of \`${brand.binary} login token\`, run where the sign-in is saved, to that file.`

/** A handed-in token that the provider rejected; `detail` is the provider's answer. */
export const handedInRejected = (detail: string) => `The access token handed in through ${ACCESS_TOKEN_FILE_ENV} was rejected (${detail}). ${HAND_IN_ADVICE}`

/** Why the file gives no token that can be used. Stable: a caller may tell them apart. */
export type HandedInProblem = "handed_in_missing" | "handed_in_unreadable" | "handed_in_empty" | "handed_in_malformed" | "handed_in_expired"

/** The file gave a token and the provider turned it down, also after the file was read once more. Stable, like the file's own codes. */
export const HANDED_IN_REJECTED = "handed_in_rejected"

/**
 * Every code a failure about a handed-in token carries, where a program can read it: the `code` of a failed step's
 * provider error, of a model list that could not be had, and of a sign-in that is not usable. `handed_in_expired`
 * and `HANDED_IN_REJECTED` are about the token (a new sign-in's token is needed); the others are about the file
 * (it was not delivered as it should be).
 */
export type HandedInCode = HandedInProblem | typeof HANDED_IN_REJECTED

/** What the file gives. `expiresAt` (milliseconds since the epoch) is `null` when the file does not state one. */
export type HandedIn =
  | { readonly usable: true; readonly accessToken: string; readonly expiresAt: number | null }
  | { readonly usable: false; readonly code: HandedInProblem; readonly message: string; readonly expiresAt: number | null }

/** The file the access token is handed in through (absolute), or `null` when the variable is unset or empty. */
export function handedInTokenFile(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const value = env[ACCESS_TOKEN_FILE_ENV]
  return value === undefined || value === "" ? null : resolve(value)
}

/** Whether a message about the sign-in is about a handed-in token: it names the variable and says what to do itself. */
export function aboutHandedIn(message: string): boolean {
  return message.includes(ACCESS_TOKEN_FILE_ENV)
}

// What can go into an `Authorization` header: no spaces, no control characters.
const TOKEN = /^[\x21-\x7e]+$/

/** What a token file's text holds: the token and the expiry it states (`null`: none), or why it holds no token. */
function tokenIn(text: string): { readonly accessToken: string; readonly expiresAt: number | null } | "empty" | "malformed" {
  if (text === "") return "empty"
  if (!text.startsWith("{")) return TOKEN.test(text) ? { accessToken: text, expiresAt: null } : "malformed"
  let value: { accessToken?: unknown; expiresAt?: unknown }
  try {
    value = JSON.parse(text)
  } catch {
    return "malformed"
  }
  const { accessToken, expiresAt } = value
  // A time a `Date` can hold, so that it can be shown.
  if (typeof accessToken !== "string" || !TOKEN.test(accessToken) || typeof expiresAt !== "number" || !(Math.abs(expiresAt) <= 8.64e15)) return "malformed"
  return { accessToken, expiresAt }
}

/**
 * Reads the file as it is now. It holds the bare token, or the object `login token --json` prints
 * (`{"accessToken": string, "expiresAt": number}`); surrounding whitespace is ignored. Never throws, and no message
 * contains anything the file holds.
 */
export async function readHandedIn(path: string, now: number = Date.now()): Promise<HandedIn> {
  const problem = (code: HandedInProblem, what: string, expiresAt: number | null = null): HandedIn => ({ usable: false, code, message: `${what} (${path}). ${HAND_IN_ADVICE}`, expiresAt })
  const file = `The file ${ACCESS_TOKEN_FILE_ENV} names`
  let text: string
  try {
    text = (await readFile(path, "utf8")).trim()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "ENOENT" ? problem("handed_in_missing", `${file} does not exist`) : problem("handed_in_unreadable", `${file} cannot be read${code === undefined ? "" : `: ${code}`}`)
  }
  const held = tokenIn(text)
  if (held === "empty") return problem("handed_in_empty", `${file} is empty`)
  if (held === "malformed") return problem("handed_in_malformed", `${file} holds neither an access token nor what \`${brand.binary} login token --json\` prints`)
  if (held.expiresAt !== null && held.expiresAt <= now) return problem("handed_in_expired", `The access token handed in through ${ACCESS_TOKEN_FILE_ENV} expired at ${new Date(held.expiresAt).toISOString()}`, held.expiresAt)
  return { usable: true, ...held }
}

/** A token file larger than this is not looked into by `handedInTokenNow`: a token is a few thousand bytes. */
const TOKEN_FILE_MAX_BYTES = 1024 * 1024

/**
 * The token the file holds at this moment, or `null` when it holds none. For the redaction of tool output, which
 * must know a token from the moment it is in the file, before any model call has read it: so an expired token
 * counts (it is no less a secret), the read is synchronous, and nothing is ever thrown. Only a regular file of a
 * token file's size is read, so that a path that names something else (a pipe, a device) cannot hold a tool call up.
 */
export function handedInTokenNow(path: string): string | null {
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > TOKEN_FILE_MAX_BYTES) return null
    const held = tokenIn(readFileSync(path, "utf8").trim())
    return typeof held === "string" ? null : held.accessToken
  } catch {
    return null
  }
}
