import { describe, expect, test } from "bun:test"
import type { CommandsResult } from "@windlass/acp/extensions"
import { BUILTIN_COMMANDS, COMMAND_SCOPE, clientCommands, commandProblemLines, commandSent, helpLines, lookup, unknownCommandText, unusableCommandLines, userCommands, type CommandSource, type SlashCommand } from "../src/slash.ts"

const command = (name: string, more: Partial<SlashCommand> = {}): SlashCommand => ({ name, args: "", description: `${name} description`, when: "any", ...more })
const source = (label: string, commands: readonly SlashCommand[]): CommandSource => ({ label, commands: () => commands })

describe("slash command lookup", () => {
  test("prefers source order, exact spelling, and aliases", () => {
    const first = source("first", [command("Test", { aliases: ["t"] })])
    const second = source("second", [command("test")])
    expect(lookup("/test", [first, second])).toMatchObject({ kind: "command", source: first, command: { name: "Test" } })
    expect(lookup("/t", [first, second])).toMatchObject({ kind: "command", command: { name: "Test" } })
    expect(lookup("/test", [second, first])).toMatchObject({ kind: "command", command: { name: "test" } })
  })

  test("splits command arguments, permits command punctuation, and preserves non-command messages", () => {
    expect(lookup(" /frontend:test a b ", [source("files", [command("frontend:test")])])).toMatchObject({ kind: "command", command: { name: "frontend:test" }, rest: "a b" })
    expect(lookup("//help now")).toEqual({ kind: "message", text: "/help now" })
    expect(lookup(" /etc/hosts is wrong")).toEqual({ kind: "message", text: " /etc/hosts is wrong" })
    expect(lookup("hello /help")).toEqual({ kind: "message", text: "hello /help" })
  })

  test("reports unknown names and nearest suggestion", () => {
    const found = lookup("/hepl")
    expect(found).toEqual({ kind: "unknown", name: "hepl", suggestion: "help" })
    expect(unknownCommandText(found as Extract<typeof found, {kind:"unknown"}>)).toContain("did you mean /help?")
    const isolated = lookup("/xyz", [])
    expect(isolated).toEqual({ kind: "unknown", name: "xyz", suggestion: null })
    expect(unknownCommandText(isolated as Extract<typeof isolated, {kind:"unknown"}>)).toContain("/help lists the commands")
  })
})

test("help lines include aliases, idle annotation, command file origin, and keys", () => {
  const lines = helpLines([source("Example", [command("go", { args: "<message>", aliases: ["g"], when: "idle", file: { path: "commands/go.md", scope: "project", agent: "reviewer" } })]), source("Empty", [])])
  expect(lines.map(({text}) => text)).toEqual(expect.arrayContaining(["Example:", "/go <message> (/g)  go description (while the agent is idle)", "from this project · runs as the agent reviewer:", "commands/go.md", "Keys:"]))
  expect(lines.at(-1)?.text).toContain("//etc sends /etc")
})

test("client commands include aliases; command files exclude hidden entries", () => {
  expect(clientCommands(source("x", [command("run", {aliases:["r"]})]))).toEqual([{name:"run", aliases:["r"]}])
  const listing = { commands: [
    { name:"visible", argumentHint:"<x>", description:"visible", path:"visible.md", scope:"user", agent:null, hiddenBy:null },
    { name:"hidden", argumentHint:null, description:"hidden", path:"hidden.md", scope:"project", agent:null, hiddenBy:"exit" },
  ], problems: [] } as unknown as CommandsResult
  const user = userCommands(listing)
  expect(user.label).toContain("command files")
  expect(user.commands()).toEqual([{name:"visible", args:"<x>", description:"visible", when:"any", file:{path:"visible.md", scope:"user", agent:null}}])
  expect(COMMAND_SCOPE.user).toBe("your own, for every project")
})

test("unusable and problem lines distinguish skipped, shadowed, and warning-free listings", () => {
  const listing = { commands: [], problems: [
    {severity:"skipped", name:"bad", reason:"missing value", path:"bad.md"},
    {severity:"shadowed", name:"hidden", reason:"built-in command", path:"hidden.md"},
    {severity:"warning", name:null, reason:"unusual", path:"other.md"},
  ] } as unknown as CommandsResult
  expect(unusableCommandLines(listing, "BAD")).toEqual([{text:"/bad cannot be used, so nothing was sent: missing value.", tone:"warn"},{text:"bad.md", tone:"warn", indent:2, path:true}])
  expect(unusableCommandLines(listing, "none")).toBeNull()
  expect(commandProblemLines(listing).map((line) => line.text)).toEqual(["Command files with problems:", "/bad: not usable: missing value", "bad.md", "/hidden: hidden: built-in command", "hidden.md", "a command file: usable, but: unusual", "other.md"])
  expect(commandProblemLines({commands:[], problems:[]} as unknown as CommandsResult)).toEqual([])
})

test("command transcript wording covers size, missing and unused arguments, and unsupported constructs", () => {
  const use = {name:"build", arguments:'"hello world" spare', path:"build.md", scope:"config", missing:[1], unused:[2], unsupported:[{kind:"shell", text:"!pwd", line:3}, {kind:"include", text:"@file", line:4}]} as Parameters<typeof commandSent>[0]
  expect(commandSent(use, "one\ntwo")).toEqual({typed:'/build "hello world" spare', head:"the text of a command file was sent (2 lines)", where:COMMAND_SCOPE.config, path:"build.md", notes:[
    "argument 1 was not given: it is empty in the text that was sent",
    'argument 2 ("spare") was not used: the command file has no place for it, so it is not in the text that was sent',
    "!pwd (line 3) was left as text: a command file runs nothing when it is used; the agent can run it with its shell tool, which asks as usual",
    "@file (line 4) was left as text: a command file reads no file into its text; the agent can read it with its tools",
  ]})
  expect(commandSent({...use, missing:[1, 2], unused:[], unsupported:[]}, null).head).toBe("the text of a command file was sent")
})
