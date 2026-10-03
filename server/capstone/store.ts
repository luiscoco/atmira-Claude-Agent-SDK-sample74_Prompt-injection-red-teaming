/**
 * The capstone's "database": customers, orders, refunds, tickets, the audit log and the app's own conversation index.
 *
 * A real app would use Postgres or SQLite; a JSON file keeps the lab dependency-free and lets you open it and look.
 * Two things matter for the agent, not the storage engine:
 *   - a Store is an INSTANCE, not a module-level global: the console uses the file-backed one, every eval case gets a
 *     fresh in-memory one, so evals run in parallel without touching the demo data;
 *   - every write emits "change", so the server can stream the new state to the browser while the agent works.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type Item = { sku: string; name: string; qty: number; priceCents: number };
export type Order = {
  id: string;
  customerId: string;
  items: Item[];
  totalCents: number;
  status: "processing" | "shipped" | "delivered";
  placedAt: string;
  deliveredAt?: string;
  carrier?: string;
  tracking?: string;
  eta?: string;
  refundedCents: number;
};
export type Customer = { id: string; name: string; email: string; since: string };
export type Refund = { id: string; orderId: string; customerId: string; amountCents: number; reason: string; approvedBy: string; at: string; session?: string };
export type Ticket = { id: string; customerId: string; subject: string; priority: "low" | "normal" | "high"; notes: string; at: string; session?: string };
export type Audit = { at: string; session?: string; agent: string; tool: string; input: unknown; outcome: "ok" | "error" | "blocked" | "denied" | "approved"; detail?: string };
export type Summary = { category: string; resolution: string; refundCents: number; sentiment: string; summary: string; followUp: string };
export type Conversation = {
  id: string; // the Claude Code session id: the transcript lives in Claude Code's session file, the app keeps the index
  customerId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
  costUsd: number;
  status: "open" | "closed";
  summary?: Summary;
};
export type Data = { customers: Customer[]; orders: Order[]; refunds: Refund[]; tickets: Ticket[]; audit: Audit[]; conversations: Conversation[] };

const day = 86_400_000;
const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * day).toISOString().slice(0, 10);

/** The demo data. Dates are relative to today, so the 30-day return window always means the same thing. */
export function seed(): Data {
  return {
    customers: [
      { id: "C-1", name: "Ana García", email: "ana@example.com", since: "2023-04-11" },
      { id: "C-2", name: "Ben Okafor", email: "ben@example.com", since: "2025-01-30" },
    ],
    orders: [
      {
        id: "A-1001", customerId: "C-1", status: "delivered", placedAt: isoDay(-10), deliveredAt: isoDay(-6), refundedCents: 0,
        items: [{ sku: "MUG-01", name: "Ceramic mug", qty: 2, priceCents: 1800 }, { sku: "TEA-10", name: "Sencha tea 100 g", qty: 1, priceCents: 1250 }],
        totalCents: 4850,
      },
      {
        id: "A-1002", customerId: "C-1", status: "shipped", placedAt: isoDay(-3), carrier: "UPS", tracking: "1Z999AA10123456784", eta: isoDay(2), refundedCents: 0,
        items: [{ sku: "KET-02", name: "Gooseneck kettle", qty: 1, priceCents: 5900 }],
        totalCents: 5900,
      },
      {
        id: "B-2001", customerId: "C-2", status: "delivered", placedAt: isoDay(-15), deliveredAt: isoDay(-11), refundedCents: 0,
        items: [{ sku: "ESP-90", name: "Espresso machine", qty: 1, priceCents: 49900 }],
        totalCents: 49900,
      },
      {
        id: "B-2002", customerId: "C-2", status: "processing", placedAt: isoDay(0), refundedCents: 0,
        items: [{ sku: "BEAN-1K", name: "Coffee beans 1 kg", qty: 2, priceCents: 2400 }],
        totalCents: 4800,
      },
    ],
    refunds: [],
    tickets: [],
    audit: [],
    conversations: [],
  };
}

export class Store extends EventEmitter {
  data: Data;
  /** file: a path to persist to (the console), or undefined for an in-memory store (one per eval case). */
  constructor(private file?: string) {
    super();
    this.data = seed();
    if (file) {
      try {
        this.data = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        this.save(); // first start, or an unreadable file: start from the seed
      }
    }
  }

  private save() {
    if (this.file) {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    }
    this.emit("change", this.data);
  }

  reset() {
    const conversations = this.data.conversations; // the transcripts are Claude Code's; keep the index that points at them
    this.data = { ...seed(), conversations };
    this.save();
  }

  customer = (id: string) => this.data.customers.find((c) => c.id === id);
  /** Tenant isolation lives HERE, in code: an order of another customer is simply "not found". */
  orderOf = (customerId: string, orderId: string) => this.data.orders.find((o) => o.id === orderId.trim().toUpperCase() && o.customerId === customerId);
  ordersOf = (customerId: string) => this.data.orders.filter((o) => o.customerId === customerId);

  addRefund(r: Omit<Refund, "id" | "at">) {
    const order = this.data.orders.find((o) => o.id === r.orderId)!;
    order.refundedCents += r.amountCents;
    const refund = { ...r, id: `R-${this.data.refunds.length + 1}`, at: new Date().toISOString() };
    this.data.refunds.push(refund);
    this.save();
    return refund;
  }

  addTicket(t: Omit<Ticket, "id" | "at">) {
    const ticket = { ...t, id: `T-${this.data.tickets.length + 1}`, at: new Date().toISOString() };
    this.data.tickets.push(ticket);
    this.save();
    return ticket;
  }

  audit(a: Omit<Audit, "at">) {
    this.data.audit.push({ ...a, at: new Date().toISOString() });
    if (this.data.audit.length > 300) this.data.audit.splice(0, this.data.audit.length - 300);
    this.save();
  }

  conversation = (id: string) => this.data.conversations.find((c) => c.id === id);
  upsertConversation(c: Pick<Conversation, "id" | "customerId"> & Partial<Conversation>) {
    const now = new Date().toISOString();
    let conv = this.conversation(c.id);
    if (!conv) {
      conv = { title: "", createdAt: now, updatedAt: now, turns: 0, costUsd: 0, status: "open", ...c };
      this.data.conversations.unshift(conv);
    } else Object.assign(conv, c, { updatedAt: now });
    this.save();
    return conv;
  }
}
