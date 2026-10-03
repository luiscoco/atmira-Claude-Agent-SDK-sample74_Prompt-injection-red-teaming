/**
 * CONCEPT 33 — an MCP server that ASKS THE USER for input in the middle of a tool call (MCP elicitation)
 *
 * This file is NOT imported by the lab's server. It is a separate Node program that Claude Code starts over stdio, like
 * notes-server.ts (Concept 13). Its tools do not get everything they need from the model's arguments: they send an
 * `elicitation/create` request back to the CLIENT (Claude Code), which hands it to YOUR host (Options.onElicitation):
 *
 *   form mode   server.elicitInput({ mode: "form", message, requestedSchema })  → { action, content }
 *   url mode    server.elicitInput({ mode: "url", message, url, elicitationId }) → { action }, then the user completes
 *               the flow in a browser page, and the server sends notifications/elicitation/complete
 *
 * The model never sees the form or the values the user types unless the tool puts them in its result.
 *
 * Configuration comes through env: LAB_URL (the lab's server: log lines and the consent page), ROOMS_FILE (the
 * bookings), ELICIT_TIMEOUT_MS (how long this server waits for an answer).
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const LAB_URL = process.env.LAB_URL;
const ROOMS_FILE = process.env.ROOMS_FILE;
const ELICIT_TIMEOUT_MS = Number(process.env.ELICIT_TIMEOUT_MS ?? 120_000);
const RUN = process.env.LAB_RUN ?? "";

/** Fire-and-forget: the lab's tab shows these lines as "rooms (stdio) server" events. */
function log(method: string, detail?: unknown) {
  if (!LAB_URL) return;
  fetch(`${LAB_URL}/api/c33/log`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ run: RUN, pid: process.pid, method, detail }),
  }).catch(() => {});
}

type Booking = { id: string; room: string; date: string; attendees: number; projector: boolean; by?: string };
const load = (): Booking[] => (ROOMS_FILE && existsSync(ROOMS_FILE) ? JSON.parse(readFileSync(ROOMS_FILE, "utf8")) : []);
const save = (b: Booking[]) => ROOMS_FILE && writeFileSync(ROOMS_FILE, JSON.stringify(b, null, 2));
const text = (data: unknown, isError = false) => ({ content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data) }], ...(isError && { isError }) });

const ROOMS = ["Madrid", "Lisboa", "Roma"];
const server = new McpServer({ name: "lab-rooms", version: "1.0.0" }, { instructions: "Books meeting rooms. The tools ask the user directly for the details they need." });

/** What Claude Code said it supports in `initialize` (capabilities.elicitation). */
const caps = () => server.server.getClientCapabilities()?.elicitation;

server.registerTool(
  "client_capabilities",
  { description: "Report which elicitation modes the MCP client (the host) declared in initialize.", annotations: { readOnlyHint: true } },
  async () => {
    const info = { client: server.server.getClientVersion(), elicitation: caps() ?? null };
    log("tools/call client_capabilities", info);
    return text(info);
  },
);

// #region form
server.registerTool(
  "book_room",
  {
    description: "Book a meeting room. Call it with no arguments: the tool asks the user for the room, date, attendees and projector itself.",
    inputSchema: { purpose: z.string().max(200).optional().describe("Optional: what the meeting is for") },
  },
  async ({ purpose }) => {
    // Only flat objects with primitive properties: string (maybe format / enum), number, integer, boolean.
    const requestedSchema = {
      type: "object" as const,
      properties: {
        room: { type: "string" as const, title: "Room", enum: ROOMS, description: "Which room" },
        date: { type: "string" as const, title: "Date", format: "date" as const, description: "YYYY-MM-DD" },
        attendees: { type: "integer" as const, title: "Attendees", minimum: 1, maximum: 12 },
        projector: { type: "boolean" as const, title: "Projector", default: false },
      },
      required: ["room", "date", "attendees"],
    };
    log("elicitation/create (form)", { requestedSchema });
    try {
      const r = await server.server.elicitInput({ mode: "form", message: `Book a meeting room${purpose ? ` for “${purpose}”` : ""}. Pick the room, the date and how many people will attend.`, requestedSchema }, { timeout: ELICIT_TIMEOUT_MS });
      log(`elicitation result: ${r.action}`, r.content);
      // decline = the user said no; cancel = the user dismissed it. Tell the model, and do nothing.
      if (r.action !== "accept") return text(`The user ${r.action === "decline" ? "declined" : "cancelled"} the booking form. Nothing was booked. Do not retry unless the user asks.`);
      const c = r.content as { room: string; date: string; attendees: number; projector?: boolean };
      const all = load();
      if (all.some((b) => b.room === c.room && b.date === c.date)) return text(`${c.room} is already booked on ${c.date}. Nothing was booked.`, true);
      const booking: Booking = { id: randomUUID().slice(0, 6), room: c.room, date: c.date, attendees: c.attendees, projector: c.projector ?? false };
      save([...all, booking]);
      return text({ booked: booking });
    } catch (err) {
      // elicitInput throws when the answer does not match requestedSchema, on timeout, or if the client has no form support.
      const message = String((err as Error)?.message ?? err);
      log("elicitation error", { message });
      return text(`Could not ask the user: ${message}`, true);
    }
  },
);
// #endregion

// #region confirm
server.registerTool(
  "cancel_booking",
  {
    description: "Cancel a booking by id. The tool asks the user to confirm, and to say why.",
    inputSchema: { id: z.string().describe("Booking id") },
  },
  async ({ id }) => {
    const all = load();
    const b = all.find((x) => x.id === id);
    if (!b) return text(`No booking ${id}. Existing: ${all.map((x) => x.id).join(", ") || "none"}`, true);
    // The SERVER asks for confirmation: this works whatever the host's permission settings are (canUseTool, allowedTools).
    const requestedSchema = {
      type: "object" as const,
      properties: {
        confirm: { type: "boolean" as const, title: `Cancel ${b.room} on ${b.date}?`, description: "Tick to confirm" },
        reason: { type: "string" as const, title: "Reason", minLength: 3, maxLength: 100 },
      },
      required: ["confirm", "reason"],
    };
    log("elicitation/create (form)", { requestedSchema });
    try {
      const r = await server.server.elicitInput({ mode: "form", message: `The assistant wants to cancel booking ${id} (${b.room}, ${b.date}, ${b.attendees} people).`, requestedSchema }, { timeout: ELICIT_TIMEOUT_MS });
      log(`elicitation result: ${r.action}`, r.content);
      if (r.action !== "accept" || r.content?.confirm !== true) return text(`The user did not confirm (${r.action}${r.action === "accept" ? ", confirm unticked" : ""}). Booking ${id} is kept.`);
      save(all.filter((x) => x.id !== id));
      return text({ cancelled: id, reason: r.content.reason });
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      log("elicitation error", { message });
      return text(`Could not ask the user: ${message}`, true);
    }
  },
);
// #endregion

// #region url
server.registerTool(
  "connect_calendar",
  {
    description: "Connect the user's calendar account. The user signs in on a web page that the tool opens for them.",
    annotations: { readOnlyHint: false },
  },
  async () => {
    // The secret (a password, an OAuth code) is typed on YOUR page, never in the MCP client, the host or the model.
    const elicitationId = randomUUID();
    const url = `${LAB_URL}/api/c33/consent/${elicitationId}`;
    const status = () => fetch(`${url}/status`).then((x) => x.json() as Promise<{ state: string; account?: string }>).catch(() => ({ state: "unknown" }));
    const outcome = (s: { state: string; account?: string }) =>
      s.state === "granted" ? text({ connected: true, account: s.account }) : s.state === "denied" ? text("The user refused access on the sign-in page. The calendar is not connected.") : text("The user did not finish signing in. The calendar is not connected.", true);
    try {
      // Check what the client declared in initialize BEFORE choosing the mode. Claude Code 2.1.281 declares form only.
      if (caps()?.url) {
        log("elicitation/create (url)", { url, elicitationId });
        const r = await server.server.elicitInput({ mode: "url", message: "Sign in to the lab calendar to let the assistant see your free slots.", url, elicitationId }, { timeout: ELICIT_TIMEOUT_MS });
        log(`elicitation result: ${r.action}`);
        // accept only means "the user agreed to open the page". The sign-in itself is not done yet: wait for it.
        if (r.action !== "accept") return text(`The user ${r.action === "decline" ? "declined" : "cancelled"} the sign-in. The calendar is not connected.`);
        const deadline = Date.now() + ELICIT_TIMEOUT_MS;
        let s = await status();
        while (Date.now() < deadline && s.state === "pending") (await new Promise((ok) => setTimeout(ok, 700)), (s = await status()));
        // Tell the client the out-of-band flow is over: Claude Code emits system/elicitation_complete.
        await server.server.createElicitationCompletionNotifier(elicitationId)();
        log("notifications/elicitation/complete", { elicitationId, state: s.state });
        return outcome(s);
      }
      // Fallback for a form-only client: a form that carries the link and asks the user to say when they are done.
      // The link is not a secret, so it may be shown in a form; the password is still typed only on the page.
      const requestedSchema = { type: "object" as const, properties: { done: { type: "boolean" as const, title: "I have signed in on that page", default: false } }, required: ["done"] };
      log("elicitation/create (form, url fallback)", { url, why: "the client did not declare elicitation.url", requestedSchema });
      const r = await server.server.elicitInput({ mode: "form", message: `Sign in to the lab calendar: open ${url} in your browser, sign in there, then come back and tick the box.`, requestedSchema }, { timeout: ELICIT_TIMEOUT_MS });
      log(`elicitation result: ${r.action}`, r.content);
      if (r.action !== "accept") return text(`The user ${r.action === "decline" ? "declined" : "cancelled"} the sign-in. The calendar is not connected.`);
      // Never trust the tick: ask YOUR sign-in page what really happened.
      const s = await status();
      log("sign-in page status", s);
      return outcome(s);
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      log("elicitation error", { message });
      return text(`Could not ask the user: ${message}`, true);
    }
  },
);
// #endregion

server.registerTool(
  "list_bookings",
  { description: "List the current room bookings.", annotations: { readOnlyHint: true } },
  async () => text(load()),
);

await server.connect(new StdioServerTransport());
log("process started", { parentPid: process.ppid });
console.error(`lab-rooms MCP server running on stdio (pid ${process.pid})`); // stderr: stdout belongs to the protocol
