# Custom process spawning

This file explains Concept 36 (**custom process spawning**) of the Claude Agent SDK Lab. In every earlier concept,
`query()` looked like a function that talks to Claude. It is really a **client**. It starts a **Claude Code process**
(a native binary shipped in the SDK's platform package) and talks to it over **stdin and stdout**, one JSON object per
line. The SDK normally starts that process on the same machine, with Node's `spawn()`. The
`spawnClaudeCodeProcess` option lets **you** start it. You can log it, wrap it, limit it, or run it **somewhere
else**: in a container, a VM, or another server.

**Goal:** see exactly what the SDK would run, read the protocol on the wire, run Claude Code in a second "machine" over
TCP, redirect a built-in tool with `toolAliases`, read Claude Code's debug log, and know what goes wrong when the
spawn fails, and what the host must then do itself.

| Concept | Topic | Routes |
|---|---|---|
| 36 | Custom process spawning: `spawnClaudeCodeProcess`, `SpawnOptions` (`command`, `args`, `cwd`, `env`, `signal`), `SpawnedProcess`, the stdin/stdout protocol (`control_request/initialize`, `can_use_tool`, `mcp_message`), a remote runner over TCP, SDK MCP tools and `canUseTool` that stay on the host, `toolAliases`, `debug` / `debugFile`, `executableArgs`, `stderr` with a custom spawner, the abort sequence, failures | `/api/c36/state`, `/reset`, `/dry`, `/run` (SSE), `/alias` (SSE), `/debug`, `/failures` (SSE), `/code` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/36-process-spawning.ts` | **New**: the spawners (local, tapped, remote, dry run), the host tools, the `toolAliases` rows, the debug runs, the failure rows, the routes |
| `server/concepts/36-runner.mjs` | **New**: the "box": a separate Node process that runs Claude Code for the host, reached over TCP |
| `server/index.ts` | Mounts the router on `/api/c36` |
| `src/concepts/Concept36ProcessSpawning.tsx` | **New**: the tab: the two machines, Parts A to H |
| `src/App.tsx` | Adds the tab |
| `src/styles.css` | The box card, the wire lines, the runner rows |
| `.gitignore` | Ignores `spawn-lab/` |
| `Tab1-query().md` | Adds Concept 36 to the table and the project tree |

---

## Step 1: What `query()` really does

```text
your code ──query()──▶ the SDK ──spawn──▶ claude.exe --output-format stream-json --input-format stream-json …
                          ▲   stdin: one JSON line per message you send, and the answers to its requests
                          └── stdout: one JSON line per message it yields, and its own requests to you
```

The option takes over the arrow marked `spawn`:

```ts
import { query, type SpawnOptions, type SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";

const options = {
  spawnClaudeCodeProcess: (o: SpawnOptions): SpawnedProcess => {
    console.log("starting", o.command, o.args.join(" "));
    const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], signal: o.signal });
    child.stderr.on("data", (d) => process.stderr.write(d)); // the SDK does not read it for you (Step 7)
    return child;
  },
};
```

It is called **once per `query()`**, in place of the SDK's local spawn. Whatever you return is the process the SDK
talks to. This is the lab's **code: spawner**.

## Step 2: What the spawner receives (`SpawnOptions`)

Scenario **1** is a **dry run**. A spawner records the `SpawnOptions` and returns a fake process that exits at once.
No Claude Code runs and no API call is made (**code: dry**). Change the form and run it again. With the lab's
defaults, the SDK passed:

| Field | Value |
|---|---|
| `command` | `node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`: the native binary of the platform package |
| `args` | 18 flags: `--output-format stream-json --verbose --input-format stream-json` (always), then one flag per option: `--thinking disabled`, `--max-turns 3`, `--model …`, `--permission-prompt-tool stdio` (from `canUseTool`), `--tools Read`, `--setting-sources=`, `--permission-mode default`, `--debug-file <path>` (from `debugFile`) |
| `cwd` | `options.cwd` |
| `env` | `options.env` (75 variables) + **`CLAUDE_CODE_ENTRYPOINT=sdk-ts`** and **`CLAUDE_AGENT_SDK_VERSION=0.3.281`**, **without `NODE_OPTIONS`** (the lab adds it to `options.env` to show that the SDK removes it) |
| `signal` | A **forwarded** `AbortSignal`, not the one from your `abortController`. It fires only at the end of the SDK's graceful close (Step 8) |

Three options are **not** in `args`: `systemPrompt`, the SDK MCP servers, and the `canUseTool` callback. They travel
over stdin, which Step 3 shows. So a spawner that runs Claude Code elsewhere only has to carry `command`, `args`, `cwd`
and `env`. Everything else goes through the pipe.

## Step 3: The protocol on the wire

Scenario **2** runs a real session on the host. Its spawner starts Claude Code like the SDK does, then wraps stdin
and stdout in a **tap** (**code: wire**). The tap is two `Transform` streams that report every line and pass it on
unchanged. The session has one tool, `Write`, one host tool, `mcp__host__roll` (an SDK MCP server, **code: host**),
and a `canUseTool` callback. The prompt: *"Call the roll tool once. Then write the number it returned into roll.txt."*

```text
SDK → stdin    control_request/initialize   carries: sdkMcpServers, sdkMcpServerManifests, systemPrompt
SDK → stdin    user                         Call the roll tool once…
stdout → SDK   control_response/success     the CLI's answer to initialize: commands, agents, models, account…  (17 KB)
stdout → SDK   system/init                  cwd spawn-lab/host/work · tools Write, mcp__host__roll
stdout → SDK   assistant                    tool_use mcp__host__roll
stdout → SDK   control_request/can_use_tool mcp__host__roll          ← Claude Code asks YOUR canUseTool
SDK → stdin    control_response/success     allow
stdout → SDK   control_request/mcp_message  host tools/call roll     ← Claude Code asks YOUR MCP server
SDK → stdin    control_response/success     [{"type":"text","text":"6"}]
stdout → SDK   user                         tool_result
stdout → SDK   assistant                    tool_use Write
stdout → SDK   control_request/can_use_tool Write
SDK → stdin    control_response/success     allow
stdout → SDK   user                         tool_result
stdout → SDK   assistant                    Lucky roll—I got a 6!
stdout → SDK   result/success               $0.0056
```

- Messages go **both ways on the same pipes**: your prompt, the messages `query()` yields, and **control requests**
  in both directions. Each `control_request` has a `request_id`, and its `control_response` carries the same id.
- Your callbacks (`canUseTool`, SDK MCP tools, hooks) run in **your** process. Claude Code only asks for them over
  stdout. That is why they keep working wherever Claude Code runs (Step 4).
- Click a line's size in the tab to read the full JSON.

## Step 4: A `SpawnedProcess` that is not a process: the remote runner

A `SpawnedProcess` is only an interface:

```ts
interface SpawnedProcess {
  stdin: Writable; stdout: Readable;
  readonly killed: boolean; readonly exitCode: number | null; readonly signalCode?: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  on / once / off(event: "exit" | "error", listener): void;
}
```

A `ChildProcess` is one, but so is any object with these members. The lab's **box** is `server/concepts/36-runner.mjs`
(**code: runner**). It is a separate Node process, listening on `127.0.0.1` on a random port, standing in for a
container or a VM. The host's spawner (**code: remote**) connects to it over TCP and returns an object built on the
socket.

```text
host → runner:  H header (token, args, cwd, env) · I stdin bytes · E end of stdin · K kill(signal)
runner → host:  O stdout bytes · R stderr bytes · X exit (code, signal) · L a log line
each frame:     [1 byte type][4 bytes length][payload]
```

The box behaves like another machine:

- It uses **its own** Claude Code, not the host's `command`.
- It runs in **its own folder** (`spawn-lab/box/work`), not the host's `cwd`.
- It has **its own** `CLAUDE_CONFIG_DIR` (`spawn-lab/box/config`).
- It keeps **3 of the host's 76** environment variables (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_ENTRYPOINT`,
  `CLAUDE_AGENT_SDK_VERSION`), plus what Windows needs to start a process.
- A random token keeps other local programs out.
- No shell is used: the arguments go to `spawn()` as a list.

Scenario **3** runs the same prompt as 2, in the box:

```text
spawnClaudeCodeProcess(o)   command …/claude.exe · 18 args · cwd spawn-lab/host/work
runner   host cwd spawn-lab/host/work → box cwd spawn-lab/box/work
runner   env: 3 of the host's 76 variables kept, CLAUDE_CONFIG_DIR = box config
runner   spawn claude.exe with 18 arguments
system/init   cwd spawn-lab/box/work · tools Write, mcp__host__roll
canUseTool, on the host   mcp__host__roll → allow
host tool ran   mcp__host__roll → 5, in the host's Node process
canUseTool, on the host   Write → allow   {"file_path":"spawn-lab/box/work/roll.txt","content":"5"}
result/success   The die rolled a 5, which has been saved to roll.txt. · $0.0058
runner   exit 0
```

`roll.txt` lands in **the box**, and the host's folder is not touched. The transcript is in the box's
`CLAUDE_CONFIG_DIR`. But the roll tool and `canUseTool` still ran **on the host**, because their calls came back over
the same stream. Note that `canUseTool` sees the **box's** paths: a host that checks paths must know the box's layout.

## Step 5: `toolAliases`: the model calls Bash, your tool runs

In a remote setup, the built-in `Bash` would run where Claude Code runs. Sometimes you want your own tool instead, for
example an MCP tool that runs the command in your sandbox. You can remove `Bash`, but a skill or a system prompt may
still tell the model to "use the Bash tool". The fix is `toolAliases`:

```ts
toolAliases: { Bash: "mcp__box__bash" }   // a model-emitted Bash call runs mcp__box__bash
```

Scenario **4** runs three sessions in parallel with the prompt *"Use the Bash tool to run exactly: cat where.txt"*.
The host's `cwd` and the box both have a `where.txt`, with different text. `mcp__box__bash` is an SDK MCP tool. It is
**not** a shell: it only knows `pwd`, `ls` and `cat` inside `spawn-lab/box/work` (**code: alias**).

| Case | The model called | `canUseTool` saw | What ran | Answer |
|---|---|---|---|---|
| `tools: ['Bash']` | `Bash {"command":"cat where.txt"}` | not asked (a read-only command) | the built-in Bash, in the host's `cwd` | `I am the HOST machine.` |
| `tools: ['Bash']`, `toolAliases: { Bash: 'mcp__box__bash' }` | `Bash {"command":"cat where.txt"}` | `mcp__box__bash` | `mcp__box__bash` | `I am the BOX (the remote runner).` |
| `tools: []`, the same alias | `mcp__box__bash {"command":"cat where.txt"}` | `mcp__box__bash` | `mcp__box__bash` | `I am the BOX (the remote runner).` |

- With the alias, the model still sees and calls `Bash`, with Bash's own input schema. The call is **executed** by
  the target tool, and permissions (`canUseTool`, `allowedTools`) see the **target's** name.
- The redirect is **one hop**: `{ A: 'B', B: 'A' }` cannot loop.
- It only changes the lookup of model-emitted `tool_use` names. To block a tool everywhere, use `disallowedTools` as
  well.

## Step 6: Claude Code's debug log (`debug`, `debugFile`)

Scenario **5** runs two one-turn sessions at the same time (**code: debug**):

| Option | Flag | Where the log goes | Measured |
|---|---|---|---|
| `debugFile: 'spawn-lab/debug/run-….log'` | `--debug-file <path>` (turns debug on) | the path you give | 212 lines, 24 KB: 206 DEBUG, 3 INFO, 3 WARN |
| `debug: true` | `--debug` | `CLAUDE_CONFIG_DIR/debug/<session id>.txt` | 212 lines. The `stderr` callback was called **0** times |

The log shows what the message stream does not: where settings and plugins were looked for (`[STARTUP]`), the MCP
servers (`[MCP]`), each API request and its time to first byte (`[API REQUEST]`, `[API:timing]`), telemetry, and
more. The tab counts the tags and lets you filter the lines. The CLI also has `--debug [filter]` (for example
`"api,hooks"`), which `debug: true` does not expose.

> The debug log contains paths, settings and request ids. The lab masks anything that looks like an API key before
> sending it to the browser. Do the same before you ship logs anywhere.

## Step 7: `stderr` and `executableArgs` with a custom spawner

- **`stderr`**: the SDK reads the child's stderr only when **it** spawned the child. With your spawner, the
  `options.stderr` callback is never called, and an error such as "exited with code 3" has no stderr tail. Read
  `child.stderr` yourself (the lab's `localSpawn(onStderr)`, and the runner's `R` frames).
- **`executableArgs`** go **before every flag**. With a JavaScript `cli.js`, the SDK runs `node <executableArgs>
  cli.js <flags>`, so they are Node's flags (`--max-old-space-size=…`). With the native binary, they are passed to
  `claude.exe` itself, and Claude Code rejects the unknown ones (Step 9).

## Step 8: Stopping: the abort sequence

When you call `abortController.abort()`, the SDK closes the process in steps. It does not kill it at once. Measured in
the failure row "abort during the answer" (Windows):

```text
+1.5 s  abortController.abort()
+1.5 s  the SDK ended stdin              ← Claude Code can shut down cleanly
+8.5 s  kill('SIGKILL')                  ← still running: 2 s grace, then 5 s more on Windows
+8.5 s  SpawnOptions.signal fired
+8.5 s  exit (SIGKILL)
```

On Linux and macOS the SDK sends `SIGTERM` after 2 s, then `SIGKILL` 5 s later. This is why `SpawnOptions.signal`
is **forwarded**. If it were your own signal, passing it to `spawn()` would kill the child at the first moment and
skip the clean shutdown. If you need the immediate signal, capture your own `abortController` in the closure.

## Step 9: When the spawn goes wrong

Scenario **6** runs seven cases in parallel (**code: failures**):

| Case | What the host sees | Why it matters |
|---|---|---|
| The spawner throws `no VM available` | `query() threw: no VM available` | Your error, unchanged |
| A command that does not exist (`spawn('no-such-runner', …)`) | `query() threw: Claude Code native binary at …/claude.exe exists but failed to launch…` | The message names the SDK's binary, not the command your spawner ran. Log the command yourself |
| The process writes `container quota exceeded` to stderr and exits 3 | `query() threw: Claude Code process exited with code 3` | No stderr in the SDK's error. Only the spawner saw it |
| `executableArgs: ['--max-old-space-size=512']`, the SDK's own spawn | `…exited with code 1. stderr: error: unknown option '--max-old-space-size=512'` | With the native binary they are CLI flags. The SDK spawned it, so its error includes the stderr tail |
| The runner is not there (a closed port) | `query() threw: Failed to spawn Claude Code process: connect ECONNREFUSED 127.0.0.1:…` | Emit `'error'` from your `SpawnedProcess`: the SDK turns it into a spawn error |
| Abort during the answer | `query() threw: Operation aborted`, and the timeline of Step 8 | ~7 s from `abort()` to the kill on Windows |
| `sessionStore` + the box (its own `CLAUDE_CONFIG_DIR`) | `result: OK`, and `store.append()` received **0 lines** | The SDK mirrors a line only if its file is under the `CLAUDE_CONFIG_DIR` **it** knows. The box writes elsewhere, so nothing reaches the store, and **no message says so**. Give the box the same config path (or check your store, Concept 35) |

## Step 10: What changes, and what does not

| What | How | What happens |
|---|---|---|
| Take over the spawn | `spawnClaudeCodeProcess: (o) => SpawnedProcess` | Called once per `query()`, instead of the local spawn |
| What you receive | `{ command, args, cwd, env, signal }` | The flags built from your options, and `options.env` + `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_AGENT_SDK_VERSION` − `NODE_OPTIONS` |
| Not in args | `systemPrompt`, SDK MCP servers, `canUseTool`, hooks | They travel over stdin (`initialize`, control requests) |
| What you return | `stdin`, `stdout`, `killed`, `exitCode`, `kill()`, `on/once/off` | A `ChildProcess`, or your own object over a socket, a VM API, SSH… |
| Your tools | `createSdkMcpServer`, `canUseTool`, hooks | Still run on the host, wherever Claude Code runs |
| Built-in tools | `Bash`, `Write`, … | Run where Claude Code runs, with **its** paths. Redirect them with `toolAliases` |
| stderr | `options.stderr` | Not called with a custom spawner. Read it yourself |
| Stopping | `abort()` | stdin EOF, 2 s, then SIGTERM (POSIX) / 5 s more (Windows), then SIGKILL; `signal` fires with the kill |
| Debug log | `debug: true` / `debugFile` | `CLAUDE_CONFIG_DIR/debug/<id>.txt` / your path; never stderr |
| Session store | `sessionStore` + a spawner | Works only if the process uses the same `CLAUDE_CONFIG_DIR` path |

## Things to try in Concept 36

1. Run 1, then tick `Bash`, `debugFile` and untick `canUseTool`, and run it again: which flags appear or disappear?
   Type `--inspect` in `executableArgs`: where does it go?
2. Run 2 and click the size of `control_request/initialize`, then of the `control_request/mcp_message` line.
3. Run 3 and compare the two machine cards: where is `roll.txt`, and which config dir has the transcript?
4. Untick "show the wire lines" in 3 to see only what your code sees: `query()`'s messages and your callbacks.
5. Run 4. Change the prompt to `ls`, then to `rm where.txt`, and see who refuses it.
6. Run 5 and filter the log by "API requests". How many requests did a one-word answer make, and why? (One is the
   session title.)
7. Run 6 and read the abort row's timeline.

## Running the app

```powershell
npm run dev        # server on http://localhost:3001, web on the Vite port
```

Open the **36. Process spawning** tab. `ANTHROPIC_API_KEY` must be in `.env`. Start the app from a normal terminal, not
from inside Claude Code (see Tab16). With Haiku 4.5: scenario 1 costs nothing, 2 and 3 about $0.006 each, 4 about
$0.025, 5 about $0.001, 6 about $0.002. The runner starts the first time scenario 3 (or 6) needs it, and stops with
the server.

```powershell
# the same from a terminal (the tab does this for you)
curl.exe -X POST http://localhost:3001/api/c36/dry -H "Content-Type: application/json" -d '{\"model\":\"claude-haiku-4-5-20251001\",\"maxTurns\":3,\"tools\":[\"Read\"],\"permissionMode\":\"default\",\"canUseTool\":true,\"sdkMcp\":true,\"debugFile\":false,\"systemPrompt\":\"\",\"executableArgs\":[]}'
curl.exe -N -X POST http://localhost:3001/api/c36/run -H "Content-Type: application/json" -d '{\"where\":\"box\",\"prompt\":\"Call the roll tool once. Then write the number into roll.txt.\"}'
```
