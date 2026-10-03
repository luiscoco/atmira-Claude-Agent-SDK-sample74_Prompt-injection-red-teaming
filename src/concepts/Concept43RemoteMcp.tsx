import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";

type Ev = { event: string; data: any };

const t = (d: any) => (d.at !== undefined ? <span className="subtype" title="time since the start of the run">@ {(d.at / 1000).toFixed(1)} s</span> : null);
const usd = (n?: number) => (n === undefined ? "" : `$${n.toFixed(4)}`);
const statusClass = (s?: string) => (s === "connected" ? "good" : s === "pending" ? "" : "bad");

// Part A: what each outcome means. From the probes in Tab43-Remote-MCP-and-resources.md (Claude Code 2.1.281).
const OUTCOMES: [string, string, string][] = [
  ["No headers", "Claude Code reads the 401's WWW-Authenticate, finds the OAuth metadata, and would open a browser. It can't: needs-auth, no tools", "needs-auth (with dynamic client registration) or failed: Incompatible auth server (without)"],
  ["headers.Authorization, wrong token", "The OAuth fallback is off when you set the header. A 401 is final", 'failed: "Server rejected the configured Authorization header (HTTP 401)…"'],
  ["headers.Authorization, a token the host got", "The host did the OAuth (here client_credentials, no browser), Claude Code only sends the header", "connected"],
];

const LANE_TITLE: Record<string, string> = {
  "auth-none": "a · no headers",
  "auth-wrong": "b · a wrong token",
  "auth-host": "c · the host gets a token",
  "tr-http": 'type: "http" (Streamable HTTP)',
  "tr-sse": 'type: "sse" (HTTP+SSE, older)',
  "hr-mention": "a · an @-mention in the prompt",
  "hr-attach": "b · the host reads it and adds it to the prompt",
  "hr-ui": "c · q.readMcpResource(): the host reads through Claude Code",
};

function WireRow({ d }: { d: any }) {
  return (
    <div className={`tool-call wire ${d.dir === "out" ? "out" : ""}`}>
      <span className="tag tag-wire">{d.dir === "out" ? "remote →" : "→ remote"}</span>{" "}
      <code>
        {d.method} {d.path}
      </code>{" "}
      {d.rpc && <code className="rpc">{d.rpc}</code>} {d.status !== undefined && <code className={d.status >= 400 ? "bad" : "good"}>{d.status}</code>}{" "}
      {d.auth && d.auth !== "none" ? <span className="subtype">auth: {d.auth}</span> : d.dir !== "out" && <span className="subtype">no token</span>}{" "}
      {/* Streamable HTTP carries the session in the Mcp-Session-Id header; HTTP+SSE in the ?sessionId= of /messages */}
      {d.session && <span className="subtype">{d.path.endsWith("/messages") ? "?sessionId=" : "Mcp-Session-Id "}{d.session}…</span>}
      {t(d)}
    </div>
  );
}

function Status({ d }: { d: any }) {
  return (
    <div className="tool-call">
      <span className="tag tag-system">mcpServerStatus()</span> {d.label && <span className="subtype">{d.label}</span>}
      {d.servers.map((s: any) => (
        <div key={s.name} className="snippet">
          <b>{s.name}</b> <code className={statusClass(s.status)}>{s.status}</code> {s.serverInfo && <span className="subtype">{s.serverInfo.name}@{s.serverInfo.version}</span>}{" "}
          {s.tools && <span className="subtype">{s.tools.length} tools</span>} {s.error && <span className="bad">{s.error}</span>}
        </div>
      ))}
      {t(d)}
    </div>
  );
}

function Output({ o }: { o: any }) {
  if (!o) return null;
  if (o.error) return <span className="snippet bad">✗ {o.error}</span>;
  if (o.resources)
    return (
      <ul className="files">
        {o.resources.map((r: any) => (
          <li key={r.uri}>
            <code>{r.uri}</code> <span className="subtype">{r.name} · {r.mimeType} · server {r.server}</span>
          </li>
        ))}
      </ul>
    );
  if (o.contents)
    return (
      <>
        {o.contents.map((c: any) => (
          <div key={c.uri}>
            <code>{c.uri}</code> <span className="subtype">{c.mimeType}</span>
            {c.text && <pre className="tur wrap">{c.text}</pre>}
            {c.blobSavedTo && (
              <div className="snippet">
                a blob: saved to <code>{c.blobSavedTo}</code> (<b>blobSavedTo</b>), the model gets the path, not the bytes
              </div>
            )}
          </div>
        ))}
      </>
    );
  return (
    <>
      {o.text && <pre className="tur wrap">{o.text}</pre>}
      {o.resourceLinks?.length > 0 && (
        <div className="snippet">
          <b>tool_use_result.resourceLinks</b>: {o.resourceLinks.map((l: any) => <code key={l.uri}>{l.uri} </code>)}
        </div>
      )}
    </>
  );
}

function Trail({ events, wire = true }: { events: Ev[]; wire?: boolean }) {
  return (
    <>
      {events.map(({ event, data: d }, i) => {
        if (event === "wire") return wire ? <WireRow key={i} d={d} /> : null;
        if (event === "step")
          return (
            <div key={i} className="step-head">
              <b>{d.title}</b> <span className="hint">{d.note}</span>
            </div>
          );
        if (event === "options")
          return (
            <details key={i} className="tool-call call">
              <summary>
                <span className="tag tag-call">options</span> <span className="snippet">{JSON.stringify(d.mcpServers ?? { tools: d.tools }).slice(0, 150)}</span>
              </summary>
              <pre className="wrap tur">{JSON.stringify(Object.fromEntries(Object.entries(d).filter(([k]) => k !== "at")), null, 2)}</pre>
            </details>
          );
        if (event === "prompt")
          return (
            <details key={i} className="tool-call">
              <summary>
                <span className="tag tag-user">prompt</span> <span className="snippet">{d.prompt.split("\n")[0].slice(0, 120)}</span>
              </summary>
              <pre className="wrap tur">{d.prompt}</pre>
            </details>
          );
        if (event === "say")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-user">user turn</span> <span className="snippet">{d.text}</span>
            </div>
          );
        if (event === "oauth")
          return (
            <div key={i} className="tool-call hook">
              <span className="tag tag-oauth">host OAuth</span> <b>{d.step}</b> <span className="snippet">{d.detail}</span>
            </div>
          );
        if (event === "host")
          return (
            <div key={i} className={`tool-call hook ${d.error ? "denied" : ""}`}>
              <span className="tag tag-host">host</span> <code>{d.action}</code> {d.detail && <span className="snippet">→ {d.detail}</span>}
              {d.error && <span className="snippet bad">✗ {d.error}</span>}
              {d.html && <iframe className="mcp-app" sandbox="" srcDoc={d.html} title="the MCP App, sandboxed" />}
              {t(d)}
            </div>
          );
        if (event === "init")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-system">system/init</span>{" "}
              {d.mcpServers.map((s: any) => (
                <span key={s.name}>
                  <b>{s.name}</b> <code className={statusClass(s.status)}>{s.status}</code>{" "}
                </span>
              ))}
              · tools: <code>{d.tools.join(", ") || "(none)"}</code>
              {t(d)}
            </div>
          );
        if (event === "note")
          return (
            <div key={i} className={`tool-call hook ${d.ok ? "" : "denied"}`}>
              <span className="tag tag-verdict">check</span> <span className="snippet">{d.text}</span>
            </div>
          );
        if (event === "status") return <Status key={i} d={d} />;
        if (event === "tool")
          return (
            <div key={i} className="tool-call web-call">
              <span className={`tag ${d.name.startsWith("mcp__") ? "tag-call" : "tag-resource"}`}>{d.name}</span> <code>{JSON.stringify(d.input)}</code>
              {t(d)}
            </div>
          );
        if (event === "toolResult")
          return (
            <div key={i} className={`tool-call ${d.isError ? "denied" : "web-result"}`}>
              <span className={`tag ${d.isError ? "tag-error" : "tag-result"}`}>{d.name} →</span> <Output o={d.output} />
              {t(d)}
            </div>
          );
        if (event === "text")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-assistant">assistant</span> <span className="snippet">{d.text}</span>
            </div>
          );
        if (event === "result")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-result">result/{d.subtype}</span> <span className="subtype">{d.turns} turns · total_cost_usd {usd(d.cost)}</span>
            </div>
          );
        if (event === "files")
          return (
            <details key={i} className="tool-call" open>
              <summary>
                <span className="tag tag-store">CLAUDE_CONFIG_DIR</span>{" "}
                <span className="snippet">
                  mcp-needs-auth-cache.json: <code className={d.needsAuthCache && Object.keys(d.needsAuthCache).length ? "bad" : ""}>{JSON.stringify(d.needsAuthCache)}</code> · .credentials.json mcpOAuth:{" "}
                  {d.mcpOAuth ? `${Object.keys(d.mcpOAuth).length} entry` : "none"}
                </span>
              </summary>
              {d.mcpOAuth && <pre className="wrap tur">{JSON.stringify(d.mcpOAuth, null, 2)}</pre>}
            </details>
          );
        if (event === "error")
          return (
            <div key={i} className="tool-call denied">
              <span className="tag tag-error">error</span> <span className="snippet">{d.message}</span>
            </div>
          );
        return null;
      })}
    </>
  );
}

/** One card per lane: the rows of that lane, and its verdict at the bottom. */
function Lanes({ lanes, order, verdict }: { lanes: Record<string, Ev[]>; order: string[]; verdict?: (v: any, lane: string) => React.ReactNode }) {
  return (
    <div className="compare-grid lanes43">
      {order.map((l) => {
        const evs = lanes[l] ?? [];
        const v = evs.find((e) => e.event === "verdict")?.data;
        return (
          <div key={l} className="card">
            <b>{LANE_TITLE[l] ?? l}</b>
            <Trail events={evs.filter((e) => e.event !== "verdict")} />
            {v && verdict?.(v, l)}
            {!evs.length && <span className="hint">Waiting…</span>}
          </div>
        );
      })}
    </div>
  );
}

export function Concept43RemoteMcp() {
  const [facts, setFacts] = useState<any>(null);
  const [waiting, setWaiting] = useState(false);
  const [code, setCode] = useState<Record<string, string>>({});
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [auth, setAuth] = useState<Record<string, Ev[]>>({});
  const [fix, setFix] = useState("reconnect");
  const [cache, setCache] = useState<Ev[]>([]);
  const [transports, setTransports] = useState<Record<string, Ev[]>>({});
  const [toolsets, setToolsets] = useState<Record<string, Ev[]>>({});
  const [resources, setResources] = useState<Ev[]>([]);
  const [hostRead, setHostRead] = useState<Record<string, Ev[]>>({});
  const [steps, setSteps] = useState<string[]>(["expire", "sessions", "listchanged", "timeout"]);
  const [live, setLive] = useState<Ev[]>([]);

  useEffect(() => {
    // The server needs a few seconds to start (and restarts on a change): retry for up to 45 s instead of staying empty.
    let stopped = false;
    const get = async (url: string) => {
      for (let i = 0; ; i++) {
        try {
          const r = await fetch(url);
          if (r.ok) return r.json();
          if (![502, 503, 504].includes(r.status) || i >= 30) throw new Error(`${url}: HTTP ${r.status}${r.status === 502 ? " (is the server on port 3001 running?)" : ""}`);
        } catch (e) {
          if (i >= 30 || !(e instanceof TypeError)) throw e;
        }
        if (stopped) throw new Error("unmounted");
        setWaiting(true);
        await new Promise((r) => setTimeout(r, 1500));
      }
    };
    get("/api/c43/facts").then((f) => !stopped && setFacts(f)).catch((e) => !stopped && setError(String(e))).finally(() => !stopped && setWaiting(false));
    get("/api/c43/code").then((c) => !stopped && setCode(c)).catch(() => {});
    return () => {
      stopped = true;
    };
  }, []);

  async function run(key: string, url: string, body: unknown, onEvent: (event: string, data: any) => void) {
    setRunning(key);
    setError(null);
    try {
      await streamPost(url, body, (event, data) => {
        if (event === "error" && !data.lane) setError(data.message);
        if (event !== "done") onEvent(event, data);
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(null);
    }
  }
  const collect = (set: (f: (p: Ev[]) => Ev[]) => void) => (event: string, data: any) => set((p) => [...p, { event, data }]);
  const byLane = (set: (f: (p: Record<string, Ev[]>) => Record<string, Ev[]>) => void) => (event: string, data: any) =>
    data.lane && set((p) => ({ ...p, [data.lane]: [...(p[data.lane] ?? []), { event, data }] }));

  const btn = (key: string, label: string, onClick: () => void, disabled = false) => (
    <button className={running === key ? "active" : ""} onClick={onClick} disabled={!!running || disabled}>
      {running === key ? "Running…" : label}
    </button>
  );
  const resCheck = resources.find((e) => e.event === "check")?.data;
  const toolsetWire = toolsets["toolsets"] ?? [];

  return (
    <section>
      <h2>43 · Remote MCP servers and MCP resources</h2>
      <p className="lead">
        A <b>remote</b> MCP server is one Claude Code reaches over the network, usually behind OAuth. This lab runs one on its own port and protects it like a
        real one: what happens with no token, a wrong one, and one the host got itself; a cache that keeps a server out; the two transports; and a live session
        while the token expires and the server loses its sessions. Then <b>resources</b>, the other half of MCP: data by URI that the model lists and reads, links
        a tool returns, binary content, and what the host can read itself.
      </p>
      <div className="card">
        <pre>{`const token = await getToken(mcpUrl);                  // the HOST does the OAuth (a headless agent can't open a browser)
const shop: McpHttpServerConfig = { type: "http", url: mcpUrl, headers: { Authorization: \`Bearer \${token}\` }, timeout: 1500 };
const q = query({
  prompt: "Read the runbook and find the orders of ana.",
  options: {
    tools: ["ListMcpResourcesTool", "ReadMcpResourceTool"],  // the resource tools (tools: [] removes them)
    mcpServers: { shop },
    allowedTools: ["mcp__shop", "ListMcpResourcesTool", "ReadMcpResourceTool"],
  },
});
await q.setMcpServers({ shop: { ...shop, headers: { Authorization: \`Bearer \${newToken}\` } } }); // after a 401`}</pre>
      </div>

      {waiting && !facts && <div className="card warn">Waiting for the server on port 3001 to start… (the tab retries on its own)</div>}

      <h3>A · A protected remote server</h3>
      {facts && (
        <p className="hint">
          The remote runs on <code>{facts.remote}</code>. Every MCP request needs an OAuth access token. It publishes its OAuth metadata (
          <code>/.well-known/oauth-protected-resource</code>, <code>/.well-known/oauth-authorization-server</code>) and gives tokens to the client{" "}
          <code>{facts.client.id}</code> with <code>{facts.client.grant}</code> ({facts.client.tokenTtlSeconds} s). It serves {facts.serves.tools.length} tools, {facts.serves.resources.length} resources (
          {facts.serves.resources.map((r: string, i: number) => <span key={r}>{i > 0 && ", "}<code>{r}</code></span>)}) and {facts.serves.templates.length} resource template (
          {facts.serves.templates.map((r: string) => <code key={r}>{r}</code>)}). Each lane has its own URL path, so its
          rows (<b>→ remote</b>) can be told apart.
        </p>
      )}
      <table className="tools compare">
        <thead>
          <tr>
            <th>mcpServers.shop has…</th>
            <th>What Claude Code does</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {OUTCOMES.map((r) => (
            <tr key={r[0]}>
              <td>
                <b>{r[0]}</b>
              </td>
              <td>{r[1]}</td>
              <td>{r[2]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="scenarios">
        {btn("auth", "1 · Three agents connect to the remote", () => {
          setAuth({});
          run("auth", "/api/c43/auth", {}, byLane(setAuth));
        })}
      </div>
      <p className="hint">Each agent has a fresh CLAUDE_CONFIG_DIR. About $0.007 in all. A failed server doesn't fail the run: the model just has no shop tools.</p>
      {Object.keys(auth).length > 0 && (
        <Lanes
          lanes={auth}
          order={["auth-none", "auth-wrong", "auth-host"]}
          verdict={(v) => (
            <p className="hint">
              <b>shop:</b> <code className={statusClass(v.status)}>{v.status}</code> · shop tools: {v.shopTools.length ? v.shopTools.map((x: string) => <code key={x}>{x} </code>) : <b className="bad">none</b>} ·{" "}
              {usd(v.cost)}
            </p>
          )}
        />
      )}

      <h3>B · The needs-auth cache</h3>
      <p className="hint">
        When a server ends in <code>needs-auth</code>, Claude Code writes it in <code>CLAUDE_CONFIG_DIR/mcp-needs-auth-cache.json</code>, by server <b>name</b>.
        The next runs with that config dir skip the server at startup, <b>even with a valid token</b>. Three runs in one config dir: no token, then a good token,
        then a fix. About $0.01.
      </p>
      <div className="row">
        {(["reconnect", "delete-cache", "rename"] as const).map((f) => (
          <label key={f} className="check">
            <input type="radio" checked={fix === f} onChange={() => setFix(f)} disabled={!!running} /> {f === "reconnect" ? "q.reconnectMcpServer()" : f === "delete-cache" ? "delete the cache file" : "another server name"}
          </label>
        ))}
      </div>
      <div className="scenarios">
        {btn("cache", "2 · Three runs, one config dir", () => {
          setCache([]);
          run("cache", "/api/c43/cache", { fix }, collect(setCache));
        })}
      </div>
      {cache.length > 0 && (
        <div className="card">
          <Trail events={cache} />
        </div>
      )}

      <h3>C · Two transports</h3>
      <p className="hint">
        The same question over <code>type: "http"</code> (Streamable HTTP: one URL, an <code>Mcp-Session-Id</code>, answers in the POST response) and{" "}
        <code>type: "sse"</code> (the older HTTP+SSE: a GET stream, POSTs to a second URL answered <code>202</code>, the answers come on the stream). About $0.008.
      </p>
      <div className="scenarios">
        {btn("transports", "3 · http and sse, side by side", () => {
          setTransports({});
          run("transports", "/api/c43/transports", {}, byLane(setTransports));
        })}
      </div>
      {Object.keys(transports).length > 0 && (
        <Lanes lanes={transports} order={["tr-http", "tr-sse"]} verdict={(v) => <p className="hint">status <code className={statusClass(v.status)}>{v.status}</code> · {usd(v.cost)}</p>} />
      )}

      <h3>D · Resources: what the model gets</h3>
      <p className="hint">
        Resources are not tools: Claude Code gives the model built-in tools to reach them. Their types, read now from <code>sdk-tools.d.ts</code> and{" "}
        <code>sdk.d.ts</code>:
      </p>
      {facts && (
        <div className="grid2">
          {Object.entries(facts.types).map(([k, v]) => (
            <pre key={k} className="card wrap">
              {v as string}
            </pre>
          ))}
        </div>
      )}
      <div className="scenarios">
        {btn("toolsets", "4 · Three values of tools, stopped at system/init ($0)", () => {
          setToolsets({});
          run("toolsets", "/api/c43/toolsets", {}, byLane(setToolsets));
        })}
      </div>
      {Object.keys(toolsets).length > 0 && (
        <table className="tools compare">
          <thead>
            <tr>
              <th>options.tools</th>
              <th>tools in system/init</th>
              <th>MCP-related tools</th>
            </tr>
          </thead>
          <tbody>
            {["ts-empty", "ts-listed", "ts-default"].map((l) => {
              const v = toolsets[l]?.find((e) => e.event === "verdict")?.data;
              return (
                <tr key={l}>
                  <td>
                    <code>{v?.label ?? "…"}</code>
                  </td>
                  <td>{v?.total}</td>
                  <td>{v?.mcpish.map((x: string) => <div key={x}><code className={/Resource/.test(x) ? "good" : ""}>{x}</code></div>)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {toolsetWire.length > 0 && (
        <details className="card">
          <summary>The remote's requests ({toolsetWire.filter((e) => e.event === "wire").length}): the three sessions connect, then close before any model call</summary>
          <Trail events={toolsetWire} />
        </details>
      )}
      <div className="scenarios">
        {btn("resources", "5 · The model lists and reads resources", () => {
          setResources([]);
          run("resources", "/api/c43/resources", {}, collect(setResources));
        })}
      </div>
      <p className="hint">
        List, read a text resource, read a PNG (a blob), call a tool that returns <code>resource_link</code> blocks, and read one of those links: a URI of the{" "}
        <code>orders://{"{id}"}</code> template, which was never in the list. About $0.01 to $0.02.
      </p>
      {resCheck && (
        <p className="hint">
          <b>Check:</b> listed {resCheck.listed.map((u: string) => <code key={u}>{u} </code>)} (not <code>ui://orders/widget</code>, not the template) · read{" "}
          {resCheck.read.map((r: any, i: number) => (
            <code key={i} className={r.ok ? "good" : "bad"}>
              {r.server}:{r.uri}{" "}
            </code>
          ))}{" "}
          · resource links {resCheck.links.length} · restart word {resCheck.restartWord ? <b className="good">found</b> : <b className="bad">not found</b>} · {usd(resCheck.cost)}
        </p>
      )}
      {resources.length > 0 && (
        <div className="card">
          <Trail events={resources.filter((e) => e.event !== "check")} />
        </div>
      )}

      <h3>E · Resources the host reads</h3>
      <p className="hint">
        In the Claude Code terminal, <code>@shop:docs://runbook</code> in a prompt attaches the resource. In an SDK run it stays plain text. The host can read the
        resource with its own MCP client and put it in the prompt. And <code>q.readMcpResource()</code> reads a <code>ui://</code> resource (an MCP App a tool
        declares in <code>_meta.ui.resourceUri</code>) through Claude Code's connection, for the host to render sandboxed. The host gets one token for
        lanes a and b (its OAuth steps show in lane a). Lane c runs inside lane b's session, so its <code>resources/read ui://…</code> request shows in lane b. About $0.005.
      </p>
      <div className="scenarios">
        {btn("hostread", "6 · @-mention, host attach, readMcpResource()", () => {
          setHostRead({});
          run("hostread", "/api/c43/host-read", {}, byLane(setHostRead));
        })}
      </div>
      {Object.keys(hostRead).length > 0 && (
        <Lanes
          lanes={hostRead}
          order={["hr-mention", "hr-attach", "hr-ui"]}
          verdict={(v) => (
            <p className="hint">
              the answer has the restart word: {v.knowsWord ? <b className="good">yes</b> : <b className="bad">no</b>} · {usd(v.cost)}
            </p>
          )}
        />
      )}

      <h3>F · A live session while the remote changes</h3>
      <p className="hint">
        One streaming session (Concept 12) with <code>timeout: 1500</code> on the server. The remote changes between the turns, and the host reacts. In a session, each <code>result</code>'s{" "}
        <code>total_cost_usd</code> is the total so far, not that turn's cost. About $0.04
        for the four steps.
      </p>
      <div className="row">
        {[
          ["expire", "1 · the token expires"],
          ["sessions", "2 · the remote loses its sessions"],
          ["listchanged", "3 · a new resource"],
          ["timeout", "4 · a slow tool"],
        ].map(([k, label]) => (
          <label key={k} className="check">
            <input type="checkbox" checked={steps.includes(k)} disabled={!!running} onChange={() => setSteps(steps.includes(k) ? steps.filter((s) => s !== k) : [...steps, k])} /> {label}
          </label>
        ))}
      </div>
      <div className="scenarios">
        {btn(
          "live",
          "7 · Run the session",
          () => {
            setLive([]);
            run("live", "/api/c43/live", { steps }, collect(setLive));
          },
          steps.length === 0,
        )}
      </div>
      {live.length > 0 && (
        <div className="card">
          <Trail events={live} />
        </div>
      )}

      <h3>G · The code</h3>
      <div className="row">
        {["remote", "oauth", "options", "run", "auth", "cache", "transports", "toolsets", "resources", "hostread", "live"].map(
          (r) =>
            typeof code[r] === "string" && (
              <button key={r} className={openCode === r ? "active" : ""} onClick={() => setOpenCode(openCode === r ? null : r)}>
                code: {r}
              </button>
            ),
        )}
      </div>
      {openCode && typeof code[openCode] === "string" && (
        <div className="card">
          <pre className="wrap">{code[openCode]}</pre>
        </div>
      )}

      {error && (
        <div className="card warn">
          <b>error</b> — <code>{error}</code>
        </div>
      )}
    </section>
  );
}
