/**
 * CONCEPT 29 — Images & file input: how an image, a PDF or a text document reaches the model, and what it costs
 *
 * There are three ways in:
 *
 *   1. Content blocks   YOUR code puts image / document blocks in an SDKUserMessage (streaming input, Concept 12).
 *                       A string prompt cannot hold them.
 *   2. Files on disk    The MODEL opens a file with the Read tool: a PNG becomes an image block, a PDF a document block.
 *                       Or the prompt says @file.png and Claude Code reads it before the first turn.
 *   3. Tool results     A custom tool (Concept 5) returns { type: "image", data, mimeType } and the model sees it.
 *
 * Between your blocks and the API sits Claude Code, and it changes them: it resizes big images, re-encodes huge ones
 * as JPEG, fixes a wrong media_type, and replaces bytes that are not an image with a text note. To SEE that, the lab
 * sets ANTHROPIC_BASE_URL to a small "wire tap" that forwards every request and reports the blocks it carries.
 *
 * Routes: GET /files, GET /file/:name, POST /inline (SSE), POST /upload (SSE), POST /disk (SSE), GET /code.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { z } from "zod";
import { createSdkMcpServer, query, tool, type Options, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";
import { cardPng, chartPng, INVOICE_TXT, invoicePdf, noisyPng, POLICY_TXT } from "./29-make-files.js";

export const concept29 = Router();

const MODEL = "claude-haiku-4-5-20251001";
const UPSTREAM = (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, "");

// The agent works in files-lab/work, where the lab writes its input files. Its config goes to a fake CLAUDE_CONFIG_DIR.
const LAB = path.resolve("files-lab");
const WORK = path.join(LAB, "work");
const CONFIG_DIR = path.join(LAB, "config");
rmSync(LAB, { recursive: true, force: true });
for (const dir of [WORK, CONFIG_DIR]) mkdirSync(dir, { recursive: true });
const FILES: Record<string, () => Buffer | string> = {
  "card.png": () => cardPng(), // 400×240: an order number, a code word, three shapes
  "big.png": () => cardPng(6), // the same card at 2400×1440
  "chart-2026.png": () => chartPng(),
  "chart-2027.png": () => chartPng([70, 20, 45, 90], "SALES 2027"),
  "invoice.pdf": () => invoicePdf(), // 3 pages; the password is on page 3
  "invoice.txt": () => INVOICE_TXT, // the same invoice as plain text
  "policy.txt": () => POLICY_TXT,
};
for (const [name, make] of Object.entries(FILES)) writeFileSync(path.join(WORK, name), make());
/** noisy.png (~11 MB) takes a few seconds to make, so it is made the first time a run needs it. */
function file(name: string) {
  const p = path.join(WORK, name);
  if (name === "noisy.png" && !existsSync(p)) writeFileSync(p, noisyPng());
  return readFileSync(p);
}
const escaped = JSON.stringify(WORK).slice(1, -1); // the path as it appears inside JSON text (Windows: doubled \)
const short = (s: string) => s.replaceAll(WORK + path.sep, "").replaceAll(WORK, "files-lab/work").replaceAll(escaped, "files-lab/work").replaceAll(LAB, "files-lab");
/** True for `dir` itself or a path inside it (not a sibling folder that only starts with the same name). */
const inside = (dir: string, p: string) => {
  const r = path.relative(dir, p);
  return r === "" || (!!r && !r.startsWith("..") && !path.isAbsolute(r));
};

type Emit = (event: string, data: object) => void;

// #region blocks
// The content blocks YOUR code writes. They are Messages API blocks, inside an SDKUserMessage.
type Block = Exclude<SDKUserMessage["message"]["content"], string>[number];
type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

const text = (t: string): Block => ({ type: "text", text: t });
const image = (data: Buffer, media_type: ImageType = "image/png"): Block => ({ type: "image", source: { type: "base64", media_type, data: data.toString("base64") } });
const imageUrl = (url: string): Block => ({ type: "image", source: { type: "url", url } }); // the API downloads it
const pdfDoc = (data: Buffer, title?: string): Block => ({ type: "document", source: { type: "base64", media_type: "application/pdf", data: data.toString("base64") }, title });
const pdfUrl = (url: string): Block => ({ type: "document", source: { type: "url", url } });
const textDoc = (data: string, title: string, citations = false): Block => ({
  type: "document",
  source: { type: "text", media_type: "text/plain", data },
  title,
  context: "Internal document, 2026", // shown to the model, never cited
  citations: { enabled: citations },
});

/** A string prompt cannot carry blocks: send one SDKUserMessage through streaming input instead. */
async function* oneMessage(content: Block[]): AsyncGenerator<SDKUserMessage> {
  yield { type: "user", parent_tool_use_id: null, message: { role: "user", content } };
}
// #endregion

// #region wire
// The wire tap: ANTHROPIC_BASE_URL = http://127.0.0.1:<port>/w/<run id>. It forwards every request to the real API
// and reports the NEW user messages each main-loop request carries, as the API receives them (after Claude Code).
type TapRun = { emit: Emit; n: number; shown: number };
const tapRuns = new Map<string, TapRun>();

function dims(buf: Buffer) {
  if (buf[0] === 0x89 && buf.length > 24) return { format: "png", w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i + 9 < buf.length; i += 2 + buf.readUInt16BE(i + 2))
      if (buf[i + 1] >= 0xc0 && buf[i + 1] <= 0xc3) return { format: "jpeg", w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
  }
  return { format: "unknown" };
}

/** One API block → one small row: what kind, and the details that matter (size, pixels, estimated tokens). */
function describe(b: any): object {
  if (b.type === "text") {
    const reminder = b.text.startsWith("<system-reminder>");
    return { kind: reminder ? "text (system-reminder)" : "text", detail: short(b.text.replace(/<\/?system-reminder>\n?/g, "").trim()).slice(0, reminder ? 110 : 220) };
  }
  if (b.type === "image" && b.source.type === "base64") {
    const buf = Buffer.from(b.source.data, "base64");
    const d = dims(buf);
    return { kind: "image", detail: `${b.source.media_type} · ${kb(buf.length)} · ${d.w ? `${d.w}×${d.h} ${d.format}` : "not an image"}`, tokens: d.w ? imageTokens(d.w, d.h) : undefined };
  }
  if (b.type === "image") return { kind: "image", detail: `url ${b.source.url}` };
  if (b.type === "document") {
    const s = b.source;
    const what = s.type === "base64" ? `${s.media_type} · ${kb(Buffer.from(s.data, "base64").length)}` : s.type === "text" ? `text/plain · ${s.data.length} chars` : `url ${s.url}`;
    return { kind: "document", detail: `${what}${b.title ? ` · title "${b.title}"` : ""}${b.citations?.enabled ? " · citations on" : ""}` };
  }
  if (b.type === "tool_result") return { kind: "tool_result", children: (Array.isArray(b.content) ? b.content : [{ type: "text", text: String(b.content ?? "") }]).map(describe) };
  return { kind: b.type };
}
/** Image tokens ≈ width × height / 750, after the API's OWN resize (long edge ≤ 1568 px, and about 1.15 megapixels). */
function imageTokens(w: number, h: number) {
  const s = Math.min(1, 1568 / Math.max(w, h), Math.sqrt(1_150_000 / (w * h)));
  return Math.round((w * s * h * s) / 750);
}
const kb = (n: number) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

const tap = http.createServer(async (req, res) => {
  const m = req.url?.match(/^\/w\/([\w-]+)(\/.*)$/);
  const run = m ? tapRuns.get(m[1]) : undefined;
  if (!m || !run) return res.writeHead(404).end();
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  let isMain = false;
  if (req.method === "POST" && m[2].startsWith("/v1/messages") && !m[2].includes("count_tokens")) {
    try {
      const j = JSON.parse(body.toString());
      const first = j.messages?.[0]?.content;
      isMain = !String(typeof first === "string" ? first : first?.[0]?.text ?? "").startsWith("<session>"); // skip the side call
      if (isMain) {
        const fresh = j.messages.slice(run.shown).filter((x: any) => x.role === "user");
        run.shown = j.messages.length;
        run.emit("wire", { n: ++run.n, messages: fresh.map((x: any) => (typeof x.content === "string" ? [describe({ type: "text", text: x.content })] : x.content.map(describe))) });
      }
    } catch {}
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "content-length", "connection", "accept-encoding"].includes(k)) headers[k] = v;
  try {
    const up = await fetch(UPSTREAM + m[2], { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method!) ? undefined : body });
    const out: Record<string, string> = {};
    up.headers.forEach((v, k) => { if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) out[k] = v; });
    res.writeHead(up.status, out);
    let raw = "";
    for await (const c of up.body ?? []) {
      res.write(c);
      if (isMain) raw += Buffer.from(c).toString();
    }
    res.end();
    // The API's answer as it came off the wire: did it carry citations? (Compare with the SDK's assistant message.)
    const cited = [...raw.matchAll(/"citation":\{"type":"(\w+)","cited_text":"((?:[^"\\]|\\.)*)"/g)].map(([, type, t]) => ({ type, cited_text: JSON.parse(`"${t}"`).trim() }));
    if (cited.length) run.emit("wireCitations", { n: run.n, citations: cited });
  } catch {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  }
});
const tapPort = new Promise<number>((resolve) => tap.listen(0, "127.0.0.1", () => resolve((tap.address() as { port: number }).port)));

async function openTap(emit: Emit) {
  const id = randomUUID().slice(0, 8);
  tapRuns.set(id, { emit, n: 0, shown: 0 });
  return { baseUrl: `http://127.0.0.1:${await tapPort}/w/${id}`, close: () => tapRuns.delete(id) };
}
// #endregion

// #region tool
// A custom tool that returns an IMAGE. Its content is MCP's shape ({ type: "image", data, mimeType }); Claude Code turns
// it into an Anthropic image block inside the tool_result.
const charts = createSdkMcpServer({
  name: "charts",
  version: "1.0.0",
  tools: [
    tool("render_chart", "Renders the sales chart of a year as a PNG image. The chart has no numbers: compare the bars.", { year: z.enum(["2026", "2027"]) }, async ({ year }) => ({
      content: [
        { type: "image", data: file(`chart-${year}.png`).toString("base64"), mimeType: "image/png" },
        { type: "text", text: `Sales chart ${year} rendered (400×240).` },
      ],
    })),
  ],
});
// #endregion

// #region options
function baseOptions(baseUrl: string, abort: AbortController, extra: Partial<Options> = {}): Options {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE"))); // see Tab16
  env.CLAUDE_CONFIG_DIR = CONFIG_DIR;
  env.ANTHROPIC_BASE_URL = baseUrl; // every API call goes through the wire tap
  return {
    model: MODEL,
    cwd: WORK,
    tools: [], // no built-in tools unless a case needs Read
    canUseTool: async (name, input) =>
      (name === "Read" && inside(WORK, path.resolve(WORK, String(input.file_path ?? "")))) || name === "mcp__charts__render_chart"
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: "Denied by the lab: only Read inside files-lab/work." },
    settingSources: [],
    persistSession: false,
    thinking: { type: "disabled" },
    abortController: abort,
    env,
    ...extra,
  };
}
// #endregion

const optionsForBrowser = (options: Options) => ({
  ...options,
  env: "{ ...process.env without CLAUDE*, CLAUDE_CONFIG_DIR: 'files-lab/config', ANTHROPIC_BASE_URL: 'http://127.0.0.1:<tap>/w/<run>' }",
  canUseTool: "[Function: Read inside files-lab/work, and mcp__charts__render_chart]",
  abortController: "[AbortController]",
  mcpServers: options.mcpServers && { charts: "[createSdkMcpServer: render_chart]" },
  cwd: options.cwd && short(options.cwd),
});

/** What the host sent, for the browser: the blocks without their base64. */
function sent(content: Block[] | string, files: (string | null)[] = []) {
  if (typeof content === "string") return [{ kind: "string prompt", detail: content }];
  return content.map((b: any, i) => ({ ...describe(b), file: files[i] ?? undefined }));
}

// #region messages
/** Turns each SDK message into a small event for the browser. */
function relay(msg: SDKMessage, emit: Emit) {
  const m = msg as any;
  if (m.type === "system" && m.subtype === "init") return emit("init", { model: m.model, tools: m.tools });
  if (m.type === "assistant") {
    for (const b of m.message.content) {
      // With citations on, the answer comes as several text blocks. Look at b.citations: the SDK's copy is EMPTY.
      if (b.type === "text") emit("assistant", { text: short(b.text).slice(0, 700), citations: b.citations, error: m.error });
      if (b.type === "tool_use") emit("toolUse", { name: b.name, input: { ...b.input, file_path: b.input.file_path && short(b.input.file_path) } });
    }
    return;
  }
  if (m.type === "user") {
    const content = typeof m.message.content === "string" ? [{ type: "text", text: m.message.content }] : m.message.content;
    for (const b of content) {
      if (b.type === "tool_result") emit("toolResult", { is_error: !!b.is_error, blocks: (Array.isArray(b.content) ? b.content : [{ type: "text", text: String(b.content ?? "") }]).map(describe) });
      // Claude Code adds a user message of its own after a resized image: isSynthetic, with the coordinate note.
      else if (b.type === "text" && m.isSynthetic) emit("synthetic", { text: short(b.text) });
    }
    // tool_use_result: the tool's full output object. For Read: the type (image, pdf, text…), sizes and dimensions.
    const r = m.tool_use_result;
    if (r && typeof r === "object" && !Array.isArray(r) && r.type)
      emit("toolUseResult", { type: r.type, mediaType: r.file?.type, originalSize: r.file?.originalSize, dimensions: r.file?.dimensions, filePath: r.file?.filePath && short(r.file.filePath) });
    else if (typeof r === "string") emit("toolUseResult", { error: short(r).slice(0, 300) });
    return;
  }
  if (m.type === "result") {
    const u = m.usage ?? {};
    emit("result", {
      subtype: m.subtype, is_error: m.is_error, num_turns: m.num_turns, cost: m.total_cost_usd, text: typeof m.result === "string" ? short(m.result).slice(0, 500) : undefined,
      tokens: { input: u.input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0, cache_read: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0 },
    });
  }
}
// #endregion

/** One run through the wire tap: opens the SSE stream, relays every message, closes everything. */
async function stream(req: any, res: any, go: (ctx: { emit: Emit; make: (extra?: Partial<Options>) => Options; opened: (content: Block[] | string, options: Options, files?: (string | null)[]) => void }) => Promise<unknown>) {
  const { abort, send } = openSse(req, res);
  const startedAt = Date.now();
  const emit: Emit = (event, data) => send(event, { ...data, at: Date.now() - startedAt });
  const t = await openTap(emit);
  try {
    await go({
      emit,
      make: (extra = {}) => baseOptions(t.baseUrl, abort, extra),
      opened: (content, options, files) => emit("opened", { sent: sent(content, files), options: optionsForBrowser(options) }),
    });
  } catch (err) {
    emit("thrown", { message: short(String((err as Error)?.message ?? err)).slice(0, 400) });
  } finally {
    t.close();
    send("done", {});
    res.end();
  }
}

async function runQuery(prompt: string | AsyncIterable<SDKUserMessage>, options: Options, emit: Emit) {
  for await (const msg of query({ prompt, options })) relay(msg, emit);
}

// ---------------------------------------------------------------------------------------------
// GET /files, GET /file/:name: the lab's input files (the browser shows them as thumbnails)
// ---------------------------------------------------------------------------------------------

concept29.get("/files", (_req, res) => {
  res.json(Object.keys(FILES).map((name) => ({ name, bytes: statSync(path.join(WORK, name)).size })));
});

concept29.get("/file/:name", (req, res) => {
  const name = req.params.name;
  if (!Object.hasOwn(FILES, name)) return res.status(404).end(); // not `in`: that also finds "constructor", "toString"…
  res.type(path.extname(name)).send(file(name));
});

// ---------------------------------------------------------------------------------------------
// POST /inline: content blocks written by the host
// ---------------------------------------------------------------------------------------------

const INLINE: Record<string, () => { blocks: Block[]; files: (string | null)[] }> = {
  image: () => ({ blocks: [image(file("card.png")), text("What is the order number, the code word, and the three shapes with their colours? One line.")], files: ["card.png", null] }),
  textOnly: () => ({ blocks: [text("Reply with the word OK.")], files: [null] }),
  twoImages: () => ({
    blocks: [text("Image 1:"), image(file("chart-2026.png")), text("Image 2:"), image(file("chart-2027.png")), text("Which quarter has the highest bar in each image? One line.")],
    files: [null, "chart-2026.png", null, "chart-2027.png", null],
  }),
  pdf: () => ({ blocks: [pdfDoc(file("invoice.pdf"), "invoice.pdf"), text("Give the invoice number, the total and the delivery password. One line.")], files: ["invoice.pdf", null] }),
  textDoc: () => ({ blocks: [textDoc(INVOICE_TXT, "invoice.txt"), text("Give the invoice number, the total and the delivery password. One line.")], files: ["invoice.txt", null] }),
  citations: () => ({ blocks: [textDoc(POLICY_TXT, "Returns policy", true), text("How many days do I have to return an item, and can clearance items be refunded? Cite the policy.")], files: ["policy.txt", null] }),
  url: () => ({
    blocks: [imageUrl("https://raw.githubusercontent.com/github/explore/main/topics/typescript/typescript.png"), pdfUrl("https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf"), text("Name the logo in the image, and quote the text of the PDF. One line.")],
    files: [null, null, null],
  }),
  urlBlocked: () => ({ blocks: [imageUrl("https://upload.wikimedia.org/wikipedia/commons/a/a7/Camponotus_flavomarginatus_ant.jpg"), text("What animal is this? Three words.")], files: [null, null] }),
  mislabeled: () => ({ blocks: [image(file("card.png"), "image/jpeg"), text("What is the order number? One line.")], files: ["card.png", null] }),
  notImage: () => ({ blocks: [image(Buffer.from("hello, I am not a picture")), text("Describe the image in one line.")], files: [null, null] }),
  large: () => ({ blocks: [image(file("big.png")), text("What is the order number and the code word? One line.")], files: ["big.png", null] }),
  huge: () => ({ blocks: [image(file("noisy.png")), text("What is the order number? One line.")], files: [null, null] }),
};

const InlineBody = z.object({ scenario: z.enum(Object.keys(INLINE) as [string, ...string[]]) }).strict();

concept29.post("/inline", (req, res) => {
  const parsed = InlineBody.safeParse(req.body ?? {});
  return stream(req, res, async ({ emit, make, opened }) => {
    if (!parsed.success) return emit("error", { message: `Unknown scenario. Allowed: ${Object.keys(INLINE).join(", ")}.` });
    const { blocks, files } = INLINE[parsed.data.scenario]();
    const options = make();
    opened(blocks, options, files);
    await runQuery(oneMessage(blocks), options, emit);
  });
});

// ---------------------------------------------------------------------------------------------
// POST /upload: YOUR file, from the browser, as a content block
// ---------------------------------------------------------------------------------------------

const UploadBody = z
  .object({
    name: z.string().max(200),
    media_type: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"]),
    data: z.string().max(10_000_000), // base64; express.json() accepts 10 MB (server/index.ts)
    question: z.string().min(1).max(1000),
  })
  .strict();

concept29.post("/upload", (req, res) => {
  const parsed = UploadBody.safeParse(req.body ?? {});
  return stream(req, res, async ({ emit, make, opened }) => {
    if (!parsed.success) return emit("error", { message: `Bad upload: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` });
    const { name, media_type, data, question } = parsed.data;
    const buf = Buffer.from(data, "base64");
    const first =
      media_type === "application/pdf" ? pdfDoc(buf, name)
      : media_type === "text/plain" ? textDoc(buf.toString("utf8"), name)
      : image(buf, media_type);
    const blocks = [first, text(question)];
    const options = make();
    opened(blocks, options, [null, null]);
    await runQuery(oneMessage(blocks), options, emit);
  });
});

// ---------------------------------------------------------------------------------------------
// POST /disk: files the agent opens itself (Read, @file), and images returned by a tool
// ---------------------------------------------------------------------------------------------

// #region disk
// No blocks in your code: the prompt is a plain string, and the file reaches the model through a tool.
const DISK: Record<string, { prompt: string; extra: Partial<Options>; files: string[] }> = {
  readImage: { prompt: "Read card.png and tell me the order number and the code word. One line.", extra: { tools: ["Read"] }, files: ["card.png"] },
  readLarge: { prompt: "Read big.png and tell me the order number and the code word. One line.", extra: { tools: ["Read"] }, files: ["big.png"] },
  readPdf: { prompt: "Read invoice.pdf and tell me the total. One line.", extra: { tools: ["Read"] }, files: ["invoice.pdf"] },
  readPages: { prompt: "Read only page 3 of invoice.pdf (use the pages parameter) and tell me the delivery password. One line.", extra: { tools: ["Read"] }, files: ["invoice.pdf"] },
  atImage: { prompt: "Look at @card.png and tell me the order number. One line.", extra: {}, files: ["card.png"] }, // no tools at all
  atPdf: { prompt: "Using @invoice.pdf, what is the invoice total? One line.", extra: {}, files: ["invoice.pdf"] },
  toolImage: { prompt: "Render the 2026 sales chart, then tell me which quarter has the highest bar. One line.", extra: { mcpServers: { charts } }, files: ["chart-2026.png"] },
};
// #endregion

const DiskBody = z.object({ scenario: z.enum(Object.keys(DISK) as [string, ...string[]]) }).strict();

concept29.post("/disk", (req, res) => {
  const parsed = DiskBody.safeParse(req.body ?? {});
  return stream(req, res, async ({ emit, make, opened }) => {
    if (!parsed.success) return emit("error", { message: `Unknown scenario. Allowed: ${Object.keys(DISK).join(", ")}.` });
    const c = DISK[parsed.data.scenario];
    const options = make(c.extra);
    opened(c.prompt, options);
    emit("files", { files: c.files });
    await runQuery(c.prompt, options, emit);
  });
});

// ---------------------------------------------------------------------------------------------
// GET /code: the lab's code in this file, cut at the #region markers
// ---------------------------------------------------------------------------------------------

const SOURCE = fileURLToPath(import.meta.url);

concept29.get("/code", (_req, res) => {
  const src = readFileSync(SOURCE, "utf8").replaceAll("\r\n", "\n");
  res.json(Object.fromEntries([...src.matchAll(/\/\/ #region (\w+)\n([\s\S]*?)\/\/ #endregion/g)].map(([, name, c]) => [name, c.trimEnd()])));
});
