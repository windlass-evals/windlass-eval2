/**
 * What the model is told about a home of the session's own. The shell tool's
 * description is frozen with the session's tool list and is the same for
 * every session, so it says nothing of the home; a session whose sandboxed
 * commands get one is told in a message that is appended when that becomes
 * true, and again, with a withdrawal, when it stops being true (source
 * `SESSION_HOME_KEY`, `instructions/state.ts`). The note a failed sandboxed
 * command gets (`approval/escalation.ts`) names the home as well.
 */
import { fingerprint } from "../instructions/source.ts"

/** The `source` of the messages about it. */
export const SESSION_HOME_KEY = "session-home"

export const SESSION_HOME_TEXT = {
  used: [
    "Commands that run in the sandbox have a home directory of this session's own (Linux). Besides the working directory and the temp directory, a command can create files and directories under the home directory, as tools do for their caches, settings and state.",
    "What a command creates there is kept for this session's commands only. The user's real home does not get it, the file tools read and write the user's real home and not this one, and it is gone for the user when the session is over. So do not rely on it for anything the user is meant to keep, such as a tool installed for them or a setting of theirs.",
    'What the user already has under the home directory is read-only there, and a directory the user already has is read-only as a whole: nothing can be added inside it. When a command must write there, or anywhere else outside the working directory and the temp directory, pass `sandbox` with `write` and that directory: the user is asked, and what the command then writes is in the user\'s real directory.',
  ].join("\n"),
  gone: "Commands that run in the sandbox no longer have a home directory of this session's own: under the home directory they can write nothing, as the shell tool says. What earlier commands created there is not there for the next ones.",
} as const

/**
 * What to append so that the model knows whether sandboxed commands have the
 * session's home, given the fingerprint it last had for `SESSION_HOME_KEY`
 * (`null` or `undefined`: it was told nothing, or that the home is gone).
 * `null` when it knows already.
 */
export function sessionHomeUpdate(known: string | null | undefined, used: boolean): { readonly text: string; readonly fingerprint: string | null } | null {
  if (!used) return known === null || known === undefined ? null : { text: SESSION_HOME_TEXT.gone, fingerprint: null }
  const current = fingerprint(SESSION_HOME_TEXT.used)
  return current === known ? null : { text: SESSION_HOME_TEXT.used, fingerprint: current }
}
