# Designing tools the model uses well

Lesson 54 extends custom tools (5), offline testing (51) and evals (52) with a practical tool-contract workshop.

Run `npm ci`, then `npm run dev` using Node 24 or newer. Open **Tools & extensions → 54. Designing tools the model uses well**. Sample54 uses backend port **3054**; Vite prints its available frontend port.

## Try the lesson

1. Inspect the vague `lookup` contract and the focused `catalog_search` / `catalog_get` contracts. Both read the same catalog. The focused descriptions explain purpose, boundaries, units and recovery.
2. Execute offline examples. Compare concise and detailed results, follow `nextCursor` with unchanged filters, and try invalid and missing product IDs. These call real handlers without a model or authentication.
3. Compare offline profiles. These are explicitly scripted demonstrations, not predicted model behavior. The vague lookup returns four camping records, including unavailable or over-budget products. Focused search returns the two qualifying records.
4. Optionally choose Live and click **Compare live (uses API)**. Each lane starts a fresh Claude Agent SDK session with the same prompt and model. Inspect actual handler calls, raw SDK messages and final answers.

Expected products are `SKU-101` (Trail mug, €18) and `SKU-104` (Trail blanket, €29). Check correctness against returned evidence; a successful SDK result alone does not prove task success.

## Design choices

The focused tools offer separate discovery and detail actions, stable product IDs, integer EUR-cent prices, enum categories, stock filtering, bounded page sizes, optional detailed responses, and recovery instructions. Empty searches succeed with no items; missing IDs return `isError: true`. Input validation runs before business logic. Offline validation error formatting can differ from live MCP validation.

Pagination uses a fixture-specific offset cursor. Keep filters unchanged between pages. A production service should bind opaque cursors to filters and a stable snapshot; concurrent catalog changes need stronger consistency. These tools only read an immutable fixture and perform no purchases or inventory updates. `readOnlyHint` describes behavior; it is not a permission mechanism.

Live runs use `claude-haiku-4-5-20251001`, no built-in tools, no project settings sources, strict MCP configuration, an explicit catalog tool allowlist, a deny callback for other tool requests, eight turns, a $0.25 budget and a 60-second host deadline per lane. Stop or leaving the lesson cancels the current request. Authentication and model API costs apply. The budget is an SDK stopping threshold, not a guarantee against a single call crossing that amount.

Reported bytes are UTF-8 bytes of serialized MCP handler results, including the content envelope; they are not token counts. Handler timing excludes model and transport latency. Schema-rejected live calls may never reach the handler, so the handler error metric does not capture every failed attempt. Inspect the SDK stream too. Live cost comes from the SDK result; interrupted runs may not report cost incurred before cancellation. Offline runs have no model answer or model cost. Compare repeated live trials and task correctness before declaring one design better.

## Verification

```powershell
npm run test:tool-design
npm run test:offline
npx tsc --noEmit
npx vite build
```

Tests cover filtering, pagination, evidence preservation, response size, validation, empty results, error recovery, HTTP validation and offline streams. They do not call a model, load `.env` or start Claude Code.

Implementation: `server/tool-design/catalog.ts`, `server/concepts/54-tool-design.ts`, and `src/concepts/Concept54ToolDesign.tsx`. The browser exposes backend source for inspection. Change one contract property, rerun representative tasks, and use lesson 52 for repeated correctness, latency and cost evals.

References: [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) and [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents).
