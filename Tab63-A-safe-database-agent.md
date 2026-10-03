# A safe database agent

Use Node 24 or newer, run `npm ci` and `npm run dev`, then open `?lesson=63` or **Permissions & security → 63. A safe database agent**. Sample63 uses backend port **3063** and Vite port **5173** (or the next available port).

The lab uses a real, disposable SQLite database with three fictional Acme orders, another tenant's private row and a malicious order note. Start a lab explicitly; its opaque session capability expires after an hour. No production database is connected. Offline actions need no API credentials.

## Read safely

`list_orders` accepts only an enumerated status and a bounded limit. The host binds parameters to a fixed SELECT, fixes the tenant to Acme and selects only allowed columns. The model cannot supply SQL, a tenant, a column or an expression. `PRAGMA query_only` guards the private connection during reads. This is a narrow application interface rather than a general natural-language SQL console: arbitrary analytics are intentionally unsupported. Parameterization prevents SQL injection in values; it does not grant authorization, so the tenant predicate remains essential.

## Preview, review, commit

`propose_cancellation` can preview one pending order only. It stores the exact change, current version, reason and five-minute expiry; it changes no database row. The agent has no approval or commit tool. The human sees the stored preview in the lesson and approves or rejects via a separate HTTP action.

Approval runs a short transaction and updates exactly one row only if tenant, pending status and version still match. A competing preview becomes stale after the first commits. Expired, rejected or already consumed proposals cannot write. The transaction rolls back on mismatch. The database returns to query-only mode after the host write. Create two previews for A-101, approve one and try the other to observe this behavior. Reasons and row notes are rendered as text; they do not become SQL or host instructions.

Expected policy rejections return a successful HTTP response with `ok: false`, a readable message and refreshed database state. The page displays these as lesson outcomes. The blocked-SQL button uses a dedicated exercise route that invokes the same strict read guard; direct malformed API requests still return HTTP 400. Unexpected server failures remain errors.

## Live agent

The billed section uses configured Anthropic credentials and `query()` with Haiku, two in-process MCP tools, no built-in tools, no settings sources, strict MCP configuration and `dontAsk`. Each run has six turns, a $0.10 budget and a 90-second deadline. Only one lesson 63 live run can execute at a time. Human mutations wait until it finishes. Stop or disconnect aborts generation; proposals created before abort survive for review. Refresh after Stop to inspect them. Model prose is not evidence of a database commit; use the table and host audit.

The hostile note demonstrates a prompt injection. Treating row contents as untrusted in the system prompt helps, but the enforceable protection is the absence of arbitrary SQL and commit tools. A malicious instruction could still influence a proposal or answer, so a human must inspect the exact target and change.

## Production boundaries

This is a localhost educational lab. The session ID is a bearer capability, not an authenticated user identity. The database, proposals and bounded audit live in memory and disappear on restart; expired idle sessions are collected when another lab starts, and capacity is limited to 50 labs. Production requires authenticated tenant and approver identities, request-origin/CSRF protections, independent read-only database credentials, durable proposals and append-only audit records. Do not expose this demo server publicly. A general SQL agent would also need query parsing/authorization, resource deadlines and output limits: read-only access can still disclose data or run expensive queries.

## Verification

Run `npm run test:database`, `npm run typecheck` and `npm run build`. The database tests exercise tenant isolation, unsupported SQL, strict schemas, bounded reads, exact preview approval, replay, rejection, expiry, stale rollback, independent sessions, the real MCP protocol and HTTP routes without a model call. Offline tests do not evaluate live model answer quality.

Implementation: `server/database/database.ts`, `server/concepts/63-safe-database-agent.ts`, `src/concepts/Concept63SafeDatabaseAgent.tsx`.

References: [Node SQLite](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html), [Agent SDK custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools).
