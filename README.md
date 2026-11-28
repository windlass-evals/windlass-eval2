# Windlass

A coding agent for the terminal: you describe a change, and it reads your code, edits files and runs commands in
your project until the change is done. It is one program, `windlass` (`wl` for short), with a line interface, a
full-screen interface, and a server for editors (the Agent Client Protocol).

![A session in the full-screen interface: the agent reads, runs the tests, edits and checks, with token and cache figures on the right](docs/images/session.png)

## What it does

- **Works in your project.** It reads, searches, edits and runs commands, then runs the checks you configured
  (tests, a type check) and carries on until they pass or says which still fail.
- **Asks before what matters.** Commands run in an operating-system sandbox without network; what needs more asks
  you first. [docs/safety.md](docs/safety.md) says exactly what runs unasked.
- **Can be undone.** `/undo` takes the files and the conversation back to before your last message.
- **Keeps every session.** Resume one later, fork it to try another way, or work in several at once.
- **Is yours to shape.** Project instructions (`AGENTS.md`), agents, skills, slash commands, hooks, MCP servers,
  language-server diagnostics, subagents, wake-ups and programs that call tools, each with a page under [docs/](docs/).

## Install

To run it you need Linux or macOS (x64 or arm64), `git`, GNU `env` (coreutils) and, on Linux, `bwrap` (bubblewrap)
for the sandbox. **From npm**, which installs the executable for your machine (Node 18 or later only starts it):

```sh
npm install -g windlass-agent
```

**Or download an executable** from [Releases](https://github.com/parthg1901/windlass/releases), check it against
`SHA256SUMS` and install it with `install.sh`. For Linux on x64 (elsewhere, `linux-arm64`, `darwin-x64` or
`darwin-arm64`):

```sh
curl -fL --remote-name-all https://github.com/parthg1901/windlass/releases/latest/download/{windlass-linux-x64,build-info.json,install.sh,SHA256SUMS}
shasum -a 256 -c --ignore-missing SHA256SUMS
sh install.sh windlass-linux-x64
```

**Or build it** with [Bun](https://bun.sh) 1.4: clone this repository, then from its folder run `bun install`,
`bun scripts/build.ts` and `sh scripts/install.sh`.

Every way installs `windlass` with `wl` as a short alias; the last two put it in `~/.local/bin`, and the install
script says what is missing and what you lose without it (`--check` only checks). The
[user guide](docs/user-guide.md#installing) has the details, uninstalling, and running from source.

Then sign in with your ChatGPT plan:

```sh
windlass login
```

It opens a browser, or on a remote machine prints an address to open anywhere
([how](docs/user-guide.md#signing-in)).

## Quickstart

Install it, sign in, and give it a task from your project's folder:

```sh
npm install -g windlass-agent
windlass login
windlass "the add test fails; find out why and fix it"
```

It prints each tool call as it runs and ends with a line such as `✓ done · no checks configured · 6 steps · 16s`.
`windlass tui` opens the full-screen interface instead, to watch and steer it as it works. The
[user guide](docs/user-guide.md#first-steps) has more to start with: demos that need no sign-in, the full-screen
interface, and choosing a model.

## Limits

- **Linux on arm64 is where it is used.** Executables for Linux x64 and macOS can be built but are untested, and
  there is no Windows version.
- **A ChatGPT plan is required.** The only way to reach a model is "Sign in with ChatGPT": no API keys, no other
  providers, no local models.
- **The sandbox needs `bwrap` on Linux.** Without it no command runs sandboxed, and every command asks first.
- **Sessions stay on your machine.** They are files in your home directory; nothing is synchronised or shared.

## Documentation

- [User guide](docs/user-guide.md): installing, sessions, models, approvals, configuration, checks, the commands
  at the prompt, undo, compaction, exit codes, the data directory, environment variables.
- [Troubleshooting](docs/troubleshooting.md): the errors you are likely to meet, and what to do.
- [Safety](docs/safety.md): what the agent may do without asking, and what the sandbox does and does not stop.
- Features: [agents](docs/agents.md), [skills](docs/skills.md), [slash commands](docs/commands.md),
  [hooks](docs/hooks.md), [MCP servers](docs/mcp.md), [diagnostics](docs/diagnostics.md),
  [subagents](docs/subagents.md), [the task list](docs/task-list.md), [forks](docs/forks.md),
  [wake-ups](docs/wake-ups.md), [memory](docs/memory.md), [telemetry](docs/telemetry.md),
  [replay](docs/replay.md), [code mode](docs/code-mode.md).
- For editors and tools: [the protocol](docs/acp.md), [the session log's format](docs/event-log.md),
  [the architecture](docs/architecture.md).
- `windlass --help`: every option and exit code.

## Licence

MIT; see `LICENSE`. `CONTRIBUTING.md` says how to work on it, [releasing](docs/releasing.md) how a version ships.
