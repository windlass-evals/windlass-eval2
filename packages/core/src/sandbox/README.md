# sandbox

Runs a shell command under an OS sandbox. `sandboxCommand(policy, command)` returns the argv, env and cwd to spawn, or `{ kind: "unavailable", reason, remedy }`. It never spawns anything itself. `detectSandbox()` is cached and costs one probe of about 10 ms on Linux.

## Threat model

It stops a command from:
- writing outside the writable roots, the temp directory and, where it has one, its own home (below), including through `..`, absolute paths, and symlinks (old ones or ones it creates);
- reading or listing hidden paths: SSH, GPG, cloud and AI-tool credentials, browser profiles, the harness's own data and config directories, and the file an access token is handed in through (`auth/handed-in.ts`), wherever it is;
- using the network when it is `off`: TCP, UDP and DNS, including loopback to the host and abstract unix sockets;
- receiving credential-looking environment variables, except the ones named to pass, and any variable named as withheld ("The environment of a session's commands" below);
- on Linux, seeing or signalling host processes, and outliving a kill of its process group.

The default policy also hides `/run/user/<uid>` and the Docker, Podman, containerd, LXD and Incus sockets. Without that, `systemd-run --user` and `curl --unix-socket /var/run/docker.sock` both escaped here with network off. A unix socket on the filesystem stays reachable through a read-only mount.

It does not stop:
- reading any file that is not hidden: source, dotfiles, `/etc`;
- anything at all on the network when it is `on`, which is unrestricted;
- other filesystem unix sockets that are not on the hidden list (Linux);
- reading a hidden file (not a hidden directory) that is replaced by a rename while the command runs (Linux): the file is covered by a mount, and the rename takes the mount away for sandboxes already running. A hidden directory stays hidden whatever is renamed inside it;
- use of CPU, memory or disk (a private `/tmp` is RAM-backed tmpfs);
- kernel exploits;
- writes inside the workspace that run later outside the sandbox: `.git/hooks`, `package.json` scripts, editor task files.

## A home of the command's own

`policy.home` (`SandboxHome`) gives the command a home directory it may write without the user's home changing. Linux only, and only where it is asked for: `createCommandSandbox` gives it to the commands of a session it was told to give it to (`sessionHome.use`), and to no other. The setting is `sandbox.home` (`config.ts`), `"user"` by default.

A directory of `home.root`, a host directory, is bound at the home's path, and every entry of the user's home is bound read-only at its own name inside it. What the user has is read as before and cannot be changed, removed or replaced; what the command makes beside it lands in `home.root`. The directories in `home.shared` (the XDG base directories and what leads to them: `.cache`, `.config`, `.local`, `.local/share`, `.local/state`) are directories of `home.root` too, bound at their places whether or not the user has them, with the user's entries bound one level down, so that a program can make its own directory beside the user's. A hidden path is not bound at all: the mask covers an empty stand-in.

`home.root` holds `home` (what is bound at the home's path) and `shared/<path>` (one directory for each shared directory, its path percent-encoded). They are kept apart, and each is a mount of its own in the sandbox, for one reason: the mount points and the copies of the user's symbolic links are made by this module, outside the sandbox, with the user's rights. A directory that is a mount cannot be renamed or replaced by a command, and `home.root` itself is mounted nowhere. So those are always made in a directory whose path no command had a part in. With the shared directories as plain subdirectories of the home's, a command could rename `~/.config`, leave a link to any directory in its place, and have the next command's mount points made there.

Why it is off unless asked for:
- on a machine with a full home most tools gain little: a directory the user already has is bound read-only as a whole, so a tool whose cache already exists there still cannot write it. That needs copy-on-write, which only an overlay gives; this uses binds alone, so that it works with bubblewrap 0.9.0, which has no overlay options. A writable root granted for such a directory is bound over it and is the user's real one;
- a write under the home that failed, after which the model asks for the directory and the change is the user's, succeeds instead and is the session's alone: a tool installed "for the user" is gone when the session is. The model is told so (`home-note.ts`);
- every command starts slower. bwrap reads the whole mount table after each bind, so the start of a command takes time with the square of the number of entries: about 3 ms more for 10 entries, 15 ms for 50, 55 ms for 130 and 0.1 s for 200 on the machine this was written on.

What it does not do:
- follow a shared directory that is a symbolic link in the user's home (`~/.config` linked into a dotfiles repository): the link is copied, and what it points to is read-only like any other entry;
- scale to a home with very many entries. `HOME_BINDS` (200) bounds the time above: a shared directory whose entries no longer fit is bound read-only as a whole, and a home whose own entries do not fit is left as it is. `homeView` is what decides, from the user's home alone, and `sessionHome.state` gives the sentence for the user that names what was left as it was;
- exist on macOS. `sandbox-exec` restricts paths and cannot show another directory at one, so `seatbelt.ts` ignores `policy.home`. Setting `HOME` to another directory there would be a different mechanism with different results (a program that reads the home from the user database is not redirected, and the user's settings would have to be linked in), and it could not be run here.

The mount points and the copies of the user's symbolic links stay in `home.root` between commands: about one empty file or directory for each entry of the user's home, in each session's home.

### Commands that run at the same time

bwrap makes what is missing on the way to a mount and follows links there. A place in the home that is a mount in a command's sandbox cannot be changed by that command; a place that is not is an entry of the command's own directory, and the command can put a link there. With a mount point made for the next command while a hostile one runs in the background, that was a race the hostile command won every time it was tried here: the user's entry was mounted where the link pointed, and for a file with a link to a missing path under `/oldroot` (where bwrap keeps the host while it sets up) bwrap created an empty file at that path on the host.

Four rules close it, and `test/sandbox/linux.e2e.test.ts` and `workflows.e2e.test.ts` run the hostile commands against them:

1. **Commands that run at the same time have the same mounts in the home** (`HomeMounts`, `homeArgs`). While a command planned with the home is not over, the next is planned with exactly the places the first of them was given, and no mount point is made, removed or replaced: the user's entry where it still is what it was, an empty stand-in (`home.root/nothing`) where it is gone, of another kind or hidden since, and nothing at all for an entry that appeared since. Every place bwrap mounts on is then a mount in every sandbox that could change it. Once no command is running, the next one is planned from the user's home as it is.
2. **A command is over when nothing of its sandbox is left** (`homeCommand`), which the exit of bwrap does not say: bwrap leaves with the command, and what the command left behind inside (a process that called `setsid`) is killed a moment later, when the first process inside has gone. In 29 of 150 runs here something of the sandbox was still alive when bwrap had been seen to exit. So the first process inside is found through `/proc` when bwrap is spawned, and the command is over when that process is gone: the kernel lets it go only once every process of its pid namespace is dead, and in 250 runs, 100 of them killed with SIGKILL, nothing was alive at that point. The shell tool waits for it before the call returns.
3. **A mount on a path under the home is made only where the user's entries lead to it** (`reaches` in `homeArgs`): a writable root, a read-only path or a hidden path below an entry that is not shown (it appeared while a command runs, or something of the command's own has its name) would be made inside the command's directory, through whatever the command put there. It is left out: the directory is not shown, so there is nothing to grant or to hide.
4. **`home.root` is reached under no second name.** `workspacePolicy` gives no home of the session's to a command whose writable roots hold `home.root` or lie in it (a working directory of `/tmp`), and hides the directory from it: under its own path nothing in it is a mount, and the command could rename `home` and leave a link to the user's real home in its place, which the next command would then write. `ownDirectory` also binds from nothing in `home.root` that is not a directory.

What remains. Two things that are a cost and not a way out of the sandbox:
- while a command of the session runs, what appears in the user's home is not in the session's home, and what leaves it is an empty file or directory there. A command in the background that runs for the whole session keeps it so for the whole session;
- a command whose sandbox cannot be seen to be empty counts as running for as long as the process lives: its first process was found and is not gone ten seconds after bwrap, or it was not found and the process group is not empty by then (a zombie nobody reaps, in a container whose first process does not).

And three conditions under which the race could still be run. None of them was carried out here:
- the first process inside was not found before bwrap exited (it is looked for every millisecond at first and then every 5 ms, and was found in 300 of 300 runs here, 200 of them of `true`). The command is then over when its process group is empty, and the first process inside is in that group. A command that may trace its parent process (`kernel.yama.ptrace_scope` 0, or `CAP_SYS_PTRACE`; this machine has 1) could move that process out of the group and outlive it, as it could outlive the kill in "How the shell tool uses it" below;
- what runs is known to one process. A session is held by one process at a time, and bwrap dies with the process that started it (`--die-with-parent`), a moment after it. A second process that opened the session and planned a command within that moment would plan it as if nothing ran;
- another session's command that may write the directory the homes are kept in (its working directory is `/tmp`, or holds it) can change this session's home while a command is being set up. Its own session's home is hidden from it, the others are not. Such a command already writes every other program's files in `/tmp`.

`createCommandSandbox` keeps the home of a session in `<temp base>/<session>.home`, makes it for a session that was told to use it, and gives it to every sandboxed command of that session except where the home is, or lies in, a writable root (the working directory is the home or contains it) and where rule 4 applies. Nothing outside the sandbox reads that directory, so what a command writes there never runs with the user's rights.

### What the engine does to use it

- Tells the sandbox which sessions have it: `sessionHome.use(sessionId, on)` when an execution starts and when the client changes its choice, from `resolveSandboxHome` (the user's file, the client's choice for the session, the project's file, which can only turn it off).
- Tells the user once what `sessionHome.state` has to say (a `session_home` notice: the home is on and the session gets none, or not all of the user's home), and that a project's file asked for the home and was not followed.
- Tells the model, in a stored message and never in the shell tool's description, which is frozen with the tool list and the same for every session: `sessionHomeUpdate` (`home-note.ts`) as an appended instruction source when the session's commands get the home, and a withdrawal when they no longer do. The note under a failed sandboxed command names the home too (`sandboxHint` with `home`).

## The environment of a session's commands

`filterEnv` gives a command every variable except the names `isCredentialName` matches. `EnvPolicy` can also leave names out whatever they look like (`names`) and exempt names from the credential rule (`keep`). `createCommandSandbox` sets the two for the commands of a session it was told names for (`environment.use(sessionId, { withhold, pass })`) and for no other: a session nothing was said about gets `{ mode: "deny" }`, as before. The settings are `sandbox.withholdEnv` and `sandbox.passEnv` (`config.ts`), both empty by default. They hold names only.

`environment.unsandboxed(sessionId)` is the environment of a command of the session that runs without the sandbox: the one commands inherit from without the withheld names, or `undefined` when the session withholds none, and the caller then uses its own environment as it is. `pass` means nothing there, since such a command gets every credential.

What a withheld name is worth:
- under bubblewrap the command is not given the variable and cannot read it from the harness either: `--unshare-pid` with a fresh `/proc` shows it its own processes only. `test/sandbox/command-env.e2e.test.ts` looks through `/proc/*/environ` from inside for a variable a process outside was started with, and finds none;
- without the sandbox the command is the harness's own user. It is not given the variable, and it can read it from `/proc/<pid of the harness>/environ` (the same test reads it from a process of its own user that was started with it). That keeps a variable out of what a command prints or hands to a child by accident, and is no protection;
- under `sandbox-exec` the profile allows `process-info*` for the same sandbox only. Whether that keeps another process's environment from a command was not run.

`workspacePolicy` never passes the variable that names the file a sign-in is handed in through (`ACCESS_TOKEN_FILE_ENV`): a sandboxed command is not told where that file is.

Why a project's file sets neither list (`resolveCommandEnv`): `passEnv` would let a repository hand itself the user's credentials, and `withholdEnv` reaches the user's own hooks and checks, which run in the same environment, so a repository could take away a variable one of them decides by.

### What the engine does to use it

- Tells the sandbox the names of each session: `environment.use` when an execution starts, when the client names some (`EngineSession.setCommandEnv`) and with empty lists when the session is closed, from `resolveCommandEnv` (the user's file and the client's lists, which add up). A subagent is told its parent's. A wake-up's check for a session that is not open is run under the user's file alone.
- Tells the user once that a project's file named some and was not followed (an `approval_ignored` notice, with the names).
- Tells the model nothing: the shell tool's description and the note under a failed command say nothing about the environment, and no message is appended.
- Passes the environment on wherever a command of the session runs without the sandbox, which is where `plan` is not asked: the shell tool (`ShellOptions.sandbox`), the project's checks (`RunCheckOptions.env`), hooks and a wake-up's check (their runners ask `environment.unsandboxed`), and a program's process, which takes its handful of variables from it (`CodeToolOptions.env`). A language server gets the withheld names as `LspRegistryOptions.withhold`: they are left out of its base variables, and a server whose `env` reads one does not start. An MCP server is not told: it gets what its definition names.

## Platforms

| | Backend | Status |
|---|---|---|
| Linux | bubblewrap (`bwrap`) | Tested on Ubuntu 24.04 aarch64 (bubblewrap 0.9.0). Needs unprivileged user namespaces; on Ubuntu 23.10+ an AppArmor profile must grant `userns` to bwrap. Detection names the exact fix. |
| macOS | `sandbox-exec` + generated Seatbelt profile | **Untested on a real Mac.** The profile text is unit-tested. It denies by default, so a missing allowance breaks a command rather than opening a hole. No home of the command's own: the home is read-only. |
| other | none | `unavailable` |

When bwrap cannot create namespaces, nothing else works without privileges. Landlock (enabled on this kernel) has to be applied between fork and exec of the child, which JavaScript cannot do. It needs a helper binary that applies the ruleset and then execs the command, and it only restricts files and TCP: no DNS, UDP or unix-socket isolation.

## How the shell tool uses it

1. At start-up, call `detectSandbox()`. If it is unavailable, show `reason` and `remedy` once and decide whether to run unsandboxed with approval.
2. Per command: `plan = sandboxCommand(defaultPolicy({ workspace, tempRoot }), { shell: input.command, shellPath, cwd })`, then `Bun.spawn(plan.argv, { env: { ...plan.env, PAGER: "cat", … }, cwd: plan.cwd, detached: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" })`. `detached` is required.
3. Output streams through unchanged: bwrap and sandbox-exec pass the file descriptors straight to the command.
4. Stopping is unchanged: SIGTERM to `-pid`, grace period, SIGKILL to `-pid`. On Linux the sandbox's supervisor ignores SIGTERM (`plan.gracefulTermination`), so the command gets its full grace period. When the command exits, or the group is SIGKILLed, the kernel kills everything left in the sandbox, including processes that called `setsid`: a moment after bwrap has exited, not before. A plan that has `started` and `ended` (a command with a home of the session's own) is told the process that was spawned and that it has exited, and `ended` resolves when nothing of the sandbox is left.
5. A command killed by a signal inside bwrap is reported as exit code `128+n`, not as `signalCode`. bwrap's own setup failures exit 1 with `bwrap: …` on stderr.
6. If a command fails with `Read-only file system`, `Permission denied` or a connection error, offer an escalation: re-plan with the extra writable root or `network: { mode: "on" }`, after approval.
