import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import type { Server } from "node:http";
import { git, offlineWorker, runWorkshop, type Worker } from "./workshop.js";
import { concept57 } from "../concepts/57-parallel-worktrees.js";

const root = path.resolve("worktrees-lab", "tests");
test("real parallel workers share a base, validate, integrate and clean their checkouts", async () => {
  let started = 0; let release!: () => void;
  const bothStarted = new Promise<void>((resolve) => { release = resolve; });
  const worker: Worker = async (assignment, signal) => {
    started++; if (started === 2) release();
    await bothStarted; await offlineWorker(assignment, signal);
  };
  const report = await runWorkshop({ root, scenario: "independent", worker });
  assert.equal(report.status, "success", report.error ?? "Expected a successful run");
  assert.equal(started, 2); assert.equal(report.cleaned, true);
  assert.equal(report.integrated.length, 2);
  const repo = path.join(report.run, "repo");
  for (const worker of report.workers) {
    assert.equal(await git(repo, "rev-parse", `${worker.commit}^`), report.base);
    assert.equal(worker.status, "validated"); assert.match(worker.diff!, /\+export const/);
  }
  assert.equal(await git(repo, "status", "--porcelain"), "");
  assert.equal(report.worktrees.match(/^worktree /gm)?.length, 1);
  assert.match(report.tests, /# pass 2/);
  assert.equal(JSON.parse(await readFile(path.join(report.run, "report.json"), "utf8")).status, "success");
});
test("overlapping edits conflict; abort retains first integration and both worker branches", async () => {
  const report = await runWorkshop({ root, scenario: "conflict" });
  assert.equal(report.status, "conflict", report.error ?? "Expected an integration conflict");
  assert.equal(report.cleaned, false); assert.equal(report.integrated.length, 1);
  assert.equal(report.worktrees.match(/^worktree /gm)?.length, 3);
  const repo = path.join(report.run, "repo");
  assert.equal(await git(repo, "status", "--porcelain"), "");
  assert.match(await readFile(path.join(repo, "greeting.mjs"), "utf8"), /Hello/);
  assert.match(await readFile(path.join(report.run, "tax", "greeting.mjs"), "utf8"), /Hi/);
  assert.equal(report.tests, "Not run");
});
test("worker failure waits for its peer and prevents all integration", async () => {
  let peerSettled = false;
  const worker: Worker = async (assignment, signal) => {
    if (assignment.id === "greeting") throw new Error("Synthetic worker failure");
    await offlineWorker(assignment, signal); peerSettled = true;
  };
  const report = await runWorkshop({ root, scenario: "independent", worker });
  assert.equal(peerSettled, true); assert.equal(report.status, "failed");
  assert.equal(report.integrated.length, 0); assert.equal(report.cleaned, false);
  assert.equal(await git(path.join(report.run, "repo"), "rev-parse", "HEAD"), report.base);
});
test("untracked files outside the assignment fail ownership and are preserved", async () => {
  const report = await runWorkshop({ root, scenario: "independent", worker: async (assignment, signal) => {
    await offlineWorker(assignment, signal);
    await writeFile(path.join(assignment.cwd, "extra.txt"), "Retain me");
  } });
  assert.equal(report.status, "failed"); assert.equal(report.integrated.length, 0);
  assert.match(report.workers[0].error!, /outside its assignment/);
  assert.equal(await readFile(path.join(report.run, "greeting", "extra.txt"), "utf8"), "Retain me");
});
test("behavior validation rejects incorrect worker output", async () => {
  const report = await runWorkshop({ root, scenario: "independent", worker: async (assignment) => {
    await writeFile(path.join(assignment.cwd, assignment.file), "export const greeting = () => 'Wrong';\nexport const tax = () => 0;\n");
  } });
  assert.equal(report.status, "failed"); assert.ok(report.workers.every((worker) => worker.status === "failed"));
  assert.equal(report.integrated.length, 0);
});
test("cancellation stops the coordinator and retains settled worker changes", async () => {
  const controller = new AbortController();
  const report = await runWorkshop({ root, scenario: "independent", signal: controller.signal, worker: async (assignment, signal) => {
    await offlineWorker(assignment, signal); controller.abort();
  } });
  assert.equal(report.status, "failed"); assert.equal(report.cleaned, false);
  assert.equal(report.integrated.length, 0); assert.match(report.error!, /Abort/);
  assert.equal(report.worktrees.match(/^worktree /gm)?.length, 3);
});
test("a dirty integration checkout prevents integration without discarding changes", async () => {
  const report = await runWorkshop({ root, scenario: "independent", worker: async (assignment, signal) => {
    await offlineWorker(assignment, signal);
    if (assignment.id === "greeting") await writeFile(path.join(path.dirname(assignment.cwd), "repo", "note.txt"), "Concurrent edit");
  } });
  assert.equal(report.status, "failed"); assert.match(report.error!, /checkout changed/);
  assert.equal(report.integrated.length, 0);
  assert.equal(await readFile(path.join(report.run, "repo", "note.txt"), "utf8"), "Concurrent edit");
});
test("individual checks can pass while combined behavior fails; retain test evidence and worktrees", async () => {
  const report = await runWorkshop({ root, scenario: "independent", worker: async (assignment, signal) => {
    if (assignment.id === "greeting") {
      await writeFile(path.join(assignment.cwd, assignment.file), 'import { tax } from "./tax.mjs";\nexport const greeting = () => tax(100) === 0 ? "Hello" : "Wrong";\n');
    } else await offlineWorker(assignment, signal);
  } });
  assert.equal(report.status, "failed"); assert.equal(report.cleaned, false);
  assert.equal(report.integrated.length, 2);
  assert.ok(report.workers.every((worker) => worker.status === "validated"));
  assert.match(report.tests, /not ok 1/);
  assert.equal(report.worktrees.match(/^worktree /gm)?.length, 3);
});

let server: Server; let url: string;
before(async () => {
  await mkdir(root, { recursive: true });
  const app = express(); app.use(express.json()); app.use("/api/c57", concept57);
  server = await new Promise<Server>((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  url = `http://127.0.0.1:${address.port}/api/c57`;
});
after(async () => { if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });
const post = (body: unknown) => fetch(`${url}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
test("HTTP rejects arbitrary paths, modes, scenarios and malformed input", async () => {
  for (const body of [{}, { mode: "offline", scenario: "unknown" }, { mode: "shell", scenario: "independent" }, { mode: "offline", scenario: "independent", root: "C:/" }]) assert.equal((await post(body)).status, 400);
});
test("HTTP source and offline SSE report are available without model calls", async () => {
  const source = await (await fetch(`${url}/code`)).json(); assert.match(source["workshop.ts"], /Promise.allSettled/);
  const response = await post({ mode: "offline", scenario: "independent" });
  assert.equal(response.status, 200); assert.match(response.headers.get("content-type")!, /text\/event-stream/);
  assert.equal((await post({ mode: "offline", scenario: "independent" })).status, 409);
  const body = await response.text(); assert.match(body, /event: progress/); assert.match(body, /event: done/);
  const chunk = body.split("\n\n").find((chunk) => chunk.startsWith("event: report")); assert.ok(chunk);
  assert.equal(JSON.parse(chunk.split("\ndata: ")[1]).status, "success");
});
