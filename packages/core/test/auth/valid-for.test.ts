/**
 * A saved sign-in's access token that is good for at least a given time (`savedAccessToken`'s `validForMs`): a
 * token with more than that left is returned as it is, one with less is refreshed first, under the same lock and
 * once however many callers ask, and a token the service issues for less than was asked is returned without
 * another try. Asking for time never makes a refresh later than a model call's margin does.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AuthConfig, AuthError, type Credentials, accessToken, savedAccessToken } from "../../src/auth/chatgpt.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const MINUTE = 60_000

/** A token endpoint that rotates refresh tokens and refuses a used one. Its tokens last `lifetimeSeconds`. */
function tokenServer(lifetimeSeconds = 3600) {
  let current = "refresh_0"
  let refreshes = 0
  const refused: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const presented = new URLSearchParams(await request.text()).get("refresh_token")
      if (presented !== current) {
        refused.push(String(presented))
        return Response.json({ error: "invalid_grant", error_description: "refresh token was already used" }, { status: 400 })
      }
      refreshes += 1
      current = `refresh_${refreshes}`
      return Response.json({ access_token: `access_${refreshes}`, refresh_token: current, expires_in: lifetimeSeconds })
    },
  })
  cleanups.push(() => server.stop(true))
  return { url: `http://127.0.0.1:${server.port}/token`, refreshes: () => refreshes, refused }
}

/** A data directory with a saved sign-in whose access token has `leftMs` before it expires. */
function signIn(tokenUrl: string, leftMs: number) {
  const dir = mkdtempSync(join(tmpdir(), "auth-valid-for-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const saved: Credentials = { hostId: "host", clientId: "client", account: { sub: "user_test" }, accessToken: "access_0", refreshToken: "refresh_0", idToken: "id", scopes: [], expiresAt: Date.now() + leftMs }
  writeFileSync(join(dir, "auth.json"), JSON.stringify(saved))
  const config: AuthConfig = { issuer: "test", authorizeUrl: "", tokenUrl, jwksUrl: "", dataDir: () => dir }
  return { config, saved, file: join(dir, "auth.json"), onDisk: () => JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")) as Credentials }
}

describe("a token that is good for at least a given time", () => {
  test("more than that left: the saved token as it is, and nothing is asked of the service or written", async () => {
    const server = tokenServer()
    const at = signIn(server.url, 40 * MINUTE)
    const before = readFileSync(at.file, "utf8")
    expect(await savedAccessToken(at.config, 30 * MINUTE)).toMatchObject({ accessToken: "access_0", expiresAt: at.saved.expiresAt })
    expect(server.refreshes()).toBe(0)
    expect(readFileSync(at.file, "utf8")).toBe(before)
  })

  test("less than that left: refreshed first, and the rotated tokens are saved, privately", async () => {
    const server = tokenServer()
    const at = signIn(server.url, 20 * MINUTE)
    // Not due by a model call's margin: without the time asked for, it is the saved one.
    expect((await savedAccessToken(at.config)).accessToken).toBe("access_0")
    expect(await accessToken(at.config)).toBe("access_0")
    const token = await savedAccessToken(at.config, 30 * MINUTE)
    expect(token.accessToken).toBe("access_1")
    expect(token.expiresAt).toBeGreaterThan(Date.now() + 30 * MINUTE)
    expect(at.onDisk()).toMatchObject({ accessToken: "access_1", refreshToken: "refresh_1", expiresAt: token.expiresAt, clientId: "client", account: { sub: "user_test" } })
    expect(statSync(at.file).mode & 0o777).toBe(0o600)
    // Asked again, it has enough left: the one refresh.
    expect((await savedAccessToken(at.config, 30 * MINUTE)).accessToken).toBe("access_1")
    expect(server.refreshes()).toBe(1)
    expect(server.refused).toEqual([])
  })

  test("several callers at once refresh once, whatever time each asks for", async () => {
    const server = tokenServer()
    const at = signIn(server.url, 20 * MINUTE)
    const tokens = await Promise.all([savedAccessToken(at.config, 30 * MINUTE), savedAccessToken(at.config, 30 * MINUTE), savedAccessToken(at.config, 30 * MINUTE), savedAccessToken(at.config, 45 * MINUTE)])
    expect(tokens.map((token) => token.accessToken)).toEqual(["access_1", "access_1", "access_1", "access_1"])
    expect(server.refreshes()).toBe(1)
    expect(server.refused).toEqual([])
    // A model call beside one that asks for time, on a token that is due for both.
    writeFileSync(at.file, JSON.stringify({ ...at.onDisk(), expiresAt: Date.now() + MINUTE }))
    expect(await Promise.all([accessToken(at.config), savedAccessToken(at.config, 30 * MINUTE).then((token) => token.accessToken)])).toEqual(["access_2", "access_2"])
    expect(server.refreshes()).toBe(2)
    expect(server.refused).toEqual([])
  })

  test("more asked than the service issues: one refresh, and the token it gave is returned as it is", async () => {
    const server = tokenServer(600)
    const at = signIn(server.url, 5 * MINUTE + 30_000)
    const token = await savedAccessToken(at.config, 30 * MINUTE)
    expect(token.accessToken).toBe("access_1")
    expect(token.expiresAt).toBeLessThan(Date.now() + 30 * MINUTE)
    expect(server.refreshes()).toBe(1)
    expect(at.onDisk().accessToken).toBe("access_1")
  })

  test("less asked than a model call's margin: the token is still refreshed when it is inside that margin", async () => {
    const server = tokenServer()
    const at = signIn(server.url, 3 * MINUTE)
    expect((await savedAccessToken(at.config, MINUTE)).accessToken).toBe("access_1")
    expect(server.refreshes()).toBe(1)
  })

  test("a refused refresh fails with the service's reason, and the saved sign-in is left as it was", async () => {
    const server = tokenServer()
    const at = signIn(server.url, 20 * MINUTE)
    writeFileSync(at.file, JSON.stringify({ ...at.saved, refreshToken: "refresh_revoked" }))
    const before = readFileSync(at.file, "utf8")
    const error = await savedAccessToken(at.config, 30 * MINUTE).then(
      () => null,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(AuthError)
    expect((error as AuthError).code).toBe("invalid_grant")
    expect(readFileSync(at.file, "utf8")).toBe(before)
    // Nothing is left in flight: the next ask tries again, and without the time asked for the saved token still serves.
    expect((await savedAccessToken(at.config)).accessToken).toBe("access_0")
    expect(server.refused).toEqual(["refresh_revoked"])
  })
})
