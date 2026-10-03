import { z } from "zod";
import { tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";

export const profiles = ["vague", "focused"] as const;
export type Profile = typeof profiles[number];
export const catalog = [
  { id: "SKU-101", name: "Trail mug", category: "camping", priceCents: 1800, stock: 12, description: "Insulated steel mug, 350 ml. Hand wash only." },
  { id: "SKU-102", name: "Camp lantern", category: "camping", priceCents: 2400, stock: 0, description: "Rechargeable lantern, 200 lumens. USB-C cable included." },
  { id: "SKU-103", name: "Pocket stove", category: "camping", priceCents: 3200, stock: 8, description: "Compact gas stove. Fuel sold separately." },
  { id: "SKU-104", name: "Trail blanket", category: "camping", priceCents: 2900, stock: 4, description: "Packable fleece blanket, 140 by 180 cm." },
  { id: "SKU-105", name: "Desk mug", category: "office", priceCents: 1400, stock: 20, description: "Ceramic mug, 300 ml. Dishwasher safe." },
  { id: "SKU-106", name: "Desk lamp", category: "office", priceCents: 3900, stock: 3, description: "Dimmable LED lamp. Mains adapter included." },
] as const;
type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
export type Call = { name: string; input: unknown; result: Result; bytes: number; elapsedMs: number };
const ok = (data: unknown): Result => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const fail = (code: string, message: string, nextAction: string): Result => ({ ...ok({ code, message, nextAction }), isError: true });
const searchShape = {
  category: z.enum(["camping", "office"]).describe("Exact catalog category; use camping for outdoor gear."),
  maxPriceCents: z.number().int().min(0).max(100_000).describe("Inclusive price ceiling in EUR cents: 30 EUR = 3000."),
  inStockOnly: z.boolean().default(true).describe("True excludes products with zero stock."),
  limit: z.number().int().min(1).max(3).default(2).describe("Maximum matches per page, 1–3."),
  cursor: z.string().regex(/^offset:\d{1,3}$/).optional().describe("Opaque nextCursor from the previous response; omit for the first page."),
  responseFormat: z.enum(["concise", "detailed"]).default("concise").describe("Concise returns decision fields; detailed also includes descriptions."),
};

/** Both the offline caller and SDK wrapper execute these exact definitions. */
export function definitions(profile: Profile): SdkMcpToolDefinition<any>[] {
  if (profile === "vague") return [tool("lookup", "Look up data.", { query: z.string() }, async ({ query }) => {
    // Deliberately underspecified: searches raw serialized records, returns everything on an empty query.
    const rows = catalog.filter((row) => JSON.stringify(row).toLowerCase().includes(query.toLowerCase()));
    return rows.length ? ok(rows) : { content: [{ type: "text", text: "Not found." }], isError: true };
  }, { annotations: { readOnlyHint: true } })];
  return [
    tool("catalog_search", "Find products by category, budget and availability. Read-only. Returns EUR-cent prices, stable product IDs and nextCursor. Follow nextCursor until null for ALL matches. Use catalog_get for one known ID. Example: camping, maxPriceCents=3000, inStockOnly=true. No purchase or inventory mutation.", searchShape, async (args) => {
      const matches = catalog.filter((row) => row.category === args.category && row.priceCents <= args.maxPriceCents && (!args.inStockOnly || row.stock > 0));
      const offset = args.cursor ? Number(args.cursor.slice(7)) : 0;
      if (args.cursor && (offset === 0 || offset >= matches.length)) return fail("INVALID_CURSOR", "Cursor is outside this result set.", "Restart without cursor. Keep filters unchanged between pages.");
      const items = matches.slice(offset, offset + args.limit).map((row) => args.responseFormat === "detailed" ? row : { id: row.id, name: row.name, priceCents: row.priceCents, stock: row.stock });
      return ok({ items, totalMatches: matches.length, nextCursor: offset + args.limit < matches.length ? `offset:${offset + args.limit}` : null, currency: "EUR" });
    }, { annotations: { readOnlyHint: true } }),
    tool("catalog_get", "Read complete details for one product using an exact ID returned by catalog_search. Read-only. Returns name, category, priceCents in EUR, stock and description. Do not use for discovery; use catalog_search. Unknown IDs return NOT_FOUND with a recovery action.", {
      productId: z.string().regex(/^SKU-\d{3}$/).describe("Exact stable ID, for example SKU-101; never a product name or array index."),
    }, async ({ productId }) => {
      const row = catalog.find((item) => item.id === productId);
      return row ? ok({ ...row, currency: "EUR" }) : fail("NOT_FOUND", `No product ${productId}.`, "Use catalog_search to discover valid product IDs; do not guess IDs.");
    }, { annotations: { readOnlyHint: true } }),
  ];
}

export async function invoke(profile: Profile, name: string, input: unknown): Promise<Call> {
  const started = performance.now();
  const definition = definitions(profile).find((item) => item.name === name);
  let result: Result;
  if (!definition) result = fail("UNKNOWN_TOOL", `Tool ${name} is unavailable.`, `Use one of: ${definitions(profile).map((item) => item.name).join(", ")}.`);
  else {
    const parsed = z.object(definition.inputSchema).strict().safeParse(input);
    result = parsed.success ? await definition.handler(parsed.data, {}) as Result : fail("INVALID_INPUT", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "), "Correct the fields using the published input schema and retry.");
  }
  return { name, input, result, bytes: Buffer.byteLength(JSON.stringify(result)), elapsedMs: Math.round(performance.now() - started) };
}

export function contracts(profile: Profile) {
  return definitions(profile).map((item) => ({ name: item.name, description: item.description, annotations: item.annotations, inputSchema: z.toJSONSchema(z.object(item.inputSchema).strict()) }));
}

export const taskPrompt = "Find ALL in-stock camping products costing at most 30 EUR. Report each product ID, name and price in EUR. Use the catalog tools as evidence; do not invent products.";
