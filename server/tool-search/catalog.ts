import { z } from "zod";
import { tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";

/**
 * A deterministic 64-tool "operations" catalog: 8 business domains x 8 actions. One of them is the needle the task
 * needs: billing_refund_invoice. The offline helpers below (estimate, search, plan) are teaching approximations;
 * the live endpoints let Claude Code report what really happens.
 */
export const server = "ops";
export const metadataProfiles = ["clear", "vague"] as const;
export type Metadata = typeof metadataProfiles[number];
export const needle = { invoiceId: "INV-2042", amountCents: 4900, refundId: "RF-2042-1" } as const;
export const taskPrompt = `Invoice ${needle.invoiceId} was charged twice by mistake. Refund the duplicate charge of 49.00 EUR and report the refund ID. Use the operations tools; do not invent IDs.`;

const domains = [
  { id: "billing", entity: "invoice", idField: "invoiceId", example: "INV-2042" },
  { id: "crm", entity: "contact", idField: "contactId", example: "C-1042" },
  { id: "shipping", entity: "shipment", idField: "shipmentId", example: "SH-310" },
  { id: "inventory", entity: "stock item", idField: "sku", example: "SKU-101" },
  { id: "hr", entity: "employee", idField: "employeeId", example: "E-77" },
  { id: "analytics", entity: "report", idField: "reportId", example: "R-9" },
  { id: "support", entity: "ticket", idField: "ticketId", example: "T-5531" },
  { id: "marketing", entity: "campaign", idField: "campaignId", example: "CMP-12" },
] as const;
const actions = {
  list: "List {entity} records with optional filters and pagination.",
  get: "Read one {entity} by its exact ID.",
  create: "Create a new {entity}.",
  update: "Change fields of an existing {entity}.",
  archive: "Archive a {entity} so it no longer appears in default lists.",
  export: "Export {entity} records as CSV for offline analysis.",
  search: "Full-text search across {entity} records.",
  audit: "Read the change history of one {entity}.",
} as const;

export type Definition = { name: string; domain: string; description: string; searchHint?: string; shape: z.ZodRawShape; needle: boolean };

/** Builds the catalog. `metadata` only changes the needle: clear name/description/searchHint versus a vague one. */
export function catalog(metadata: Metadata = "clear"): Definition[] {
  const rows: Definition[] = [];
  for (const domain of domains) {
    for (const [action, sentence] of Object.entries(actions)) {
      // billing_audit is replaced by the needle, so the catalog stays at 64 tools.
      if (domain.id === "billing" && action === "audit") continue;
      rows.push({
        name: `${domain.id}_${action}`, domain: domain.id, needle: false,
        description: `${sentence.replace("{entity}", domain.entity)} Part of the ${domain.id} system. Returns JSON with stable IDs. Read the schema for filters, limits and response formats before calling.`,
        shape: {
          [domain.idField]: z.string().optional().describe(`Exact ${domain.entity} ID, for example ${domain.example}.`),
          filter: z.string().max(200).optional().describe("Optional filter expression, for example status:open."),
          limit: z.number().int().min(1).max(50).default(20).describe("Maximum records per page, 1-50."),
          cursor: z.string().optional().describe("Opaque nextCursor from the previous page; omit for the first page."),
          responseFormat: z.enum(["concise", "detailed"]).default("concise").describe("concise returns decision fields; detailed returns every field."),
        },
      });
    }
  }
  const shape = {
    invoiceId: z.string().regex(/^INV-\d{4}$/).describe("Exact invoice ID, for example INV-2042."),
    amountCents: z.number().int().min(1).max(1_000_000).describe("Amount to refund in EUR cents: 49.00 EUR = 4900."),
    reason: z.enum(["duplicate_charge", "overcharge", "cancelled_order"]).describe("Why the money is returned."),
  };
  rows.splice(7, 0, metadata === "clear"
    ? { name: "billing_refund_invoice", domain: "billing", needle: true, shape,
        description: "Refund all or part of a paid charge on one invoice. Use for duplicate charges, overcharges or cancelled orders. Amount in EUR cents. Returns refundId. Fixture only: no real payment moves.",
        searchHint: "refund money back duplicate double charge reverse payment chargeback" }
    : { name: "billing_op_7", domain: "billing", needle: true, shape, description: "Billing operation." });
  return rows;
}

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (data: unknown): Result => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const fail = (code: string, message: string, nextAction: string): Result => ({ ...ok({ code, message, nextAction }), isError: true });

/** The fixture behaviour. Nothing here touches a real system. */
export function handle(definition: Definition, args: Record<string, unknown>): Result {
  if (!definition.needle) return ok({ tool: definition.name, items: [], nextCursor: null, note: "Fixture: this lesson only implements the refund tool." });
  if (args.invoiceId !== needle.invoiceId) return fail("NOT_FOUND", `No paid invoice ${String(args.invoiceId)}.`, "Check the invoice ID from the user's request.");
  if (args.amountCents !== needle.amountCents) return fail("AMOUNT_MISMATCH", `The duplicate charge on ${needle.invoiceId} is ${needle.amountCents} cents.`, "Retry with the duplicate charge amount in cents.");
  return ok({ refundId: needle.refundId, invoiceId: needle.invoiceId, amountCents: needle.amountCents, currency: "EUR", status: "refunded" });
}

/** The same definitions as SDK MCP tools, with searchHint and the optional per-tool alwaysLoad pin. */
export function sdkTools(metadata: Metadata, pinNeedle: boolean, onCall: (name: string, args: unknown, result: Result) => void): SdkMcpToolDefinition<any>[] {
  return catalog(metadata).map((definition) => tool(definition.name, definition.description, definition.shape, async (args) => {
    const result = handle(definition, args as Record<string, unknown>);
    onCall(definition.name, args, result);
    return result;
  }, {
    ...(definition.searchHint ? { searchHint: definition.searchHint } : {}),
    ...(definition.needle && pinNeedle ? { alwaysLoad: true } : {}),
  }));
}

/** What the model would receive for one tool: name, description and JSON Schema. */
export function wireDefinition(definition: Definition) {
  return { name: `mcp__${server}__${definition.name}`, description: definition.description, input_schema: z.toJSONSchema(z.object(definition.shape)) };
}
/** Rough estimate: about 4 characters of JSON per token. Real counts come from getContextUsage(). */
export const estimateTokens = (definition: Definition) => Math.ceil(JSON.stringify(wireDefinition(definition)).length / 4);

// ---------------------------------------------------------------------------------------------
// Offline search: a keyword scorer that shows WHY metadata matters. It is not Claude Code's ranking algorithm.
// ---------------------------------------------------------------------------------------------
const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1);
// Filler words match almost every description ("for offline analysis"), so they would rank noise. Query terms skip them.
const stopwords = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "is", "it", "me", "my", "of", "on", "or", "the", "to", "with", "please", "can", "you", "i", "we"]);
export type Hit = { name: string; score: number; matched: string[] };
export function search(text: string, metadata: Metadata = "clear", limit = 5): { mode: "select" | "keywords"; terms: string[]; hits: Hit[] } {
  const rows = catalog(metadata);
  if (text.trim().startsWith("select:")) {
    const wanted = text.trim().slice(7).split(",").map((name) => name.trim().replace(`mcp__${server}__`, "")).filter(Boolean);
    return { mode: "select", terms: wanted, hits: rows.filter((row) => wanted.includes(row.name)).map((row) => ({ name: row.name, score: 1, matched: ["exact name"] })) };
  }
  const terms = [...new Set(words(text))].filter((term) => !stopwords.has(term));
  const hits = rows.map((row) => {
    const name = words(row.name), hint = words(row.searchHint ?? ""), description = words(row.description);
    let score = 0; const matched: string[] = [];
    for (const term of terms) {
      const weight = name.includes(term) ? 3 : hint.includes(term) ? 2 : description.includes(term) ? 1 : 0;
      if (weight) { score += weight; matched.push(`${term}+${weight}`); }
    }
    return { name: row.name, score, matched };
  }).filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return { mode: "keywords", terms, hits: hits.slice(0, limit) };
}

// ---------------------------------------------------------------------------------------------
// Offline planner: the documented ENABLE_TOOL_SEARCH rules applied to the estimates above.
// ---------------------------------------------------------------------------------------------
export const modeSchema = z.string().regex(/^(true|false|auto|auto:(100|[1-9]?\d))$/, "Use true, false, auto or auto:N with N from 0 to 100.");
export function plan(mode: string, opts: { metadata?: Metadata; pinNeedle?: boolean; contextWindow?: number } = {}) {
  const rows = catalog(opts.metadata);
  const window = opts.contextWindow ?? 200_000;
  const pinned = rows.filter((row) => row.needle && opts.pinNeedle);
  const deferrable = rows.filter((row) => !pinned.includes(row));
  const deferrableTokens = deferrable.reduce((sum, row) => sum + estimateTokens(row), 0);
  const percent = mode === "auto" ? 10 : mode.startsWith("auto:") ? Number(mode.slice(5)) : null;
  const thresholdTokens = percent === null ? null : Math.floor(window * percent / 100);
  const defer = mode === "true" || (thresholdTokens !== null && deferrableTokens >= thresholdTokens);
  const upfront = defer ? pinned : rows;
  return {
    mode, window, thresholdTokens, defer,
    rule: mode === "false" ? "false: every MCP tool loads upfront; no ToolSearch tool."
      : mode === "true" ? "true: every MCP tool is deferred except alwaysLoad ones."
      : `${mode}: defer once deferrable definitions reach ${percent}% of the window (${thresholdTokens!.toLocaleString("en")} tokens).`,
    upfront: upfront.map((row) => row.name), deferredCount: rows.length - upfront.length,
    upfrontTokens: upfront.reduce((sum, row) => sum + estimateTokens(row), 0),
    deferredTokens: defer ? deferrableTokens : 0, allTokens: rows.reduce((sum, row) => sum + estimateTokens(row), 0),
  };
}
