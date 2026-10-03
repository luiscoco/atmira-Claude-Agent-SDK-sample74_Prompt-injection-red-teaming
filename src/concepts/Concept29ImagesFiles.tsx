import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";

type Ev = { event: string; data: any };
type Row = { kind: string; detail?: string; tokens?: number; file?: string; children?: Row[] };

// Part A: content blocks written by YOUR code, sent in one SDKUserMessage (streaming input).
const inlineScenarios: { id: string; label: string; hint: string }[] = [
  {
    id: "textOnly",
    label: "0 · Text only (baseline)",
    hint: "No file: one text block. Claude Code adds its own system-reminder blocks (environment, model, date) before yours, so even “Reply with OK” costs about 240 input tokens. Compare the other scenarios with this number.",
  },
  {
    id: "image",
    label: "1 · One image",
    hint: "{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } } before the question. Image first, question after, as the docs advise. The wire shows it reaching the API unchanged. 400×240 ≈ 128 tokens (width × height / 750): about 393 input tokens in all. The model reads the order number, the code word and the shapes.",
  },
  {
    id: "twoImages",
    label: "2 · Two images, labelled",
    hint: "Text blocks “Image 1:” and “Image 2:” between the images let the question refer to each one. Each image is its own block and costs its own tokens (about 533 input tokens in all).",
  },
  {
    id: "pdf",
    label: "3 · PDF (base64)",
    hint: "{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }. The API reads each page twice: as extracted text AND as a page image. A 3-page, 1.9 KB PDF cost about 5,100 input tokens, and Claude Code cached them (cache_write, billed at 1.25×). Compare with scenario 4.",
  },
  {
    id: "textDoc",
    label: "4 · The same invoice as text",
    hint: "{ type: 'document', source: { type: 'text', media_type: 'text/plain', data }, title, context }. Same facts, same answer, about 490 input tokens: 10× cheaper than the PDF. When you already have the text, send the text.",
  },
  {
    id: "citations",
    label: "5 · Citations: the SDK drops them",
    hint: "citations: { enabled: true } on a text document. The wire tap reads the API's answer: it carries char_location citations with the cited text. But the SDK's assistant messages arrive with citations: [], split into several text blocks. With 0.3.281 you cannot get the citations through query().",
  },
  {
    id: "url",
    label: "6 · URL sources",
    hint: "{ source: { type: 'url', url } } for an image and a PDF. Your code sends only the URL, and the API downloads the file. The wire shows just the URL. About 1,975 input tokens.",
  },
  {
    id: "urlBlocked",
    label: "7 · A URL the API cannot fetch",
    hint: "Some hosts refuse the API's downloader (here: upload.wikimedia.org). The answer is API Error: 400 “Unable to download the file”, then an error result, then a throw, like any API error (Concept 28). $0.",
  },
  {
    id: "mislabeled",
    label: "8 · Wrong media_type",
    hint: "A PNG sent as media_type: 'image/jpeg'. The Messages API would reject that, but Claude Code reads the real type from the bytes: the wire shows image/png, and the run works.",
  },
  {
    id: "notImage",
    label: "9 · Bytes that are not an image",
    hint: "“hello, I am not a picture” as an image/png block. No error, no throw: Claude Code REPLACES the block with the text “[Image could not be processed …]” and the model apologises. Check your files yourself: a result with is_error: false does not mean the image arrived.",
  },
  {
    id: "large",
    label: "10 · A 2400×1440 image",
    hint: "Claude Code downsizes it to 2000×1200 and adds a text block: “[Image: original 2400x1440, displayed at 2000x1200. Multiply coordinates by 1.20 …]”. The API then downsizes it again, to about 1.15 megapixels (≈1,530 tokens, 12× the small card). In every test run the model MISREAD the order number here (1721, 3721, 13721…), and the 400×240 card was always right. More pixels are not better.",
  },
  {
    id: "huge",
    label: "11 · An 11 MB image",
    hint: "A noisy 2600×1800 PNG of about 11 MB (the API limit is 5 MB per image). Claude Code re-encodes it as a 487 KB JPEG at 2000×1385, so it goes through. The first run takes a few seconds, while the server makes the file.",
  },
];

// Part B: no blocks in your code. The file reaches the model through a tool.
const diskScenarios: { id: string; label: string; hint: string }[] = [
  {
    id: "readImage",
    label: "Read card.png",
    hint: "tools: ['Read'] and a plain string prompt. The model calls Read, and the tool_result holds an IMAGE block. The SDK also gives you tool_use_result: { type: 'image', file: { originalSize, dimensions } }. 2 turns plus Read's tool definition: about 3,100 input tokens against 393 inline.",
  },
  {
    id: "readLarge",
    label: "Read big.png",
    hint: "Read resizes the same way: displayWidth 2000 in tool_use_result, and a user message with isSynthetic: true that holds the coordinate note. That message is Claude Code's, not yours.",
  },
  {
    id: "readPdf",
    label: "Read invoice.pdf",
    hint: "Read turns the PDF into a text line (“PDF file read: invoice.pdf (1.9KB)”) plus a DOCUMENT block, so the model sees the same thing as scenario 3. tool_use_result.type is 'pdf'.",
  },
  {
    id: "readPages",
    label: "Read pages: '3'",
    hint: "The Read tool's pages parameter (“1-5”, “3”, at most 20 pages) renders the pages to images with pdftoppm (poppler). Without poppler on the machine, the tool_result is an is_error: “pdftoppm is not installed”. The model then reads the whole PDF instead, and pays for both calls.",
  },
  {
    id: "atImage",
    label: "@card.png in the prompt",
    hint: "No tools and a string prompt, yet the model sees the image. Before the first turn, Claude Code runs Read for every @file in the prompt and attaches the result: the wire shows “Called the Read tool …” and then the image block. The cheapest way to send a local image: no streaming input and no base64 in your code.",
  },
  {
    id: "atPdf",
    label: "@invoice.pdf in the prompt",
    hint: "The same trick with a PDF does NOT work: only the text “PDF file read: invoice.pdf (1.9KB)” is attached, not the document. The model says it cannot see the content. For a PDF, send a document block or allow Read.",
  },
  {
    id: "toolImage",
    label: "A tool returns an image",
    hint: "A custom MCP tool (Concept 5) returns { type: 'image', data, mimeType: 'image/png' }, MCP's own shape. Claude Code turns it into an Anthropic image block inside the tool_result. The model compares the bars and answers Q3.",
  },
];

// Part D: every way in, measured with Haiku 4.5.
const table: [string, string, string, string][] = [
  ["Text only", "string or text block", "adds its system-reminder blocks", "240"],
  ["Image 400×240", "image block, base64", "checks the media_type against the bytes", "393"],
  ["Image 2400×1440", "image block", "resizes it to 2000×1200 and adds a coordinate note; the API resizes it again", "1,786"],
  ["Image 11 MB", "image block", "re-encodes it as a 487 KB JPEG", "1,833"],
  ["Not an image", "image block", "replaces it with a text note: no error", "287"],
  ["PDF, 3 pages", "document block, base64", "nothing (the API reads text + page images)", "5,106"],
  ["The same invoice as text", "document block, text source", "nothing", "489"],
  ["Text + citations", "citations: { enabled: true }", "the API cites, but the SDK's copy has citations: []", "1,026"],
  ["URL image + URL PDF", "source.type: 'url'", "nothing: the API downloads them (some hosts refuse)", "1,975"],
  ["Read card.png", "tools: ['Read']", "image block in the tool_result + tool_use_result", "3,141"],
  ["Read invoice.pdf", "tools: ['Read']", "document block in the tool_result", "7,884"],
  ["Read pages: '3'", "tools: ['Read']", "needs pdftoppm (poppler); otherwise an is_error tool_result", "—"],
  ["@card.png", "a string prompt", "runs Read before the turn and attaches the image", "459"],
  ["@invoice.pdf", "a string prompt", "attaches only “PDF file read …”: the model does not see the PDF", "391"],
  ["A tool returns an image", "MCP content { type: 'image' }", "turns it into an image block in the tool_result", "1,960"],
];

function Blocks({ rows }: { rows: Row[] }) {
  return (
    <div className="blocks">
      {rows.map((r, i) => (
        <div key={i} className={`block kind-${r.kind.split(" ")[0].replace("_", "-")} ${r.kind.includes("system-reminder") ? "observer" : ""}`}>
          <code>{r.kind}</code> {r.detail && <span className="snippet">{r.detail}</span>}
          {r.tokens !== undefined && <span className="subtype">≈ {r.tokens} tokens</span>}
          {r.file && /\.(png|jpe?g|gif|webp)$/.test(r.file) && <img className="thumb" src={`/api/c29/file/${r.file}`} alt={r.file} />}
          {r.children && <Blocks rows={r.children} />}
        </div>
      ))}
    </div>
  );
}

function Timeline({ events }: { events: Ev[] }) {
  return (
    <div>
      {events.map(({ event, data }, i) => {
        const t = data.at !== undefined ? <span className="subtype">{(data.at / 1000).toFixed(1)} s</span> : null;
        switch (event) {
          case "files":
            return (
              <div key={i} className="tool-call">
                <span className="tag tag-user">on disk in files-lab/work</span> <code>{data.files.join(", ")}</code>
                <div className="row">
                  {data.files.filter((f: string) => f.endsWith(".png")).map((f: string) => (
                    <img key={f} className="thumb" src={`/api/c29/file/${f}`} alt={f} />
                  ))}
                </div>
              </div>
            );
          case "wire":
            return (
              <div key={i} className="tool-call wire">
                <span className="tag tag-wire">wire → API</span> <code>request {data.n}</code> <span className="subtype">new user message(s), as the API receives them</span> {t}
                {data.messages.map((rows: Row[], j: number) => (
                  <Blocks key={j} rows={rows} />
                ))}
              </div>
            );
          case "wireCitations":
            return (
              <div key={i} className="tool-call wire">
                <span className="tag tag-wire">wire ← API</span> <code>{data.citations.length} citations in the raw answer</code> {t}
                <div className="snippet">{data.citations.map((c: any) => `${c.type}: “${c.cited_text}”`).join("\n")}</div>
              </div>
            );
          case "init":
            return (
              <div key={i} className="tool-call">
                <span className="tag tag-system">system/init</span> <code>{data.model}</code> <span className="subtype">tools: [{data.tools.join(", ")}]</span> {t}
              </div>
            );
          case "assistant":
            return (
              <div key={i} className={`tool-call ${data.error ? "denied" : ""}`}>
                <span className="tag tag-assistant">assistant</span> {data.error && <code>error: {data.error}</code>}{" "}
                {data.citations && <code className={data.citations.length ? "" : "bad"}>citations: {JSON.stringify(data.citations)}</code>} {t}
                <div className="snippet">{data.text}</div>
              </div>
            );
          case "toolUse":
            return (
              <div key={i} className="tool-call">
                <span className="tag tag-pre">tool_use {data.name}</span> {t}
                <div className="snippet">{JSON.stringify(data.input)}</div>
              </div>
            );
          case "toolResult":
            return (
              <div key={i} className={`tool-call ${data.is_error ? "denied" : ""}`}>
                <span className="tag tag-mcp-stdio">tool_result</span> {data.is_error && <code className="bad">is_error</code>} {t}
                <Blocks rows={data.blocks} />
              </div>
            );
          case "toolUseResult":
            return (
              <div key={i} className="tool-call observer">
                <span className="tag tag-user">user.tool_use_result</span> {data.type && <code>type: {data.type}</code>} {t}
                <div className="snippet">
                  {data.error ??
                    [data.mediaType, data.originalSize !== undefined && `originalSize ${data.originalSize} B`, data.dimensions && `original ${data.dimensions.originalWidth}×${data.dimensions.originalHeight} → display ${data.dimensions.displayWidth}×${data.dimensions.displayHeight}`]
                      .filter(Boolean)
                      .join(" · ")}
                </div>
              </div>
            );
          case "synthetic":
            return (
              <div key={i} className="tool-call">
                <span className="tag tag-user">user (isSynthetic)</span> {t}
                <div className="snippet">{data.text}</div>
              </div>
            );
          case "result": {
            const k = data.tokens;
            return (
              <div key={i} className={`tool-call ${data.is_error ? "denied" : ""}`}>
                <span className="tag tag-result">result</span> <code>{data.subtype}</code> {data.is_error && <code className="bad">is_error: true</code>}
                <span className="subtype">
                  num_turns {data.num_turns} · input {k.input + k.cache_write + k.cache_read} tokens ({k.input} + cache_write {k.cache_write} + cache_read {k.cache_read}) · output {k.output} · ${data.cost.toFixed(4)}
                </span>{" "}
                {t}
                {data.text && <div className="snippet">{data.text}</div>}
              </div>
            );
          }
          case "thrown":
          case "error":
            return (
              <div key={i} className="tool-call denied">
                <span className="tag tag-error">{event === "thrown" ? "for await threw" : "error"}</span> {t}
                <div className="snippet">{data.message}</div>
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}

const ACCEPT = "image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain";

export function Concept29ImagesFiles() {
  const [code, setCode] = useState<Record<string, string>>({});
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [files, setFiles] = useState<{ name: string; bytes: number }[]>([]);
  const [events, setEvents] = useState<Ev[]>([]);
  const [sent, setSent] = useState<Row[] | null>(null);
  const [options, setOptions] = useState<unknown>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ name: string; media_type: string; data: string; url: string } | null>(null);
  const [question, setQuestion] = useState("Describe this file in two sentences.");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/c29/code")
      .then((r) => r.json())
      .then(setCode)
      .catch(() => setError("Could not reach /api/c29 — is this sample's server running on port 3001?"));
    fetch("/api/c29/files")
      .then((r) => r.json())
      .then(setFiles)
      .catch(() => {});
  }, []);

  async function run(label: string, url: string, body: unknown, h: string | null) {
    setRunning(label);
    setHint(h);
    setError(null);
    setOptions(null);
    setSent(null);
    const got: Ev[] = [];
    setEvents([]);
    try {
      await streamPost(url, body, (event, data) => {
        if (event === "done") return;
        if (event === "opened") return setSent(data.sent), setOptions(data.options);
        got.push({ event, data });
        setEvents([...got]);
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(null);
    }
  }

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

  const result = events.filter((e) => e.event === "result");
  const cost = result.reduce((s, e) => s + e.data.cost, 0);
  const tokens = result.reduce((s, e) => s + e.data.tokens.input + e.data.tokens.cache_write + e.data.tokens.cache_read, 0);

  return (
    <section>
      <h2>29 · Images &amp; file input</h2>
      <p className="lead">
        The model can read images, PDFs and text documents, sent three ways: as <b>content blocks</b> your code puts in a user message, as <b>files on
        disk</b> the agent opens with <code>Read</code> (or an <code>@file</code> in the prompt), and as the <b>result of a tool</b>. Claude Code sits
        between your blocks and the API and changes some of them. A small <b>wire tap</b> at <code>ANTHROPIC_BASE_URL</code> shows what really reaches the
        API.
      </p>

      <div className="card">
        <b>The lab's files</b> <span className="subtype">made by the server (no downloads) in files-lab/work. Each one holds a fact the model can only get by reading it</span>
        <div className="row files-row">
          {files.map((f) => (
            <a key={f.name} href={`/api/c29/file/${f.name}`} target="_blank" rel="noreferrer" className="file-chip">
              {f.name.endsWith(".png") ? <img className="thumb" src={`/api/c29/file/${f.name}`} alt={f.name} /> : <span className="doc-icon">{f.name.split(".").pop()}</span>}
              <code>{f.name}</code>
              <span className="subtype">{f.bytes < 10240 ? `${f.bytes} B` : `${(f.bytes / 1024).toFixed(0)} KB`}</span>
            </a>
          ))}
        </div>
      </div>

      <h3>A · Content blocks in the user message</h3>
      <p className="hint">
        A string prompt holds text only. For an image or a document, send an <code>SDKUserMessage</code> whose <code>message.content</code> is an array of
        blocks, through streaming input (Concept 12). Each run is one message with one question.
      </p>
      <div className="scenarios">
        {inlineScenarios.map((s) => (
          <button key={s.id} disabled={!!running} className={running === s.label ? "active" : ""} onClick={() => run(s.label, "/api/c29/inline", { scenario: s.id }, s.hint)}>
            {s.label}
          </button>
        ))}
      </div>

      <div className="card config">
        <label>your own file (PNG, JPEG, GIF, WebP, PDF or plain text, up to 7 MB; the server refuses any other type) → one block + your question</label>
        <input type="file" accept={ACCEPT} onChange={(e) => pick(e.target.files?.[0])} />
        {upload && upload.media_type.startsWith("image/") && <img className="thumb" src={upload.url} alt={upload.name} />}
        <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Your question about the file" />
        <button
          className="primary"
          disabled={!!running || !upload || !question.trim()}
          onClick={() => upload && run("your file", "/api/c29/upload", { name: upload.name, media_type: upload.media_type, data: upload.data, question }, `Your file goes into a ${upload.media_type.startsWith("image/") ? "image" : "document"} block (${upload.media_type}), then your question as a text block. Only PNG, JPEG, GIF, WebP, PDF and plain text are accepted (a file with no type is sent as text/plain); any other type is refused. Watch the wire: does Claude Code change it?`)}
        >
          {running === "your file" ? "Running…" : "Send my file"}
        </button>
      </div>

      <h3>B · Files the agent opens itself, and images from a tool</h3>
      <div className="scenarios">
        {diskScenarios.map((s) => (
          <button key={s.id} disabled={!!running} className={running === s.label ? "active" : ""} onClick={() => run(s.label, "/api/c29/disk", { scenario: s.id }, s.hint)}>
            {s.label}
          </button>
        ))}
      </div>

      {hint && <p className="hint">{hint}</p>}
      {sent && (
        <div className="card">
          <b>What your code sent</b> <span className="subtype">the message content, without the base64</span>
          <Blocks rows={sent} />
        </div>
      )}
      {(events.length > 0 || running) && (
        <div className="card">
          <b>Events</b>{" "}
          <span className="subtype">
            {running ? `running "${running}"…` : "done"} · input {tokens} tokens · ${cost.toFixed(4)}
          </span>
          <Timeline events={events} />
        </div>
      )}
      {options !== null && (
        <details className="card">
          <summary className="subtype">options sent to query()</summary>
          <pre className="wrap">{JSON.stringify(options, null, 2)}</pre>
        </details>
      )}

      <h3>C · The code</h3>
      <div className="row">
        {["blocks", "disk", "tool", "messages", "options", "wire"].map(
          (r) =>
            code[r] && (
              <button key={r} className={openCode === r ? "active" : ""} onClick={() => setOpenCode(openCode === r ? null : r)}>
                code: {r}
              </button>
            ),
        )}
      </div>
      {openCode && code[openCode] && (
        <div className="card">
          <pre className="wrap">{code[openCode]}</pre>
        </div>
      )}

      <h3>D · Every way in, compared</h3>
      <table className="tools compare">
        <thead>
          <tr>
            <th>input</th>
            <th>how</th>
            <th>what Claude Code does before the API</th>
            <th>input tokens (Haiku 4.5)</th>
          </tr>
        </thead>
        <tbody>
          {table.map(([f, h, c, n]) => (
            <tr key={f}>
              <td>
                <code>{f}</code>
              </td>
              <td>{h}</td>
              <td>{c}</td>
              <td>{n}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {error && (
        <div className="card warn">
          <b>error</b> — <code>{error}</code>
        </div>
      )}
    </section>
  );
}
