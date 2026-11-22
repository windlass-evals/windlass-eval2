/**
 * The sign-in service cannot be reached (`AUTH_UNREACHABLE`): a refresh that gets no connection, or one whose
 * connection breaks before the answer, fails as an `AuthError` with a code of its own and one line that names the
 * host, like every other sign-in failure, and not as whatever the runtime threw. The saved sign-in is as it was, and
 * the next call refreshes as if nothing had happened.
 *
 * No network is used: the address nothing listens on is this machine's port 1, and the server that breaks the
 * connection is a socket here that closes as soon as it is opened.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AUTH_UNREACHABLE, type AuthConfig, AuthError, type Credentials, accessToken, savedAccessToken } from "../../src/auth/chatgpt.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/** Nothing listens here: a connection is refused at once. */
const NOWHERE = "http://127.0.0.1:1/token"

/** A token endpoint that closes every connection without an answer. */
function droppingServer() {
  let connections = 0
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        connections += 1
        socket.end()
      },
      data() {},
    },
  })
  cleanups.push(() => server.stop(true))
  return { url: `http://127.0.0.1:${server.port}/token`, connections: () => connections }
}

/** A token endpoint that works. */
function tokenServer() {
  let refreshes = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      refreshes += 1
      return Response.json({ access_token: `access_${refreshes}`, refresh_token: `refresh_${refreshes}`, expires_in: 3600 })
    },
  })
  cleanups.push(() => server.stop(true))
  return { url: `http://127.0.0.1:${server.port}/token`, refreshes: () => refreshes }
}

/** A data directory with a saved sign-in that is due for its refresh, and a configuration per token endpoint. */
function signIn() {
  const dir = mkdtempSync(join(tmpdir(), "auth-unreachable-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const saved: Credentials = { hostId: "host", clientId: "client", account: { sub: "user_test" }, accessToken: "access_0", refreshToken: "refresh_0", idToken: "id", scopes: [], expiresAt: Date.now() + 60_000 }
  const file = join(dir, "auth.json")
  writeFileSync(file, JSON.stringify(saved))
  const config = (tokenUrl: string): AuthConfig => ({ issuer: "test", authorizeUrl: "", tokenUrl, jwksUrl: "", dataDir: () => dir, env: {} })
  return { dir, file, config }
}

const failure = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  )
  if (!(error instanceof AuthError)) throw new Error(`expected an AuthError, got ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
  return error
}

describe("a refresh that cannot reach the sign-in service", () => {
  test("no connection: an AuthError with the network's own code and one line that names the host", async () => {
    const at = signIn()
    const before = readFileSync(at.file, "utf8")
    const error = await failure(savedAccessToken(at.config(NOWHERE)))
    expect(error.code).toBe(AUTH_UNREACHABLE)
    expect(AUTH_UNREACHABLE).toBe("network_error")
    expect(error.message).toStartWith("Could not reach the sign-in service at 127.0.0.1:1: ")
    // One line and one sentence: the runtime's reason, without the advice it adds for whoever wrote the request.
    expect(error.message).not.toMatch(/\n|\.\s/)
    // Nothing of the request is in it, and the saved sign-in is as it was.
    expect(error.message).not.toContain("refresh_0")
    expect(readFileSync(at.file, "utf8")).toBe(before)
    // A model call's token and a token asked for with time left fail the same way.
    expect((await failure(accessToken(at.config(NOWHERE)))).code).toBe(AUTH_UNREACHABLE)
    expect((await failure(savedAccessToken(at.config(NOWHERE), 30 * 60_000))).code).toBe(AUTH_UNREACHABLE)
    expect(readdirSync(at.dir).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  test("a connection that breaks before the answer fails the same way", async () => {
    const server = droppingServer()
    const at = signIn()
    const error = await failure(savedAccessToken(at.config(server.url)))
    expect(error.code).toBe(AUTH_UNREACHABLE)
    expect(error.message).toStartWith(`Could not reach the sign-in service at ${new URL(server.url).host}: `)
    expect(error.message).not.toMatch(/\n|\.\s/)
    expect(server.connections()).toBeGreaterThan(0)
  })

  test("the next call refreshes as if nothing had happened: the lock is free and the refresh token was not spent", async () => {
    const at = signIn()
    await failure(savedAccessToken(at.config(NOWHERE)))
    const server = tokenServer()
    expect((await savedAccessToken(at.config(server.url))).accessToken).toBe("access_1")
    expect(server.refreshes()).toBe(1)
    expect((JSON.parse(readFileSync(at.file, "utf8")) as Credentials).refreshToken).toBe("refresh_1")
  })
})
