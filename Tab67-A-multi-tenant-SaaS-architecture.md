# A multi-tenant SaaS architecture

With Node 24 or newer, run `npm ci` and `npm run dev`. Open `?lesson=67` or **Production & deployment → 67. A multi-tenant SaaS architecture**. Sample67 uses backend port **3067**; Vite uses **5173** or the next free port.

## Learning objectives

Build one agent application serving multiple organizations without mixing their records, conversations, configuration or usage. Follow authenticated identity through membership, authorization, scoped tool execution and quota accounting. Tenant names in prompts never establish authority.

## Exercise

1. As Alice, inspect Acme's project. Read `orbit-launch` and observe the expected access-denied result (404); `acme-roadmap` succeeds. Lesson access checks complete with HTTP 200 and report the authorization outcome in their JSON body, keeping expected denials out of the browser console. Direct resource endpoints still return HTTP 404. Each access button shows progress and a numbered result directly below it, including the checked ID and a retry message for connection failures.
2. Create a conversation and run the guided response. The default prompt requests a switch to Orbit; the host-owned tool scope still reads only Acme. Guided mode makes no model calls.
3. Copy the conversation ID, switch to Bob, paste it into the access probe and check it. Bob sees an access-denied result (404). Use the generated conversation UUID; a person's name is not a conversation ID. His project list, conversations and quota usage belong to Orbit.
4. Switch to Ava. She can read Acme projects but cannot create or run conversations (403).
5. Run five guided requests as Alice, even across different conversations. The run buttons disable at five accepted requests and show the tenant quota beside them; Bob still has his own quota. If browser usage is stale, the lesson execution endpoint reports the 429 admission denial inside an HTTP 200 result, without starting a worker or generating a browser console error. Direct `/run` API requests still return HTTP 429. Restart the backend to reset this in-memory fixture.
6. Optionally run the live agent with configured Anthropic credentials. Each request uses Haiku and one private `list_projects` tool, with four turns, a $0.05 SDK budget and a 60-second host deadline. Stop request aborts the browser fetch and signals the worker when the response connection closes. Refresh usage after stopping.
7. Click **Refresh workspace** to fetch current server data. The button shows progress, then a timestamped result with project, conversation and run counts beside it. Refresh preserves data and quotas; it does not reset the fixture. A failed refresh displays a retry message and keeps the previous snapshot.
8. Load source code to inspect the host authorization, quota reservation, scoped tool and frontend.

## Architecture and API

The lesson publishes three fixed demo bearer credentials at `/api/c67/facts`. They are public teaching identities, not production authentication. Protected routes require `Authorization: Bearer <credential>`. A production adapter must verify an identity-provider token and resolve current membership on the server.

| Route | Authorization and behavior |
| --- | --- |
| `POST /access-check` with `{ kind, id }` | Authenticated lesson probe; HTTP 200 with `allowed`, resource status and authorized data or generic denial |
| `GET /workspace` | Caller tenant's projects, usage and audit; caller-owned conversations |
| `GET /projects/:id` | Tenant-filtered lookup; foreign and unknown objects return 404 |
| `POST /sessions` with `{}` | Admin only; host generates conversation ID, tenant and owner |
| `GET /sessions/:id` | Both tenant and user ownership must match |
| `POST /sessions/:id/execute` | Lesson UI execution; same checks and quotas, with expected admission denials reported as HTTP 200 JSON `{ accepted: false, status, message }` |
| `POST /sessions/:id/run` | Admin and owner; strict `{ requestId, prompt, mode }` |

`requestId` must be a UUID, prompts contain 1–2000 characters, and mode is `guided` or `live`. Unknown keys, including tenant overrides, are rejected. Accepted duplicate request IDs return 409 instead of executing and billing again. This is duplicate prevention, not durable result replay; inspect the conversation after a lost response.

Project reads always filter by authenticated tenant. Live tools capture that context in a closure and expose no tenant selector. Prior messages are copied from the authorized conversation and passed explicitly to a fresh SDK query; there is no arbitrary SDK session resume. Each conversation gets its own work and configuration folders in ignored `saas-lab/<tenant>/<conversation>/`. Built-in tools, inherited settings and external MCP configurations are disabled; only the scoped read tool is allowed. These application controls are not an OS sandbox.

## Quotas and usage

Each tenant has ten conversations, five accepted requests, one concurrent run and a $0.20 teaching budget. Admission reserves $0.05 for a live request synchronously before awaited execution. Completion releases the reservation and records SDK usage; failure with unknown usage charges the reservation conservatively. Guided requests count toward the run quota and cost $0. Per-tenant audit keeps the latest 50 events and conversation history the latest 20 completed turns. Rejected access probes are recorded only in the caller's tenant audit.

The SDK budget is an execution threshold, not a strict prepaid billing guarantee. Actual reported costs can exceed the reservation. This fixture records that usage and rejects subsequent live admissions when the budget is exhausted. Production needs reconciliation against provider billing and a durable ledger.

## Production extensions

This demo runs in one Node process and stores state in memory. Use shared transactions or atomic quota reservations before adding replicas. Persist conversations, accepted request IDs, execution state and billing events for recovery. Scope background jobs, caches, retrieval indexes, object storage and logs by tenant. Recheck current membership when workers execute queued jobs.

Use composite tenant/object keys and database row-level authorization as defense in depth. Give workers tenant-specific capabilities. If agents need shell or filesystem access, use isolated containers or processes with scoped credentials. Add real authentication, rate limits, credential rotation, HTTPS, audit retention and limits for account creation before public deployment. The demo tokens intentionally permit switching identities and must not be exposed as real credentials.

## Verification

```sh
npm run test:saas
npm run test:offline
npm run typecheck
npm run build
npm run test:saas:smoke
```

Tests make no model calls. They check authenticated HTTP requests, role restrictions, cross-tenant object access, owner checks, prompt scope, history isolation, duplicate requests, tenant quotas, concurrency reservations, usage reconciliation, failed and cancelled runs, and session limits.

The browser smoke test requires installed Chrome (or `PLAYWRIGHT_MCP_EXECUTABLE_PATH`). It verifies the built lesson's account switching, guided conversation, cross-tenant probes, role and quota errors, source loading and mobile layout.
