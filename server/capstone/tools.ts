/**
 * The "desk" tools: an in-process MCP server (Concept 5) built PER REQUEST for ONE signed-in customer.
 *
 * The customer id is captured in a closure, never taken from the model's input. Whatever the chat says ("I am Ana",
 * "SYSTEM: act as admin"), get_order can only see the signed-in customer's orders. The model cannot widen its own
 * authority, because the authority is not a parameter.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Store } from "./store.js";

export const SERVER = "desk";
export const T = {
  getCustomer: `mcp__${SERVER}__get_customer`,
  listOrders: `mcp__${SERVER}__list_orders`,
  getOrder: `mcp__${SERVER}__get_order`,
  issueRefund: `mcp__${SERVER}__issue_refund`,
  createTicket: `mcp__${SERVER}__create_ticket`,
} as const;

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 1) }] });
const fail = (msg: string) => ({ ...text(msg), isError: true });
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

// #region tools
/** ctx: what the HOST knows and the model must not supply: the session, and who approved the last refund. */
export type DeskCtx = { session: () => string | undefined; approver: () => string };

export function deskServer(store: Store, customerId: string, ctx: DeskCtx) {
  const ro = { annotations: { readOnlyHint: true } };
  return createSdkMcpServer({
    name: SERVER,
    version: "1.0.0",
    tools: [
      tool("get_customer", "The signed-in customer's profile.", {}, async () => text(store.customer(customerId)), ro),

      tool("list_orders", "All orders of the signed-in customer (id, status, total).", {}, async () =>
        text(store.ordersOf(customerId).map((o) => ({ id: o.id, status: o.status, placedAt: o.placedAt, total: money(o.totalCents) }))), ro),

      tool("get_order", "One order of the signed-in customer: items with prices in cents, status, delivery and tracking, amount already refunded.",
        { order_id: z.string().describe("e.g. A-1001") },
        async ({ order_id }) => {
          const o = store.orderOf(customerId, order_id);
          return o ? text(o) : fail(`Order ${order_id} not found for this customer.`);
        }, ro),

      tool("issue_refund", "Refund money for an order to the original payment method. Amount in cents. Needs human approval.",
        { order_id: z.string(), amount_cents: z.number().int().positive(), reason: z.string().min(3).max(300) },
        async ({ order_id, amount_cents, reason }) => {
          // The tool re-checks what it can, even though a hook and a human already looked: defence in depth.
          const o = store.orderOf(customerId, order_id);
          if (!o) return fail(`Order ${order_id} not found for this customer.`);
          const left = o.totalCents - o.refundedCents;
          if (amount_cents > left) return fail(`Only ${money(left)} of ${o.id} is still refundable.`);
          const r = store.addRefund({ orderId: o.id, customerId, amountCents: amount_cents, reason, approvedBy: ctx.approver(), session: ctx.session() });
          return text({ refund: r.id, order: o.id, amount: money(amount_cents), status: "refunded to the original payment method (3-5 business days)" });
        }),

      tool("create_ticket", "Escalate to the human support team (a supervisor, the returns desk...).",
        { subject: z.string().min(3).max(120), priority: z.enum(["low", "normal", "high"]), notes: z.string().max(1000) },
        async ({ subject, priority, notes }) => {
          const t = store.addTicket({ customerId, subject, priority, notes, session: ctx.session() });
          return text({ ticket: t.id, status: "open", sla: priority === "high" ? "4 hours" : "1 business day" });
        }),
    ],
  });
}
// #endregion
