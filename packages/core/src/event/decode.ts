/**
 * The storage boundary for events. Events go into SQLite as JSON text and come
 * back as untyped rows; these functions are the only way across.
 */
import { brand } from "../brand.ts"
import { canonicalJson } from "../request/canonical.ts"
import { sessionId } from "../id.ts"
import { DecodeError, integer } from "../validate.ts"
import { type EventType, type NewEvent, type StoredEvent, durableEvents } from "./durable.ts"

/** One row of the `event` table. `data` is the JSON text of the event's data. */
export interface EventRow {
  readonly sessionId: string
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly v: number
  readonly data: string
}

/**
 * Why a row could not be decoded.
 * - `unknown_type` / `unknown_version`: written by a newer build. The caller
 *   must stop rather than skip, because folding a log with a hole in it gives a wrong projection.
 * - `invalid_json` / `invalid_data`: the row is corrupt or was written around the schema.
 */
export class EventDecodeError extends Error {
  constructor(
    readonly reason: "unknown_type" | "unknown_version" | "invalid_json" | "invalid_data",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "EventDecodeError"
  }
}

/**
 * Validates an event before it is appended. Callers are typed, but the store
 * checks anyway so that nothing can be written that cannot be read back.
 */
export function validateEvent(input: { readonly type: string; readonly v: number; readonly data: unknown }): NewEvent {
  if (!isEventType(input.type)) throw new EventDecodeError("unknown_type", `unknown event type ${input.type}`)
  const definition = durableEvents[input.type]
  if (input.v !== definition.v)
    throw new EventDecodeError(
      "unknown_version",
      `event ${input.type} has version ${input.v}; this build reads version ${definition.v}`,
    )
  try {
    return { type: input.type, v: definition.v, data: definition.data(input.data, "data") } as NewEvent
  } catch (error) {
    if (error instanceof DecodeError)
      throw new EventDecodeError("invalid_data", `event ${input.type}: ${error.message}`, { cause: error })
    throw error
  }
}

/** The JSON text to store in the `data` column: canonical, so equal data is equal bytes. */
export function encodeEventData(event: NewEvent): string {
  return canonicalJson(event.data)
}

/** Decodes one row of the `event` table. Throws `EventDecodeError`. */
export function decodeEvent(row: EventRow): StoredEvent {
  const data = parse(row)
  const event = validateEvent({ type: row.type, v: row.v, data })
  try {
    return {
      ...event,
      sessionId: sessionId(row.sessionId, "sessionId"),
      seq: integer(1)(row.seq, "seq"),
      time: integer(0)(row.time, "time"),
    }
  } catch (error) {
    if (error instanceof DecodeError)
      throw new EventDecodeError("invalid_data", `event ${row.type}: ${error.message}`, { cause: error })
    throw error
  }
}

/**
 * What to tell someone whose session cannot be opened because a record in it is not one this build reads: an
 * event of a type or version it does not know, or a key or a value it does not know in an event or in the stored
 * state. Decoding is strict, so a build refuses such a session whole instead of opening it and misreading it,
 * and the usual cause is that a later version has worked in the session. `null` for any other error.
 */
export function unreadableSession(error: unknown): string | null {
  if (!(error instanceof EventDecodeError) && !(error instanceof DecodeError)) return null
  return `that session holds a record this version of ${brand.name} does not read (${error.message}). A later version wrote it, or the file is damaged: open the session with the version that wrote it, or a later one.`
}

export function isEventType(type: string): type is EventType {
  return Object.hasOwn(durableEvents, type)
}

function parse(row: EventRow): unknown {
  try {
    return JSON.parse(row.data)
  } catch (error) {
    throw new EventDecodeError("invalid_json", `event ${row.type} at seq ${row.seq}: data is not JSON`, { cause: error })
  }
}
