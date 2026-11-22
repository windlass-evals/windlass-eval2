# Changelog

All notable changes to Windlass are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (before 1.0, a minor version may break compatibility).

## [Unreleased]

## [0.5.0] - 2026-11-20

### Added

- New sessions get a short title from the first prompt in the background. Listings and ACP clients receive the
  saved title, and an explicit rename always wins. Set `titles` to `"off"` to keep the prompt-derived title, or
  choose a `titleModel` offered by your account. Automatic selection prefers `gpt-6-luna`, then fast or small
  models from the same catalog as `--models`. An unavailable choice or unreadable list keeps the prompt-derived
  title without a title request. Scripted runs and demos make no title request. Title calls use the
  session's sign-in and their tokens are included in session usage. Existing sessions keep their titles. Version
  0.4.0 cannot read sessions that contain the new title excerpt, generated-title marker or title-usage event.

## [0.4.0] - 2026-11-19

### Added

- **A client can hand a session a message of its own, once.** `_windlass/admit` admits a message under an ID the
  client chooses, with an origin that names it, as Windlass's own wake-ups admit theirs: a queued item that never
  steers the turn in progress, shown to the model in an envelope that names the origin, and with `start` the
  beginning of a turn when the session is idle. An ID the session already admitted is answered `duplicate` and
  nothing is written, so a client that is not sure its message arrived sends it again. With `untrusted: { source }`
  the text is not the user's own: the session is tainted from the admission on, with a source of the new kind
  `client-input`, before the turn it starts. The method is listed in `agentCapabilities._meta["windlass"].methods`.
- **A client can declare tools it runs itself.** `hostTools` in `_meta["windlass"]` of `session/new`,
  `session/load` and `session/resume` declares tools by name, description, input schema and `effect`; the model is
  offered them beside the built-in tools, in the tool list frozen with the session's first baseline. A call is
  approved by its declared effect through the same decision as every tool, which is told that no sandbox contains
  it (the client runs it), so an `exec` or a `write` asks in modes `ask` and `auto`, and an approval of it
  is remembered for the session only (a client names its tools per session, so a project-wide approval of a name
  would cover another client's tool), covering that tool by name and nothing else; then it is sent to the client as
  `_windlass/host_call`, and the answer (`{ status, output }`) is the call's result. A call the client does not
  answer within its time limit is cancelled and ends as an error the model reads; the limit is the MCP call limit
  (60 s) unless the declaration's `timeoutSeconds` names another, at most an hour, so a tool can wait for a person. With
  `untrustedResult: true` each answer taints the session (`host-tool`). A declaration with the name of one of the
  agent's own tools, or one it cannot use otherwise, refuses the open with a sentence that names it. A subagent is
  not offered them. The key is listed in `agentCapabilities._meta["windlass"].openMeta`; `docs/acp.md`, "Tools the
  client runs", has the rest.
- A session in which a client's tool ran under the approval layer, or that took in untrusted admitted text, holds
  records 0.3.0 does not read, and 0.3.0 refuses to open it (`unreadable_session`) rather than open it without its
  taint. A client that uses neither feature sees no change, and sessions of earlier versions open as before.

## [0.3.0] - 2026-11-19

### Added

- **Required checks: checks that a project's file cannot replace or switch off.** A project's
  `.windlass/config.json` replaces your `checks` and sets `verify`, and the agent can edit that file, so
  `"checks": []` or `"verify": { "mode": "off" }` there ran nothing from the next turn on, and nobody who starts
  Windlass could say "these checks always run". `requiredChecks` in your own configuration file now does: a list
  like `checks`, read from your file only. A program that starts `windlass acp` for you names them for a session
  with `requiredChecks` in `_meta["windlass"]` of `session/new`, `session/load` and `session/resume`; they add to
  your file's, and the key is listed in `agentCapabilities._meta["windlass"].openMeta`.
  - They run before a turn ends when it changed a file their `when` patterns cover, before the project's own
    checks, which still run. A project's check with the name of a required one is not run, `requiredChecks` in a
    project's file is not followed, and you are told once of either.
  - A failing required check sends the agent back whatever `verify.mode` says, as often as `verify.maxRounds` in
    your own file says. The project's `verify` applies to the project's checks.
  - A turn keeps the checks it started with: no file edited during a session changes them. They run in the
    directory the session works in, not in the project directory, which is wherever the project's file is.
  - Where commands are sandboxed and there is no sandbox, a required check is recorded as one that could not
    start and the turn ends there, unresolved, where the project's checks are passed over as before.
  - After a required check failed in a turn, the turn ends as done only when a later run of it passed, or
    with the files it covers again exactly as they were in a state the check stands on: the one the session
    started from, or one verified since while it was a required check with the command it has now. A required check
    named later, or with another command, is run at the end of the next turn that changes a file, whatever the
    file.
  - A subagent's turn runs no check, as before; its parent's turn runs them. The checks a program names are not
    stored with the session: it names them each time it opens it. `docs/safety.md`, "Required checks", has what a
    project can still do to one (make it fail, not pass) and what a required check does not promise.
  - With no required check named, the checks, the gate and the report are what they were.
- **The record of a check says whose check it was.** Each check in the evidence of a run (`checks.finished`, a
  turn's ending, `_windlass/turn` and the prompt response over ACP) has `origin`: `user` for your own file,
  `session` for the program that opened the session, `project` for the project's file, and `required`. A client
  no longer works out from the two files which check ran.
- **The last lines of a failing check's output are in the record.** The evidence held only the path of the file
  with the whole output, which is a path on the machine Windlass runs on. It now also has `outputTail`: the end
  of the output of a check that did not pass, at most 60 lines and 4096 bytes, redacted like all tool output,
  with `truncated` when there was more; the file is kept as before. A check that says `"outputTail": "always"`
  has it also when it passes. `startError` says why a check's command could not be started at all. Records
  written before this have none of these fields and are read as they are.
- **An ending that needed no check says why, and what it rests on.** A turn could end as done with no check
  needed right after a run of checks that failed in it, because the agent had put its change back, and nothing
  in the record said so. `not_needed` now has `reason`: `turn_unchanged` (the turn changed no file),
  `state_unchanged` (the workspace is again what it was in a verified state) or `not_covered` (no check covers
  what differs from it), and `since`: where that verified state is in the log, and the run of checks that last
  passed on the way to it (`null`: none has, the state is what the session started from). The evidence of every
  run has `since` too, for what its `changedFiles` are measured from, and both name the session's required
  checks (`requiredChecks`). The two interfaces say it under the ending.
- **A session that holds a record this version does not read is refused in a sentence.** It was
  `Internal error`. Over ACP the error has `data["windlass"].reason` `unreadable_session`.
- **A later version may add to the evidence of a run of checks without locking this one out.** A key this
  version does not know in the evidence of a run, in a check of it or in the end of its output is kept as it is
  and written back unchanged. Everything else in a session's records is still read strictly.

### Changed

- **A check that could not be started no longer sends the agent back to fix the code.** When the shell for a
  check cannot be run at all (commands run only in the sandbox and there is none, the directory is gone), the
  check says nothing about the code, and no change to the code starts it. The agent was told
  `Fix the code so that this check passes` and sent back, as often as `verify.maxRounds` allows, and the turn
  ended as `max_rounds`. Now, when every check that did not pass is one that was never started, the turn ends
  unresolved at once with the new reason `not_started`, and the agent and you are told that the check could not
  be started and why. When other checks failed, the agent is sent back for those alone and is told to leave
  the one that did not start. This holds for every check, required or not. A command the shell does not find
  (exit code 126 or 127) is as before: the check ran, and the agent is shown its output.
- **Windlass 0.2.0 and earlier do not open a session in which this version recorded anything about checks.**
  They read a session's records strictly, and the records gained fields: a run of checks (`origin`, `required`,
  `outputTail`, `since`), an ending that needed no check (`reason`), the reason `not_started`. Asked to open
  such a session, 0.2.0 says `Internal error` and writes nothing; the session is intact, and this version opens
  it. A session without checks (`not_configured` endings only) holds nothing new and still opens in 0.2.0. This
  version opens every session 0.2.0 wrote. There is no way to record these facts that 0.2.0 would read: every
  place in a session it reads, it reads strictly. If you go back to 0.2.0, start new sessions there.

## [0.2.0] - 2026-11-16

### Added

- **One sign-in for several machines.** `windlass login token` prints the access token of the saved ChatGPT sign-in
  (a secret; the sign-in is refreshed first when it is due), and a `windlass` started with
  `WINDLASS_ACCESS_TOKEN_FILE` naming a file with that token runs on it instead of a saved sign-in. This is for
  processes that cannot share a data directory, such as one per sandbox, where a copied `auth.json` would sign the
  other copies out at its first refresh: the one that holds the sign-in does all the refreshing. The file is hidden
  from sandboxed commands like the saved sign-in, and the tokens in it are redacted from tool output.
  `windlass login token --valid-for <duration>` (`30m`, `1h30m`) prints a token that is good for at least that long,
  refreshing the sign-in first when the saved token has less left: run it on a timer to keep such a file fresh,
  instead of having to ask in the last five minutes of each token.

- **A home of the session's own for sandboxed commands (Linux), as a setting that is off by default.** Tools that
  write under the home directory without being told to fail in the sandbox or go without: `npm ci` cannot write
  `~/.npm`, `uv` cannot make its cache in `~/.cache/uv`, pip runs without its cache, `astro build` fails on
  `~/.config/astro`. With `"sandbox": { "home": "session" }` in your own configuration file, a sandboxed command
  sees a directory of the session's in place of your home, at the same path, with everything you have there
  read-only in it. What it makes beside your entries is written to `/tmp/windlass-<uid>/<session id>.home`, stays
  between the session's commands, and is never in your home. A program that starts `windlass acp` for you turns it
  on for a session with `"sandboxHome": "session"` in `_meta["windlass"]` of `session/new`, `session/load` and
  `session/resume`, with no file in your home; a project's own configuration can only turn it off. Credential
  stores stay hidden, and the network rule is unchanged.
  - It is off by default because of what it costs: a directory you already have stays read-only as a whole, so on
    a machine with a full home most tools still need the write access they needed before; a write under the home
    that used to fail, after which the agent asked for the directory and the change was yours, succeeds and is
    gone with the session (`pip install --user`); and every command starts slower by a time that grows with your
    home. With it off, a sandboxed command is run exactly as before, and the agent is told nothing about a home.
  - With it on, the agent is told in a message of the session, and the note under a failed command names the
    home. The shell tool's own description is the same for every session.
  - While a command of the session is still running (one in the background), the next command is given the same
    home as the running one: what appears in your home meanwhile is shown once no command of the session runs.
    This closes a race in which a command in the background could turn the place of a new entry into a link and
    have the next command's mount made where the link pointed.
  - A home with more than 200 entries gets no session home, and a directory such as `~/.config` whose entries no
    longer fit stays read-only as a whole. You are told once, with what was left as it was and why.
  - pnpm still puts its store inside the project; macOS has no session home. `docs/safety.md`, "The session's
    home", has the rest.

- **Saying which environment variables the agent's commands get.** A sandboxed command gets every variable of
  Windlass's environment except those whose name looks like a credential, and nothing could change that. Two lists
  of names in the `sandbox` section of your own configuration file now do: `withholdEnv` names variables that no
  command the agent runs is given, whatever the name looks like (`SENTRY_DSN`), and `passEnv` names variables that
  sandboxed commands are given although the name looks like a credential (`DEPLOY_KEY`). A program that starts
  `windlass acp` for you names them for a session with `withholdEnv` and `passEnv` in `_meta["windlass"]` of
  `session/new`, `session/load` and `session/resume`; they add to your file's. Names only: no value is written in
  a file or sent over the protocol. With neither named, every command's environment is what it was.
  - A withheld variable is kept from the shell tool's commands, the project's checks, hooks, a wake-up's check,
    programs, language servers and subagents. An MCP server whose definition names it (`${SENTRY_DSN}`) still gets
    it: that is how a server is given a secret that no command gets.
  - In the sandbox on Linux that holds: the command cannot see Windlass's process. Without the sandbox (`full`, a
    machine where the sandbox is unavailable, a command you allowed to run without it) the command is not given
    the variable and can still read it from Windlass's process, so there it is a courtesy and not a protection.
  - A project's own configuration sets neither list; when it tries you are told once. The model is told nothing
    about them. `docs/safety.md`, "A command's environment", has the rest.

### Changed

- A sign-in failure says which one it was by a code, where a program reads it: the `code` of the failed step's
  provider error in the session's log, and `data["windlass"].code` of the error an ACP client is answered with
  (`auth_required`, `execution_failed`, `model_list_failed`). With a handed-in access token it is one of
  `handed_in_missing`, `handed_in_unreadable`, `handed_in_empty`, `handed_in_malformed`, `handed_in_expired`, or
  the new `handed_in_rejected` for a token the provider turned down, whose step error now says so in its message
  too; with a saved sign-in it is `signed_out`, the sign-in service's own code such as `invalid_grant`, or
  `network_error`. `docs/acp.md` has the table.

### Fixed

- A refresh of the sign-in that cannot reach the sign-in service (no network, a failed lookup, a broken connection)
  is a sign-in failure like any other, with the code `network_error`: `windlass login token` prints one line,
  `sign-in failed: Could not reach the sign-in service at <host>: <reason> (network_error)`, and exits with code 1,
  where it printed a stack trace. A turn that needs a refresh at such a moment is tried again and fails as a
  connection problem, not as "Signed out".

- A handed-in access token is redacted from tool output from the moment it is in the file
  `WINDLASS_ACCESS_TOKEN_FILE` names: the file is looked at each time an output is redacted. Before, a token
  written while a command ran was unknown to the redaction until the next model call, and a command that printed it
  put it in the session.

## [0.1.1] - 2026-11-13

### Changed

- The npm packages are published by the release workflow, each with a provenance statement that ties it to the
  commit and the build that made it.

## [0.1.0] - 2026-11-13

The first release: a coding agent for the terminal that signs in with a ChatGPT plan.

### Added

- **Three interfaces, one program.** `windlass` (or `wl`) is a line interface, `windlass tui` a full-screen one, and
  `windlass acp` a server for editors that speak the Agent Client Protocol. `windlass "<task>"` runs one task to the
  end without you.
- **Works in your project.** The agent reads, searches, edits files and runs commands, then runs the checks you
  configure (tests, a type check) and carries on until they pass or says which still fail.
- **Asks before what matters.** Commands run in an operating-system sandbox without network (bubblewrap on Linux,
  `sandbox-exec` on macOS); anything that needs more asks first. Secrets in tool output are redacted before the model
  sees them.
- **Undo, review and forks.** `/undo` and `/redo` take files and conversation back or forward a turn, `/diff` and
  `/review` show and comment on what a turn changed, and a session can be forked to try another way.
- **Sessions that last.** Every session is kept on your machine and can be resumed (`windlass -c`), replayed or
  exported; long sessions are compacted, and the prompt cache's share of each request is shown as you work.
- **Yours to shape.** Project instructions (`AGENTS.md`), agents, skills, slash commands, hooks, MCP servers,
  language-server diagnostics, subagents, background commands and wake-ups, opt-in memory and telemetry.
- **Executables** for Linux and macOS, x64 and arm64, with SHA-256 checksums and an install script, and on npm:
  `npm install -g windlass-agent` installs the one for your machine.

[Unreleased]: https://github.com/parthg1901/windlass/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/parthg1901/windlass/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/parthg1901/windlass/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/parthg1901/windlass/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/parthg1901/windlass/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/parthg1901/windlass/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/parthg1901/windlass/releases/tag/v0.1.0
