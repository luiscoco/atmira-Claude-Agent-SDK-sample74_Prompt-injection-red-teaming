# Human approval over Slack, Teams or email

Run `npm ci` and `npm run dev` with Node 24 or newer. Open `?lesson=65` or **Agent workflows → 65. Human approval over Slack, Teams or email**. Sample65 uses backend port **3065**; Vite uses **5173** or the next free port.

## Learning objectives

Turn a proposed tool action into a concrete human review request. Send it through Slack, Teams or email, wait for an explicit decision, bind that decision to the exact tool input, and verify the resulting effect independently of the agent's report. Handle denial, expiry, delivery errors, cancellation and replay.

## Local exercise

Choose a channel, an amount in integer cents ($0.01–$100.00), and an expiry (5–120 seconds). Click **Run guided approval (no model API)**. The host proposes a fictional refund for `ORD-65`, freezes its input and creates a random request ID, action fingerprint and 256-bit bearer capability.

The inbox preview shows the channel's actual payload shape: Slack Block Kit, a Teams Adaptive Card or an HTML email. Local delivery is simulated; no account or messaging service is contacted. The approval gate and decision endpoints are real. Approve or reject in the preview, or use **Open approval page** to review in another tab. The SSE run stays open until the decision arrives. The host ledger shows exactly one fictional refund after approval, or none after rejection. Let a five-second request expire and try Stop on another pending request.

The preview shows the remaining approval time and submission feedback beside the buttons. Failed decisions display their error there and can be retried while the request is pending. Completed or expired requests show their outcome instead of inactive buttons; use **Start a new approval request** for a fresh guided run. Decision submissions time out after ten seconds, and unexpected stream closure is reported explicitly.

The review page clears its URL fragment after reading the credential. Opening the link performs no decision. The page first inspects the request using a credential-bearing POST, then waits for the reviewer to press Approve or Reject. This prevents a mail scanner's GET from approving a refund. It does not protect against a scanner that deliberately executes JavaScript and submits approval, or against a stolen link.

## SDK integration

**Run approval agent (billed)** calls `query()` with Haiku and a single `mcp__approval__issue_refund` custom tool. The tool handler creates the request, sends the notification, awaits the human outcome, and performs the effect only after approval. Built-in tools and user configuration sources are disabled. The host checks that the tool input exactly matches the exercise action; the agent cannot change the amount or generate its own decision. It can create at most one request per run.

This is application authorization enforced in the tool handler. The SDK's `canUseTool` callback is another integration point: return a pending Promise until a reviewer responds, then return `{ behavior: "allow", updatedInput: input }` or `{ behavior: "deny", message }`. However, auto-approved tools skip that callback, and `dontAsk` denies SDK permission prompts without asking it. An unconditional business approval gate belongs inside the effect handler or in a host hook that always executes. This sample deliberately auto-allows the narrow MCP tool at the SDK level while requiring approval inside that tool.

The live run is capped at four turns, $0.10 and an overall deadline of the selected expiry plus 60 seconds. The expiry starts when the actual tool request is created. Stop, disconnect or leaving the lesson aborts the run and cancels pending requests. Notification credentials are removed from the SDK subprocess environment. Anthropic credentials are still required for the live model call. Guided mode uses no model API.

## Real notifications

The UI defaults to local delivery. For real notification delivery, copy the new variables from `.env.example` into `.env`, configure an HTTPS origin in `APPROVAL_PUBLIC_BASE_URL`, and restart the backend. The origin must have no path prefix, query, fragment or URL credentials. It must serve `/api/c65/review`, `/api/c65/inspect` and `/api/c65/decision`. Reverse proxies must preserve the request Host or use the configured public origin for browser decision requests.

| Channel | Configuration | Delivery behavior |
| --- | --- | --- |
| Slack | `APPROVAL_SLACK_BOT_TOKEN`, `APPROVAL_SLACK_CHANNEL` | Sends `chat.postMessage` with plain text and a URL review button. The bot needs `chat:write` and access to the selected channel. |
| Teams | `APPROVAL_TEAMS_WORKFLOW_URL` | Posts an Adaptive Card envelope to a Teams Workflows webhook configured to publish that card. Use an endpoint accepting this payload without additional authentication; configure the workflow's ownership and channel permissions. |
| Email | `APPROVAL_GRAPH_TOKEN`, `APPROVAL_EMAIL_SENDER`, `APPROVAL_EMAIL_TO` | Sends an HTML review link through Graph v1.0 `/users/{sender}/sendMail`. The token needs `Mail.Send` with access to that mailbox. Acquire and refresh it outside this sample. |

Select **Send to configured channel** and start a run to send a real notification. The refund remains fictional. Provider HTTP acceptance only means the request was accepted; Graph's 202 does not guarantee delivery, and Slack's JSON `ok` is checked separately. Delivery is bounded to ten seconds and redirects are refused. An error denies the effect and invalidates pending approval. The host does not automatically retry an uncertain notification delivery.

Slack and Teams buttons open the hosted review page. Neither adapter receives an identity-verified platform approval callback. `Action.OpenUrl` does not capture a Teams approval itself. No Slack signing secret or Teams bot callback is used here. A future platform-native callback implementation must authenticate the provider, authorize the reviewer, verify request/action correlation, reject replay and acknowledge within the platform's deadline before doing lengthy agent work.

## Trust and lifecycle

The credential is a one-use bearer capability for one immutable action, not proof of a person's identity. Anyone with the link can decide. Channel membership, an email address and message delivery do not prove who clicked. Do not publish the private payload or link. Production identity requirements need authenticated reviewer sessions and an approver allowlist.

The credential lives in the URL fragment, which is not part of the GET request. It is submitted in a POST body, never in query strings. The review page uses `no-store`, `no-referrer` and a restrictive content security policy. Browser requests from another origin are rejected. The decision schema accepts only an ID, token and boolean; the reviewer cannot replace the action. Audit and final evidence contain no capability token. Local preview exposes the capability to the initiating learner so it can act as a test inbox.

Request state transitions are `pending → approved | rejected | expired | cancelled | delivery_failed`. The transition happens synchronously and clears the timer and abort listener. A second decision returns 409; an incorrect credential returns 403. Expiry is checked synchronously at decision time as well as by a timer. The effect checks cancellation again immediately before committing. The fictional ledger has one entry at most, regardless of repeated execution attempts.

Requests, audit and ledgers are held in memory. The latest 100 requests are retained for replay rejection; older IDs return 404. Only one lesson 65 run can execute at a time. Restart loses all state and outstanding capabilities become invalid. This sample does not promise durable or distributed exactly-once processing. Real payment or deployment actions need persisted action snapshots, atomic decision consumption and provider idempotency keys. For hours-long approvals, combine this gate with lesson 60's durable supervisor rather than holding a Node process open. Cancellation cannot undo an already completed action.

## Verification

```sh
npm run test:approval
npm run test:offline
npm run typecheck
npm run build
npm run test:approval:smoke
```

The offline tests cover immutable inputs, pending behavior, invalid credentials, one-use decisions, denial, expiry, cancellation, delivery failure, payload escaping and mocked provider adapters. HTTP/SSE tests exercise each channel, inert GET review links, cross-origin rejection, request validation, one active run, action evidence and replay rejection. They do not send external messages or call a model.

The smoke tests require Chrome and a preceding build. They open both the built UI and the React development UI through Vite's proxy, approve Slack through a separate review page, reject Teams, approve email, wait for expiry and cancel a pending SSE request. They also simulate a failed decision POST, verify the error beside the buttons, and retry successfully. They verify successful decision POSTs, the host evidence and browser JavaScript errors. The proxy preserves the frontend Host header so the browser Origin passes the backend's same-origin check. External account delivery and live model behavior require separately configured credentials and are not exercised by these tests.

Implementation: `server/approval/approval.ts`, `server/approval/channels.ts`, `server/approval/review.ts`, `server/concepts/65-human-approval.ts`, `src/concepts/Concept65HumanApproval.tsx`.

References: [Agent SDK approvals](https://code.claude.com/docs/en/agent-sdk/user-input), [Slack chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/), [Teams workflows and Adaptive Cards](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook), [Graph sendMail](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0), [Slack signature verification for native callbacks](https://docs.slack.dev/authentication/verifying-requests-from-slack/).
