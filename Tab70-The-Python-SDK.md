# The Python SDK

Use Node 24+ and Python 3.10+. Run `npm ci`, then `npm run dev`, and open
`http://localhost:5173/?lesson=70` (Vite may choose another available port).
Sample70 uses backend port **3070**. Lesson 70 appears in lesson order and
**SDK fundamentals**.

## Install

Guided mode needs only Python's standard library. Live mode uses a separate
Python package, pinned in `python-sdk/requirements.txt`:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r python-sdk/requirements.txt
```

On macOS/Linux, use `.venv/bin/python` for the install command. The host detects
the local virtual environment automatically. Alternatively set
`PYTHON_SDK_EXECUTABLE` to an interpreter's executable path in `.env` and restart
the server. Do not put command-line arguments in this variable.

Set `ANTHROPIC_API_KEY` in `.env` for live web runs. Standalone execution reads
the shell environment, not `.env`. The lab uses private, disposable CLI config
and does not reuse your normal Claude login. Platform wheels bundle the Claude
Code CLI; a source-distribution install may instead require a separately
installed native CLI. On Windows use `claude.exe`, not an npm `.cmd` shim.

## Walkthrough

1. Select **Guided** and **One-shot query()**. Run the exercise and inspect the
   text, result and terminal events. These are fixed fixtures, not model output.
2. Choose **Two-turn ClaudeSDKClient**. Both fixed results share a session ID.
   In live mode the same client handles the initial prompt and the automatic
   follow-up: “Summarize your previous answer in one sentence.”
3. Choose **Custom calculator + PreToolUse hook**. The guided exercise calls
   actual Python hook and arithmetic functions, producing 42 from 19 + 23.
   Live mode registers an `@tool` function in an in-process MCP server and lets
   the model choose its inputs. Inspect the hook and tool events to confirm
   execution rather than assuming that a text answer means the tool ran.
4. Switch to **Live**, edit the prompt and repeat. Results include session ID,
   reported cost and usage. The trace streams complete assistant text blocks,
   not token deltas. Token streaming uses `include_partial_messages` and
   `StreamEvent` in the SDK.
5. Cancel a running exercise. The browser closes its connection and the host
   terminates the Python process tree, including the CLI. Cancelled live runs
   can incur cost without a final cost report.
6. Load the source in the lesson to inspect the Python examples and Node bridge.

You can run the same program from PowerShell without the browser:

```powershell
'{"mode":"guided","exercise":"tool","prompt":"What is 19 + 23?"}' | python -B python-sdk/lesson.py
```

For live execution, change `mode` to `live`, use the virtual environment's
interpreter and set `ANTHROPIC_API_KEY` in the shell.

## API choices

`query(prompt=..., options=ClaudeAgentOptions(...))` returns an async iterator.
Filter `AssistantMessage.content` for `TextBlock`, then inspect the final
`ResultMessage`. `ClaudeSDKClient` owns an interactive connection; send with
`await client.query(...)` and consume `client.receive_response()` before sending
the next turn. Keep context entry, receive and context exit in the same task.
The one-shot iterator is explicitly closed on failure before its temporary
workspace is removed. A new browser run starts a new client, not a resumed one.

TypeScript camelCase option names become Python snake_case: `maxTurns` becomes
`max_turns`, `settingSources` becomes `setting_sources`, and `allowedTools`
becomes `allowed_tools`. Python message classes replace TypeScript's type-tag
checks. Tools use `@tool` and `create_sdk_mcp_server`; hook callbacks are async
Python functions with `HookMatcher` registrations.

The lab disables built-in tools with `tools=[]`, disables filesystem settings
with `setting_sources=[]`, and uses strict MCP configuration. `allowed_tools`
pre-approves the calculator; it does not restrict the tool catalog. Interactive
clients deny other tools through a permission callback and a PreToolUse hook.
The one-shot query uses `dontAsk`. The calculator independently validates finite
numbers within its documented range.

Each live query allows three agentic turns and a $0.03 SDK budget threshold.
This is not an exact billing cap, and the second conversation query can add
cost. Python has a 75-second deadline and the host has a 90-second deadline.
Four web runs may be active at once. Requests cannot select a script, working
directory, model or executable. Credentials and raw SDK diagnostics stay in
the host process; errors sent to the browser are sanitized. These HTTP routes
are local teaching endpoints; add authentication before exposing them publicly.

## Validation

```powershell
npm run test:python-sdk
npm run typecheck
npm run build
npm run test:python-sdk:smoke
```

Tests cover actual Python subprocess execution for all guided exercises, event
ordering, arithmetic validation, hook denial, strict request validation, missing
interpreters, malformed/incomplete output, cancellation, deadlines and HTTP
source/run routes. They make no API calls. Optional SDK contract tests also
exercise the live Python branches against the installed SDK with mocked model
responses; run them with the virtual environment interpreter:

```powershell
.\.venv\Scripts\python.exe -B -m unittest discover -s python-sdk -p 'test_*.py'
```

References: [Python Agent SDK reference](https://code.claude.com/docs/en/agent-sdk/python),
[official Python SDK source](https://github.com/anthropics/claude-agent-sdk-python).
