/**
 * Real processes under bubblewrap. Every test spawns the sandbox the way the
 * shell tool will: detached, with the planned argv, env and cwd.
 */
import { afterAll, afterEach, describe, expect, test, setDefaultTimeout } from "bun:test"
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { networkInterfaces } from "node:os"
import { join } from "node:path"
import { ACCESS_TOKEN_FILE_ENV } from "../../src/auth/handed-in.ts"
import { brand } from "../../src/brand.ts"
import { type SandboxPolicy, defaultPolicy, homeMounts, sandboxCommand } from "../../src/sandbox/index.ts"
import { descendants, isRunning, plan, removeTempDirs, run, skipReason, spawnPlan, tempDir, waitUntil } from "./helpers.ts"
import { E2E_TIMEOUT_MS, waitFor } from "../../src/testing/wait.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

afterEach(removeTempDirs)

const title = skipReason ? `bwrap backend (SKIPPED: ${skipReason})` : "bwrap backend"

/** A workspace, a sibling directory outside it, and a fake home holding credentials. */
function fixture(overrides: Partial<SandboxPolicy> = {}) {
  const root = tempDir("fs")
  const workspace = join(root, "workspace")
  const outside = join(root, "outside")
  const home = join(root, "home")
  mkdirSync(workspace)
  mkdirSync(outside)
  mkdirSync(join(home, ".ssh"), { recursive: true })
  mkdirSync(join(home, ".local", "share", brand.directory), { recursive: true })
  writeFileSync(join(home, ".ssh", "id_ed25519"), "SSH-PRIVATE-KEY-MATERIAL\n")
  writeFileSync(join(home, ".netrc"), "machine example.com password NETRC-PASSWORD\n")
  writeFileSync(join(home, ".local", "share", brand.directory, "auth.json"), '{"token":"HARNESS-AUTH-TOKEN"}\n')
  writeFileSync(join(home, "notes.txt"), "ordinary file\n")
  const policy = { ...defaultPolicy({ workspace, home, env: {} }), ...overrides }
  return { root, workspace, outside, home, policy }
}

/** Every path under `dir` with what it is and, for a file or a link, what it holds: two of these are equal when nothing was added, removed or changed. */
function contents(dir: string): string[] {
  return (readdirSync(dir, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
    .map((entry) => {
      const path = join(entry.parentPath, entry.name)
      return `${path.slice(dir.length)} ${entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "link" : JSON.stringify(readFileSync(path, "utf8"))}`
    })
    .sort()
}

/** The fixture with a home of the command's own: the user's home also has settings and a cache, and `own` takes what a command writes under it. */
function homeFixture() {
  const f = fixture()
  const own = join(f.root, "session.home")
  mkdirSync(own)
  mkdirSync(join(f.home, ".config", "git"), { recursive: true })
  mkdirSync(join(f.home, ".cache", "pip"), { recursive: true })
  writeFileSync(join(f.home, ".gitconfig"), "[user]\n\tname = The User\n")
  writeFileSync(join(f.home, ".config", "git", "ignore"), "*.swp\n")
  writeFileSync(join(f.home, ".cache", "pip", "selfcheck.json"), "{}\n")
  writeFileSync(join(f.home, ".local", "share", "data.txt"), "user data\n")
  symlinkSync("notes.txt", join(f.home, "notes-link"))
  const policy: SandboxPolicy = { ...defaultPolicy({ workspace: f.workspace, home: f.home, env: {}, homeRoot: own }) }
  const sh = (shell: string) => run(plan(policy, shell, f.workspace, { HOME: f.home, PATH: process.env.PATH }))
  return { ...f, own, policy, sh }
}

/**
 * The home fixture as one session runs its commands: each is planned with the
 * mounts the running ones have in the home and followed to its end, as
 * `createCommandSandbox` and the shell tool do. `start` returns once the
 * command says it runs (it makes `started/<label>` in the workspace first).
 */
function homeSession() {
  const f = homeFixture()
  const mounts = homeMounts()
  mkdirSync(join(f.workspace, "started"))
  const begin = (shell: string, policy: SandboxPolicy = f.policy) => {
    const planned = sandboxCommand(policy, { shell, shellPath: "/bin/bash", cwd: f.workspace }, { env: { HOME: f.home, PATH: process.env.PATH }, homeMounts: mounts })
    if (planned.kind !== "ready") throw new Error(planned.reason)
    const child = spawnPlan(planned)
    planned.started?.(child.pid)
    const done = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).then(async ([stdout, stderr, code]) => {
      await planned.ended?.()
      return { stdout, stderr, code }
    })
    return { child, done }
  }
  const start = async (label: string, shell: string, policy?: SandboxPolicy) => {
    const command = begin(`touch started/${label}\n${shell}`, policy)
    await waitFor(() => existsSync(join(f.workspace, "started", label)))
    return command
  }
  const stop = async (command: ReturnType<typeof begin>) => {
    process.kill(-command.child.pid, "SIGTERM")
    return command.done
  }
  return { ...f, mounts, start, stop, sh: (shell: string, policy?: SandboxPolicy) => begin(shell, policy).done }
}

/**
 * A command that waits for something to be put at one of `names` in its home
 * and at once puts a link to `target/<name>` in its place: what a hostile
 * command in the background does to a mount point that is made for the next
 * command. `/oldroot` is where bwrap keeps the host while it sets a sandbox
 * up, so a link through it names a path of the host.
 */
function swapping(names: readonly string[], target: string) {
  return `while :; do for name in ${names.join(" ")}; do p=~/$name; if [ -e "$p" ] && [ ! -L "$p" ]; then rm -rf "$p" 2>/dev/null; ln -s "/oldroot${target}/$name" "$p" 2>/dev/null; fi; done; done`
}

describe.skipIf(skipReason !== null)(title, () => {
  describe("a home of the command's own", () => {
    test("a tool makes its cache, settings and state under the home; they are there for the next command, in the session's directory, and the user's home is unchanged", async () => {
      const f = homeFixture()
      const before = contents(f.home)
      const made = await f.sh(
        "mkdir -p ~/.cache/tool ~/.config/tool ~/.local/state/tool ~/.local/share/tool ~/.tool && for dir in .cache .config .local/state .local/share; do echo $dir > ~/$dir/tool/file; done && echo top > ~/.tool/file && echo rc > ~/.toolrc && echo made",
      )
      expect(made).toMatchObject({ stdout: "made\n", stderr: "", code: 0 })
      const next = await f.sh("cat ~/.cache/tool/file ~/.config/tool/file ~/.local/state/tool/file ~/.local/share/tool/file ~/.tool/file ~/.toolrc")
      expect(next.stdout).toBe(".cache\n.config\n.local/state\n.local/share\ntop\nrc\n")
      expect(readFileSync(join(f.own, "shared", ".config", "tool", "file"), "utf8")).toBe(".config\n")
      expect(readFileSync(join(f.own, "shared", encodeURIComponent(".local/state"), "tool", "file"), "utf8")).toBe(".local/state\n")
      expect(readFileSync(join(f.own, "home", ".toolrc"), "utf8")).toBe("rc\n")
      expect(contents(f.home)).toEqual(before)
    })

    test("what the user has in the home is read as before, links included, and none of it can be changed, removed or added to", async () => {
      const f = homeFixture()
      const before = contents(f.home)
      const read = await f.sh("cat ~/.gitconfig ~/.config/git/ignore ~/.cache/pip/selfcheck.json ~/.local/share/data.txt ~/notes-link && ls -A ~ | sort | tr '\\n' ' '")
      expect(read.stdout).toBe("[user]\n\tname = The User\n*.swp\n{}\nuser data\nordinary file\n.cache .config .gitconfig .local .netrc .ssh notes-link notes.txt ")
      expect(read.code).toBe(0)
      const changed = await f.sh(
        "echo x >> ~/.gitconfig; echo x > ~/.config/git/ignore; echo x > ~/.config/git/new; echo x > ~/.cache/pip/new; rm ~/notes.txt; rm -rf ~/.config/git; mv ~/.gitconfig ~/moved; echo x > ~/notes-link; echo done",
      )
      expect(changed.stdout).toBe("done\n")
      expect(changed.stderr.match(/Read-only file system|Device or resource busy/g)?.length).toBe(8)
      expect(contents(f.home)).toEqual(before)
      expect((await f.sh("cat ~/.gitconfig ~/notes.txt")).stdout).toBe("[user]\n\tname = The User\nordinary file\n")
    })

    test("credential stores and the harness's data stay unreadable, and one the command makes for itself is not the user's", async () => {
      const f = homeFixture()
      const result = await f.sh(`cat ~/.ssh/id_ed25519; ls ~/.ssh; cat ~/.netrc; cat ~/.local/share/${brand.directory}/auth.json; echo x > ~/.netrc; mkdir ~/.aws && echo made-up > ~/.aws/credentials && cat ~/.aws/credentials`)
      expect(result.stdout).toBe("made-up\n")
      expect(result.stderr.match(/Permission denied|Read-only file system/g)).toEqual(["Permission denied", "Permission denied", "Permission denied", "Permission denied", "Read-only file system"])
      for (const secret of ["SSH-PRIVATE-KEY-MATERIAL", "NETRC-PASSWORD", "HARNESS-AUTH-TOKEN"]) expect(result.stdout + result.stderr).not.toContain(secret)
      expect(readFileSync(join(f.home, ".netrc"), "utf8")).toContain("NETRC-PASSWORD")
      expect(existsSync(join(f.home, ".aws"))).toBe(false)
      // The stand-ins under the masks hold nothing of the user's.
      expect(readFileSync(join(f.own, "home", ".netrc"), "utf8")).toBe("")
      expect(readdirSync(join(f.own, "home", ".ssh"))).toEqual([])
    })

    test("a shared directory cannot be renamed, removed or replaced by a link, so nothing made for the next command lands where a command pointed", async () => {
      const f = homeFixture()
      const victim = join(f.root, "victim")
      mkdirSync(victim)
      const swap = await f.sh(`mv ~/.config ~/moved; rmdir ~/.local/state; ln -sfn ${victim} ~/.cache; mv ~/.local ~/moved-too; echo tried`)
      expect(swap.stdout).toBe("tried\n")
      expect(swap.stderr.match(/Device or resource busy/g)?.length).toBe(3)
      // `ln -sfn` on a directory that cannot be replaced makes the link inside it, in the session's own cache.
      expect((await f.sh("cat ~/.config/git/ignore && ls -A ~/.cache")).stdout).toBe("*.swp\npip\nvictim\n")
      expect(readdirSync(victim)).toEqual([])
    })

    test("an entry the user adds to the home during the session is seen by the next command, read-only", async () => {
      const f = homeFixture()
      expect((await f.sh("ls ~/.config")).stdout).toBe("git\n")
      mkdirSync(join(f.home, ".config", "later"))
      writeFileSync(join(f.home, ".config", "later", "settings"), "added later\n")
      const result = await f.sh("cat ~/.config/later/settings; echo x > ~/.config/later/settings")
      expect(result.stdout).toBe("added later\n")
      expect(result.stderr).toContain("Read-only file system")
    })

    test("a workspace inside the home is written as before, and the rest of the home is the command's own", async () => {
      const f = homeFixture()
      const workspace = join(f.home, "work", "project")
      mkdirSync(workspace, { recursive: true })
      const policy = defaultPolicy({ workspace, home: f.home, env: {}, homeRoot: f.own })
      const result = await run(plan(policy, "echo in-workspace > file.txt && echo beside > ../beside.txt; echo own > ~/own.txt && pwd -P", workspace, { HOME: f.home, PATH: process.env.PATH }))
      expect(result.stdout).toBe(`${workspace}\n`)
      expect(result.stderr).toContain("Read-only file system")
      expect(readFileSync(join(workspace, "file.txt"), "utf8")).toBe("in-workspace\n")
      expect(existsSync(join(f.home, "work", "beside.txt"))).toBe(false)
      expect(existsSync(join(f.home, "own.txt"))).toBe(false)
      expect(readFileSync(join(f.own, "home", "own.txt"), "utf8")).toBe("own\n")
    })

    test("overhead: median of 20 runs of `true` with a home of 100 entries", async () => {
      const f = homeFixture()
      for (let index = 0; index < 100; index++) writeFileSync(join(f.home, `.entry-${index}`), "")
      const samples: number[] = []
      for (let i = 0; i < 20; i++) {
        const start = performance.now()
        const sandboxed = sandboxCommand(f.policy, { argv: ["/usr/bin/true"], cwd: f.workspace })
        if (sandboxed.kind !== "ready") throw new Error(sandboxed.reason)
        const child = Bun.spawn(sandboxed.argv, { env: sandboxed.env, cwd: f.workspace, detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" })
        expect(await child.exited).toBe(0)
        samples.push(performance.now() - start)
      }
      const median = samples.sort((a, b) => a - b)[10] ?? 0
      console.log(`[sandbox overhead] true with a home of 100 entries: ${median.toFixed(2)} ms planned and run (median of 20)`)
      expect(median).toBeLessThan(1000)
    })

    test("an entry that appears in the user's home while a command runs is not mounted for the next one, so the running one has no mount point to turn into a link; once none runs it is shown", async () => {
      const f = homeSession()
      const victim = join(f.root, "victim")
      mkdirSync(victim)
      const hostile = await f.start("hostile", swapping(["new-file", "new-directory", ".new-secret"], victim))
      for (let round = 0; round < 3; round++) {
        writeFileSync(join(f.home, "new-file"), "the user's new file\n")
        mkdirSync(join(f.home, "new-directory"), { recursive: true })
        writeFileSync(join(f.home, ".new-secret"), "A-NEW-SECRET\n")
        // The credential store is one the policy hides, and a directory under the new entry is one the user allowed writes to.
        const policy = { ...f.policy, hiddenPaths: [...f.policy.hiddenPaths, join(f.home, ".new-secret")], writableRoots: [...f.policy.writableRoots, join(f.home, "new-directory")] }
        const next = await f.sh("cat ~/new-file ~/.new-secret; ls -d ~/new-directory; echo ran", policy)
        expect(next.stdout).toBe("ran\n")
        expect(next.stderr.match(/No such file or directory/g)?.length).toBe(3)
        expect(readdirSync(victim)).toEqual([])
        for (const name of ["new-file", "new-directory", ".new-secret"]) rmSync(join(f.home, name), { recursive: true })
      }
      await f.stop(hostile)
      expect(f.mounts).toEqual({ running: 0, held: null })
      // With no command of the session running, what the user has now is shown, and nothing is left to race with.
      writeFileSync(join(f.home, "new-file"), "the user's new file\n")
      expect((await f.sh("cat ~/new-file")).stdout).toBe("the user's new file\n")
      expect(readdirSync(victim)).toEqual([])
    })

    test("an entry that leaves the user's home while commands run stays a mount in the next one, so it cannot be replaced before it comes back; one that changes kind is shown empty", async () => {
      const f = homeSession()
      const victim = join(f.root, "victim")
      mkdirSync(victim)
      const first = await f.start("first", "sleep 300 & wait")
      rmSync(join(f.home, "notes.txt"))
      rmSync(join(f.home, ".gitconfig"))
      mkdirSync(join(f.home, ".gitconfig"))
      // Planned after the entries left: it has an empty file mounted where each was, and tries to put a link there.
      const hostile = await f.start("hostile", `echo x > ~/notes.txt; cat ~/.gitconfig; echo "[$(cat ~/notes.txt)]" > shown-to-the-hostile\n${swapping(["notes.txt", ".gitconfig"], victim)}`)
      await waitFor(() => existsSync(join(f.workspace, "shown-to-the-hostile")))
      expect(readFileSync(join(f.workspace, "shown-to-the-hostile"), "utf8")).toBe("[]\n")
      writeFileSync(join(f.home, "notes.txt"), "back again\n")
      const next = await f.sh("cat ~/notes.txt; cat ~/.gitconfig; echo ran")
      expect(next).toMatchObject({ stdout: "back again\nran\n", stderr: "", code: 0 })
      expect(readdirSync(victim)).toEqual([])
      // The mount points are as they were made: a running command had each as a mount, and nothing outside changed them.
      expect(lstatSync(join(f.own, "home", "notes.txt")).isFile()).toBe(true)
      expect(lstatSync(join(f.own, "home", ".gitconfig")).isFile()).toBe(true)
      await Promise.all([f.stop(first), f.stop(hostile)])
      expect(f.mounts).toEqual({ running: 0, held: null })
      // Now the directory the user has at that name is shown as one.
      expect((await f.sh("ls -d ~/.gitconfig/ && cat ~/notes.txt")).stdout).toBe(`${join(f.home, ".gitconfig")}/\nback again\n`)
    })

    test("a command counts as running until nothing of its sandbox is left: what it left behind when it exited, and when it had to be killed, also a process that left its process group", async () => {
      const f = homeSession()
      const marker = `3${process.pid}`
      // A command that exits at once and leaves three processes behind that left its group and ignore SIGTERM: bwrap exits with it, they do not.
      const leaving = await f.sh(`for n in 1 2 3; do setsid bash -c 'trap "" TERM HUP; exec sleep ${marker}' & done; exit 0`)
      expect(leaving.code).toBe(0)
      const stubborn = await f.start("stubborn", `trap '' TERM\nsetsid sleep ${marker} &\nsleep 0.3; touch started/settled\nwait`)
      await waitFor(() => existsSync(join(f.workspace, "started", "settled")))
      const commandLine = (pid: string) => {
        try {
          return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim()
        } catch {
          return ""
        }
      }
      const sleepers = () => readdirSync("/proc").filter((entry) => /^\d+$/.test(entry) && commandLine(entry) === `sleep ${marker}`)
      // The first command was over only when its three were dead: the one that runs now has the only one.
      expect(sleepers().length).toBe(1)
      expect(f.mounts.running).toBe(1)
      process.kill(-stubborn.child.pid, "SIGKILL")
      await stubborn.done
      await waitFor(() => f.mounts.running === 0)
      expect(sleepers()).toEqual([])
      expect(f.mounts.held).toBeNull()
    })

    test("a link the command leaves in its home under a name the user's home gets later does not send a mount elsewhere: a directory allowed for writing below it is not mounted", async () => {
      const f = homeSession()
      const victim = join(f.root, "victim")
      mkdirSync(victim)
      expect((await f.sh(`ln -s /oldroot${victim} ~/later && echo planted`)).stdout).toBe("planted\n")
      mkdirSync(join(f.home, "later", "sub"), { recursive: true })
      const policy = { ...f.policy, writableRoots: [...f.policy.writableRoots, join(f.home, "later", "sub")] }
      const next = await f.sh("echo x > ~/later/sub/file; echo ran", policy)
      expect(next.stdout).toBe("ran\n")
      expect(next.stderr).toContain("No such file or directory")
      expect(readdirSync(victim)).toEqual([])
      expect(readdirSync(join(f.home, "later", "sub"))).toEqual([])
    })

    test("a directory the user allowed writes to is the user's own, also under the home", async () => {
      const f = homeFixture()
      const policy = { ...f.policy, writableRoots: [...f.policy.writableRoots, join(f.home, ".cache", "pip")] }
      const result = await run(plan(policy, "echo wheel > ~/.cache/pip/wheel && echo wrote", f.workspace, { HOME: f.home, PATH: process.env.PATH }))
      expect(result.stdout).toBe("wrote\n")
      expect(readFileSync(join(f.home, ".cache", "pip", "wheel"), "utf8")).toBe("wheel\n")
    })
  })

  describe("filesystem", () => {
    test("a write inside the workspace succeeds", async () => {
      const f = fixture()
      const result = await run(plan(f.policy, "echo hello > made.txt && mkdir -p sub/deep && echo nested > sub/deep/file", f.workspace))
      expect(result).toMatchObject({ code: 0, stderr: "" })
      expect(readFileSync(join(f.workspace, "made.txt"), "utf8")).toBe("hello\n")
      expect(readFileSync(join(f.workspace, "sub", "deep", "file"), "utf8")).toBe("nested\n")
    })

    test("a write outside the workspace fails and leaves nothing behind", async () => {
      const f = fixture()
      const result = await run(plan(f.policy, `echo pwned > ${f.outside}/direct; echo pwned > ../outside/relative; touch ${f.home}/in-home`, f.workspace))
      expect(result.stderr).toContain("Read-only file system")
      expect(existsSync(join(f.outside, "direct"))).toBe(false)
      expect(existsSync(join(f.outside, "relative"))).toBe(false)
      expect(existsSync(join(f.home, "in-home"))).toBe(false)
    })

    test("a relative symlink inside the workspace cannot be used to write outside it", async () => {
      const f = fixture()
      writeFileSync(join(f.outside, "existing.txt"), "original\n")
      symlinkSync("../outside", join(f.workspace, "escape-dir"))
      symlinkSync("../outside/existing.txt", join(f.workspace, "escape-file"))
      const result = await run(
        plan(f.policy, "echo pwned > escape-dir/new; echo pwned > escape-file; ln -s ../outside made-inside && echo pwned > made-inside/new2; echo done", f.workspace),
      )
      expect(result.stdout).toBe("done\n")
      expect(result.stderr.match(/Read-only file system/g)?.length).toBe(3)
      expect(existsSync(join(f.outside, "new"))).toBe(false)
      expect(existsSync(join(f.outside, "new2"))).toBe(false)
      expect(readFileSync(join(f.outside, "existing.txt"), "utf8")).toBe("original\n")
    })

    test("hidden paths cannot be read or listed, including the harness data directory", async () => {
      const f = fixture()
      const result = await run(
        plan(
          f.policy,
          `cat ${f.home}/.ssh/id_ed25519; ls ${f.home}/.ssh; cat ${f.home}/.netrc; cat ${f.home}/.local/share/${brand.directory}/auth.json; echo exit-ok`,
          f.workspace,
        ),
      )
      expect(result.stdout).toBe("exit-ok\n")
      expect(result.stderr.match(/Permission denied/g)?.length).toBe(4)
      for (const secret of ["SSH-PRIVATE-KEY-MATERIAL", "NETRC-PASSWORD", "HARNESS-AUTH-TOKEN"]) expect(result.stdout + result.stderr).not.toContain(secret)
    })

    test("a hidden path inside a writable root stays hidden and unwritable", async () => {
      const f = fixture()
      writeFileSync(join(f.workspace, ".env"), "API_KEY=WORKSPACE-SECRET\n")
      const policy = { ...f.policy, hiddenPaths: [...f.policy.hiddenPaths, join(f.workspace, ".env")] }
      const result = await run(plan(policy, "cat .env; echo overwrite > .env; echo exit-ok", f.workspace))
      expect(result.stdout).toBe("exit-ok\n")
      expect(result.stdout + result.stderr).not.toContain("WORKSPACE-SECRET")
      expect(readFileSync(join(f.workspace, ".env"), "utf8")).toBe("API_KEY=WORKSPACE-SECRET\n")
    })

    test("the file an access token is handed in through cannot be read or replaced, outside the workspace or inside it", async () => {
      const f = fixture()
      for (const [where, file] of [
        ["outside the workspace", join(f.outside, "token")],
        ["inside the workspace", join(f.workspace, "token")],
      ] as const) {
        writeFileSync(file, "HANDED-IN-ACCESS-TOKEN\n")
        writeFileSync(`${file}.txt`, "beside it\n")
        const policy = defaultPolicy({ workspace: f.workspace, home: f.home, env: { [ACCESS_TOKEN_FILE_ENV]: file } })
        const result = await run(plan(policy, `cat ${file}; echo overwrite > ${file}; mv ${file}.txt ${file}; cat ${file}.txt; echo exit-ok`, f.workspace))
        expect(result.stdout, where).toBe("beside it\nexit-ok\n")
        expect(result.stderr, where).toContain("Permission denied")
        expect(result.stdout + result.stderr, where).not.toContain("HANDED-IN-ACCESS-TOKEN")
        expect(readFileSync(file, "utf8"), where).toBe("HANDED-IN-ACCESS-TOKEN\n")
        // Without the variable the same file is an ordinary one.
        expect((await run(plan(f.policy, `cat ${file}`, f.workspace))).stdout, where).toBe("HANDED-IN-ACCESS-TOKEN\n")
      }
    })

    test("ordinary files outside the workspace stay readable", async () => {
      const f = fixture()
      const result = await run(plan(f.policy, `head -1 /etc/passwd; cat ${f.home}/notes.txt`, f.workspace))
      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`${readFileSync("/etc/passwd", "utf8").split("\n")[0]}\nordinary file\n`)
    })

    test("with readRest off, only system directories and the workspace are readable", async () => {
      const f = fixture({ readRest: false })
      writeFileSync(join(f.workspace, "mine.txt"), "workspace file\n")
      const result = await run(plan(f.policy, `cat mine.txt; /usr/bin/true && echo system-ok; cat ${f.home}/notes.txt`, f.workspace))
      expect(result.stdout).toBe("workspace file\nsystem-ok\n")
      expect(result.stderr).toContain("No such file or directory")
    })

    test("/tmp is private and empty unless a temp root is given", async () => {
      const f = fixture()
      const marker = `marker-${crypto.randomUUID()}`
      const first = await run(plan(f.policy, `ls -A /tmp | wc -l; echo x > /tmp/${marker} && echo wrote`, f.workspace))
      expect(first.stdout).toBe("0\nwrote\n")
      expect(existsSync(join("/tmp", marker))).toBe(false)
      expect((await run(plan(f.policy, `test -e /tmp/${marker} && echo leaked || echo gone`, f.workspace))).stdout).toBe("gone\n")

      const tempRoot = join(f.root, "tmp")
      mkdirSync(tempRoot)
      const withRoot = await run(plan({ ...f.policy, tempRoot }, `echo kept > /tmp/${marker}; echo "$TMPDIR"`, f.workspace))
      expect(withRoot.stdout).toBe("/tmp\n")
      expect(readFileSync(join(tempRoot, marker), "utf8")).toBe("kept\n")
    })
  })

  describe("network", () => {
    const listener = Bun.listen({ hostname: "0.0.0.0", port: 0, socket: { open: (socket) => void socket.end("hello from host\n"), data: () => {} } })
    afterAll(() => listener.stop(true))
    const hostAddress = Object.values(networkInterfaces())
      .flat()
      .find((address) => address && address.family === "IPv4" && !address.internal)?.address
    const connect = (address: string) => `exec 3<>/dev/tcp/${address}/${listener.port} && head -1 <&3 || echo "connect to ${address} failed"`

    test("off: TCP to a listener on the host fails, over loopback and the host's address", async () => {
      const f = fixture()
      const result = await run(plan(f.policy, [connect("127.0.0.1"), ...(hostAddress ? [connect(hostAddress)] : [])].join("; "), f.workspace))
      expect(result.stdout).toBe(["connect to 127.0.0.1 failed\n", ...(hostAddress ? [`connect to ${hostAddress} failed\n`] : [])].join(""))
    })

    test("off: DNS fails", async () => {
      const f = fixture()
      const result = await run(plan(f.policy, "getent hosts example.com || echo dns-failed", f.workspace))
      expect(result.stdout).toBe("dns-failed\n")
    })

    test("on: TCP to the host listener succeeds", async () => {
      const f = fixture({ network: { mode: "on" } })
      const result = await run(plan(f.policy, connect("127.0.0.1"), f.workspace))
      expect(result.stdout).toBe("hello from host\n")
    })

    test("on: DNS resolves whenever it resolves outside the sandbox", async () => {
      const f = fixture({ network: { mode: "on" } })
      const host = Bun.spawnSync(["getent", "hosts", "example.com"], { stdout: "pipe" })
      if (host.exitCode !== 0) return console.warn("[sandbox tests] DNS does not work outside the sandbox here; skipping the network-on DNS check")
      const result = await run(plan(f.policy, "getent hosts example.com >/dev/null && echo resolved", f.workspace))
      expect(result.stdout).toBe("resolved\n")
    })
  })

  describe("process", () => {
    test("exit code, stdout and stderr pass through unchanged", async () => {
      const f = fixture()
      const result = await run(plan(f.policy, "printf 'out line\\n'; printf 'err line\\n' >&2; printf 'no newline'; exit 42", f.workspace))
      expect(result).toEqual({ stdout: "out line\nno newline", stderr: "err line\n", code: 42, signal: null })
    })

    test("a command killed by a signal is reported as exit code 128+n, not as a signal", async () => {
      const f = fixture()
      expect(await run(plan(f.policy, "kill -KILL $$", f.workspace))).toMatchObject({ code: 137, signal: null })
    })

    test("SIGTERM to the group gives the command its grace period, and every descendant is gone afterwards", async () => {
      const f = fixture()
      const child = spawnPlan(
        plan(
          f.policy,
          [
            `trap 'echo cleaned > cleanup-ran; exit 3' TERM`,
            // a child that ignores SIGTERM, with a grandchild that inherits the ignore
            `bash -c 'trap "" TERM; sleep 300 & wait' &`,
            // a process that leaves the process group entirely
            "setsid sleep 300 &",
            "sleep 300 &",
            "echo ready",
            "wait",
          ].join("\n"),
          f.workspace,
        ),
      )
      const pids = await readyThenDescendants(child, 3)
      expect(pids.length).toBeGreaterThanOrEqual(6)

      process.kill(-child.pid, "SIGTERM")
      expect(await child.exited).toBe(3)
      expect(readFileSync(join(f.workspace, "cleanup-ran"), "utf8")).toBe("cleaned\n")
      expect(await waitUntil(() => !pids.some(isRunning), 10_000)).toBe(true)
    })

    test("SIGKILL to the group kills a tree that ignores SIGTERM, including a setsid escapee", async () => {
      const f = fixture()
      const child = spawnPlan(plan(f.policy, `trap '' TERM\nbash -c 'sleep 300 & wait' &\nsetsid sleep 300 &\necho ready\nwait`, f.workspace))
      const pids = await readyThenDescendants(child, 2)

      process.kill(-child.pid, "SIGTERM")
      await Bun.sleep(300)
      // Nothing died: the sandbox did not turn SIGTERM into an immediate kill.
      expect(pids.filter(isRunning)).toEqual(pids)

      process.kill(-child.pid, "SIGKILL")
      await child.exited
      expect(await waitUntil(() => !pids.some(isRunning), 10_000)).toBe(true)
    })

    test("the sandbox sees only its own processes", async () => {
      const f = fixture()
      const result = await run(plan(f.policy, `ls /proc | grep -cE '^[0-9]+$'; test -e /proc/${process.pid} && echo visible || echo invisible`, f.workspace))
      expect(Number(result.stdout.split("\n")[0])).toBeLessThan(10)
      expect(result.stdout.split("\n")[1]).toBe("invisible")
    })
  })

  describe("environment", () => {
    test("credential-looking variables do not reach the child", async () => {
      const f = fixture()
      const env = {
        PATH: process.env.PATH,
        HOME: f.home,
        GITHUB_TOKEN: "ghp_secret",
        OPENAI_API_KEY: "sk-openai",
        ANTHROPIC_BASE_URL: "https://proxy.example",
        AWS_ACCESS_KEY_ID: "AKIA",
        AWS_REGION: "eu-west-1",
        DB_PASSWORD: "hunter2",
        CLIENT_SECRET: "s3cret",
        SSH_AUTH_SOCK: "/run/agent.sock",
        DATABASE_URL: "postgres://user:pw@db/app",
        SAFE_SETTING: "visible",
        GIT_AUTHOR_NAME: "Someone",
      }
      const result = await run(plan(f.policy, "env | cut -d= -f1 | sort", f.workspace, env))
      const names = result.stdout.trim().split("\n")
      expect(names).toEqual(expect.arrayContaining(["GIT_AUTHOR_NAME", "HOME", "PATH", "SAFE_SETTING", "TMPDIR"]))
      for (const name of ["GITHUB_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_BASE_URL", "AWS_ACCESS_KEY_ID", "AWS_REGION", "DB_PASSWORD", "CLIENT_SECRET", "SSH_AUTH_SOCK", "DATABASE_URL"])
        expect(names).not.toContain(name)
    })
  })

  describe("escapes through host services", () => {
    const uid = process.getuid?.() ?? 0
    const userManager = Bun.which("systemd-run") && Bun.spawnSync(["systemd-run", "--user", "--wait", "-q", "true"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0

    test.skipIf(!userManager)(`systemd-run --user cannot start a unit outside the sandbox${userManager ? "" : " (SKIPPED: no reachable systemd user manager)"}`, async () => {
      const f = fixture()
      const result = await run(plan(f.policy, `XDG_RUNTIME_DIR=/run/user/${uid} systemd-run --user --wait -q true && echo escaped || echo blocked`, f.workspace, { PATH: process.env.PATH }))
      expect(result.stdout).toBe("blocked\n")
    })

    const dockerReachable = existsSync("/run/docker.sock") && Bun.which("curl") && Bun.spawnSync(["curl", "-s", "-m", "3", "--unix-socket", "/run/docker.sock", "http://docker/_ping"]).exitCode === 0
    test.skipIf(!dockerReachable)(`the Docker socket is unreachable${dockerReachable ? "" : " (SKIPPED: no reachable Docker socket on this host)"}`, async () => {
      const f = fixture()
      const result = await run(plan(f.policy, "curl -s -m 3 --unix-socket /var/run/docker.sock http://docker/_ping && echo escaped || echo blocked", f.workspace))
      expect(result.stdout).toBe("blocked\n")
    })
  })

  test("overhead: median of 20 runs of `true`", async () => {
    const f = fixture()
    const trueArgv = ["/usr/bin/true"]
    const sandboxed = sandboxCommand(f.policy, { argv: trueArgv, cwd: f.workspace })
    if (sandboxed.kind !== "ready") throw new Error(sandboxed.reason)
    const time = async (argv: string[]) => {
      const samples: number[] = []
      for (let i = 0; i < 20; i++) {
        const start = performance.now()
        const child = Bun.spawn(argv, { env: sandboxed.env, cwd: f.workspace, detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" })
        expect(await child.exited).toBe(0)
        samples.push(performance.now() - start)
      }
      return samples.sort((a, b) => a - b)[10] ?? 0
    }
    const bare = await time(trueArgv)
    const inSandbox = await time(sandboxed.argv)
    console.log(`[sandbox overhead] true: ${bare.toFixed(2)} ms bare, ${inSandbox.toFixed(2)} ms sandboxed, +${(inSandbox - bare).toFixed(2)} ms per command (median of 20)`)
    expect(inSandbox).toBeLessThan(1000)
  })
})

/** Waits for the command's "ready" line and for its `sleeps` background `sleep` processes, then lists its host-side process tree. */
async function readyThenDescendants(child: ReturnType<typeof spawnPlan>, sleeps: number) {
  const reader = child.stdout.getReader()
  let seen = ""
  while (!seen.includes("ready")) {
    const next = await reader.read()
    if (next.done) throw new Error(`exited before ready: ${seen}`)
    seen += new TextDecoder().decode(next.value)
  }
  reader.releaseLock()
  // Background jobs may still be forking after "ready": the tree is complete once every one of them runs its sleep.
  const sleeping = () => descendants(child.pid).filter((pid) => readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "sleep").length
  await waitUntil(() => {
    try {
      return sleeping() >= sleeps
    } catch {
      return false
    }
  }, E2E_TIMEOUT_MS)
  return descendants(child.pid)
}
