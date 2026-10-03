# Embedding the SDK in a desktop app or IDE extension

Use Node 24 or newer. Run `npm ci`, then `npm run dev`. Open `http://localhost:5173/?lesson=69` (Vite may choose the next free port). Sample69 uses backend port **3069**. Lesson 69 appears in lesson order and **Production & deployment**.

## What you will learn

Embed the Claude Agent SDK in a trusted Node process and bridge it to an interface. The host owns authentication, context capture, validation, subprocess lifecycle, deadlines and edits. The UI sends four kinds of intent: start, cancel, review, apply/discard. The model cannot write files in this example.

The React lesson is a browser teaching adapter. Its trust checkbox and editor buffer are simulated inputs, not security attestations. The included VS Code extension obtains actual workspace trust and document snapshots from VS Code APIs, validates messages with the same strict protocol, and uses the same runner and lifecycle host. The HTTP lab endpoints are for local development; authenticate and authorize them before exposing them to other users.

## Guided walkthrough

1. Trust the demo workspace and select **Guided**. Click **Explain selection**. Inspect ordered events carrying a run ID and sequence number.
2. Click **Propose rewrite**. Guided mode deliberately adds a fixed comment; it does not perform model analysis. Review Before and After, then Apply. Only the selected range changes.
3. Propose again, edit the buffer, then Apply. The captured URI, version and full text must still match; otherwise the edit is rejected and you must run again.
4. Start another run and immediately Cancel. Disconnecting the stream aborts the host. Changing lessons also closes the connection.
5. Select **Live Haiku** to run the SDK. This sends only selected text to the model and is billed. The SDK uses structured output for an explanation and replacement, no tools, no MCP servers, no project settings, two turns, a 60-second host deadline and a $0.03 SDK budget threshold. The threshold is not an exact billing cap; interrupted runs may incur cost without reporting a final cost result. A reported zero on cancellation means no result accounting was received.

## VS Code example

From this sample's root:

```powershell
npm run build:extension
code --extensionDevelopmentPath=./ide-extension .
```

In the Extension Development Host, open a local JavaScript file in the trusted workspace. Select a range and run **Lesson 69: Open Agent Panel** from the Command Palette. An empty selection captures the whole document, capped at 24,000 UTF-16 code units. Unsaved contents come from `TextDocument.getText()`, not filesystem reads.

Choose Guided, click Propose rewrite, then Review diff. The panel keeps the most recent file editor when the webview or a virtual diff has focus; focus another source file to change the captured context. Files outside the workspace are rejected. Apply uses an undoable `WorkspaceEdit`; it does not save. Change the document after generating a proposal to verify that applying fails. Close the panel during a run to abort the subprocess.

For live mode, launch VS Code with `ANTHROPIC_API_KEY` set in its host environment. The development extension does not load this project's `.env`. Existing VS Code instances may reuse their original environment; fully restart VS Code or launch a separate instance to change it. The browser server loads `.env` through the dev script. Isolated `CLAUDE_CONFIG_DIR` storage means this sample does not reuse your normal Claude login. Credentials never enter webview messages or source responses.

`ide-extension/extension.cjs` is the VS Code adapter. `webview.js` runs without Node access, renders with `textContent`, and uses a nonce-based content security policy. `npm run build:extension` compiles `server/embedding/` into `ide-extension/runtime/`; the nested runtime package declares ESM. The extension is CommonJS and dynamically imports that runtime. Dependencies resolve from the sample's root during development.

This is a development extension, not a published VSIX. To package independently, build the runtime, install the extension manifest's production dependencies inside `ide-extension/`, and package the extension with your chosen VS Code tooling. Preserve the SDK's CLI assets and subprocess dependencies. Test an installed package on every supported platform. Workspace extensions may run in the remote extension host for SSH, WSL or Codespaces; environment and storage belong to that host.

## Host boundary

`protocol.ts` strictly validates start commands: action and execution mode are the only configurable fields. UI messages cannot supply a working directory, executable, tool list, credential or file path. The extension captures the URI, version, full buffer and selected offsets itself. The live runner sends only the selection and action to Claude; the full captured buffer remains in host memory for stale-edit detection.

`host.ts` permits one active run per panel, caps output and replacement size, and races runner completion against host cancellation. Late callbacks cannot publish a proposal after cancellation. Every accepted run produces one final event. Cancel, deadline, panel disposal and extension deactivation all reach the same AbortController. Each independent run closes its SDK query in `finally`; this sample does not persist conversation sessions.

Applying is a separate user action. The extension stores proposals in the host, opens a read-only virtual diff, and applies only the reviewed proposal to the captured document. URI, version and text checks detect local changes before applying; VS Code owns the undo operation. For collaborative or distributed editors, use the editor's transactional versioned edit API to close any race between validation and commit.

## Electron adaptation

Use the same host in Electron's main process or a utility process. Enable context isolation and disable node integration in the renderer. Expose a narrow preload API for typed commands/events, validate each message and its sender, and remove event subscriptions on disposal. Capture trusted document context in the main process, rather than accepting arbitrary paths from renderer messages. Store credentials in the main process or an OS credential store.

The SDK launches a CLI subprocess. Desktop packaging must provide a compatible runtime and preserve CLI assets, executable permissions and platform support. Avoid executing workspace-provided binaries or loading arbitrary workspace configuration. Handle offline/authentication failures in the host. Persist host-owned session IDs only if adding conversation resume; define which document/workspace owns a session and when it expires.

## Verification

```powershell
npm run test:embedding
npm run typecheck
npm run build
npm run build:extension
npm run test:embedding:extension
npm run test:embedding:smoke
npm run test:offline
```

Offline tests cover trust, strict IPC validation, selected-range replacement, stale documents, event ordering, concurrent-run rejection, cancellation, late output, deadlines, disposal, sanitized failures, guided HTTP streaming and source loading. No API calls are required. The extension adapter test builds the shared runtime and exercises the actual adapter against a mock VS Code API. The browser smoke test requires installed Chrome (or PLAYWRIGHT_MCP_EXECUTABLE_PATH) and a current build. It checks the guided workflow, stale rejection, cancellation and mobile layout. The VS Code walkthrough checks host integration and undo in the real editor; the tests do not launch VS Code.

References: [Anthropic Agent SDK TypeScript reference](https://platform.claude.com/docs/en/agent-sdk/typescript), [VS Code workspace trust](https://code.visualstudio.com/api/extension-guides/workspace-trust), [VS Code webviews](https://code.visualstudio.com/api/extension-guides/webview), [Electron context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation).
