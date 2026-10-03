import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import { callCost, grade, models, needsEscalation, normalize, project, ruleRoute, strategies, taskById, tasks } from "./workshop.js";
import { concept59 } from "../concepts/59-model-routing.js";

test("the task set has unique ids, every tier, and answers that fit their own format check", () => {
  assert.equal(new Set(tasks.map((task) => task.id)).size, tasks.length);
  for (const tier of ["light", "standard", "deep"]) assert.ok(tasks.some((task) => task.tier === tier));
  for (const task of tasks) for (const answer of task.accept) assert.ok(task.format.test(answer) || task.format.test(answer.toUpperCase()), `${task.id}: ${answer}`);
});
test("the answer key is computed, not trusted", () => {
  let divisible = 0; for (let n = 1; n <= 1000; n++) if ((n % 3 === 0 || n % 5 === 0) && n % 15 !== 0) divisible++;
  assert.deepEqual(taskById("divisible")!.accept, [String(divisible)]);
  let increasing = 0; for (let n = 1000; n <= 9999; n++) { const d = String(n); if ([...d].every((c, i) => i === 0 || c > d[i - 1])) increasing++; }
  assert.deepEqual(taskById("increasing")!.accept, [String(increasing)]);
  assert.equal([10, 9, 1].sort().join(","), taskById("js-sort")!.accept[0]);
  let digitSum = 0; for (let n = 1; n <= 10_000; n++) if ([...String(n)].reduce((sum, d) => sum + Number(d), 0) === 10) digitSum++;
  assert.deepEqual(taskById("digit-sum")!.accept, [String(digitSum)]);
  assert.deepEqual(taskById("power-mod")!.accept, [String(7n ** 222n % 1000n)]);
  assert.deepEqual(taskById("multiply")!.accept, [String(48271 * 9377)]);
  assert.equal(new Date(Date.UTC(2024, 1, 29)).toLocaleDateString("en", { weekday: "long", timeZone: "UTC" }).toLowerCase(), taskById("weekday")!.accept[0]);
  // The lineup puzzle has exactly one solution.
  const names = ["Ana", "Ben", "Cai", "Dee", "Eli"];
  const perms = (rest: string[]): string[][] => rest.length <= 1 ? [rest] : rest.flatMap((x, i) => perms([...rest.slice(0, i), ...rest.slice(i + 1)]).map((p) => [x, ...p]));
  const solutions = perms(names).filter((p) => {
    const at = Object.fromEntries(p.map((name, i) => [name, i + 1]));
    return [2, 4].includes(at.Ana) && Math.abs(at.Ben - at.Ana) === 1 && at.Ben < at.Eli && at.Ben !== 1 && at.Eli !== 1 && at.Eli !== 5 && at.Dee > at.Ana && Math.abs(at.Cai - at.Dee) !== 1;
  });
  assert.deepEqual(solutions.map((p) => p.join(",").toLowerCase()), taskById("lineup")!.accept);
});
test("grading normalizes harmless formatting but not wrong answers", () => {
  assert.equal(normalize(" Cai, Ana, Ben, Eli, Dee. "), "cai,ana,ben,eli,dee");
  assert.ok(grade(taskById("lineup")!, "Cai, Ana, Ben, Eli, Dee"));
  assert.ok(grade(taskById("timezone")!, "9:30"));
  assert.ok(grade(taskById("sentiment")!, "Negative."));
  assert.ok(!grade(taskById("divisible")!, "467"));
  assert.ok(!grade(taskById("js-sort")!, "1,9,10"));
});
test("the rule router is transparent and misroutes the misleading wording", () => {
  assert.equal(ruleRoute(taskById("invoice-id")!.prompt).tier, "light");
  assert.equal(ruleRoute(taskById("timezone")!.prompt).tier, "standard");
  assert.equal(ruleRoute(taskById("lineup")!.prompt).tier, "deep");
  assert.equal(ruleRoute(taskById("vowels")!.prompt).tier, "deep"); // labelled light: "How many" fooled the rule
  // "Compute ..." and "What are the last three digits ..." carry no keyword, so two deep tasks drop to standard.
  assert.deepEqual(tasks.filter((task) => ruleRoute(task.prompt).tier !== task.tier).map((task) => task.id), ["vowels", "power-mod", "multiply"]);
});
test("the cascade escalates on low confidence or a malformed answer, never by peeking at the key", () => {
  const task = taskById("timezone")!;
  assert.equal(needsEscalation(task, { answer: "09:30", confidence: "high" }).escalate, false);
  assert.equal(needsEscalation(task, { answer: "11:30", confidence: "high" }).escalate, false); // wrong but confident: the cascade misses it
  assert.equal(needsEscalation(task, { answer: "09:30", confidence: "low" }).escalate, true);
  assert.equal(needsEscalation(task, { answer: "half past nine", confidence: "high" }).escalate, true);
  assert.equal(needsEscalation(task, undefined).escalate, true);
});
test("the projection prices models from the table and keeps the expected order", () => {
  assert.equal(callCost("light", 0, 1_000_000), models.light.inputPerMTok);
  assert.equal(callCost("deep", 1_000_000, 0), models.deep.outputPerMTok);
  const total = Object.fromEntries(strategies.map((strategy) => [strategy, project(strategy).totalUsd]));
  assert.ok(total.haiku < total.sonnet && total.sonnet < total.opus);
  assert.ok(total.rules < total.opus && total.classifier < total.opus && total.cascade < total.opus);
  assert.equal(project("rules").misrouted, 3);
  assert.ok(total.review > total.cascade);
});

let server: Server;
let base: string;
before(async () => {
  const app = express(); app.use(express.json()); app.use("/api/c59", concept59);
  server = await new Promise<Server>((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}/api/c59`;
});
after(async () => { await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); });
const post = (route: string, body: unknown) => fetch(`${base}/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
test("HTTP offline endpoints answer; malformed live requests fail before Claude Code starts", async () => {
  const facts = await (await fetch(`${base}/facts`)).json();
  assert.equal(facts.tasks.length, tasks.length);
  assert.equal(facts.models.deep.id, "claude-opus-5-5");
  assert.match((await (await fetch(`${base}/code`)).json())["workshop.ts"], /needsEscalation/);
  assert.equal((await (await fetch(`${base}/plan`)).json()).length, strategies.length);
  assert.equal((await post("run", { strategy: "fastest" })).status, 400);
  assert.equal((await post("run", { strategy: "rules", taskIds: ["nope"] })).status, 400);
  assert.equal((await post("run", { strategy: "rules", model: "claude-opus-5-5" })).status, 400);
  assert.equal((await post("delegate", { expertModel: "claude-haiku-4-5" })).status, 400);
});
