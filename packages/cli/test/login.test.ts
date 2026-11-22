import { expect, test } from "bun:test"
import { brand } from "@windlass/core"
import { LOGIN_HELP, runLogin } from "../src/login.ts"

const io = () => {
  const out = { stdout: "", stderr: "" }
  return { out, io: { env: {}, stdout: { write: (text: string) => void (out.stdout += text) }, stderr: { write: (text: string) => void (out.stderr += text) }, stdin: { isTTY: false, readAll: async () => "" } } }
}

test("login --help and -h print each form with what it does, and exit 0", async () => {
  for (const argv of [["--help"], ["-h"], ["status", "--help"]]) {
    const { out, io: given } = io()
    expect(await runLogin(argv, given)).toBe(0)
    expect(out.stdout).toBe(LOGIN_HELP)
    expect(out.stderr).toBe("")
  }
  for (const form of ["login [start]", "login finish", "login status", "login token", "login logout"]) expect(LOGIN_HELP).toContain(`  ${brand.binary} ${form}`)
  for (const option of ["--no-browser", "--json", "--valid-for <duration>"]) expect(LOGIN_HELP).toContain(`  ${option}`)
  expect(LOGIN_HELP).toContain(`${brand.binary} login token [--json] [--valid-for <duration>]\n`)
  // What `login token` is for, where the token goes, and that it is a secret.
  const token = LOGIN_HELP.slice(LOGIN_HELP.indexOf("login token"), LOGIN_HELP.indexOf("login logout")).replace(/\s+/g, " ")
  expect(token).toContain(`for another ${brand.name} that cannot share this data directory: it reads the token from the file ${brand.envPrefix}ACCESS_TOKEN_FILE names. The output is a secret`)
  // What the option for a token with time left is for: keeping the other process's file fresh.
  expect(token).toContain("a token good for at least that long, such as 20m or 1h30m: the sign-in is refreshed first when the saved token has less left. Ask with it to keep another process's token file fresh")
  for (const row of LOGIN_HELP.split("\n")) expect(row.length).toBeLessThan(80)
})

test("an unknown login command is still a usage error", async () => {
  const { out, io: given } = io()
  expect(await runLogin(["sideways"], given)).toBe(2)
  expect(out.stderr).toContain('unknown login command "sideways"')
})
