# Retrieval (RAG) through custom tools

Run `npm ci`, then `npm run dev` with Node 24 or newer. Open **Tools & extensions → 62. Retrieval (RAG) through custom tools**, or visit `?lesson=62`. Sample62 uses backend port **3062**; Vite uses **5173** or the next free port.

The Agent SDK does not require a special RAG option. Your application owns the knowledge index and exposes retrieval using `tool()` and `createSdkMcpServer()`. The agent decides which query to send, receives passages in tool results, and uses those passages to answer.

## The lab

The corpus contains fictional returns, shipping and account policies. Markdown headings define small, independently citable chunks with stable IDs such as `returns-v2#1`. There are also an obsolete policy, another tenant's private policy, and an imported note with hostile instructions.

1. **Corpus:** inspect all documents, including excluded ones. This inspection endpoint is teaching data only; do not expose a cross-tenant corpus inspector in a production app.
2. **Offline search:** inspect BM25-style lexical ranking and change the passage limit. Current-version and tenant filters run before ranking; neither filter is available as a model argument. All five regression exercises run without credentials.
3. **Live generation (billed):** ask a question, inspect custom tool events and raw SDK messages, and read the answer with citations. `search_knowledge` returns bounded passages; `get_passage` only reads IDs already retrieved in that run. Each query has its own server and evidence map.
4. **Source:** inspect the search schema, system prompt and implementation from the page.

## Retrieval versus generation

Retrieval uses case-normalized keyword tokens and BM25-style length/frequency scoring. Scores indicate relevance, not confidence. There are no embeddings, semantic paraphrase matching, stemming, external databases or network retrieval. Empty results indicate no keyword overlap, not proof that an answer does not exist. An agent can reformulate a query; the corpus may still lack the answer.

The offline checks expect a particular top source or no matches. The hostile note is intentionally retrievable: filtering by tenant and version does not make content trustworthy. The generation prompt treats passages as untrusted data and imported notes as non-authoritative. That instruction mitigates injection but is not a guaranteed defence; production systems should enforce trusted-source provenance and evaluate adversarial cases.

The agent returns `{ status, answer, citations: [{ sourceId, quote }] }`. The host validates the schema, requires citations for answers, rejects IDs not retrieved in this run, and checks that each quote occurs exactly in its source. An abstention has no citations. **These checks validate provenance, not meaning:** a misleading answer could cite a real quote. Evaluate claim support and completeness separately, using human review or an answer-faithfulness evaluator.

The live agent has no built-in tools, user/project settings or extra MCP servers. Only the two knowledge tools are allowed. It has a six-turn limit, a $0.10 SDK budget and a 90-second host deadline. Browser Stop or disconnect aborts the query. Live generation uses configured Anthropic credentials; offline exercises never call a model. Raw SDK messages may show an unvalidated candidate; the final answer card appears only after citation validation.

## Verification

`npm run test:retrieval` checks ranking, tenant isolation, version filtering, source IDs, limits, missing evidence, fabricated citations/quotes, the real in-memory MCP tool protocol and HTTP routes. `npm run typecheck` and `npm run build` verify integration. Offline regression checks do not measure the live model's answer quality.

Optional checks:

```powershell
# Offline UI check using installed Chrome; saves a screenshot under retrieval-lab/
node --import tsx server/retrieval/browser-smoke.mjs
# Billed: three live questions, each capped at $0.10
node --env-file-if-exists=.env --import tsx server/retrieval/live-check.ts
```

Validation during implementation: all 136 offline tests passed, along with TypeScript, the production build and the Chrome check (desktop interactions and mobile width). Three live Haiku runs returned the 30-day policy with a verified quote, abstained on missing lunar-rover warranty evidence, and rejected the hostile note's unlimited-refund claim after searching official policy. Their combined reported SDK cost was about $0.0222. These are individual smoke checks, not a statistical answer-quality evaluation or an injection-resistance guarantee.

For a larger system, replace `search()` with vector or hybrid retrieval. Preserve access checks before top-k selection, document versions, bounded payloads, source metadata and per-run evidence tracking. Index updates should retain stable IDs for unchanged chunks and retire outdated versions. Tune chunk size and top-k against retrieval recall, then evaluate answer faithfulness separately.

Implementation: `server/retrieval/{corpus,retrieval}.ts`, `server/concepts/62-retrieval-rag.ts`, `src/concepts/Concept62RetrievalRag.tsx`.

Reference: [Agent SDK custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools).
