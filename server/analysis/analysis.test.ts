import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AnalysisLab, ReportSchema, makeAnalysisServer, parseCsv, reportJsonSchema, scriptedAnalysis, tamperedReport, verifyReport } from "./analysis.js";
import { concept71 } from "../concepts/71-data-analysis-agent.js";

test("CSV reader handles quoted commas, doubled quotes and CRLF", () => {
  assert.deepEqual(parseCsv('a,b\r\n1,"x, ""y"""\r\n'), [["a", "b"], ["1", 'x, "y"']]);
});

test("quality rules find the planted duplicate, empty cell and outlier", () => {
  const lab = new AnalysisLab();
  assert.equal(lab.rows.length, 49);
  assert.deepEqual(lab.issues.map((issue) => [issue.row, issue.kind]), [[25, "outlier"], [28, "missing"], [36, "duplicate"]]);
});

test("aggregates are exact, and clean differs from raw by the dropped lines", () => {
  const lab = new AnalysisLab();
  const total = (quality: "raw" | "clean") => lab.aggregate({ metric: "units", quality }).rows[0].value;
  const rawSum = lab.rows.reduce((sum, row) => sum + (row.units ?? 0), 0);
  assert.equal(total("raw"), rawSum);
  const dropped = lab.rows.filter((row) => row.row === 25 || row.row === 36).reduce((sum, row) => sum + row.units!, 0);
  assert.equal(total("clean"), rawSum - dropped);
  const byMonth = lab.aggregate({ metric: "revenue_eur", by: ["order_month"], agg: "count" });
  assert.equal(byMonth.rows.length, 6);
  assert.equal(byMonth.rows[3].value, 7); // April: the empty revenue cell is skipped, not counted as 0
  const rate = lab.aggregate({ metric: "return_rate", by: ["product"] });
  assert.ok(rate.rows.find((row) => row.group.product === "Pro")!.value! > rate.rows.find((row) => row.group.product === "Basic")!.value!);
  assert.deepEqual(lab.computations.map((c) => c.id), ["C1", "C2", "C3", "C4"]);
});

test("tool inputs are closed: no SQL, no unknown columns, no bad charts", () => {
  const lab = new AnalysisLab();
  for (const input of [{ sql: "SELECT 1" }, { metric: "profit" }, { metric: "units", by: ["customer"] }, { metric: "units", by: ["region", "region"] },
    { metric: "units", filter: { region: "Mars" } }, { metric: "units", filter: { from: "2026-06", to: "2026-01" } }]) assert.throws(() => lab.aggregate(input));
  assert.throws(() => lab.compare({ metric: "revenue_eur", from: "2026-06", to: "2026-01" }));
  assert.throws(() => lab.chart({ computationId: "C1", kind: "bar", title: "x" }), /not an aggregate/);
  lab.aggregate({ metric: "units", by: ["region"] });
  assert.throws(() => lab.chart({ computationId: "C1", kind: "line", title: "x" }), /order_month/);
  assert.equal(lab.chart({ computationId: "C1", kind: "bar", title: "Units by region" }).chartId, "G1");
  assert.equal(lab.charts[0].points.length, 4);
});

test("compare_periods records one computation with correct changes", () => {
  const lab = new AnalysisLab();
  const result = lab.compare({ metric: "revenue_eur", from: "2026-01", to: "2026-06", by: "region" });
  assert.equal(result.computationId, "C1"); assert.equal(lab.computations.length, 1);
  for (const row of result.rows) assert.equal(row.change, row.to - row.from!);
});

test("the honest report verifies; the tampered one is caught on every planted mistake", () => {
  const lab = new AnalysisLab(); const report = scriptedAnalysis(lab);
  assert.ok(ReportSchema.safeParse(report).success);
  const good = verifyReport(report, lab);
  assert.equal(good.ok, true); assert.ok(good.findings.every((item) => item.uncheckedProse.length === 0));
  const tampered = tamperedReport(report);
  assert.ok(ReportSchema.safeParse(tampered).success, "schema-valid on purpose");
  const bad = verifyReport(tampered, lab);
  assert.equal(bad.ok, false);
  assert.equal(bad.findings[0].verdict, "unsupported"); assert.deepEqual(bad.findings[0].uncheckedProse, [tampered.findings[0].value]);
  assert.equal(bad.findings.at(-1)!.verdict, "unknown computation");
  assert.deepEqual(bad.charts.filter((c) => !c.exists).map((c) => c.id), ["G42"]);
  // A right number cited from the wrong computation is also unsupported.
  assert.equal(verifyReport({ ...report, findings: [{ ...report.findings[0], computationId: "C1" }] }, lab).findings[0].verdict, "unsupported");
  assert.equal("$schema" in reportJsonSchema, false);
});

test("MCP exposes exactly the four read-only analysis tools and returns errors as tool errors", async () => {
  const lab = new AnalysisLab(); const server = makeAnalysisServer(lab, () => {});
  const client = new Client({ name: "analysis-test", version: "1" }); const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.instance.connect(a); await client.connect(b);
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map((t) => t.name), ["profile_dataset", "aggregate", "compare_periods", "make_chart"]);
    assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
    assert.equal((await client.callTool({ name: "aggregate", arguments: { metric: "profit" } })).isError, true);
    const ok = await client.callTool({ name: "aggregate", arguments: { metric: "units" } });
    assert.equal(ok.isError, undefined);
    assert.match((ok.content as { text: string }[])[0].text, /"computationId":"C1"/);
  } finally { await client.close(); await server.instance.close(); }
});

test("HTTP routes: sessions, manual tools, offline analyst, verify and input validation", async () => {
  const app = express(); app.use(express.json()); app.use("/api/c71", concept71);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/c71`;
  const post = (route: string, body: unknown) => fetch(`${base}/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const facts = await (await fetch(`${base}/facts`)).json(); assert.match(facts.csv, /^order_month,/);
    assert.ok((await (await fetch(`${base}/code`)).json())["analysis.ts"].includes("verifyReport"));
    const a = await (await post("sessions", {})).json(); const b = await (await post("sessions", {})).json();
    assert.equal(a.issues.length, 3);
    assert.equal((await post("sessions/missing/tool", { name: "profile_dataset", input: {} })).status, 404);
    assert.equal((await post(`sessions/${a.id}/tool`, { name: "run_sql", input: {} })).status, 400);
    const blocked = await (await post(`sessions/${a.id}/tool`, { name: "aggregate", input: { sql: "DROP TABLE sales" } })).json();
    assert.equal(blocked.ok, false); assert.match(blocked.message, /Invalid input/);
    const scripted = await (await post(`sessions/${a.id}/scripted`, {})).json();
    assert.equal(scripted.verification.ok, true); assert.equal(scripted.charts.length, 2);
    const tampered = await (await post(`sessions/${a.id}/verify`, { report: scripted.tampered })).json();
    assert.equal(tampered.ok, true); assert.equal(tampered.verification.ok, false);
    // Ledgers are per session: lab b never computed C2.
    assert.equal((await (await post(`sessions/${b.id}/verify`, { report: scripted.report })).json()).verification.ok, false);
    assert.equal((await (await post(`sessions/${a.id}/verify`, { report: { headline: "x" } })).json()).ok, false);
    assert.equal((await post(`sessions/${a.id}/query`, { question: " " })).status, 400);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
