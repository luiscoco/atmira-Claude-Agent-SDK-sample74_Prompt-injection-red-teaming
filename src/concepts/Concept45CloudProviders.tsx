import { useEffect, useState } from "react";
import { streamPost } from "../lib/sse";

type Ev = { event: string; data: any };

const t = (d: any) => (d.at !== undefined ? <span className="subtype" title="time since the start of the run">@ {(d.at / 1000).toFixed(1)} s</span> : null);
const usd = (n?: number) => (n === undefined ? "" : `$${n.toFixed(4)}`);

// The switches, from the probes in Tab45-Cloud-providers.md (Claude Code 2.1.281).
const PROVIDERS: [string, string, string, string, string, string][] = [
  ["firstParty", "(nothing: the default)", "api.anthropic.com · ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, a Claude login", "claude-haiku-4-5-20251001", "POST /v1/messages"],
  ["bedrock", "CLAUDE_CODE_USE_BEDROCK=1 + AWS_REGION", "bedrock-runtime.<region>.amazonaws.com · ANTHROPIC_BEDROCK_BASE_URL", "the AWS SDK chain (keys, profile, SSO, role) · AWS_BEARER_TOKEN_BEDROCK · awsCredentialExport", "us.anthropic.claude-haiku-4-5-20251001-v1:0", "POST /model/<id>/invoke-with-response-stream"],
  ["vertex", "CLAUDE_CODE_USE_VERTEX=1 + ANTHROPIC_VERTEX_PROJECT_ID + CLOUD_ML_REGION", "<region>-aiplatform.googleapis.com · ANTHROPIC_VERTEX_BASE_URL", "Google ADC (gcloud login, a service account, Workload Identity Federation)", "claude-haiku-4-5@20251001", "POST …/publishers/anthropic/models/<id>:streamRawPredict"],
  ["foundry", "CLAUDE_CODE_USE_FOUNDRY=1 + ANTHROPIC_FOUNDRY_RESOURCE", "<resource>.services.ai.azure.com/anthropic · ANTHROPIC_FOUNDRY_BASE_URL", "ANTHROPIC_FOUNDRY_API_KEY, or Microsoft Entra ID (Azure CLI, managed identity…)", "claude-haiku-4-5", "POST /anthropic/v1/messages"],
  ["mantle", "CLAUDE_CODE_USE_MANTLE=1 + AWS_REGION", "bedrock-mantle.<region>.api.aws · ANTHROPIC_BEDROCK_MANTLE_BASE_URL", "AWS credentials", "anthropic.claude-haiku-4-5", "POST /v1/messages"],
  ["anthropicAws", "CLAUDE_CODE_USE_ANTHROPIC_AWS=1 + ANTHROPIC_AWS_WORKSPACE_ID", "aws-external-anthropic.<region>.api.aws · ANTHROPIC_AWS_BASE_URL", "AWS credentials · ANTHROPIC_AWS_API_KEY", "claude-haiku-4-5-20251001", "POST /v1/messages + anthropic-workspace-id"],
  ["anthropicGoogleCloud", "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD=1 + ANTHROPIC_GOOGLE_CLOUD_PROJECT", "claude.googleapis.com · ANTHROPIC_GOOGLE_CLOUD_BASE_URL", "Google ADC", "claude-haiku-4-5-20251001", "POST /v1/messages"],
];

const LANE_TITLE: Record<string, string> = {
  "p-first": "firstParty · the Anthropic API",
  "p-bedrock": "bedrock · Amazon Bedrock",
  "p-vertex": "vertex · Google Vertex AI",
  "p-foundry": "foundry · Microsoft Foundry",
  "p-mantle": "mantle · Bedrock's Messages API",
  "p-aws": "anthropicAws · Claude Platform on AWS",
  "p-gcloud": "anthropicGoogleCloud · Claude Platform on Google Cloud",
  "au-sigv4": "a · Bedrock · AWS access keys (SigV4)",
  "au-apikey": "b · Bedrock · a Bedrock API key",
  "au-export": "c · Bedrock · awsCredentialExport (temporary credentials)",
  "au-none": "d · Bedrock · no credentials at all",
  "au-badsig": "e · Bedrock · the right key id, a wrong secret",
  "au-wif": "f · Vertex · Workload Identity Federation",
  "au-foundry": "g · Foundry · an API key",
  "au-gateway": "h · an LLM gateway (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN)",
  "mo-default": "a · Bedrock · the default (AWS_REGION=us-east-1)",
  "mo-eu": "b · Bedrock · AWS_REGION=eu-west-1",
  "mo-global": "c · Bedrock · the account's profiles + REGION_PREFIX=global",
  "mo-apac": "d · Bedrock · the same, REGION_PREFIX=apac",
  "mo-arn": "e · Bedrock · an application inference profile ARN",
  "mo-override": "f · Bedrock · modelOverrides: haiku → the ARN",
  "mo-pin": "g · Bedrock · ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "mo-vertex-region": "h · Vertex · VERTEX_REGION_CLAUDE_HAIKU_4_5",
  "fa-bedrock-denied": "a · Bedrock · Sonnet not enabled (403)",
  "fa-vertex-denied": "b · Vertex · Sonnet not enabled (404)",
  "fa-throttle": "c · Bedrock · ThrottlingException (429)",
  "fa-fallback-denied": "d · Bedrock · Sonnet not enabled + fallbackModel",
  "fa-fallback-overloaded": "e · Bedrock · Sonnet overloaded (529) + fallbackModel",
};

function CloudRowView({ d }: { d: any }) {
  return (
    <div className={`tool-call wire cloud-call ${d.status >= 400 ? "denied" : ""}`}>
      <span className="tag tag-cloud">→ cloud</span> <b className="subtype">{d.kind}</b> <code>{d.method} {d.path.length > 110 ? `${d.path.slice(0, 110)}…` : d.path}</code>{" "}
      <code className={d.status >= 400 ? "bad" : "good"}>{d.status}</code>
      {d.wireModel && d.provider !== "anthropic" && (
        <span className="subtype">
          {" "}
          · model on the wire <code>{d.wireModel}</code> → <code>{d.model}</code>
        </span>
      )}
      {d.version && <span className="subtype"> · {d.version}</span>}
      {d.auth && (
        <div className="snippet">
          {d.authOk === false ? <b className="bad">✗</b> : <b className="good">✓</b>} {d.auth}
        </div>
      )}
      {d.note && <div className="snippet">{d.note}</div>}
      {t(d)}
    </div>
  );
}

function Trail({ events }: { events: Ev[] }) {
  return (
    <>
      {events.map(({ event, data: d }, i) => {
        if (event === "cloud") return <CloudRowView key={i} d={d} />;
        if (event === "options")
          return (
            <details key={i} className="tool-call call">
              <summary>
                <span className="tag tag-call">options</span>{" "}
                <span className="snippet">
                  {d.model && `model: ${d.model}${d.fallbackModel ? `, fallbackModel: ${d.fallbackModel}` : ""} · `}
                  {Object.keys(d.env ?? {}).join(", ").slice(0, 200) || "(no extra env)"}
                  {d.settings && " · settings"}
                </span>
              </summary>
              <pre className="wrap tur">{JSON.stringify(Object.fromEntries(Object.entries(d).filter(([k]) => k !== "at" && k !== "lane")), null, 2)}</pre>
            </details>
          );
        if (event === "init")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-system">system/init</span> model <code>{d.model}</code> · <span className="subtype">apiKeySource {d.apiKeySource}</span>
              {t(d)}
            </div>
          );
        if (event === "account")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-system">accountInfo()</span> <code>{JSON.stringify(d.account)}</code>
            </div>
          );
        if (event === "retry")
          return (
            <div key={i} className="tool-call denied">
              <span className="tag tag-error">system/api_retry</span> attempt {d.attempt}/{d.max} · status <code>{d.status}</code> · error <code>{d.error}</code> · wait {d.delay} ms
              {t(d)}
            </div>
          );
        if (event === "tool")
          return (
            <div key={i} className="tool-call web-call">
              <span className="tag tag-call">{d.name}</span> <code>{JSON.stringify(d.input).slice(0, 160)}</code>
              {t(d)}
            </div>
          );
        if (event === "toolResult")
          return (
            <div key={i} className={`tool-call ${d.isError ? "denied" : "web-result"}`}>
              <span className={`tag ${d.isError ? "tag-error" : "tag-result"}`}>tool_result</span> <span className="snippet">{d.text}</span>
            </div>
          );
        if (event === "text")
          return (
            <div key={i} className={`tool-call ${d.error ? "denied" : ""}`}>
              <span className={`tag ${d.error ? "tag-error" : "tag-assistant"}`}>assistant{d.error ? ` · error: ${d.error}` : ""}</span> <span className="snippet">{d.text}</span>
            </div>
          );
        if (event === "catalog")
          return (
            <div key={i} className="tool-call">
              <span className="tag tag-system">initializationResult()</span> account <code>{JSON.stringify(d.account)}</code> · {d.models.length} models
            </div>
          );
        if (event === "result")
          return (
            <div key={i} className={`tool-call ${d.isError ? "denied" : ""}`}>
              <span className={`tag ${d.isError ? "tag-error" : "tag-result"}`}>result/{d.subtype}{d.isError ? " · is_error" : ""}</span>{" "}
              <span className="subtype">
                {d.turns} turns · total_cost_usd {usd(d.cost)}
              </span>
              {d.usage.map((u: any) => (
                <div key={u.key} className="snippet">
                  modelUsage[<code>{u.key}</code>]: canonicalModel <code>{u.canonicalModel}</code> · provider <code>{u.provider}</code> · {usd(u.costUSD)} ({u.costBasis}) · input {u.input}, cache read {u.cacheRead}, cache write {u.cacheWrite}
                </div>
              ))}
              {t(d)}
            </div>
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

function Lanes({ lanes, order }: { lanes: Record<string, Ev[]>; order: string[] }) {
  return (
    <div className="compare-grid lanes43">
      {order.map((l) => {
        const evs = (lanes[l] ?? []).filter((e) => e.event !== "verdict");
        return (
          <div key={l} className="card">
            <b>{LANE_TITLE[l] ?? l}</b>
            <Trail events={evs} />
            {!evs.length && <span className="hint">Waiting…</span>}
          </div>
        );
      })}
    </div>
  );
}

const verdictOf = (lanes: Record<string, Ev[]>, l: string) => lanes[l]?.find((e) => e.event === "verdict")?.data;
const ResultCell = ({ run }: { run: any }) =>
  run.isError ? (
    <>
      <b className="bad">is_error</b> <code>{run.error ?? run.subtype}</code>
      <div className="snippet">{run.text.slice(0, 500)}</div>
    </>
  ) : (
    <>
      <b className="good">✓</b> <span className="snippet">{run.text.slice(0, 80)}</span>
    </>
  );

export function Concept45CloudProviders() {
  const [facts, setFacts] = useState<any>(null);
  const [waiting, setWaiting] = useState(false);
  const [code, setCode] = useState<Record<string, string>>({});
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [catalog, setCatalog] = useState<Record<string, Ev[]>>({});
  const [same, setSame] = useState<Record<string, Ev[]>>({});
  const [auth, setAuth] = useState<Record<string, Ev[]>>({});
  const [models, setModels] = useState<Record<string, Ev[]>>({});
  const [fails, setFails] = useState<Record<string, Ev[]>>({});

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
    get("/api/c45/facts").then((f) => !stopped && setFacts(f)).catch((e) => !stopped && setError(String(e))).finally(() => !stopped && setWaiting(false));
    get("/api/c45/code").then((c) => !stopped && setCode(c)).catch(() => {});
    return () => {
      stopped = true;
    };
  }, []);

  async function run(key: string, url: string, set: (f: (p: Record<string, Ev[]>) => Record<string, Ev[]>) => void) {
    set(() => ({}));
    setRunning(key);
    setError(null);
    try {
      await streamPost(url, {}, (event, data) => {
        if (event === "error" && !data.lane) setError(data.message);
        if (event !== "done" && data.lane) set((p) => ({ ...p, [data.lane]: [...(p[data.lane] ?? []), { event, data }] }));
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(null);
    }
  }
  const btn = (key: string, label: string, url: string, set: (f: (p: Record<string, Ev[]>) => Record<string, Ev[]>) => void) => (
    <button className={running === key ? "active" : ""} onClick={() => run(key, url, set)} disabled={!!running}>
      {running === key ? "Running…" : label}
    </button>
  );
  const P_LANES = ["p-first", "p-bedrock", "p-vertex", "p-foundry", "p-mantle", "p-aws", "p-gcloud"];
  const total = (lanes: Record<string, Ev[]>) => Object.values(lanes).flat().filter((e) => e.event === "result").reduce((a, e) => a + e.data.cost, 0);

  return (
    <section>
      <h2>45 · Cloud providers</h2>
      <p className="lead">
        The same agent can run on the Anthropic API or on a cloud your company already buys from: <b>Amazon Bedrock</b>, <b>Google Vertex AI</b>, <b>Microsoft Foundry</b>, and the newer
        Claude Platform endpoints on AWS and Google Cloud. There is no provider option in <code>query()</code>: <b>one environment switch</b> picks the provider, and Claude Code changes the
        whole call (URL, model id, auth, body). The lab has no cloud account, so it runs <b>"the cloud"</b>: a local server that speaks each provider's format, checks each provider's
        credentials, and forwards the call to the Anthropic API with the lab's key. The agent itself never gets an Anthropic key on the cloud lanes.
      </p>
      <div className="card">
        <pre>{`const q = query({
  prompt: "Read notes.txt and tell me the refund number.",
  options: {
    model: "haiku",                       // an alias: each provider turns it into its own id
    env: {
      ...process.env,
      CLAUDE_CODE_USE_BEDROCK: "1",       // or CLAUDE_CODE_USE_VERTEX / _FOUNDRY / _MANTLE / _ANTHROPIC_AWS / _ANTHROPIC_GOOGLE_CLOUD
      AWS_REGION: "us-east-1",            // required on Bedrock: it is not read from ~/.aws/config
      // credentials: whatever the cloud SDK finds (keys, profile, SSO, instance role), or AWS_BEARER_TOKEN_BEDROCK
    },
  },
});
// (await q.accountInfo()).apiProvider === "bedrock"; result.modelUsage["us.anthropic.claude-haiku-4-5-20251001-v1:0"].provider === "bedrock"`}</pre>
      </div>

      {waiting && !facts && <div className="card warn">Waiting for the server on port 3001 to start… (the tab retries on its own)</div>}

      <h3>A · The switches</h3>
      <p className="hint">
        Claude Code {facts?.claudeCodeVersion ?? "…"}. <code>AccountInfo.apiProvider</code> (sdk.d.ts): <code>{facts?.apiProvider ?? "…"}</code>. The lab's cloud:{" "}
        <code>{facts?.cloud ?? "…"}</code>, one URL prefix per lane. Each lane sets the provider's <code>*_BASE_URL</code> to it; the cloud lanes of scenarios 1, 2, 4 and 5 also set{" "}
        <code>CLAUDE_CODE_SKIP_*_AUTH=1</code> (scenario 3 is about credentials, so it does not).
      </p>
      <table className="tools compare">
        <thead>
          <tr>
            <th>apiProvider</th>
            <th>switch</th>
            <th>endpoint · override</th>
            <th>credentials</th>
            <th>"haiku" becomes</th>
            <th>the call</th>
          </tr>
        </thead>
        <tbody>
          {PROVIDERS.map((r) => (
            <tr key={r[0]}>
              <td>
                <code>{r[0]}</code>
              </td>
              <td>
                <code>{r[1]}</code>
              </td>
              <td className="snippet">{r[2]}</td>
              <td className="snippet">{r[3]}</td>
              <td>
                <code>{r[4]}</code>
              </td>
              <td className="snippet">{r[5]}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>B · What each provider offers, before any call</h3>
      <p className="hint">
        Seven sessions that never get a prompt: <code>initializationResult()</code> is answered by the CLI itself. The model list is in each provider's ids, and the default model is not
        the same everywhere. <b>$0</b>: no model is called (Bedrock already lists the account's inference profiles).
      </p>
      <div className="scenarios">{btn("catalog", "1 · The catalog on seven providers", "/api/c45/catalog", setCatalog)}</div>
      {Object.keys(catalog).length > 0 && (
        <div className="compare-grid lanes43">
          {P_LANES.map((l) => {
            const c = catalog[l]?.find((e) => e.event === "catalog")?.data;
            return (
              <div key={l} className="card">
                <b>{LANE_TITLE[l]}</b>
                {catalog[l]?.filter((e) => e.event === "cloud").map((e, i) => <CloudRowView key={i} d={e.data} />)}
                {c ? (
                  <>
                    <div className="snippet">
                      account <code>{JSON.stringify(c.account)}</code>
                    </div>
                    <table className="tools compare cloud-models">
                      <tbody>
                        {c.models.map((m: any) => (
                          <tr key={m.value} className={m.value === "default" ? "cloud-default" : ""}>
                            <td>
                              <code>{m.value}</code>
                            </td>
                            <td className="snippet">{m.value === "default" ? m.description : m.displayName}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                ) : (
                  <span className="hint">Waiting…</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      <h3>C · The same agent on seven providers</h3>
      <p className="hint">
        <code>model: "haiku"</code>, one <code>Read</code> and an answer, on every provider at once. The <b>→ cloud</b> rows are what the cloud received: look at the URL, where the model
        id is, <code>anthropic_version</code>, and the beta flags. The SDK stream barely changes: <code>system/init.model</code>, <code>accountInfo().apiProvider</code> and the{" "}
        <code>modelUsage</code> key do. About $0.035.
      </p>
      <div className="scenarios">{btn("same", "2 · One agent, seven providers", "/api/c45/same", setSame)}</div>
      {Object.keys(same).length > 0 && (
        <>
          <table className="tools compare cloud-table">
            <thead>
              <tr>
                <th>provider</th>
                <th>the turn on the wire</th>
                <th>anthropic_version</th>
                <th>beta flags sent</th>
                <th>the SDK side</th>
                <th>answer · cost</th>
              </tr>
            </thead>
            <tbody>
              {P_LANES.map((l) => {
                const v = verdictOf(same, l);
                const firstBetas: string[] = verdictOf(same, "p-first")?.wire?.betas ?? [];
                return (
                  <tr key={l}>
                    <td>
                      <b>{LANE_TITLE[l].split(" · ")[0]}</b>
                    </td>
                    <td className="snippet">
                      {v?.wire ? (
                        <>
                          <code>{v.wire.method} {v.wire.path}</code>
                          <div>
                            model: <code>{v.wire.wireModel}</code>
                          </div>
                          {v.wire.note && <div>{v.wire.note}</div>}
                          <div className="subtype">{v.wire.auth}</div>
                        </>
                      ) : (
                        "…"
                      )}
                    </td>
                    <td>{v?.wire && <code>{v.wire.version ?? "(header only)"}</code>}</td>
                    <td className="snippet">
                      {v?.wire?.betas.map((b: string) => (
                        <code key={b} className={l !== "p-first" && !firstBetas.includes(b) ? "bad" : ""}>
                          {b}{" "}
                        </code>
                      ))}
                      {v?.wire && l !== "p-first" && firstBetas.filter((b) => !v.wire.betas.includes(b)).length > 0 && (
                        <div className="subtype">not sent here: {firstBetas.filter((b) => !v.wire.betas.includes(b)).join(", ")}</div>
                      )}
                    </td>
                    <td className="snippet">
                      {v && (
                        <>
                          init.model <code>{v.run.initModel}</code>
                          <div>
                            apiProvider <code>{v.run.provider}</code>
                          </div>
                          {v.run.usage.map((u: any) => (
                            <div key={u.key}>
                              modelUsage <code>{u.key}</code> → <code>{u.canonicalModel}</code>
                            </div>
                          ))}
                        </>
                      )}
                    </td>
                    <td>{v && <><ResultCell run={v.run} /> <div className="subtype">{usd(v.run.cost)} · {v.calls} model calls</div></>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="hint">
            Total: {usd(total(same))}. <b>Red</b> beta flags are sent here but not to the Anthropic API; the grey line lists the ones only the Anthropic API gets. Features ride on these
            flags, so a feature can exist on one provider and not on another. The price is the same list price everywhere (<code>costBasis: "list"</code>): Claude Code prices by the{" "}
            <code>canonicalModel</code>, not by the provider's id.
          </p>
          <details className="card">
            <summary>Each lane's rows</summary>
            <Lanes lanes={same} order={P_LANES} />
          </details>
        </>
      )}

      <h3>D · Credentials</h3>
      <p className="hint">
        No <code>SKIP_*_AUTH</code> here: the cloud checks what Claude Code sends. For SigV4 it <b>recomputes the signature</b> with the secret it knows; for Vertex it runs the Google STS
        token exchange; for Foundry and the gateway it compares the key. Watch the <b>access check</b> calls: with real AWS or Google credentials, Claude Code first sends a{" "}
        <code>max_tokens: 1</code> call per model family to see what the account may use. About $0.01.
      </p>
      <div className="scenarios">{btn("auth", "3 · Eight ways to authenticate", "/api/c45/auth", setAuth)}</div>
      {Object.keys(auth).length > 0 && (
        <>
          <table className="tools compare cloud-table">
            <thead>
              <tr>
                <th>lane</th>
                <th>what the cloud saw</th>
                <th>access checks</th>
                <th>the run</th>
              </tr>
            </thead>
            <tbody>
              {Object.keys(LANE_TITLE)
                .filter((l) => l.startsWith("au-"))
                .map((l) => {
                  const v = verdictOf(auth, l);
                  return (
                    <tr key={l}>
                      <td>{LANE_TITLE[l]}</td>
                      <td className="snippet">
                        {v?.auth.map((a: string) => <div key={a}>{a}</div>)}
                        {v && !v.auth.length && <span className="subtype">(no request reached the model endpoint)</span>}
                        {v?.rejected > 0 && <b className="bad">{v.rejected} rejected</b>}
                      </td>
                      <td className="snippet">{v?.accessChecks.join(" · ")}</td>
                      <td>{v ? <ResultCell run={v.run} /> : "…"}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
          <details className="card">
            <summary>Each lane's rows (the token exchange, the signatures, the retries)</summary>
            <Lanes lanes={auth} order={Object.keys(LANE_TITLE).filter((l) => l.startsWith("au-"))} />
          </details>
        </>
      )}

      <h3>E · Model ids</h3>
      <p className="hint">
        The same alias, <code>haiku</code>, through the knobs that decide the id on Bedrock and Vertex: the region, the account's inference profiles and{" "}
        <code>ANTHROPIC_BEDROCK_REGION_PREFIX</code>, an application inference profile (an ARN, for cost allocation tags), <code>modelOverrides</code> (usually in managed settings),{" "}
        <code>ANTHROPIC_DEFAULT_HAIKU_MODEL</code>, and a per-model Vertex region. About $0.01. The costs differ between lanes (about $0.0012 or $0.0003) because of the <b>session title</b> call: it runs next to the turn, and <code>total_cost_usd</code> only counts it when it finishes before the <code>result</code> (compare the input tokens).
      </p>
      <div className="scenarios">{btn("models", "4 · Eight ways to name Haiku", "/api/c45/models", setModels)}</div>
      {Object.keys(models).length > 0 && (
        <>
          <table className="tools compare cloud-table">
            <thead>
              <tr>
                <th>lane</th>
                <th>model asked</th>
                <th>system/init.model</th>
                <th>on the wire</th>
                <th>modelUsage → canonicalModel · cost · input tokens</th>
              </tr>
            </thead>
            <tbody>
              {Object.keys(LANE_TITLE)
                .filter((l) => l.startsWith("mo-"))
                .map((l) => {
                  const v = verdictOf(models, l);
                  return (
                    <tr key={l}>
                      <td>{LANE_TITLE[l]}</td>
                      <td>
                        <code>{v?.asked}</code>
                      </td>
                      <td>
                        <code>{v?.run.initModel}</code>
                      </td>
                      <td className="snippet">
                        {v?.wire && <code>{v.wire.path}</code>}
                        {v?.lookups.map((x: string) => <div key={x}>{x}</div>)}
                        {v?.run.isError && <ResultCell run={v.run} />}
                      </td>
                      <td className="snippet">{v?.run.usage.map((u: any) => <div key={u.key}>{`${u.canonicalModel} · ${usd(u.costUSD)} · input ${u.input}`}</div>)}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
          <details className="card">
            <summary>Each lane's rows</summary>
            <Lanes lanes={models} order={Object.keys(LANE_TITLE).filter((l) => l.startsWith("mo-"))} />
          </details>
        </>
      )}

      <h3>F · When the cloud says no</h3>
      <p className="hint">
        A model the account has not enabled, and a cloud that throttles. The lanes set <code>CLAUDE_CODE_MAX_RETRIES=2</code> (the default is 10: a Bedrock 403 is retried for about three
        minutes). Lanes d and e add <code>fallbackModel: "haiku"</code>: it is for a model that is <b>overloaded</b> (529), not for one the account may not use (403). About $0.001.
      </p>
      <div className="scenarios">{btn("failures", "5 · Denied, throttled, fallback", "/api/c45/failures", setFails)}</div>
      {Object.keys(fails).length > 0 && (
        <>
          <table className="tools compare cloud-table">
            <thead>
              <tr>
                <th>lane</th>
                <th>the run</th>
                <th>api_retry</th>
                <th>model calls · statuses · models</th>
                <th>time</th>
              </tr>
            </thead>
            <tbody>
              {Object.keys(LANE_TITLE)
                .filter((l) => l.startsWith("fa-"))
                .map((l) => {
                  const v = verdictOf(fails, l);
                  return (
                    <tr key={l}>
                      <td>{LANE_TITLE[l]}</td>
                      <td>{v ? <ResultCell run={v.run} /> : "…"}</td>
                      <td>{v?.run.retries}</td>
                      <td className="snippet">{v && `${v.calls} · ${v.statuses.join(", ")} · ${v.models.join(", ")}`}</td>
                      <td>{v && `${(v.run.ms / 1000).toFixed(1)} s`}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
          <details className="card">
            <summary>Each lane's rows</summary>
            <Lanes lanes={fails} order={Object.keys(LANE_TITLE).filter((l) => l.startsWith("fa-"))} />
          </details>
        </>
      )}

      <h3>G · The code</h3>
      <div className="row">
        {["cloud", "providers", "run", "scenario-catalog", "scenario-same", "scenario-auth", "scenario-models", "scenario-failures"].map(
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
