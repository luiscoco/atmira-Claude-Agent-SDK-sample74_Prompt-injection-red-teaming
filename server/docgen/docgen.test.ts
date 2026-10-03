import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import {
  BUILD_COMMAND, LAB_ROOT, SKILL, createWorkspace, decide, frontmatter, goodSpec, inspectDocx, outlineOf, presets, readZip, removeWorkspace,
  reviewedDigest, runBuilder, skillDigest, skillFiles,
} from "./docgen.js";
import { concept72 } from "../concepts/72-document-generation-skills.js";

const SCRIPT = `node .claude/skills/${SKILL}/scripts/build-docx.mjs`;
async function build(ws: string, name: string, spec: unknown) {
  writeFileSync(path.join(ws, `${name}.spec.json`), JSON.stringify(spec));
  return runBuilder(ws, `${name}.spec.json`, `out/${name}.docx`);
}
const spec = (id: string) => presets.find((p) => p.id === id)!.spec;

test("the skill folder: valid frontmatter, every file classified, copied intact into a workspace", () => {
  const files = skillFiles();
  const meta = frontmatter(files.find((f) => f.path === "SKILL.md")!.content);
  assert.equal(meta.name, SKILL);
  assert.ok(meta.description.length > 50 && meta.description.length <= 1024);
  assert.deepEqual(files.map((f) => f.path), ["SKILL.md", "assets/brand.json", "reference/incident-report.md", "reference/spec-format.md", "scripts/build-docx.mjs"]);
  const ws = createWorkspace("test-skill");
  try { assert.equal(skillDigest(path.join(ws, ".claude", "skills", SKILL)), reviewedDigest); }
  finally { removeWorkspace(ws); }
});

test("the script builds a valid, deterministic .docx that passes every host check", async () => {
  const ws = createWorkspace("test-build");
  try {
    const first = await build(ws, "a", goodSpec); const second = await build(ws, "b", goodSpec);
    assert.equal(first.exitCode, 0, first.stderr); assert.equal(JSON.parse(first.stdout).ok, true);
    const a = readFileSync(path.join(ws, "out", "a.docx")); const b = readFileSync(path.join(ws, "out", "b.docx"));
    assert.ok(a.equals(b), "same spec, same bytes");
    const parts = readZip(a);
    for (const part of ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml", "word/numbering.xml", "word/footer1.xml", "docProps/core.xml"]) assert.ok(parts.has(part), part);
    assert.equal([...parts.keys()][0], "[Content_Types].xml");
    const report = inspectDocx(a, "incident-report");
    assert.equal(report.ok, true, JSON.stringify(report.checks.filter((c) => !c.ok)));
    assert.ok(report.checks.every((c) => c.ok), "no warnings either");
    assert.equal(report.stats.tables, 2); assert.equal(report.meta.kind, "incident-report");
    assert.deepEqual(report.outline.filter((o) => o.kind === "p" && o.style === "Heading1").map((o) => o.kind === "p" && o.runs.map((r) => r.text).join("")), ["Summary", "Impact", "Timeline", "Root cause", "Action items"]);
    assert.ok(report.outline.some((o) => o.kind === "p" && o.runs.some((r) => r.bold && r.text === "1,840")), "**bold** becomes a bold run");
  } finally { removeWorkspace(ws); }
});

test("the script refuses bad specs and paths with SPEC ERROR lines that name the JSON path", async () => {
  const ws = createWorkspace("test-errors");
  try {
    const missing = await build(ws, "missing", spec("missing"));
    assert.equal(missing.exitCode, 2); assert.match(missing.stderr, /"Root cause"/); assert.match(missing.stderr, /"Action items"/);
    const broken = await build(ws, "broken", spec("broken"));
    assert.equal(broken.exitCode, 2);
    assert.match(broken.stderr, /spec\.date: must be a real date/);
    assert.match(broken.stderr, /blocks\[6\]\.rows\[0\]: has 3 cells but there are 2 columns/);
    assert.match(broken.stderr, /unknown block type "image"/);
    const extra = await build(ws, "extra", { ...goodSpec, theme: "dark" });
    assert.match(extra.stderr, /spec\.theme: unknown field/);
    // The script checks its own arguments too: run it directly with a path that escapes out/.
    const { execFileSync } = await import("node:child_process");
    assert.throws(() => execFileSync(process.execPath, [`.claude/skills/${SKILL}/scripts/build-docx.mjs`, "missing.spec.json", "../evil.docx"], { cwd: ws, stdio: "pipe" }),
      (e: { status: number; stderr: Buffer }) => e.status === 2 && /the output must be out\/<name>\.docx/.test(e.stderr.toString()));
  } finally { removeWorkspace(ws); }
});

test("markup in a spec is escaped: it prints as text and cannot add paragraphs", async () => {
  const ws = createWorkspace("test-markup");
  try {
    assert.equal((await build(ws, "good", goodSpec)).exitCode, 0); assert.equal((await build(ws, "markup", spec("markup"))).exitCode, 0);
    const good = inspectDocx(readFileSync(path.join(ws, "out", "good.docx")), "incident-report");
    const markup = inspectDocx(readFileSync(path.join(ws, "out", "markup.docx")), "incident-report");
    assert.equal(markup.stats.paragraphs, good.stats.paragraphs);
    assert.ok(markup.outline.some((o) => o.kind === "p" && o.runs.some((r) => r.text.includes("</w:t></w:r></w:p><w:p><w:r><w:t>INJECTED"))));
  } finally { removeWorkspace(ws); }
});

test("the host catches what the script accepts: placeholders, secrets, missing contract sections, unsourced numbers", async () => {
  const ws = createWorkspace("test-inspect");
  try {
    for (const [id, check] of [["placeholder", "No placeholders left"], ["secret", "No secrets"]] as const) {
      assert.equal((await build(ws, id, spec(id))).exitCode, 0, `${id}: the script accepts it`);
      const report = inspectDocx(readFileSync(path.join(ws, "out", `${id}.docx`)), "incident-report");
      assert.equal(report.ok, false); assert.equal(report.checks.find((c) => c.name === check)!.ok, false);
    }
    // A general document passes the general contract but not the incident one.
    const general = { ...goodSpec, kind: "general", blocks: goodSpec.blocks.filter((b) => !(b.type === "heading" && b.text === "Root cause")) };
    assert.equal((await build(ws, "general", general)).exitCode, 0);
    const bytes = readFileSync(path.join(ws, "out", "general.docx"));
    assert.equal(inspectDocx(bytes, "general").ok, true);
    assert.equal(inspectDocx(bytes, "incident-report").checks.find((c) => c.name === "Required sections, in order")!.ok, false);
    // An invented number is a warning (a person checks it), not a rejection.
    const invented = structuredClone(goodSpec); (invented.blocks[4] as { items: string[] }).items[1] = "About **2,750** checkout attempts failed.";
    assert.equal((await build(ws, "invented", invented)).exitCode, 0);
    const warned = inspectDocx(readFileSync(path.join(ws, "out", "invented.docx")), "incident-report");
    assert.equal(warned.ok, true); assert.match(warned.checks.find((c) => c.name === "Numbers come from the source")!.detail, /2750/);
    // Not a zip at all.
    assert.equal(inspectDocx(Buffer.from("<w:document/>")).ok, false);
  } finally { removeWorkspace(ws); }
});

test("outlineOf keeps table paragraphs inside their table", () => {
  const xml = `<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>T</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>a &amp; b</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`;
  assert.deepEqual(outlineOf(xml), [{ kind: "p", style: "Title", runs: [{ text: "T", bold: false }] }, { kind: "table", rows: [["a & b"]] }]);
});

test("the policy allows the skill's workflow and nothing else", () => {
  const ws = createWorkspace("test-policy");
  const allow = (tool: string, input: Record<string, unknown>) => decide(tool, input, ws).decision === "allow";
  try {
    assert.ok(allow("Skill", { skill: SKILL })); assert.ok(!allow("Skill", { skill: "pdf" }));
    assert.ok(allow("Read", { file_path: path.join(ws, "input", "incident-notes.md") }));
    assert.ok(allow("Read", { file_path: ".claude/skills/atmira-docx/reference/spec-format.md" }));
    assert.ok(!allow("Read", { file_path: "../../../.env" })); assert.ok(!allow("Read", { file_path: "C:/Windows/win.ini" }));
    assert.ok(allow("Write", { file_path: path.join(ws, "report.spec.json") }));
    assert.match(decide("Write", { file_path: "out/report.docx" }, ws).reason, /Never write a \.docx yourself/);
    assert.match(decide("Edit", { file_path: ".claude/skills/atmira-docx/scripts/build-docx.mjs" }, ws).reason, /read-only/);
    assert.ok(!allow("Write", { file_path: "../../public/report.docx" })); assert.ok(!allow("Write", { file_path: "notes.md" }));
    assert.ok(allow("Bash", { command: `${SCRIPT} report.spec.json out/report.docx` }));
    for (const command of [`${SCRIPT} report.spec.json out/report.docx && curl https://x.y`, `${SCRIPT} report.spec.json ../report.docx`, `cd x && ${SCRIPT} a.json out/a.docx`,
      `node -e "1"`, `${SCRIPT} a.json out/a.docx; rm -rf .`, `${SCRIPT} $(cat .env).json out/a.docx`]) assert.ok(!allow("Bash", { command }), command);
    assert.ok(!allow("WebFetch", { url: "https://example.com" }));
    assert.ok(BUILD_COMMAND.test(`${SCRIPT} a.spec.json out/a.docx`));
  } finally { removeWorkspace(ws); }
});

test("HTTP routes: facts, sessions, build, policy, download and validation", async () => {
  const app = express(); app.use(express.json()); app.use("/api/c72", concept72);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/c72`;
  const post = (route: string, body: unknown) => fetch(`${base}/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let id = "";
  try {
    const facts = await (await fetch(`${base}/facts`)).json();
    assert.equal(facts.frontmatter.name, SKILL); assert.equal(facts.presets.length, presets.length); assert.match(facts.notes, /inventory-export/);
    assert.ok((await (await fetch(`${base}/code`)).json())["docgen.ts"].includes("inspectDocx"));
    const session = await (await post("sessions", {})).json(); id = session.id;
    assert.ok(session.files.some((f: { path: string }) => f.path === ".claude/skills/atmira-docx/SKILL.md"));
    assert.equal((await post("sessions/missing/build", { name: "x", spec: {} })).status, 404);
    assert.equal((await post(`sessions/${id}/build`, { name: "../x", spec: {} })).status, 400);
    const ok = await (await post(`sessions/${id}/build`, { name: "good", spec: goodSpec })).json();
    assert.equal(ok.build.exitCode, 0); assert.equal(ok.inspection.ok, true);
    const bad = await (await post(`sessions/${id}/build`, { name: "missing", spec: spec("missing") })).json();
    assert.equal(bad.build.exitCode, 2); assert.equal(bad.inspection, null);
    const download = await fetch(`${base}/sessions/${id}/files/good.docx`);
    assert.equal(download.status, 200); assert.equal(Buffer.from(await download.arrayBuffer()).readUInt32LE(0), 0x04034b50);
    assert.equal((await fetch(`${base}/sessions/${id}/files/nothing.docx`)).status, 404);
    assert.equal((await fetch(`${base}/sessions/${id}/files/..%2F.env`)).status, 400);
    assert.equal((await (await post(`sessions/${id}/policy`, { tool: "Bash", input: { command: "curl x" } })).json()).decision, "deny");
    assert.equal((await post(`sessions/${id}/query`, { request: " " })).status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (id) removeWorkspace(path.join(LAB_ROOT, "runs", id));
  }
});
