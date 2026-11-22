/**
 * Linux backend: bubblewrap. The command runs in new user, pid, ipc, uts and
 * cgroup namespaces (plus net when the network is off) on a read-only view of
 * the host, with the writable roots bound back read-write, a private /tmp, a
 * fresh /proc (only the sandbox's own processes) and a minimal /dev. With a
 * home of its own (`policy.home`) the command also writes under its home
 * directory, into a directory that is not the user's (`homeArgs`).
 *
 * Process lifetime:
 * - No `--new-session`: every sandboxed process stays in the caller's process
 *   group, so `kill(-pgid)` reaches all of them. The caller spawns detached
 *   (setsid), which also leaves the sandbox without a controlling terminal, so
 *   TIOCSTI injection (the reason `--new-session` exists) has no target.
 * - `--die-with-parent` and the pid namespace: when bwrap or its parent dies,
 *   or the command (pid 2 under bwrap's init) exits, the kernel SIGKILLs every
 *   process left in the namespace, including ones that called setsid.
 * - bwrap itself would die on SIGTERM and take the sandbox down at once, so it
 *   is started through `env --ignore-signal` and the command through
 *   `env --default-signal`: a group SIGTERM reaches only the command and its
 *   descendants, which get the caller's grace period before SIGKILL.
 */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative } from "node:path"
import { brand } from "../brand.ts"
import type { SandboxHome, SandboxPolicy } from "./policy.ts"

export interface BwrapOptions {
  readonly bwrapPath: string
  /** GNU env supporting --ignore-signal/--default-signal, or null to skip the signal trampoline. */
  readonly envPath: string | null
  /**
   * What the commands that run with `policy.home` have mounted in it. A
   * caller that runs several at a time passes the same one for each and
   * follows each with `homeCommand`; without it every command is planned as
   * if no other were running with the home.
   */
  readonly homeMounts?: HomeMounts
  /** An empty file with mode 000 to bind over hidden files. Default: one per user under the temp directory. */
  readonly maskFile?: string
}

const TRAMPOLINE_SIGNALS = "TERM,INT,HUP"
/** Read-only system paths when `readRest` is false. */
const SYSTEM_PATHS = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/etc", "/opt", "/nix", "/run/systemd/resolve"]

/** The full argv (bwrap first, the command last) that runs `command` in `cwd` under `policy`. */
export function bwrapArgv(policy: SandboxPolicy, command: readonly string[], cwd: string, options: BwrapOptions): string[] {
  const hidden = outermost(policy.hiddenPaths.map(existingRealpath).filter((path) => path !== null))
  const home = policy.home ? homeArgs(policy.home, hidden, options.homeMounts) : null
  const homePath = home === null ? null : existingRealpath(policy.home!.path)
  // With a home of the command's own, a mount on a path under the home that the user's entries do not lead to is left out (`homeArgs`).
  const mountable = (real: string) => home === null || homePath === null || real === homePath || !within(homePath, real) || home.reaches(real)
  const args = [
    "--die-with-parent",
    "--unshare-user-try",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    ...(policy.network.mode === "off" ? ["--unshare-net"] : []),
    ...readArgs(policy),
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    // Before the writable roots, so roots under /tmp are bound on top of it.
    ...(policy.tempRoot ? ["--bind", existingRealpath(policy.tempRoot) ?? policy.tempRoot, "/tmp"] : ["--tmpfs", "/tmp"]),
    // Before the writable roots as well: a workspace inside the home is bound on top of it.
    ...(home === null ? [] : home.args),
    ...policy.writableRoots.flatMap((root) => {
      const real = existingRealpath(root)
      return real && mountable(real) ? ["--bind", real, real] : []
    }),
    // After the writable roots, so they are read-only inside them. A file is bound too: replacing it by rename then fails.
    ...(policy.readOnlyPaths ?? []).flatMap((path) => {
      const real = existingRealpath(path)
      return real && mountable(real) ? ["--ro-bind", real, real] : []
    }),
    // Last, so they cover anything above, including paths inside writable roots.
    ...hidden.filter(mountable).flatMap((path) => hideArgs(path, options)),
    "--chdir",
    cwd,
  ]
  const inner = options.envPath ? [options.envPath, `--default-signal=${TRAMPOLINE_SIGNALS}`, ...command] : [...command]
  const outer = options.envPath ? [options.envPath, `--ignore-signal=${TRAMPOLINE_SIGNALS}`, options.bwrapPath] : [options.bwrapPath]
  return [...outer, ...args, "--", ...inner]
}

function readArgs(policy: SandboxPolicy) {
  if (policy.readRest) return ["--ro-bind", "/", "/"]
  return [...SYSTEM_PATHS, ...(policy.readableRoots ?? [])].flatMap((path) => {
    const stat = lstatOrNull(path)
    if (!stat) return []
    // Merged-/usr systems: /bin -> usr/bin must stay a symlink, or binaries resolve twice.
    if (stat.isSymbolicLink() && SYSTEM_PATHS.includes(path)) return ["--symlink", readlinkSync(path), path]
    const real = existingRealpath(path)
    return real ? ["--ro-bind", real, real] : []
  })
}

/**
 * How many of the user's entries the command's home shows, each by a bind of
 * its own. bwrap reads the whole mount table after every bind, so its start
 * takes time with the square of their number: about 50 ms more for 130
 * entries and 0.1 s for this many, measured with bubblewrap 0.9.0.
 */
export const HOME_BINDS = 200

/** One directory of the user's home as a home of the command's own shows it. */
export interface HomeLayer {
  /** Relative to the home; `""` is the home itself. */
  readonly directory: string
  /** How many entries the user has in it. */
  readonly count: number
  /**
   * `true`: the entries no longer fit in `HOME_BINDS`, so the directory is
   * bound as the user's, read-only as a whole, and the command can add
   * nothing in it.
   */
  readonly whole: boolean
  readonly entries: readonly { readonly name: string; readonly kind: "link" | "hidden" | "shared" | "file" | "directory" }[]
}

/**
 * What of the user's home a home of the command's own shows, decided from the
 * user's home alone: the home's own entries first, then the shared
 * directories in the order they are reached. `over` is set, to the number of
 * entries, when the home's own do not fit in `HOME_BINDS`: the command then
 * gets no home of its own. `null`: there can be none (the home or the
 * directory for it is missing, or the home is `/` or holds a directory
 * mounted before it).
 */
export function homeView(home: SandboxHome, hidden: readonly string[] = []): { readonly over: number | null; readonly layers: readonly HomeLayer[] } | null {
  const path = existingRealpath(home.path)
  if (path === null || existingRealpath(home.root) === null) return null
  // `/` as a home, or one that holds a directory mounted above, cannot be replaced without replacing that as well.
  if (["/tmp", "/dev", "/proc"].some((mounted) => within(path, existingRealpath(mounted) ?? mounted))) return null
  const layers: HomeLayer[] = []
  let shown = 0
  const reached = [""]
  for (const directory of reached) {
    const names = namesIn(join(path, directory))
    if (shown + names.length > HOME_BINDS) {
      if (directory === "") return { over: names.length, layers: [] }
      layers.push({ directory, count: names.length, whole: true, entries: [] })
      shown += 1
      continue
    }
    const shared = home.shared.filter((entry) => dirname(entry) === (directory === "" ? "." : directory))
    const entries = names.flatMap((name): HomeLayer["entries"] => {
      const info = lstatOrNull(join(path, directory, name))
      if (info === null) return []
      if (info.isSymbolicLink()) return [{ name, kind: "link" }]
      if (info.isDirectory() && shared.includes(join(directory, name))) return [{ name, kind: "shared" }]
      if (hidden.includes(join(path, directory, name))) return [{ name, kind: "hidden" }]
      return [{ name, kind: info.isDirectory() ? "directory" : "file" }]
    })
    shown += entries.filter((entry) => entry.kind === "file" || entry.kind === "directory").length
    layers.push({ directory, count: names.length, whole: false, entries })
    // The user's directory of that name, or none: a link or a file of that name is an entry like any other.
    reached.push(...shared.filter((entry) => lstatOrNull(join(path, entry))?.isDirectory() !== false))
  }
  return { over: null, layers }
}

/** One place in a home of the command's own that something is mounted on. */
interface HomeSlot {
  /** Relative to the home: `.gitconfig`, `.config`, `.config/git`. */
  readonly place: string
  readonly directory: boolean
  /** A shared directory of the command's own (`own`), the user's entry read-only (`user`), or the stand-in a hidden path's mask covers (`hidden`). */
  readonly holds: "own" | "user" | "hidden"
}

/**
 * What the commands that run with one home of their own have mounted in it,
 * for a caller that runs more than one at a time (a command in the
 * background, two calls of one step). One of these belongs to one
 * `SandboxHome.root`, and every command planned with that home is planned
 * with it.
 *
 * A place in the home that is a mount in a command's sandbox cannot be
 * renamed, removed or replaced by that command. A place that is not is the
 * command's to change, and bwrap follows a link there when it mounts on it
 * for another command. So commands that run at the same time are given the
 * same mounts: while one planned with the home has not ended, the next is
 * planned with exactly the places the first one of them was given, and
 * nothing new is mounted in the home until none is left.
 */
export interface HomeMounts {
  /** The commands planned with the home that are not known to have ended. */
  running: number
  /** What they have mounted in it, in the order it is mounted; `null` while none runs. */
  held: readonly HomeSlot[] | null
}

export function homeMounts(): HomeMounts {
  return { running: 0, held: null }
}

/**
 * Follows one command planned with `mounts` to its end. `started` is told the
 * process that was spawned for it (the leader of a process group of its
 * own), `ended` that this process has exited, or that none was spawned. The
 * command counts as running until its sandbox is empty, which the exit of
 * bwrap does not say: bwrap leaves as soon as the command has, and what the
 * command left behind inside is killed a moment later, when the first
 * process inside, the one every other is a descendant of, has gone. The
 * kernel lets that one go only once every process of its pid namespace is
 * dead. So:
 *
 * - the first process inside is looked for from the moment bwrap is
 *   spawned, and the command is over when that process is gone;
 * - when it was not seen in time (bwrap failed before it made one, or was
 *   over at once), the command is over when its process group is empty: the
 *   first process inside is in it, and stays there until it is reaped;
 * - when neither comes to be within `GONE_MS`, the command counts as running
 *   for as long as this process lives. The home then stays as it is, and is
 *   not unsafe.
 *
 * `ended` resolves when the command is over, or after `SETTLE_MS` when it
 * is not yet: long enough for the usual case, so that a caller that waits
 * for it plans its next command with nothing running.
 */
export function homeCommand(mounts: HomeMounts): { readonly started: (pid: number) => void; readonly ended: () => Promise<void> } {
  let spawned: number | null = null
  let first: { readonly pid: number; readonly birth: string } | null = null
  let over = false
  const release = () => {
    mounts.running -= 1
    if (mounts.running === 0) mounts.held = null
  }
  return {
    started: (pid) => {
      if (over || spawned !== null) return
      spawned = pid
      void (async () => {
        for (let waited = 0; !over && first === null && waited < FIRST_INSIDE_MS; waited += await pause(waited < 4 ? 1 : 5)) first = firstInside(pid)
      })()
    },
    ended: async () => {
      if (over) return
      over = true
      const pid = spawned
      // Nothing was spawned for the plan.
      if (pid === null) return release()
      const inside = first
      const gone = inside === null ? () => !groupAlive(pid) : () => birthOf(inside.pid) !== inside.birth
      const watching = (async () => {
        for (let waited = 0; !gone(); waited += await pause(waited < 10 ? 1 : 10)) if (waited >= GONE_MS) return
        release()
      })()
      await Promise.race([watching, pause(SETTLE_MS)])
    },
  }
}

const FIRST_INSIDE_MS = 2000
const GONE_MS = 10_000
const SETTLE_MS = 250

/** Waits `ms` without keeping the process alive, and says how long it asked for. */
function pause(ms: number): Promise<number> {
  return new Promise((resolve) => setTimeout(() => resolve(ms), ms).unref())
}

/** Whether a process of the group led by `pid` is left, one that exited and was not reaped yet included. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

/** The first process inside the sandbox of the bwrap that runs as `pid`: its child that is process 1 of a pid namespace of its own. */
function firstInside(pid: number): { readonly pid: number; readonly birth: string } | null {
  for (const child of (readOrNull(`/proc/${pid}/task/${pid}/children`) ?? "").split(/\s+/).filter((entry) => entry !== "")) {
    const inside = /^NSpid:(?:\s+\d+)+\s+1$/m.test(readOrNull(`/proc/${child}/status`) ?? "")
    const birth = birthOf(Number(child))
    if (inside && birth !== null) return { pid: Number(child), birth }
  }
  return null
}

/** When the process `pid` started, which tells it from a later one of the same number; `null` when there is none, or only what is left of one that exited. */
function birthOf(pid: number): string | null {
  const stat = readOrNull(`/proc/${pid}/stat`)
  if (stat === null) return null
  // After the parenthesised command name: the state, then the fields up to the start time, the 22nd of the line.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
  return fields[0] === "Z" || fields[0] === "X" ? null : (fields[19] ?? null)
}

/**
 * The command's own home. A directory of `home.root` is bound at the home's
 * path, and every entry of the user's home is bound read-only at its own name
 * inside it: the command reads what the user has there as before and can
 * change none of it, and what it adds beside those entries is written to
 * `home.root`. A shared directory (`.config`, `.cache`) is a directory of
 * `home.root` as well, bound at its place whether or not the user has one,
 * with the user's entries bound one level down, because a directory bound
 * read-only as a whole takes no new entry.
 *
 * Each of these directories is kept apart in `home.root` (`home`, and
 * `shared/<its path>`) and is a mount of its own in the sandbox, and
 * `home.root` itself is mounted nowhere. A command can therefore not rename
 * or replace one, and the mount points and the copies of the user's symbolic
 * links, which are made here and not by bwrap, are always made in a
 * directory whose path a command had no part in. Only binds are used, so
 * this works with a bubblewrap that has no overlay options. A hidden entry
 * gets its mount point and no bind: `hideArgs` then covers an empty
 * stand-in, not the user's entry.
 *
 * What is mounted follows `homeView` while no other command runs with the
 * home (`mounts`): the mount points are made or put right, and the places
 * are kept in `mounts.held`. While another runs, exactly those places are
 * mounted again and no mount point is touched: the user's entry where it
 * still is what it was, an empty stand-in where it is gone or of another
 * kind, and nothing for an entry that has appeared since.
 *
 * `reaches` says whether a mount on a path under the home would land in the
 * user's own entry or on one of these places. bwrap makes what is missing
 * on the way to a mount and follows links, so a mount on any other path
 * would be made in the command's home, where the command decides what the
 * path is: such a path is not mounted on at all.
 */
function homeArgs(home: SandboxHome, hidden: readonly string[], mounts: HomeMounts | undefined): { readonly args: string[]; readonly reaches: (real: string) => boolean } | null {
  const path = existingRealpath(home.path)
  const root = existingRealpath(home.root)
  if (path === null || root === null) return null
  const ownOf = (directory: string) => ownDirectory(root, directory)
  const running = mounts !== undefined && mounts.running > 0 ? mounts.held : null
  const slots = running ?? madeSlots(home, path, hidden, ownOf)
  const own = ownOf("")
  if (slots === null || own === null) return null
  const args = ["--bind", own, path]
  const users = new Set<string>()
  for (const slot of slots) {
    const place = join(path, slot.place)
    if (slot.holds === "own") {
      const directory = ownOf(slot.place)
      // Without its directory the place still gets a mount, so that it stays what it is for the commands that run.
      args.push(...(directory === null ? ["--ro-bind", nothing(root, true)] : ["--bind", directory]), place)
      continue
    }
    const info = lstatOrNull(place)
    const asBefore = info !== null && !info.isSymbolicLink() && info.isDirectory() === slot.directory
    if (slot.holds === "user" && asBefore && !hidden.includes(place)) {
      args.push("--ro-bind", place, place)
      users.add(slot.place)
    } else if (slot.holds === "user" || running !== null) args.push("--ro-bind", nothing(root, slot.directory), place)
  }
  if (mounts !== undefined) {
    mounts.running += 1
    mounts.held = slots
  }
  const held = new Map(slots.map((slot) => [slot.place, slot]))
  return {
    args,
    reaches: (real) => {
      const parts = relative(path, real).split("/")
      for (let depth = 1; depth <= parts.length; depth += 1) {
        const place = parts.slice(0, depth).join("/")
        const slot = held.get(place)
        if (slot === undefined) return false
        if (depth === parts.length) return true
        if (slot.holds !== "own") return users.has(place)
      }
      return false
    },
  }
}

/** The places of a home that nothing else runs with, with their mount points made or put right; `null` when the command gets no home of its own. */
function madeSlots(home: SandboxHome, path: string, hidden: readonly string[], ownOf: (directory: string) => string | null): HomeSlot[] | null {
  const view = homeView(home, hidden)
  if (view === null || view.over !== null) return null
  const slots: HomeSlot[] = []
  const without = new Set<string>()
  for (const layer of view.layers) {
    const parent = layer.directory === "" ? null : dirname(layer.directory) === "." ? "" : dirname(layer.directory)
    const above = parent === null || without.has(parent) ? null : ownOf(parent)
    // Not shown at all: its place cannot be made in the directory above, or the directory it would be bound from is not one.
    const placed = parent === null || (above !== null && mountPoint(join(above, basename(layer.directory)), true))
    const own = placed && !layer.whole ? ownOf(layer.directory) : null
    if (!placed || (!layer.whole && own === null)) {
      without.add(layer.directory)
      continue
    }
    if (parent !== null) slots.push({ place: layer.directory, directory: true, holds: layer.whole ? "user" : "own" })
    if (own === null) continue
    for (const entry of layer.entries) {
      const place = join(layer.directory, entry.name)
      const directory = entry.kind === "directory" || (entry.kind === "hidden" && lstatOrNull(join(path, place))?.isDirectory() === true)
      if (entry.kind === "link") copyLink(join(path, place), join(own, entry.name))
      else if (entry.kind === "hidden") {
        standIn(join(own, entry.name), directory)
        slots.push({ place, directory, holds: "hidden" })
      } else if (entry.kind !== "shared" && mountPoint(join(own, entry.name), directory)) slots.push({ place, directory, holds: "user" })
    }
  }
  return slots
}

/**
 * The directory of `root` that is bound at `directory` of the home, made
 * when it is missing; `null` when what is there is not a directory. It is
 * looked at without following a link: `root` is mounted in no sandbox, so
 * nothing there is a command's doing, and should something be a link all
 * the same, nothing is bound from where it points.
 */
function ownDirectory(root: string, directory: string): string | null {
  const steps = directory === "" ? ["home"] : ["shared", encodeURIComponent(directory)]
  let made = root
  for (const step of steps) {
    made = join(made, step)
    ignoreExists(() => mkdirSync(made))
    if (lstatOrNull(made)?.isDirectory() !== true) return null
  }
  return made
}

/** An empty directory or file of `root` that is bound where the user's entry is gone, so that the place stays a mount. */
function nothing(root: string, directory: boolean): string {
  const kept = join(root, "nothing")
  ignoreExists(() => mkdirSync(kept))
  const path = join(kept, directory ? "directory" : "file")
  ignoreExists(() => (directory ? mkdirSync(path) : writeFileSync(path, "", { flag: "wx" })))
  return path
}

/** A mount point for a hidden entry. What the command made under a credential store's name gives way to it. */
function standIn(path: string, directory: boolean) {
  if (mountPoint(path, directory)) return
  rmSync(path, { recursive: true, force: true })
  mountPoint(path, directory)
}

/**
 * Makes `path` what a directory or a file can be mounted on, and says whether
 * it is. Something else of the command's own under that name stays (the
 * user's entry is then not shown), unless it is empty: a mount point left
 * from an entry the user has since replaced by one of the other kind.
 */
function mountPoint(path: string, directory: boolean): boolean {
  const info = lstatOrNull(path)
  if (info !== null && (directory ? info.isDirectory() : info.isFile())) return true
  try {
    if (info?.isDirectory()) rmdirSync(path)
    else if (info?.isFile() && info.size === 0) unlinkSync(path)
    else if (info !== null) return false
    if (directory) mkdirSync(path)
    else writeFileSync(path, "", { flag: "wx" })
    return true
  } catch {
    return false
  }
}

/** The user's symbolic link `source` as the same link at `own`, unless the command put something there that is not a link. */
function copyLink(source: string, own: string) {
  try {
    const target = readlinkSync(source)
    const info = lstatOrNull(own)
    if (info?.isSymbolicLink() && readlinkSync(own) !== target) unlinkSync(own)
    else if (info !== null) return
    symlinkSync(target, own)
  } catch {
    // The link is then missing in the command's home, as an entry that could not be read is.
  }
}

function namesIn(directory: string): string[] {
  try {
    return readdirSync(directory).sort()
  } catch {
    return []
  }
}

/** Whether `path` is `root` or inside it. */
function within(root: string, path: string) {
  return path === root || path.startsWith(root === "/" ? "/" : `${root}/`)
}

/** A directory becomes an empty mode-000 tmpfs; anything else (file, socket) is covered by the mode-000 mask file. */
function hideArgs(real: string, options: BwrapOptions) {
  if (statSync(real).isDirectory()) return ["--perms", "0000", "--tmpfs", real]
  return ["--ro-bind", options.maskFile ?? processMaskFile(), real]
}

/** Drops duplicates and paths inside another hidden path: mounting them would recreate their parents inside the mask. */
function outermost(paths: string[]) {
  const unique = [...new Set(paths)]
  return unique.filter((path) => !unique.some((other) => other !== path && (path.startsWith(`${other}/`) || other === "/")))
}

let maskFile: string | null = null

/**
 * bwrap can only create files inside the sandbox from a file descriptor, so a
 * hidden file is covered by binding this host file over it. Mode 000 and no
 * capabilities inside the sandbox make every open fail with EACCES (a
 * /dev/null bind would read as empty instead of failing).
 *
 * One stable file per user (`<tmp>/<brand>-sandbox-<uid>/hidden`), so nothing
 * accumulates and nothing needs cleaning up. The directory is only trusted
 * when it is ours, a real directory and private; otherwise a fresh private
 * directory is used.
 */
function processMaskFile() {
  if (maskFile && isMask(maskFile)) return maskFile
  const uid = process.getuid?.() ?? 0
  const stable = join(tmpdir(), `${brand.directory}-sandbox-${uid}`)
  ignoreExists(() => mkdirSync(stable, { mode: 0o700 }))
  const dirStat = lstatOrNull(stable)
  const dir = dirStat?.isDirectory() && dirStat.uid === uid && (dirStat.mode & 0o077) === 0 ? stable : mkdtempSync(join(tmpdir(), `${brand.directory}-sandbox-`))
  const file = join(dir, "hidden")
  if (lstatOrNull(file) && !isMask(file)) rmSync(file, { force: true })
  // Mode 0 at creation (the umask can only remove bits), so the file is never readable, even briefly.
  ignoreExists(() => writeFileSync(file, "", { mode: 0o000, flag: "wx" }))
  maskFile = file
  return file
}

function isMask(path: string) {
  const stat = lstatOrNull(path)
  return stat !== null && stat.isFile() && stat.size === 0 && (stat.mode & 0o777) === 0 && stat.uid === (process.getuid?.() ?? 0)
}

function ignoreExists(create: () => void) {
  try {
    create()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
}

function existingRealpath(path: string) {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function readOrNull(path: string) {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}
