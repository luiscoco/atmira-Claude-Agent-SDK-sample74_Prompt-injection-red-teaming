# Deploy and CI headless

This file explains Concept 49 (**deploy and CI headless**) of the Claude Agent SDK Lab. Every earlier tab had a
person watching the agent. In a CI pipeline or a deployed service **nobody is watching**. There is no terminal, nobody
can answer a permission prompt, and nobody notices a run that loops or hangs. A headless agent therefore has to be:

- **Scriptable**: `claude -p --output-format json` or the SDK's `query()`. One process starts, one JSON result comes out.
- **Machine-readable**: `outputFormat` / `--json-schema` returns a typed verdict that the pipeline can trust.
- **Fail-closed**: `permissionMode: "dontAsk"` denies anything that was not pre-approved. No prompt can hang the job.
- **Bounded**: `maxTurns`, `maxBudgetUsd` and an `AbortController` timeout. Each one maps to its own **exit code**.
- **Reproducible**: `settingSources: []`, `persistSession: false`, a temporary `CLAUDE_CONFIG_DIR` and a clean env.
- **Operable as a service**: health and readiness probes, a concurrency cap (429), and a graceful SIGTERM drain.

**Goal:** run the same job through `claude -p` and through `query()`. Run a real review gate the way GitHub Actions
runs it, with annotations, a job summary, outputs and an exit code. See how every limit ends cleanly. Run a deployable
agent worker through its whole life cycle: start → probes → backpressure → SIGTERM → drain → exit 0.

| Concept | Topic | Routes |
|---|---|---|
| 49 | Deploy & CI headless: `-p`/`--print`, `--output-format json \| stream-json`, `--json-schema` ↔ `outputFormat`, `permissionMode: "dontAsk"`, `maxTurns`, `maxBudgetUsd`, `AbortController` timeouts, result `subtype` / `terminal_reason` / `permission_denials`, an exit-code policy, GitHub workflow commands (`::error file=,line=::`), `$GITHUB_STEP_SUMMARY`, `$GITHUB_OUTPUT`, a clean env, `settingSources: []`, `persistSession: false`, `CLAUDE_CONFIG_DIR`, a Dockerfile, `/healthz` + `/readyz`, 429 + `Retry-After`, SIGTERM drain | `/api/c49/facts`, `/headless`, `/ci`, `/limits`, `/deploy` (SSE), `/files`, `/code` |

## Files touched

| File | Change |
|---|---|
| `ci-kit/agent-review.mjs` | **New, a deliverable**: a headless review gate built on `query()`. It uses a JSON-schema verdict, read-only tools, `dontAsk`, turn, budget and time limits, annotations, a job summary, outputs and exit codes 0/1/2/124 |
| `ci-kit/worker.mjs` | **New, a deliverable**: an HTTP agent service with `/healthz`, `/readyz`, `POST /run`, a concurrency cap, per-job limits, JSON logs, and a graceful shutdown on SIGTERM, SIGINT or an IPC message |
| `ci-kit/workflows/agent-review.yml` | **New, a deliverable**: a GitHub Actions pull-request gate that runs `agent-review.mjs` |
| `ci-kit/workflows/claude-cli-headless.yml` | **New, a deliverable**: the same idea with `claude -p` only, with no script |
| `ci-kit/Dockerfile`, `ci-kit/Dockerfile.dockerignore` | **New, deliverables**: the container image for `worker.mjs` (non-root user, `tini`, `HEALTHCHECK`, no secret in the image) |
| `server/concepts/49-deploy-ci-headless.ts` | **New**: the fixture repo (a buggy and a clean diff), `cleanEnv()`, the CLI runner, `exitCodeFor()`, the four scenarios and the routes |
| `server/index.ts` | Mounts the router on `/api/c49` |
| `src/concepts/Concept49DeployCiHeadless.tsx` | **New**: the tab, Parts A to H |
| `src/App.tsx` | Adds the tab |
| `src/styles.css` | The CI log, the exit-code badges and the HTTP status colours |
| `.gitignore` | Ignores `deploy-lab/`, the folder the server recreates for each run |
| `Tab49-Deploy-and-CI-headless.md` | A copy of this file, next to the other tab notes |

## The steps I followed

1. **I chose the scope.** The course index says sample 49 combines topic #8 (headless / CLI print mode) and topic #23
   (deploy & CI). So the tab has two halves. The first half covers *running without a human*: the CLI, the SDK, limits
   and exit codes. The second half covers *running somewhere else*: a CI runner and a container platform.
2. **I copied sample 48 and installed the dependencies** (`npm ci`). The `package.json` is unchanged, so no new
   dependency was needed.
3. **I checked the real headless behaviour before writing any code.** I ran the bundled `claude.exe -p` with
   `--output-format json`, `--json-schema`, `--max-turns`, `--max-budget-usd` and `--permission-mode dontAsk`, and
   looked at the JSON result and the exit codes. I found three things that shaped the lab:
   - A run started from inside another Claude Code session inherited `CLAUDECODE` / `CLAUDE_CODE_*` variables and
     failed with *"Not logged in"*, even with a valid API key. **Lesson: build the env of a headless agent from an
     allow-list. Never spread `process.env` into it.** This is `cleanEnv()`.
   - The CLI exits **1** on `error_max_turns` and `error_max_budget_usd`, and **0** on success. `structured_output`
     holds the validated JSON.
   - The SDK **yields the error result and then throws** (*"Claude Code returned an error result…"*). On abort it
     throws **with no result at all**, and only after Claude Code has exited (≈7 s here). Both shaped the catch blocks
     in `agent-review.mjs` and Part D.
4. **I wrote the deliverables first, in `ci-kit/`.** These are real files a student copies into a repository:
   - `agent-review.mjs`: the gate. Read-only tools + `dontAsk` + a schema + limits. Its exit-code policy is 0 pass,
     1 blocking findings, 2 incomplete, 124 timeout. *Incomplete is never a pass.*
   - `worker.mjs`: the service. Probes, `MAX_CONCURRENCY` with 429 + `Retry-After`, per-job limits, and on SIGTERM:
     readiness goes to 503, new work gets 503, it drains for `DRAIN_MS`, aborts the rest and exits 0.
   - Two workflows (an SDK gate and a plain `claude -p` job) and a Dockerfile. The Dockerfile runs `npm ci` *inside*
     the image, because the Claude Code binary is a per-platform optional package. It also adds a non-root user,
     `tini` as PID 1 so SIGTERM reaches node, and a `HEALTHCHECK`. The API key is injected at run time.
5. **I wrote the server route** `server/concepts/49-deploy-ci-headless.ts`. It *runs* the deliverables the way the
   real platforms do:
   - `/headless` runs the CLI (`spawn`, `stdin: "ignore"`) and then `query()` with identical options, and shows both
     results side by side.
   - `/ci` runs `node ci-kit/agent-review.mjs` as a child process with `CI=true` and with `GITHUB_STEP_SUMMARY` /
     `GITHUB_OUTPUT` pointing to files. It streams stdout (the annotations) and stderr (the log), then reads the exit code.
   - `/limits` runs four bounded runs in parallel (turns, budget, timeout, a denied `Write`) and maps each ending with
     `exitCodeFor()`.
   - `/deploy` `fork()`s the worker (`execArgv: []`, so it does not inherit the server's `--watch --import tsx`), then
     plays the platform: probes, a long job, a second job (429), the shutdown signal, a readiness probe and a new job
     during the drain (503), and the exit code.
6. **I wrote the tab** `Concept49DeployCiHeadless.tsx` (Parts A to H). It also has a tiny Markdown renderer, so the job
   summary looks the way GitHub would show it.
7. **I tested every route against the real API** and fixed what the tests showed:
   - `/ci` *buggy* → exit 1 with two `::error` annotations (the 100× discount bug and `eval()`). *clean* → exit 0.
   - The gate with `REVIEW_MAX_TURNS=1` → exit 2, with a "did not complete" summary instead of a false pass.
   - `/limits` → `error_max_turns` (2), `error_max_budget_usd` (2), timeout (124), `Write` denied (3).
   - `/deploy` with a 3 s drain → the long job was aborted, its caller got a clean 503, and the worker exited 0. With a
     30 s drain → the job finished (200) before the worker exited 0.
   - Fixes made during testing: tool paths in logs are now relative; a JSON-escaped Windows path is shortened; an
     error result that is followed by a throw is now reported instead of being treated as a crash; a run folder that
     an orphaned process still locks on Windows now gets a fresh name; and the drain budget is documented as
     `DRAIN_MS` **+** the abort teardown.

## The tab, part by part

**A · Headless flags ↔ SDK options.** Every `claude -p` flag next to its `Options` field. The descriptions are read
live from the installed `sdk.d.ts`. The table also shows the exit-code convention used by the rest of the tab.

**B · `claude -p` vs `query()`.** The same task, schema and limits run both ways. With `json`, the CLI prints **one**
result object. With `stream-json`, it prints every message as a JSON line, which is the protocol the SDK itself reads.
Both return the same `subtype`, `structured_output` and `permission_denials`.

```bash
claude -p "List the exported functions…" --output-format json --model haiku \
  --tools Read,Grep,Glob --allowedTools Read,Grep,Glob --permission-mode dontAsk \
  --json-schema '{"type":"object",…}' --max-turns 5 --max-budget-usd 0.05 \
  --no-session-persistence --setting-sources '' --strict-mcp-config
```

```ts
query({ prompt, options: {
  tools: ["Read", "Grep", "Glob"], allowedTools: ["Read", "Grep", "Glob"], permissionMode: "dontAsk",
  outputFormat: { type: "json_schema", schema }, maxTurns: 5, maxBudgetUsd: 0.05,
  persistSession: false, settingSources: [], strictMcpConfig: true, env: cleanEnv({ CLAUDE_CONFIG_DIR }),
}})
```

**C · A CI gate.** `ci-kit/agent-review.mjs` runs as a GitHub Actions step would. The pipeline never parses prose. It
branches on `result.subtype` and `result.structured_output`:

```js
if (!result || result.subtype !== "success" || !result.structured_output) process.exit(2); // could not review ≠ pass
for (const f of report.findings) console.log(`::${f.severity} file=${f.file},line=${f.line},title=${f.title}::${f.detail}`);
appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
appendFileSync(process.env.GITHUB_OUTPUT, `verdict=${report.verdict}\n`);
process.exit(errors > 0 ? 1 : 0);
```

**D · Bounded runs.** Each limit ends cleanly, and one function turns the ending into an exit code:

```ts
function exitCodeFor(r, timedOut) {
  if (timedOut) return 124;                              // your AbortController fired
  if (!r || r.subtype !== "success") return 2;           // error_max_turns, error_max_budget_usd, …
  if (r.permission_denials.length) return 3;             // dontAsk denied something the job needed
  return 0;
}
```

**E · Deploy.** `ci-kit/worker.mjs` runs through its life cycle. Its stdout is JSON lines. The timeline shows `/healthz`
200, `/readyz` 200, a long job, then a second job → **429 Retry-After: 5**. Next comes SIGTERM (sent over IPC on
Windows) → `/readyz` **503**, a new job **503**. Then either the drain deadline arrives → `shutdown.abort` → the long
job's caller gets **503 "cancelled"** → exit **0**, or the long job finishes first → **200** → exit **0**.

**F · The kit.** The `ci-kit/` files, verbatim, ready to copy.

**G · A checklist** for unattended agents. **H · The code**, cut at the `#region` markers of the server route, the
gate and the worker.

## Using the kit for real

- **GitHub Actions:** copy `ci-kit/workflows/agent-review.yml` to `.github/workflows/` and `ci-kit/agent-review.mjs`
  into the repository. Add the `ANTHROPIC_API_KEY` repository secret. Pull requests from forks get no secrets, so the
  workflow skips them. `concurrency: cancel-in-progress` stops you paying twice for an outdated diff.
- **Container:** `docker build -f ci-kit/Dockerfile -t agent-worker .`, then
  `docker run --rm -p 8080:8080 -e ANTHROPIC_API_KEY --read-only --tmpfs /tmp agent-worker`. Keep `DRAIN_MS` plus
  a few seconds of abort teardown below the platform's grace period (Kubernetes' default is 30 s).

## How to run

```bash
npm install
npm run dev        # http://localhost:5173 → tab "49. Deploy & CI headless"
```

All the agents use Haiku 4.5. Each part costs about $0.02–0.03. If `ANTHROPIC_API_KEY` in `.env` is empty, the SDK
uses your Claude Code login instead.
