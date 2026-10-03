# Upgrading the SDK safely

Run `npm ci`, then `npm run dev` with Node 24 or newer. Open **Production & deployment → 55. Upgrading the SDK safely**, or use `?lesson=55`. Sample55's backend uses **3055**; Vite selects an available frontend port.

The primary SDK is now pinned to **0.3.281**, the version already in the lockfile. This lesson does not upgrade it to another release. The historical `claude-agent-sdk-v2` alias remains separately pinned to **0.2.141** for lesson 41.

## Try the workshop

1. Inspect declared, locked and installed package versions, runtime platform, lockfile SHA-256 and installed public exports. The probe imports the SDK without calling `query()` or starting Claude.
2. Run the compatible scenario. Inspect four gates: exports, stream/task evidence, permission boundaries, and eval thresholds. An unknown additive event is recorded without breaking the stream adapter.
3. Try removed exports, a renamed result field, permission drift, quality/cost/latency regression and missing evidence. Each blocks simulated promotion and shows a recovery path.
4. Return to the compatible scenario, run gates, start a simulated canary, promote and roll back. Rollback is also available directly from canary. Selecting another scenario resets browser state.

All candidate records and eval measurements are **synthetic fixtures**, not real release behavior or benchmark results. These fixtures execute the application's adapter and gate evaluator. No model calls, package installations or deployments occur through lesson endpoints. The transition endpoint is stateless: it validates a submitted exercise state and recomputes scenario eligibility; it is not a deployment authorization service.

Eval thresholds allow a correctness drop of at most **0.02 absolute** (two percentage points), cost growth of at most **20%**, and latency growth of at most **25%**. Missing or invalid evidence fails. A passing fixture is only permission to continue the simulation, not proof that an SDK release is safe.

## Real upgrade procedure

Save a known-good artifact, manifest, lockfile, configuration and eval baseline. In an isolated checkout install a reviewed exact candidate with `npm install --save-exact @anthropic-ai/claude-agent-sdk@<candidate-version>`. Review intervening release notes, runtime and peer dependency changes and the lock diff. Commit both package files together.

Run clean installation, type checks, offline tests and build. Test real candidate behavior for MCP tools, hooks, denied actions, streaming, cancellation and session resumption. Use lesson 52 for repeated live evals with the same model, prompts, tools, dataset and environment; use lesson 53 for raw diagnostic evidence. Fixtures cannot test the bundled Claude process or remote model behavior.

Canary the retained candidate artifact with representative traffic and explicit observation and stop thresholds. Promote only after reviewing those measurements. Roll back by redeploying the prior artifact; for local dependencies restore both prior package files and run `npm ci`. Newer session transcripts and data migrations may be incompatible with older runtimes: retain snapshots and test recovery before rollout.

Exact pins and lockfiles reproduce dependencies, not external model behavior or settings. Explicitly select `systemPrompt` and `settingSources` where isolation matters and verify the selected release. The official migration guide documents historical changes and current settings behavior; consult it alongside release-specific notes rather than assuming old migration advice still applies.

## Verification

```powershell
npm run test:upgrading
npm run test:offline
npm run typecheck
npm run build
```

Tests cover all candidate drills, stream forward compatibility, missing/error results, threshold boundaries, invalid metrics, installed SDK metadata/exports, promotion ordering, rollback and HTTP validation. No `.env`, model calls or Claude process are required.

Implementation: `server/upgrading/workshop.ts`, `server/concepts/55-upgrading-sdk.ts`, `src/concepts/Concept55UpgradingSdk.tsx`.

References: [official SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md), [official migration guide](https://code.claude.com/docs/en/agent-sdk/migration-guide).
