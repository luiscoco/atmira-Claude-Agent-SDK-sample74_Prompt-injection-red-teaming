# Images & file input

This file explains Concept 29 (**Images & file input**) of the Claude Agent SDK Lab. The model can read **images**,
**PDFs** and **text documents**. They reach it in three ways: as **content blocks** your code writes, as **files on
disk** the agent opens itself, and as the **result of a tool**. Claude Code sits between your blocks and the API, and
it changes some of them. This concept shows each way in, what really reaches the API, and what it costs.

**Goal:** know how to send a file to `query()`, which way is cheapest for each case, and which surprises to expect:
resized images, silently replaced bytes, lost citations, and an `@file.pdf` that attaches nothing.

Concept 12 already sent **one** image block through streaming input. This concept covers the rest: PDFs, text
documents, URLs, citations, `Read`, `@file`, images from tools, and what Claude Code does to all of them.

| Concept | Topic | Routes |
|---|---|---|
| 29 | Images & file input: `image` / `document` blocks (base64, `text`, `url`), `title`, `context`, `citations`, Claude Code's rewrites, `Read` on images and PDFs (`tool_use_result`, `isSynthetic`, `pages`), `@file`, an MCP tool that returns an image, token costs, a wire tap | `/api/c29/files`, `/file/:name`, `/inline` (SSE), `/upload` (SSE), `/disk` (SSE), `/code` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/29-make-files.ts` | **New**: a tiny PNG encoder with a 5×7 bitmap font, a tiny PDF writer, and the lab's files |
| `server/concepts/29-images-files.ts` | **New**: the block builders, the wire tap, the image tool, the message relay, the routes |
| `server/index.ts` | Mounts the router on `/api/c29` |
| `src/concepts/Concept29ImagesFiles.tsx` | **New**: the tab (Parts A to D) and the upload form |
| `src/App.tsx` | Adds the tab |
| `src/styles.css` | Block rows, wire rows, file chips |
| `.gitignore` | Ignores `files-lab/` |
| `Tab1-query().md` | Adds Concept 29 to the table |

---

## Step 1: Three ways in

| Way | Who puts the file in the conversation | You write |
|---|---|---|
| **Content blocks** | Your code | An `SDKUserMessage` whose `message.content` is an array of blocks |
| **Files on disk** | The model (with `Read`) or Claude Code (for `@file`) | A plain string prompt |
| **Tool results** | Your custom tool | `{ type: "image", data, mimeType }` in the tool's `content` |

A **string prompt holds text only**. To send blocks, use streaming input (Concept 12), even for a single message.
Simplified from `oneMessage()` and `runQuery()` in [server/concepts/29-images-files.ts](server/concepts/29-images-files.ts):

```ts
async function* oneMessage(content: Block[]): AsyncGenerator<SDKUserMessage> {
  yield { type: "user", parent_tool_use_id: null, message: { role: "user", content } };
}
for await (const msg of query({ prompt: oneMessage(blocks), options })) { ... }
```

## Step 2: The lab's files, made by the server

The lab downloads nothing. `29-make-files.ts` draws its own PNGs (with a 5×7 bitmap font) and writes its own PDF.
**Each file holds a fact that is only inside it**, so a right answer proves the model read the file:

| File | What is inside |
|---|---|
| `card.png` (400×240) | “ORDER #4721”, “CODE: KESTREL”, a red circle, a green square, a blue triangle |
| `big.png` (2400×1440) | The same card, 6× larger |
| `chart-2026.png`, `chart-2027.png` | Bar charts with no numbers: the model must compare the bars |
| `invoice.pdf` (3 pages) | Invoice INV-2026-0917, total 1,284.50 EUR; page 3: “The delivery password is HERON” |
| `invoice.txt` | The same invoice as plain text |
| `policy.txt` | A 4-rule returns policy (for citations) |
| `noisy.png` (~11 MB) | Random pixels with the order number on a white band. Made on first use |

## Step 3: The content blocks

These are Messages API blocks. The SDK passes them on as they are. Simplified from the builders of the `blocks`
region in [server/concepts/29-images-files.ts](server/concepts/29-images-files.ts):

```ts
// Image, base64
{ type: "image", source: { type: "base64", media_type: "image/png", data } }
// Image, URL: the API downloads it
{ type: "image", source: { type: "url", url } }
// PDF, base64 (or source: { type: "url", url })
{ type: "document", source: { type: "base64", media_type: "application/pdf", data }, title: "invoice.pdf" }
// Plain text as a document: title and context help the model; citations let it cite
{ type: "document", source: { type: "text", media_type: "text/plain", data }, title, context, citations: { enabled: true } }
```

Put the file **before** the question. To refer to several images, put a label before each one (“Image 1:”,
“Image 2:”).

## Step 4: A wire tap, to see what reaches the API

What you send is not always what the API receives. To see the difference, the lab sets
`ANTHROPIC_BASE_URL = http://127.0.0.1:<port>/w/<run id>`. That points at a small proxy, similar to Concept 28's
fault proxy but without faults. It forwards every request and reports the **new user messages** of each main-loop
request. It also reads the API's raw answer for citations. The tab shows its rows in green:
`wire → API` and `wire ← API`.

Each block row shows its kind and size. For images it also shows the pixels and **≈ tokens**:
`width × height / 750`, computed after the API's own downscale (long edge ≤ 1568 px, about 1.15 megapixels).

The wire also shows what Claude Code adds to **every** first message: three `<system-reminder>` text blocks
(environment, model, date), shown faded. They explain why even “Reply with OK” costs about 240 input tokens.

## Step 5: Part A, content blocks (scenarios 0 to 11)

All numbers were measured with Haiku 4.5:

| # | Scenario | What happened | Input tokens |
|---|---|---|---|
| 0 | Text only | The baseline | 240 |
| 1 | One image, 400×240 | Unchanged on the wire; the model read the order number, the code word and the shapes | 393 |
| 2 | Two labelled images | Each image costs its own ~128 tokens; Q3 and Q4 | 533 |
| 3 | PDF, base64 | The API reads each page as text **and** as an image; cached by Claude Code | 5,106 (cache write) |
| 4 | The same invoice as text | Same answer | 489 |
| 5 | Citations | See Step 6 | 1,026 |
| 6 | URL image + URL PDF | Only the URLs go on the wire; the API downloads them | 1,975 |
| 7 | URL on upload.wikimedia.org | `API Error: 400 Unable to download the file`, an error result, a throw (like Concept 28) | 0 |
| 8 | PNG sent as `image/jpeg` | Claude Code reads the real type from the bytes: the wire shows `image/png` | 381 |
| 9 | Bytes that are not an image | Replaced by a text block: “[Image could not be processed …]”. **No error** | 287 |
| 10 | 2400×1440 image | Resized to 2000×1200, plus a text block with a coordinate note | 1,786 |
| 11 | 11 MB image | Re-encoded as a 487 KB JPEG, 2000×1385 (the API limit is 5 MB) | 1,833 |

Lessons:

- **A PDF costs about 10× the same text** (scenarios 3 and 4). When you already have the text, send the text. Send a
  PDF when its layout, tables or images matter.
- **Claude Code fixes some mistakes and hides others.** A wrong `media_type` just works. Bytes that are not an image
  become a note, and the result says `is_error: false`. If the file matters, check it yourself before you send it.
- **Big images are downsized twice**: first by Claude Code (to 2000 px), then by the API (to about 1.15 MP). The note
  “Multiply coordinates by 1.20” is for tasks that need pixel positions (clicks, boxes).
- **More pixels were not better.** Scenario 10 cost 12× the small card, and in every test run the model misread the
  order number (1721, 3721, 13721…). The 400×240 card was read right every time. Send the smallest image that still
  shows what matters.

## Step 6: Citations, and what the SDK drops

With `citations: { enabled: true }`, the API splits the answer into text blocks and attaches citations to the ones
that quote the document. The wire tap sees them in the raw answer:

```
wire ← API   2 citations in the raw answer
  char_location: “Customers may return unused items within 45 days of delivery.”
  char_location: “Items on clearance sale can only be exchanged, never refunded.”
```

But the SDK's assistant messages arrive like this:

```
assistant  citations: []   You have 45 days from delivery to return unused items.
assistant                  However,
assistant  citations: []   items on clearance sale can only be exchanged, never refunded.
```

The text is split in the right places, but the `citations` arrays are **empty**. With SDK 0.3.281, you cannot get
citations through `query()`. If you need them, call the Messages API directly (Concept 24).

## Step 7: Part B, files the agent opens itself

No blocks in your code: a string prompt, and the file comes through a tool.

| Scenario | What happened | Input tokens |
|---|---|---|
| `Read card.png` | `tool_result` holds an **image** block. The SDK also gives `tool_use_result: { type: "image", file: { originalSize, dimensions } }` | 3,141 |
| `Read big.png` | `dimensions`: original 2400×1440 → display 2000×1200, and a user message with `isSynthetic: true` holding the coordinate note | 4,546 |
| `Read invoice.pdf` | `tool_result` = a text line “PDF file read: invoice.pdf (1.9KB)” + a **document** block; `tool_use_result.type: "pdf"` | 7,884 |
| `Read pages: "3"` | `is_error`: “pdftoppm is not installed”. The model then read the whole PDF instead, so it paid for both calls | 9,743 |
| `@card.png` (no tools) | Before the turn, Claude Code runs `Read` itself and attaches the image. The wire shows “Called the Read tool …” and then the image | 459 |
| `@invoice.pdf` (no tools) | Only the text “PDF file read: invoice.pdf (1.9KB)” is attached, **not** the document. The model says it cannot see it | 391 |
| A tool returns an image | The MCP content `{ type: "image", data, mimeType }` becomes an Anthropic image block in the `tool_result` | 1,960 |

Lessons:

- **`Read` costs more than a block.** It takes two turns, and `Read`'s tool definition is in every request. Use it
  when the **model** should decide which file to open. When your code already knows the file, send a block.
- **`@image.png` is the cheapest way to send a local image**: no streaming input and no base64 in your code. It does
  not work for PDFs.
- **`pages` needs poppler** (`pdftoppm`) on the machine where Claude Code runs. Without it, the page range fails and
  the model falls back to the whole file.
- **`tool_use_result`** is the tool's full output object, on the user message that carries the `tool_result`. For `Read`, it tells
  you the file type, its size, and whether the image was resized, with no need to parse the `tool_result`.

## Step 8: An image returned by a tool

From the `tool` region of [server/concepts/29-images-files.ts](server/concepts/29-images-files.ts):

```ts
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
```

This is how a tool can show the model a screenshot, a chart or a scanned page. Mind the shape: MCP's `{ data, mimeType }`,
not Anthropic's `{ source: { … } }`. Claude Code converts it.

## Step 9: Your own file

The form under Part A reads a file with `FileReader.readAsDataURL()` and posts `{ name, media_type, data, question }`.
The server turns it into one block (`image`, a PDF `document`, or a `text` document) plus your question. The body is
checked with a strict zod schema, which accepts six media types: `image/png`, `image/jpeg`, `image/gif`,
`image/webp`, `application/pdf` and `text/plain`. Any other type (an SVG, a Word file…) is refused with a
"Bad upload" error, and the tab says so. A file whose type the browser does not know is sent as `text/plain`. The
JSON limit is 10 MB (`server/index.ts`), so the tab refuses files over 7 MB (base64 adds a third).

## Step 10: Part D, which way to choose

| You have | Send it as | Why |
|---|---|---|
| An image your code already has | An `image` block (or `@file.png` for a local file) | Cheapest: one turn |
| Text (from a PDF, a web page, a database) | A `text` document with `title` | About 10× cheaper than the PDF |
| A PDF whose layout matters | A PDF `document` block | The model sees each page as an image too |
| A public URL | A `url` source | No bytes in your code (some hosts refuse the API) |
| Files the model should choose | `tools: ["Read"]` | The model decides; it costs more turns |
| An image your tool makes | An MCP `image` in the tool's content | The model sees it in the `tool_result` |

## How it was built, step by step

This section follows the order in which the lab's tab was built, so you can rebuild it yourself. The code comes from
[server/concepts/29-images-files.ts](server/concepts/29-images-files.ts), its helper
[server/concepts/29-make-files.ts](server/concepts/29-make-files.ts), and
[src/concepts/Concept29ImagesFiles.tsx](src/concepts/Concept29ImagesFiles.tsx). The tab's **code** buttons show the
`blocks`, `disk`, `tool`, `messages`, `options` and `wire` regions.

### Step 1: Read the types

In `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, search for `SDKUserMessage`: its `message` is a Messages
API `MessageParam`, so its `content` can be an array of `image` and `document` blocks. Then search for
`tool_use_result` and `isSynthetic` (on the user messages), and `createSdkMcpServer` / `tool` (for the image tool).
What Claude Code does to the blocks (resizing, replacing, dropping citations) is not in the types at all. The wire
tap of Step 5 was built to see it.

### Step 2: Make the files, with no downloads

[server/concepts/29-make-files.ts](server/concepts/29-make-files.ts) has a small `Canvas` class (an RGB pixel buffer
with `rect`, `circle`, `triangle` and `text` in a 5×7 bitmap font) and a PNG encoder:

```ts
png(level = 9): Buffer {
  const raw = Buffer.alloc((this.w * 3 + 1) * this.h);
  for (let y = 0; y < this.h; y++) {
    raw[y * (this.w * 3 + 1)] = 0; // filter: none
    this.px.copy(raw, y * (this.w * 3 + 1) + 1, y * this.w * 3, (y + 1) * this.w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(this.w, 0);
  ihdr.writeUInt32BE(this.h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB, deflate, no filter, no interlace
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level })), chunk("IEND", Buffer.alloc(0))]);
}
```

- A PNG is a signature and three chunks. `deflateSync` and `crc32` both come from `node:zlib`, so there is no
  dependency.
- `noisyPng()` calls `png(1)` on random pixels: random data does not compress, which is how the file reaches ~11 MB.

The card is drawn with a scale factor, so `big.png` is the same picture, only larger:

```ts
export function cardPng(k = 1) {
  const c = new Canvas(400 * k, 240 * k);
  c.rect(0, 0, 400 * k, 8 * k, ORANGE);
  c.text(20 * k, 28 * k, "ORDER #4721", 4 * k, INK);
  c.text(20 * k, 72 * k, "CODE: KESTREL", 3 * k, INK);
  // … a red circle, a green square, a blue triangle
  return c.png();
}
```

The PDF and the text file come from the **same** data, so scenarios 3 and 4 compare the same facts:

```ts
export const invoicePdf = () => pdf(INVOICE_PAGES);
export const INVOICE_TXT = INVOICE_PAGES.map((p) => p.join("\n")).join("\n\n") + "\n";
```

`pdf()` writes one Helvetica text stream per page, the objects, and the `xref` table by hand.

### Step 3: The lab folder

```ts
const FILES: Record<string, () => Buffer | string> = {
  "card.png": () => cardPng(), // 400×240: an order number, a code word, three shapes
  "big.png": () => cardPng(6), // the same card at 2400×1440
  // … the two charts, invoice.pdf, invoice.txt, policy.txt
};
for (const [name, make] of Object.entries(FILES)) writeFileSync(path.join(WORK, name), make());
/** noisy.png (~11 MB) takes a few seconds to make, so it is made the first time a run needs it. */
function file(name: string) {
  const p = path.join(WORK, name);
  if (name === "noisy.png" && !existsSync(p)) writeFileSync(p, noisyPng());
  return readFileSync(p);
}
```

- `files-lab/` is deleted and rebuilt at start-up, and every file is written into `work/`, the agent's cwd. So
  `Read card.png` and `@card.png` find them.
- `noisy.png` is not in `FILES`, so the server does not make it at start-up, and the tab does not list it.

### Step 4: The block builders

The `blocks` region has one small function for each kind of block of Step 3 of the concept:

```ts
const image = (data: Buffer, media_type: ImageType = "image/png"): Block => ({ type: "image", source: { type: "base64", media_type, data: data.toString("base64") } });
const imageUrl = (url: string): Block => ({ type: "image", source: { type: "url", url } }); // the API downloads it
const pdfDoc = (data: Buffer, title?: string): Block => ({ type: "document", source: { type: "base64", media_type: "application/pdf", data: data.toString("base64") }, title });
```

```ts
/** A string prompt cannot carry blocks: send one SDKUserMessage through streaming input instead. */
async function* oneMessage(content: Block[]): AsyncGenerator<SDKUserMessage> {
  yield { type: "user", parent_tool_use_id: null, message: { role: "user", content } };
}
```

- `Block` is not written by hand: it is taken from the SDK's own type,
  `Exclude<SDKUserMessage["message"]["content"], string>[number]`. So a wrong block does not compile.
- `textDoc()` builds the text document with `title`, a fixed `context` and `citations: { enabled }`.

### Step 5: The wire tap

The same idea as Concept 28's fault proxy, without faults. For each main-loop request it reports only the **new**
user messages:

```ts
isMain = !String(typeof first === "string" ? first : first?.[0]?.text ?? "").startsWith("<session>"); // skip the side call
if (isMain) {
  const fresh = j.messages.slice(run.shown).filter((x: any) => x.role === "user");
  run.shown = j.messages.length;
  run.emit("wire", { n: ++run.n, messages: fresh.map((x: any) => (typeof x.content === "string" ? [describe({ type: "text", text: x.content })] : x.content.map(describe))) });
}
```

- Each request carries the whole conversation. `run.shown` remembers how many messages were already reported, so a
  second request only shows the `tool_result` that is new.
- `describe()` turns one block into a small row. For a base64 image, `dims()` reads the width and height from the
  PNG or JPEG header, and `imageTokens()` computes the "≈ tokens" of Step 4 of the concept.

After the answer is forwarded, the tap searches the raw stream for citations:

```ts
const cited = [...raw.matchAll(/"citation":\{"type":"(\w+)","cited_text":"((?:[^"\\]|\\.)*)"/g)].map(([, type, t]) => ({ type, cited_text: JSON.parse(`"${t}"`).trim() }));
if (cited.length) run.emit("wireCitations", { n: run.n, citations: cited });
```

That is the green `wire ← API` row of scenario 5, to compare with the empty `citations` of the SDK (Step 6 of the
concept).

### Step 6: The image tool and the options

```ts
tool("render_chart", "Renders the sales chart of a year as a PNG image. The chart has no numbers: compare the bars.", { year: z.enum(["2026", "2027"]) }, async ({ year }) => ({
  content: [
    { type: "image", data: file(`chart-${year}.png`).toString("base64"), mimeType: "image/png" },
    { type: "text", text: `Sales chart ${year} rendered (400×240).` },
  ],
})),
```

- The tool lives in an in-process MCP server, `charts` (`createSdkMcpServer`). Only the `toolImage` case adds it,
  through `mcpServers: { charts }`.

`baseOptions(baseUrl, abort, extra)` points `ANTHROPIC_BASE_URL` at the tap and starts with `tools: []`. A case
that needs `Read` adds it in `extra`. `canUseTool` allows only `Read` inside `files-lab/work` and
`mcp__charts__render_chart`. "Inside" is checked by a small helper, `inside(WORK, path.resolve(WORK, file_path))`,
built on `path.relative()`: a sibling folder whose name only starts with `work` is refused.

### Step 7: The relay, and one helper for every route

`relay()` (the `messages` region) sends the usual events, plus two that are special to this concept:

```ts
// Claude Code adds a user message of its own after a resized image: isSynthetic, with the coordinate note.
else if (b.type === "text" && m.isSynthetic) emit("synthetic", { text: short(b.text) });
```

```ts
const r = m.tool_use_result;
if (r && typeof r === "object" && !Array.isArray(r) && r.type)
  emit("toolUseResult", { type: r.type, mediaType: r.file?.type, originalSize: r.file?.originalSize, dimensions: r.file?.dimensions, filePath: r.file?.filePath && short(r.file.filePath) });
```

- The `result` event carries the four token counts (`input`, `cache_write`, `cache_read`, `output`). The tab adds the
  first three to get the "input tokens" of the tables above.

All three run routes share `stream()`. It opens the SSE stream and a tap run, and gives the route a small context:

```ts
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
```

- `opened` sends "what your code sent": the same `describe()` rows, without the base64, and with the file name of
  each block (for the thumbnail).
- A throw (scenario 7) becomes a `thrown` event, and the tap run is always closed.

### Step 8: The routes

`POST /inline` picks a scenario from a table. The browser only sends its name:

```ts
const INLINE: Record<string, () => { blocks: Block[]; files: (string | null)[] }> = {
  image: () => ({ blocks: [image(file("card.png")), text("What is the order number, the code word, and the three shapes with their colours? One line.")], files: ["card.png", null] }),
  // …
  mislabeled: () => ({ blocks: [image(file("card.png"), "image/jpeg"), text("What is the order number? One line.")], files: ["card.png", null] }),
  notImage: () => ({ blocks: [image(Buffer.from("hello, I am not a picture")), text("Describe the image in one line.")], files: [null, null] }),
  // …
};

const InlineBody = z.object({ scenario: z.enum(Object.keys(INLINE) as [string, ...string[]]) }).strict();
```

- Scenarios 8 and 9 are just a wrong argument to the same `image()` builder.
- The zod enum is built from the table's keys, so a new scenario needs no other change on the server.

`POST /upload` takes your file (Step 9 of the concept) and picks the block from the media type:

```ts
const buf = Buffer.from(data, "base64");
const first =
  media_type === "application/pdf" ? pdfDoc(buf, name)
  : media_type === "text/plain" ? textDoc(buf.toString("utf8"), name)
  : image(buf, media_type);
const blocks = [first, text(question)];
```

- `UploadBody` (zod, strict) lets through only the six media types of Step 9 of the concept. Any other type never
  reaches this code: the route sends a "Bad upload" error event.

`POST /disk` (the `disk` region) is a table of string prompts, each with its `extra` options:
`{ tools: ["Read"] }`, `{}` for the `@file` cases (no tools at all), or `{ mcpServers: { charts } }`. It sends a
`files` event first, so the tab can show what is on disk. `GET /files` and `GET /file/:name` serve the files of
`FILES` for the thumbnails:

```ts
if (!Object.hasOwn(FILES, name)) return res.status(404).end(); // not `in`: that also finds "constructor", "toString"…
```

- `name in FILES` would also be true for the keys every object inherits, so `/api/c29/file/constructor` got past
  the check. `Object.hasOwn()` looks only at the keys of `FILES`, and anything else is a 404.

### Step 9: Mount the router

In [server/index.ts](server/index.ts), one import and one line, like every other concept:

```ts
import { concept29 } from "./concepts/29-images-files.js";
// …
app.use("/api/c29", concept29); // also runs the wire tap (its own port on 127.0.0.1)
```

The same file sets `app.use(express.json({ limit: "10mb" }));`, which is what makes uploads of a few MB possible.

### Step 10: The React tab

Every button calls one `run()` function, with a different URL and body:

```tsx
await streamPost(url, body, (event, data) => {
  if (event === "done") return;
  if (event === "opened") return setSent(data.sent), setOptions(data.options);
  got.push({ event, data });
  setEvents([...got]);
});
```

- Part A: `run(s.label, "/api/c29/inline", { scenario: s.id }, s.hint)`. Part B: the same with `/api/c29/disk`.
- The `Blocks` component draws the rows of `sent`, `wire` and `toolResult`. When a row has a `file` that is an
  image, it shows a thumbnail from `/api/c29/file/<name>`.

The upload form reads the file in the browser:

```tsx
function pick(file: File | undefined) {
  if (!file) return setUpload(null);
  if (file.size > 7 * 1024 * 1024) return setError(`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB: the JSON body limit is 10 MB, so keep files under 7 MB (base64 adds a third).`);
  const reader = new FileReader();
  reader.onload = () => {
    const url = String(reader.result); // data:<type>;base64,....
    setUpload({ name: file.name, media_type: file.type || "text/plain", data: url.split(",")[1], url });
  };
  reader.readAsDataURL(file);
}
```

- `readAsDataURL()` gives `data:<type>;base64,<data>`. The part after the comma is the base64 the server expects.
- A file whose type the browser does not know (an empty `file.type`) is sent as `text/plain`.

Then register the tab in [src/App.tsx](src/App.tsx):

```tsx
{ id: 29, title: "Images & file input", Component: Concept29ImagesFiles },
```

### Step 11: Check that it works

1. `npx tsc --noEmit -p .` must print nothing.
2. `npm run dev`, open tab 29. The "lab's files" card shows the thumbnails: the files were made by the server.
3. Press **1 · One image**: "What your code sent" and the green `wire → API` row show the same 400×240 PNG.
4. Press **10 · A 2400×1440 image**: the wire row shows 2000×1200, and a text block with the coordinate note.

## How to try it

1. `npm run dev`, then open the **29. Images & file input** tab. `ANTHROPIC_API_KEY` must be in `.env`.
2. Press **0 · Text only**, then **1 · One image**, and compare the input tokens (240 and 393).
3. Press **3 · PDF** and then **4 · The same invoice as text**: the same answer, for 10× fewer tokens.
4. Press **5 · Citations**: compare the green `wire ← API` row with the `citations: []` of the assistant rows.
5. Press **9 · Bytes that are not an image**: see the text block that replaced it, and the result with no error.
6. In Part B, press **@card.png** and then **@invoice.pdf**, and compare what the wire attached.
7. Send a photo of your own with the form, and watch whether Claude Code resizes it.

Each run costs $0.015 or less. The PDF runs are the most expensive.
