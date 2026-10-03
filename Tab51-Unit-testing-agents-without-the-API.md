# Unit-testing agents without the API

Lesson 51 of the Claude Agent SDK Lab tests the deterministic code around an agent: tools, data boundaries,
hooks, permission decisions, streaming consumers, cancellation and output validation. Every exercise runs without
an API key, a Claude Code process or a model request. It follows the support-desk capstone from lesson 50 and uses
its actual tools and callbacks rather than copies of their implementations.

Open **Production & deployment → 51. Unit-testing agents without the API** in the sidebar.

| Concept | Topic | Routes |
|---|---|---|
| 51 | In-memory MCP tool tests, direct hook and permission tests, dependency injection, synthetic async iterators, effect-based assertions, virtual timers and a deliberate mutation | `GET /api/c51/facts`, `GET /code`, `POST /run` (SSE), `POST /replay` (SSE) |

## Run it

```powershell
npm ci
npm run test:offline
```

Use Node 24 for the lesson's timer-mocking example. The command does not load `.env`, launch the app server or
require a Claude login. It runs 28 unit tests and 6 local HTTP integration tests. The HTTP tests mount only the
lesson 51 router on a loopback port. They never import `server/index.ts`, which starts all the other labs.

For the interactive lesson:

```powershell
npm run dev
```

Open `http://localhost:5173`, expand **Production & deployment**, and select lesson 51. The browser calls the local
Express endpoints to execute tests; “without the API” means without the **model API**, not without local HTTP.

## A. Choose what to test

| Boundary | Real code | Test double | Assertions |
|---|---|---|---|
| MCP tools | `deskServer()`, schemas, handlers, `Store` | In-memory transport and host context | Tool inventory, invalid inputs, customer isolation, refund balance, persisted effects |
| Hooks | Callbacks registered by `deskOptions()` | Typed hook input and in-memory store | Boundary values, deny reason, caller identity, audit outcome |
| Permissions | The real `canUseTool` callback | Approver returning a fixed answer | Safe allow, unknown deny, approval attribution, unchanged business state |
| Host stream | `runAgent()` | Required `QueryPort` dependency yielding fixtures | No repeated text, hidden subagent output, errors, missing result, schema validation, resume, cancellation |
| Time | The host's real deadline | Node's mock timers | A 60-second timeout without a 60-second delay |

The model is outside these unit-test boundaries. A fixture saying “Refund approved” proves how the host consumes
that message, not that Claude would approve a refund or choose the correct tool. The live eval suite in lesson 50
remains useful for model behaviour.

## B. Exercise the real tools through MCP

`server/testing/mcp.ts` creates the actual capstone server and a real MCP client. A linked pair of
`InMemoryTransport` objects carries their JSON-RPC messages in the same process:

```typescript
const server = deskServer(store, customerId, trustedContext);
const client = new Client({ name: "lesson-51-tests", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.instance.connect(serverTransport);
await client.connect(clientTransport);

const result = await client.callTool({
  name: "issue_refund",
  arguments: { order_id: "A-1001", amount_cents: 1800, reason: "One broken mug" },
});
```

The helper closes both sides in `finally`. Every case constructs a fresh `new Store()` without a file path, so
the tests do not write `capstone-lab/db.json` or depend on a previous case's state.

Assert business effects: exactly one refund, 1,800 cents refunded, and the approver supplied by host context.
For invalid or foreign-order requests, assert `isError` and **no refund**. Do not assert the exact phrasing of
human-readable tool output unless wording itself is the contract.

Calling MCP directly does **not** invoke Claude Code's hooks or permission system. In particular, the test's
trusted approver is pre-supplied context, not a simulated human approval flow. The hook enforces the $150 cap;
the tool enforces ownership and remaining balance. Test each layer separately.

## C. Test hook and permission functions directly

`withOptions()` constructs the real capstone options with an in-memory store and a deterministic approver. It
does not invoke `query()` or create a workspace. Tests call the registered callback with a typed input:

```typescript
const output = await matcher.hooks[0](
  {
    session_id: "offline-session-51", transcript_path: "unused.jsonl", cwd: process.cwd(),
    hook_event_name: "PreToolUse", tool_name: T.issueRefund,
    tool_input: { order_id: "A-1001", amount_cents: 15001, reason: "Broken item" },
    tool_use_id: "tool-51",
  },
  "tool-51",
  { signal: new AbortController().signal },
);
```

The boundary test gives its order enough refundable balance to isolate the per-call cap. Exactly 15,000 cents
passes that hook; 15,001 cents produces a deny and a blocked audit entry. A different case covers another
customer's order.

Permission tests call `options.canUseTool` directly with `signal`, `toolUseID` and `requestId`, as required by the
installed SDK. Safe lookups are allowed, Bash is denied, and refunds receive the approver's answer. Approval
does not write a refund: permission callbacks decide whether a tool may run; the handler performs the write.

These tests verify callback functions. They do not verify CLI matcher scheduling, callback ordering,
`allowedTools` precedence or the complete permission pipeline. Those require SDK integration tests.

## D. Inject a query boundary

`QueryPort` is a small application interface:

```typescript
type QueryPort = (request: {
  prompt: string;
  signal: AbortSignal;
  resume?: string;
}) => AsyncIterable<AgentMessage>;
```

The dependency is required. There is no default that silently falls back to a real `query()`. `AgentMessage`
contains only the fields the host reads, with field types derived from the installed SDK's exported types. It
is not a complete `SDKMessage` fixture or an implementation of the SDK's `Query` methods.

The offline generator yields fresh cloned messages per invocation. A spy records the prompt and resume id.
Separate fixtures represent a complete reply, subagent deltas, a budget error, a success subtype with
`is_error: true`, invalid structured output, a truncated stream, an exception, and a stream waiting for abort.

A production adapter would supply a real SDK iterator, filter the three message kinds this consumer handles,
forward the prompt and resume id, connect cancellation to the SDK's `abortController`, and release resources
when iteration ends. That adapter is intentionally outside the offline runner. Use a live integration test to
check it against the SDK rather than adding real API calls to this suite.

The host:

1. Checks cancellation before invoking its dependency.
2. Streams only main-thread text deltas (`parent_tool_use_id === null`).
3. Avoids appending completed assistant text after the same text's deltas.
4. Uses the terminal result as the authoritative final answer.
5. Checks both `subtype` and `is_error`.
6. Validates `structured_output` with zod before returning a typed summary.
7. Reports an ended stream without a result as `incomplete`.
8. Distinguishes transport errors, user cancellation and timeout, and clears its timer/listener.

The query dependency must honour cancellation while waiting for its next message. `fakeQuery("wait")` does so
by rejecting its pending promise when its signal aborts. This is a contract of this example, not a claim that
an arbitrary uncooperative async iterable can always be interrupted.

## E. Make a failing test useful

The UI's bug checkbox deliberately changes the host's repeated-text handling. It appends the complete
assistant text even after receiving the same streamed deltas, and preserves that duplicated text at completion.
The expected answer stays `Refund approved.`. The assertion fails with a difference between actual and expected
text. Only `stream-text` fails; tools and policy cases remain green.

The command-line suite uses `assert.rejects()` around that same unchanged assertion with the mutation enabled.
That test passes when the regression is **detected**. The interactive run displays a red assertion to teach the
failure. Turning the checkbox off restores the original implementation for subsequent runs. It does not edit
the capstone or any source file.

## F. Control time and cleanup

The Node-only deadline test uses the real `runAgent()` timeout logic:

```typescript
t.mock.timers.enable({ apis: ["setTimeout"], now: 0 });
const pending = runAgent(fakeQuery("wait"), { prompt: "Hello", timeoutMs: 60_000 });
t.mock.timers.tick(60_000);
assert.equal((await pending).status, "timeout");
```

The test context restores mocked timers. The host clears its timeout in `finally`. A separate test asserts
that the async generator's `finally` runs when the host consumes a terminal result and returns early.
The UI timeout fixture uses a real one-second local delay so the waiting state is visible; it makes no model call.

## Files and implementation steps

| File | Purpose |
|---|---|
| `server/testing/host.ts` | Required dependency boundary, stream consumer, validation and cancellation |
| `server/testing/fixtures.ts` | Typed synthetic transcripts and an abort-aware async generator |
| `server/testing/mcp.ts` | In-memory client connected to actual capstone tools |
| `server/testing/cases.ts` | 25 reusable assertions shared by the GUI and Node runner |
| `server/testing/offline.test.ts` | Native Node test registration, mutation detection, virtual deadline and iterator cleanup |
| `server/testing/routes.test.ts` | Six loopback HTTP checks of lesson facts, source, validation, suite results and replay |
| `server/concepts/51-unit-testing.ts` | Facts, source and SSE exercise endpoints |
| `src/concepts/Concept51UnitTesting.tsx` | Test results, bug switch, fixture replay, source viewer and explanations |
| `src/App.tsx` | Lesson 51 under Production & deployment |
| `src/styles.css` | Boundary cards and test-result styling |
| `server/index.ts` | Mounts `/api/c51` |
| `package.json` | Adds `npm run test:offline` using existing `tsx` and the built-in Node test runner |

Implementation order: define the test boundary; connect the real MCP tools in memory; call the existing policy
callbacks; build a typed host seam and synthetic transcripts; write effect-based assertions; expose those same
assertions over SSE; add the UI and lesson notes; validate TypeScript, the tests and the production build.

No new dependencies and no changes to the capstone business rules are needed.

## Verification

- TypeScript: `node node_modules/typescript/bin/tsc --noEmit` passes.
- Command-line suite: 34/34 tests pass (28 unit tests and 6 local HTTP integration tests).
- Production build: `node node_modules/vite/bin/vite.js build` passes.
- Headless Chrome: sidebar selection, 25/25 interactive assertions, exactly one expected mutation failure,
  successful structured fixture replay, mobile menu opening/closing and no horizontal overflow pass.
  No browser runtime exceptions were observed.
- Navigation coverage: all 51 lessons occur exactly once across the eight sections.

## References

- [Node 24 test runner, assertions and mock timers](https://nodejs.org/docs/latest-v24.x/api/test.html).
- [Claude Agent SDK TypeScript reference](https://platform.claude.com/docs/en/agent-sdk/typescript).
- Installed SDK types: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` and
  `node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.d.ts`. These are the contracts used by this lesson's code.
