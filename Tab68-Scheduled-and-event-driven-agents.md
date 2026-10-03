# Scheduled and event-driven agents

With Node 24 or newer, run `npm ci` and `npm run dev`. Open `?lesson=68` or **Production & deployment → 68. Scheduled and event-driven agents**. Sample68 uses backend port **3068**, with Vite on **5173** or the next free port.

## Learning objectives

Separate trigger admission from agent execution. Both interval schedules and signed incident webhooks enqueue jobs in the same bounded queue. Observe duplicate handling, atomic worker claims, cancellation, retry backoff and dead letters. The host owns these behaviors; the model only summarizes a job's payload.

## Development startup and recovery

The Windows development command watches only `server/` and `mcp-servers/` with Node's explicit `--watch-path` flags, so reads or changes in `node_modules` and generated lab directories do not restart the server. See [Node watch-path documentation](https://nodejs.org/api/cli.html#--watch-path). After changing package scripts, stop the previous development command and run `npm run dev` again. Wait for `Agent SDK server on http://localhost:3068`, then reload `?lesson=68`.

If the backend restarts during a request, the lesson reports an empty, invalid or timed-out response with a recovery instruction. Click **Refresh queue** after startup completes. Polling keeps one background refresh in flight and recovers automatically when the backend returns. Failed actions release their busy state; event admission and live execution are never automatically retried. A backend restart resets this in-memory fixture.

## Exercise

1. Enable a ten-second schedule. The server checks it every second, even when the lesson is closed. Refresh or wait for polling to see queued work. No agent runs automatically.
2. Advance the lesson clock 30 seconds. Missed interval occurrences coalesce into one job, with a skipped count. Pause the schedule before exploring retries.
3. Send the signed incident webhook twice with the same event ID. The second delivery returns the existing job. Change the ID to create another incident. An ID remains consumed even if its job fails or is cancelled.
4. Run the next job in Guided mode. This makes no API calls. Acknowledgment of a webhook (HTTP 202) is distinct from successful execution.
5. Select Inject failure, run a job, advance the clock, and repeat until three attempts produce a dead letter. Retry delays are one and two seconds; the third failed attempt is terminal. Switch to Guided before the third attempt to recover instead.
6. Cancel a queued or running job. Cancellation aborts the host-owned worker and prevents a result from being recorded. Navigating away aborts browser requests; accepted work remains server-owned and can be inspected when returning.
7. Optionally choose Live Haiku and click Run next job. Each attempt uses a fresh SDK query, no tools or inherited settings, two turns, a $0.03 SDK threshold and a 60-second host deadline. Live retries also require explicit clicks. Failed attempts may still incur costs. The SDK budget is not a prepaid billing guarantee.
8. Load source code to inspect signature verification, scheduling, the queue and frontend.

## API

All routes are below `/api/c68`. This is a local, unauthenticated teaching fixture; control routes and the fixture sender must not be exposed as production services.

| Route | Behavior |
| --- | --- |
| `GET /state` | Tick due schedule and return a copied queue snapshot |
| `POST /schedule` | `{ everySeconds: 5..3600 }`; replace the current interval schedule |
| `POST /pause` | Disable future occurrences; retain queued jobs |
| `POST /advance` | `{ seconds: 1..3600 }`; advance simulation clock and tick |
| `POST /fixture` | `{ eventId, type: "incident.created", message }`; return exact JSON bytes, timestamp and signature for the local sender |
| `POST /webhook` | Same JSON event with `x-event-timestamp` and `x-event-signature`; HTTP 202 for new and duplicate deliveries |
| `POST /work` | `{ mode: "guided" | "fail" | "live" }`; execute one eligible job |
| `POST /jobs/:id/cancel` | Cancel queued, retrying or running work |
| `GET /code` | Lesson sources |

Event IDs accept 1–100 letters, digits, underscores or hyphens. Messages contain 1–2000 characters. Unknown event and control fields are rejected. Signing uses SHA-256 HMAC of `timestamp + "." + rawBody`, with timestamp in epoch milliseconds and a five-minute tolerance against the real host clock. The router must be mounted before global JSON parsing. Signature comparison uses constant-time comparison after checking lengths. The random secret stays on the server and changes at restart; the public fixture endpoint simulates the trusted sender. It is intentionally not production authentication.

## Execution and limits

The queue stores at most 100 jobs, including completed history and deduplication keys. One worker claims a job synchronously before awaiting execution. Every job has at most three attempts. A host deadline races execution and signals abort. An injected runner that ignores abort cannot hold the teaching queue forever, but production must terminate or fence such a worker before permitting external effects.

Schedule occurrences use host-generated schedule IDs and UTC epoch times. The clock advancement affects schedule and retry eligibility, never webhook signature freshness. This sample demonstrates interval scheduling, not a complete cron parser. No persistence, distributed lease, crash recovery, tenant auth or exactly-once effects are provided. Restart loses queue history, schedules and deduplication.

For production, persist accepted event IDs and jobs atomically, use leased claims with fencing, acknowledge only durable enqueue, and retain deduplication keys for the sender's replay period. Tools that create effects need transactional idempotency keys; queue deduplication alone cannot prevent duplicate side effects after a crash. Reauthorize tenant capabilities when workers execute (lesson 67), and recover interrupted executions using the durable host design (lesson 60). Use a trusted cron service or queue scheduler, define timezone and daylight-saving behavior for daily schedules, authenticate control routes, rotate webhook secrets, rate-limit admission, reconcile costs, and review dead letters.

The live runner follows the installed SDK types and [Anthropic's Agent SDK TypeScript source](https://github.com/anthropics/claude-agent-sdk-typescript).

## Verification

```sh
npm run test:scheduled
npm run test:offline
npm run typecheck
npm run build
npm run test:scheduled:smoke
```

Offline tests cover schedule coalescing and pause, duplicate deliveries, queue limits, retry eligibility and exhaustion, atomic claims, cancellation, deadlines, HMAC tampering and timestamp freshness, strict HTTP validation, raw-body mounting, guided execution and source loading. No model calls are needed.

The browser smoke test requires installed Chrome or `PLAYWRIGHT_MCP_EXECUTABLE_PATH`. It verifies scheduling, duplicate event delivery, guided completion, recovery after an injected failure, cancellation, source loading and mobile layout.
