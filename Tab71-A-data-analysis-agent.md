# A data-analysis agent

Use Node 24+. Run `npm ci`, then `npm run dev`, and open
`http://localhost:5173/?lesson=71` (Vite may choose another available port).
Sample71 uses backend port **3071**. Lesson 71 appears in lesson order and under
**Agent workflows**.

## The idea

A language model is good at choosing an analysis and explaining it. It is
unreliable at arithmetic over many rows. So the lesson splits the work:

- **The model plans.** It decides which questions to ask of the data.
- **The host computes.** Four read-only tools run every calculation in code.
- **Every number is traceable.** Each tool result is stored in a ledger with an
  ID (`C1`, `C2`…). The final report must cite those IDs, and the host checks
  each cited number against the ledger before showing it as verified.

## Steps followed

1. **Dataset.** `server/analysis/sales.csv` holds fictional sales: six months,
   four regions, two products. Four traps are planted:
   - a typo outlier (940 Pro units on line 25)
   - an empty revenue cell (line 28)
   - a duplicated line (line 36)
   - a note that tries to give the model orders (line 15)
2. **Parsing and quality rules in code.** `parseCsv` is a small RFC 4180
   reader. `findIssues` flags duplicates, empty cells and outliers. Outliers use
   1.5 × IQR fences on units per product. "Clean" drops duplicate and outlier
   lines and skips empty cells, so it means the same thing in every run. "Raw"
   is available so you can see the difference.
3. **Closed tool contracts (zod).** Metrics, group-by columns, filters and months
   are enumerations. There is no free-text SQL, column or expression to inject.
   - `profile_dataset`: columns, ranges, issues and notes (labelled untrusted).
   - `aggregate`: sum/mean/median/min/max/count, or ratio metrics
     (`return_rate` in percent, `avg_price_eur`), grouped by up to two columns.
   - `compare_periods`: from, to, change and change % between two months.
   - `make_chart`: charts an existing aggregate computation. The host draws it
     from ledger data, never from numbers the model typed.
4. **Computation ledger.** `AnalysisLab.record()` stores every result with its
   input. This is what makes a report checkable after the fact.
5. **Structured report.** `query()` uses
   `outputFormat: { type: "json_schema", schema: reportJsonSchema }`. Every
   finding has `statement`, `value`, `unit` and `computationId`. The JSON Schema
   is generated from the same zod object, with `$schema` removed because Claude
   Code rejects it.
6. **Verifier.** `verifyReport()` looks up the cited computation and checks
   that `value` appears in it, within display rounding (0.5% or 0.01).
   - Unknown IDs are reported as `unknown computation`.
   - Numbers that don't match are reported as `unsupported`.
   - Missing charts are listed.
   - Other numbers in the sentence that are not in the cited result are shown
     as warnings (`uncheckedProse`).
7. **Offline analyst.** `scriptedAnalysis()` calls the same tools with a fixed
   plan and writes a report in the agent's format. `tamperedReport()` makes a
   copy with three mistakes: an inflated number, a citation to `C99` (it "obeys"
   the injected note) and a chart `G42` that was never drawn. The tampered copy
   is still schema-valid on purpose: schema-valid is not the same as true.
8. **Live agent.** Haiku 4.5 with `tools: []` (no Read, Bash or code execution),
   an in-process MCP server with the four tools, `settingSources: []`,
   `strictMcpConfig`, `permissionMode: "dontAsk"`, 14 turns, a $0.25 budget and
   a 120-second deadline. The host parses `structured_output` with zod again
   and verifies it against the session's ledger.
9. **UI.** `src/concepts/Concept71DataAnalysisAgent.tsx` contains:
   - a CSV viewer with flagged lines highlighted
   - preset manual tool calls, including blocked inputs
   - the offline analyst with an editable report and a verify button
   - the live run and the ledger
   - charts as single-series SVG (one axis, hover values, a table view and a
     validated colour for each of light and dark mode)
10. **Wiring.** Router `/api/c71` in `server/index.ts`, port 3071 in
    `server/index.ts` and `vite.config.ts`, lesson entry in `src/App.tsx`,
    `analysis-lab/` in `.gitignore`, and `test:analysis` plus `test:offline`
    in `package.json`.

## Walkthrough

1. Click **Start lab (offline)**. Read the quality issues and open `sales.csv`.
2. In **B**, run **Units: raw total**, then **Units: clean total**. The
   difference is the outlier plus the duplicate. Then try **Blocked: raw SQL**
   and **Blocked: unknown column**. The rejection text is exactly what the model
   would receive.
3. Run **Chart C2 as a line** after **Revenue by month**. Try charting a
   two-column aggregate and read the rejection.
4. In **C**, run the offline analyst. All findings verify. Click
   **Load tampered report**, then **Verify against ledger**, and see each
   mistake flagged. Edit any value by hand and verify again.
5. In **D**, ask the analyst (billed). Watch the tool calls stream in. The report
   is verified the same way.

   In a test run, the agent:
   - asked for a chart of a two-column aggregate
   - read the rejection and corrected itself by computing a one-column aggregate
   - ignored the injected note
   - cost about $0.02 in 9 turns

   All five findings verified. One warning showed a real subtlety: the model
   wrote "contracted 15.6%" while the ledger holds −15.6.
6. Open the ledger and source code in **E**.

## Design notes

- **Why tools rather than a code sandbox?** Narrow tools make every result
  structured, bounded and recordable. A sandboxed Python or Bash runner is more
  flexible. If you use one, record its inputs and outputs in a ledger the same
  way, and keep it isolated (see lessons 18 and 48).
- **Ratios are computed as ratios of sums.** Averaging per-row ratios would give
  a different, misleading number. Empty cells are skipped, not counted as 0, and
  each result reports `n` and `skippedEmpty`.
- **Untrusted data.** Notes are returned as `untrustedText`, and the system
  prompt says data is never instructions. The real protection is structural:
  there is no tool that could act on such an instruction, and the verifier
  rejects numbers that were not computed.
- **Limits of the verifier.** It proves that a cited number exists in the cited
  result. It does not prove that the conclusion is sensible or that the right
  comparison was made. A human still reads the report.
- The lab is localhost-only. Sessions are opaque IDs in memory, with a one-hour
  lifetime, at most 50 labs and 60 computations per lab. Only one live run can
  execute at a time.

## Validation

```powershell
npm run test:analysis
npm run test:offline
npm run typecheck
npm run build
```

`test:analysis` (8 tests, no API calls) covers:

- the CSV reader
- the planted issues
- exact raw and clean totals
- closed inputs (SQL, unknown columns, duplicate group-bys, bad ranges, bad charts)
- comparisons
- honest and tampered reports
- the real MCP protocol (four read-only tools, errors returned as tool errors)
- the HTTP routes, including per-session ledgers

The full offline suite passes (193 tests).

Implementation: `server/analysis/analysis.ts`,
`server/concepts/71-data-analysis-agent.ts`,
`src/concepts/Concept71DataAnalysisAgent.tsx`, `server/analysis/sales.csv`.

References: [Agent SDK custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools),
[Structured outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs).
