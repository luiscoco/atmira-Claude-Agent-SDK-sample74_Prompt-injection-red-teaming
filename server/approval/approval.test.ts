import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Approval, ApprovalError, guardedRefund, type Channel, type Refund } from "./approval.js";
import { configured, deliver, messageFor } from "./channels.js";
import { concept65 } from "../concepts/65-human-approval.js";
import { streamPost } from "../../src/lib/sse.js";

const refund: Refund = { orderId: "ORD-65", amountCents: 2500, reason: "Fictional workshop cancellation" };
test("approval freezes the exact action, remains pending, denies forged credentials, and executes once", async () => {
  const abort = new AbortController(); const raw = { ...refund }; const approval = new Approval(raw, "slack", 1000, abort.signal);
  const ledger: Refund[] = []; const effect = guardedRefund(approval, abort.signal, ledger);
  try {
    raw.amountCents = 1; assert.equal(approval.refund.amountCents, 2500); assert.ok(Object.isFrozen(approval.refund));
    await Promise.resolve(); assert.equal(ledger.length, 0);
    assert.throws(() => approval.decide("forged", true), (error) => error instanceof ApprovalError && error.status === 403);
    assert.equal(approval.state, "pending");
    assert.ok(!JSON.stringify(approval.snapshot()).includes(approval.token));
    approval.decide(approval.token, true); assert.equal((await effect).executed, true);
    assert.deepEqual(ledger, [refund]);
    assert.throws(() => approval.decide(approval.token, true), /cannot be used again/);
    assert.throws(() => approval.decide(approval.token, false), /cannot be used again/);
    assert.equal((await guardedRefund(approval, abort.signal, ledger)).executed, false);
  } finally { abort.abort(); }
});
test("rejection, timeout, delivery failure and cancellation all deny effects", async () => {
  for (const scenario of ["rejected", "expired", "delivery_failed", "cancelled", "already_aborted"] as const) {
    const abort = new AbortController(); if (scenario === "already_aborted") abort.abort();
    const approval = new Approval(refund, "email", scenario === "expired" ? 10 : 1000, abort.signal);
    const ledger: Refund[] = []; const effect = guardedRefund(approval, abort.signal, ledger);
    if (scenario === "rejected") approval.decide(approval.token, false);
    if (scenario === "delivery_failed") approval.finish("delivery_failed");
    if (scenario === "cancelled") abort.abort();
    assert.equal((await effect).executed, false); assert.deepEqual(ledger, []);
    assert.throws(() => approval.decide(approval.token, true), /cannot be used again/);
  }
});
test("deadline is checked at decision time even before the timeout callback; abort after approval prevents execution", async () => {
  let now = 0; const abort = new AbortController();
  const approval = new Approval(refund, "teams", 1000, abort.signal, undefined, () => now);
  now = 1001; assert.throws(() => approval.decide(approval.token, true), /expired/); assert.equal(await approval.result, "expired");
  const second = new Approval(refund, "teams", 1000, abort.signal);
  second.decide(second.token, true); abort.abort(); const ledger: Refund[] = [];
  assert.equal((await guardedRefund(second, abort.signal, ledger)).executed, false); assert.deepEqual(ledger, []);
});
test("each channel opens a review page, with credentials only in the fragment and escaped email content", () => {
  for (const channel of ["slack", "teams", "email"] as Channel[]) {
    const abort = new AbortController(); const approval = new Approval({ ...refund, reason: '<img src=x onerror="bad()">' }, channel, 1000, abort.signal);
    try {
      const message = messageFor(approval, "https://approval.example"); const url = new URL(message.link);
      assert.equal(url.pathname, "/api/c65/review"); assert.equal(url.search, ""); assert.ok(url.hash.includes(approval.token));
      if (channel === "email") { assert.ok(!JSON.stringify(message.payload).includes("<img")); assert.match(JSON.stringify(message.payload), /&lt;img/); }
      if (channel === "teams") assert.match(JSON.stringify(message.payload), /Action.OpenUrl/);
      if (channel === "slack") assert.match(JSON.stringify(message.payload), /plain_text/);
    } finally { abort.abort(); }
  }
});
test("outbound adapters authenticate to providers, reject failures and never follow redirects", async () => {
  const env = { APPROVAL_PUBLIC_BASE_URL: "https://approval.example", APPROVAL_SLACK_BOT_TOKEN: "secret", APPROVAL_SLACK_CHANNEL: "C123",
    APPROVAL_TEAMS_WORKFLOW_URL: "https://workflow.example/hook", APPROVAL_GRAPH_TOKEN: "graph-secret", APPROVAL_EMAIL_SENDER: "sender@example.com", APPROVAL_EMAIL_TO: "reviewer@example.com" };
  for (const channel of ["slack", "teams", "email"] as Channel[]) {
    const abort = new AbortController(); const approval = new Approval(refund, channel, 1000, abort.signal);
    try {
      const message = messageFor(approval, env.APPROVAL_PUBLIC_BASE_URL);
      assert.ok(configured(channel, env)); assert.equal(configured(channel, {}), false);
      const calls: { url: string; options: RequestInit }[] = [];
      const mock = (async (url, options) => {
        calls.push({ url: String(url), options: options! });
        return channel === "slack" ? Response.json({ ok: true }) : new Response(null, { status: 202 });
      }) as typeof fetch;
      await deliver(approval, message, abort.signal, env, mock);
      assert.equal(calls.length, 1); assert.equal(calls[0].options.redirect, "error"); assert.equal(calls[0].options.method, "POST");
      const body = JSON.parse(String(calls[0].options.body));
      if (channel === "slack") { assert.equal(body.channel, "C123"); assert.equal((calls[0].options.headers as any).Authorization, "Bearer secret"); }
      if (channel === "email") { assert.equal(body.message.toRecipients[0].emailAddress.address, "reviewer@example.com"); assert.match(calls[0].url, /graph.microsoft.com\/v1.0\/users\/sender%40example.com\/sendMail/); }
      await assert.rejects(deliver(approval, message, abort.signal, env, (async () => new Response(null, { status: 500 })) as typeof fetch), /HTTP 500/);
      if (channel === "slack") await assert.rejects(deliver(approval, message, abort.signal, env, (async () => Response.json({ ok: false })) as typeof fetch), /did not accept/);
    } finally { abort.abort(); }
  }
});

test("HTTP/SSE guided runs across all channels: GET is inert, valid POST releases the gate, replay and malformed decisions fail", async () => {
  const app = express(); app.use(express.json()); app.use("/api/c65", concept65);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/c65`;
  const post = (route: string, body: unknown, extra: Record<string, string> = {}) => fetch(`${base}/${route}`, { method: "POST", headers: { "Content-Type": "application/json", ...extra }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(`${base}/facts`)).status, 200); assert.equal((await fetch(`${base}/code`)).status, 200);
    for (const body of [{}, { mode: "guided", delivery: "local", channel: "fax", amountCents: 2500, timeoutSeconds: 5 },
      { mode: "guided", delivery: "local", channel: "slack", amountCents: 10001, timeoutSeconds: 5 }]) assert.equal((await post("run", body)).status, 400);
    for (const channel of ["slack", "teams", "email"] as Channel[]) {
      const controller = new AbortController();
      let ready!: (value: any) => void; const notification = new Promise<any>((resolve) => { ready = resolve; });
      const events: { event: string; data: any }[] = [];
      const run = streamPost(`${base}/run`, { mode: "guided", delivery: "local", channel, amountCents: 2500, timeoutSeconds: 5 }, (event, data) => {
        events.push({ event, data }); if (event === "notification") ready(data);
      }, controller.signal);
      try {
        const delivered = await notification;
        const credential = { id: delivered.id, token: delivered.token };
        assert.equal((await post("run", { mode: "guided", delivery: "local", channel, amountCents: 2500, timeoutSeconds: 5 })).status, 409);
        const page = await fetch(`${base}/review#id=${credential.id}&token=${credential.token}`);
        assert.equal(page.status, 200); assert.equal(page.headers.get("referrer-policy"), "no-referrer");
        assert.ok(!(await page.text()).includes(credential.token));
        assert.equal((await post("inspect", credential)).status, 200);
        assert.equal((await post("decision", { ...credential, token: "fake", approve: true })).status, 403);
        assert.equal((await post("decision", { ...credential, approve: true }, { Origin: "https://attacker.example" })).status, 403);
        assert.equal((await post("decision", { ...credential, approve: "true" })).status, 400);
        assert.equal(events.some((entry) => entry.event === "evidence"), false);
        const approve = channel !== "teams";
        assert.equal((await post("decision", { ...credential, approve })).status, 200);
        await run;
        const evidence = events.find((entry) => entry.event === "evidence")!.data;
        assert.equal(evidence.executed, approve); assert.equal(evidence.ledger.length, approve ? 1 : 0);
        assert.equal(evidence.approval.state, approve ? "approved" : "rejected");
        assert.equal((await post("decision", { ...credential, approve: true })).status, 409);
        assert.ok(!JSON.stringify(evidence).includes(credential.token));
      } finally { controller.abort(); await run.catch(() => {}); }
    }
  } finally { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); }
});
