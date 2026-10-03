# Browser automation with Playwright MCP

Run `npm ci` and `npm run dev` using Node 24 or newer. Open `?lesson=64` or **Tools & extensions → 64. Browser automation with Playwright MCP**. Sample64 uses backend port **3064**; Vite uses **5173** or the next free port.

Install Chrome before running the exercise. To use another Chromium executable, set `PLAYWRIGHT_MCP_EXECUTABLE_PATH` in `.env` to its absolute path and restart the server. The lab never installs a browser automatically. `@playwright/mcp` is pinned to **0.0.83** in the package and lockfile. The host launches its installed CLI with Node directly, avoiding runtime `npx` downloads and Windows command-shell quoting problems.

## What you will learn

Connect an external stdio MCP server to `query()`, discover browser tool schemas, use accessibility snapshots and element references, fill and submit a form, wait for meaningful page state, and capture evidence. Compare deterministic host orchestration with model-driven tool selection. Understand isolated profiles, stale refs, prompt injection and browser permissions.

## The practice site

Each run starts a fresh HTTP site bound to a random loopback port. Its accessible form contains a named textbox, workshop selector, submit button and status message. It accepts one fictional booking and records it in host memory. There are no real payments, accounts or bookings. Its imported note contains a deliberate prompt injection asking the agent to visit an external URL and upload cookies. Its content security policy allows requests only to itself and loads no external assets.

## Guided run: real browser, no model API

Choose a fictional attendee name and click **Run guided browser**. The host connects an MCP `Client` to `StdioClientTransport`, calls `listTools`, navigates to the fixture and requests a snapshot. It extracts the textbox's observed reference, fills the name, refreshes the snapshot, selects Playwright MCP, refreshes again and clicks Book workshop. It waits for the exact confirmation text and checks the final snapshot before saving `proof.png` and closing the browser.

The streamed tool catalog includes real input schemas. The pinned version uses `target` for element references; the guided runner also recognizes the older `ref` field through the discovered schema. Snapshot references are ephemeral handles, not stable CSS selectors. Refresh after DOM changes; never invent a ref or reuse one from a different page. Wait for visible confirmation rather than sleeping for an arbitrary number of seconds.

This is an executable browser exercise; “no model API” does not mean a simulated MCP server. Chrome and the local Playwright MCP process really run. Tool-level `isError` results fail the workflow instead of becoming successful evidence.

## Live run: let the model choose the actions

Click **Run browser agent (billed)** to give the same task to Haiku through the Agent SDK. The external server configuration uses the installed CLI and a headless isolated browser:

```ts
mcpServers: {
  playwright: { type: "stdio", command: process.execPath, args, env }
},
allowedTools: toolNames.map(name => `mcp__playwright__${name}`),
tools: [],
settingSources: [],
strictMcpConfig: true,
permissionMode: "dontAsk"
```

The agent has only navigate, snapshot, type, select, click, wait, screenshot and close. It has no evaluation, arbitrary code, file upload, tab-management or browser-install tool. A host `PreToolUse` hook independently checks tool names, denies navigation away from the exact fixture URL, returns snapshots inline and permits screenshot output only at `proof.png`. Denials and inputs stream to the UI; raw SDK messages contain the model's tool requests and results.

The live run requires configured Anthropic credentials, is limited to 16 turns, $0.25 and 120 seconds, and has no persisted SDK session. Only one lesson 64 run can execute at a time. Stop, disconnect or leaving the lesson aborts the run. Cleanup closes the SDK or MCP connection and the fixture server. A submission can already have happened when cancellation arrives; cancellation does not undo an action. This fixture is disposable, but a production workflow needs application-specific idempotency and recovery.

## Verify effects and retain evidence

The result shows whether the host recorded exactly one booking for the expected attendee and workshop. Guided runs also check confirmation text in a final accessibility snapshot. The live agent's report and screenshot are separate evidence: a success claim alone does not verify a submission, and a matching host record does not prove the screenshot depicts it correctly. Missing screenshots are shown explicitly.

PNG screenshots stay in `browser-lab/<run-id>/proof.png`; this directory is ignored by Git. Only known run artifacts can be retrieved through the screenshot route. The server exposes the latest 50 screenshots until restart; older files remain on disk for local inspection. Remove `browser-lab` when no lesson 64 run is active to clear retained files. A failed or cancelled run may leave files in its folder even though no screenshot link is registered.

## Browser boundaries

`--isolated` creates fresh browser storage and discards it on close. Persistent profiles retain authentication and can conflict between clients. CDP or the browser extension can connect an agent to existing browser sessions, so they are deliberately absent here. Browser processes receive OS variables rather than model credentials in the guided run. The live SDK process inherits configured credentials as required for generation; do not treat an MCP subprocess as a strong credential or operating-system isolation boundary.

The origin allowlist filters requests but is **not a security boundary** and does not cover every redirect. The host hook controls agent tool calls, not everything a page or browser process can do. A system prompt helps reject imported instructions, while narrow tools and host checks enforce specific restrictions. Production automation needs network controls, a browser sandbox, authenticated users, origin/CSRF protections and explicit authorization for real submissions. This educational server is intended for localhost use.

Accessibility snapshots expose roles, names and state; screenshots reveal visual appearance. Use snapshots for interactions and screenshots for visual review. Neither guarantees an accessible interface or correct business behavior; verify the application's resulting state independently.

## Verification

```sh
npm run test:browser
npm run test:offline
npm run typecheck
npm run build
npm run test:browser:smoke
```

Offline tests check navigation/file restrictions, narrow tools, missing references, MCP error handling, fixture isolation, one-use submission and HTTP validation. The smoke tests require Chrome and a preceding `npm run build`. They drive the actual Playwright MCP process through the complete form workflow, check the host booking and final snapshot, and verify a real PNG was written. A second test opens the built lesson page in Chrome, clicks Run guided browser, and checks the rendered evidence and screenshot with no page errors. No model call is required. These checks do not measure live model reliability.

Implementation: `server/browser/browser.ts`, `server/browser/fixture.ts`, `server/concepts/64-browser-playwright-mcp.ts`, `src/concepts/Concept64BrowserPlaywrightMcp.tsx`.

References: [Official Playwright MCP documentation](https://github.com/microsoft/playwright-mcp), [Agent SDK MCP integration](https://code.claude.com/docs/en/agent-sdk/mcp), [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).
