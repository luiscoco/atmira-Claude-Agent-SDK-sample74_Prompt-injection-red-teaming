/**
 * CONCEPT 45 — Cloud providers: Amazon Bedrock, Google Vertex AI, Microsoft Foundry (and the newer Claude Platform ones)
 *
 *   options.env = { ...process.env, CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1" }        // + AWS credentials
 *   options.env = { ...process.env, CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_VERTEX_PROJECT_ID: "p", CLOUD_ML_REGION: "global" }
 *   options.env = { ...process.env, CLAUDE_CODE_USE_FOUNDRY: "1", ANTHROPIC_FOUNDRY_RESOURCE: "my-resource" }
 *
 * The same agent can run on Anthropic's API or on a cloud your company already has a contract with. There is no
 * provider option in query(): one environment switch picks the provider, and Claude Code changes the whole wire format
 * (URL, where the model id goes, anthropic_version, auth, the beta flags it sends). The lab has no cloud account, so it
 * runs "the cloud": a local server on 127.0.0.1 that speaks each provider's format, checks each provider's credentials
 * (it recomputes AWS SigV4 signatures, issues Google STS tokens, checks Azure keys), and forwards the call to the
 * Anthropic API with the lab's key. Every *_BASE_URL variable points Claude Code at it. It shows:
 *   1. what each provider offers before any call: the model catalog in the provider's ids, the default model ($0);
 *   2. the same agent on seven providers: what goes on the wire, and what the SDK stream says about it;
 *   3. credentials: SigV4 keys, a Bedrock API key, awsCredentialExport, none, a bad secret, Workload Identity
 *      Federation for Vertex, a Foundry key, an LLM gateway (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN);
 *   4. model ids: inference profiles and ANTHROPIC_BEDROCK_REGION_PREFIX, an application inference profile ARN,
 *      modelOverrides, ANTHROPIC_DEFAULT_HAIKU_MODEL, VERTEX_REGION_<MODEL>;
 *   5. when the cloud says no: a model that is not enabled (Bedrock 403, Vertex 404), throttling, fallbackModel.
 * Routes: GET /facts, POST /catalog, /same, /auth, /models, /failures (SSE), GET /code.
 */
import { EventEmitter } from "node:events";
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { Router } from "express";
import { z } from "zod";
import { query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept45 = Router();

const MODEL = "haiku"; // an alias on purpose: each provider turns it into its own model id
const LAB = path.resolve("cloud-lab");
const ROOT = process.cwd();
const UPSTREAM = (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, "");
const LAB_KEY = () => process.env.ANTHROPIC_API_KEY ?? "";
let cloudBase = ""; // http://127.0.0.1:<port>, once the cloud listens
const short = (s: string) =>
  s
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replaceAll(LAB, "cloud-lab")
    .replaceAll(LAB.replaceAll("\\", "\\\\"), "cloud-lab")
    .replaceAll(ROOT, ".")
    .replace(/sk-ant-[\w-]+/g, "sk-ant-…")
    .replaceAll(cloudBase || "\u0000", "http://127.0.0.1:<cloud>");

type Emit = (event: string, data: object) => void;
const badRequest = (e: z.ZodError) => `Bad request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);
const errText = (err: unknown) => short(String((err as Error)?.message ?? err)).slice(0, 600);
const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const hmac = (key: string | Buffer, s: string) => createHmac("sha256", key).update(s).digest();

// ---------------------------------------------------------------------------------------------
// "The cloud": one local server, one URL prefix per lane: http://127.0.0.1:<port>/<lane>/<provider>/...
// Each lane has an ACCOUNT: which credentials it accepts, which models are enabled, a fault to inject.
// ---------------------------------------------------------------------------------------------

// #region cloud
export type Account = {
  open?: boolean; // accept calls without credentials (the lanes that use CLAUDE_CODE_SKIP_*_AUTH)
  awsKeys?: Record<string, string>; // SigV4: access key id -> secret (the cloud recomputes each signature)
  bedrockApiKey?: string; // AWS_BEARER_TOKEN_BEDROCK
  foundryKey?: string; // ANTHROPIC_FOUNDRY_API_KEY (sent as the api-key header)
  gatewayToken?: string; // an LLM gateway: ANTHROPIC_AUTH_TOKEN (sent as Authorization: Bearer)
  googleTokens?: Set<string>; // access tokens the lab's STS issued for this lane (Workload Identity Federation)
  enabled?: RegExp; // the models this account may call (the rest: Bedrock 403 AccessDenied, Vertex 404)
  fault?: { status: number; headers?: Record<string, string>; body: object; models?: RegExp }; // answer the model calls (all, or those models) with this
  profiles?: string[]; // Bedrock ListInferenceProfiles (SYSTEM_DEFINED): the cross-region profiles the account has
  appProfiles?: Record<string, string>; // Bedrock application inference profiles: ARN -> backing foundation model
};
export type CloudRow = { at: number; lane: string; provider: string; method: string; path: string; kind: string; wireModel?: string; model?: string; version?: string; betas?: string[]; auth?: string; authOk?: boolean; status: number; note?: string };

const accounts = new Map<string, Account>();
const calls = new Map<string, CloudRow[]>();
const cloudBus = new EventEmitter(); // one "call" per request the cloud gets

/** The Anthropic model id behind a provider's id: us.anthropic.claude-haiku-4-5-20251001-v1:0, claude-haiku-4-5@20251001, … */
const anthropicModel = (id: string) =>
  decodeURIComponent(id)
    .replace(/^(us|eu|apac|global|jp|au|us-gov)\./, "")
    .replace(/^anthropic\./, "")
    .replace(/-v\d+(:\d+)?$/, "")
    .replace(/@(\d{8})$/, "-$1")
    .replace(/\[1m\]$/, "");

/** What kind of call this is, from its body: Claude Code's model access check, the session title, or a turn. */
function kindOf(body: any) {
  if (body?.max_tokens === 1) return "access check";
  if (JSON.stringify(body?.messages?.[0]?.content ?? "").includes("<session>")) return "session title";
  return "turn";
}

/** AWS SigV4: rebuild the canonical request, sign it with the secret for that access key, compare. */
function checkSigV4(req: http.IncomingMessage, rawPath: string, search: string, body: Buffer, keys: Record<string, string> = {}) {
  const m = String(req.headers.authorization).match(/Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)/);
  if (!m) return { ok: false, note: "not a SigV4 header" };
  const [, keyId, date, region, service, signed, signature] = m;
  const secret = keys[keyId];
  const who = `SigV4 ${keyId.slice(0, 8)}… ${region}/${service}${req.headers["x-amz-security-token"] ? " + session token" : ""}`;
  if (!secret) return { ok: false, note: `${who}: unknown access key` };
  const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const params = [...new URLSearchParams(search)].map(([k, v]) => [rfc3986(k), rfc3986(v)]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const headers = signed.split(";").map((h) => `${h}:${String(req.headers[h] ?? "").trim().replace(/\s+/g, " ")}\n`).join("");
  const payload = String(req.headers["x-amz-content-sha256"] ?? sha256(body));
  let key = hmac(`AWS4${secret}`, date);
  for (const part of [region, service, "aws4_request"]) key = hmac(key, part);
  // Non-S3 services encode the path twice: each segment of the path as sent is encoded again.
  const uri = rawPath.split("/").map(rfc3986).join("/");
  const canonical = [req.method, uri, params.map(([k, v]) => `${k}=${v}`).join("&"), headers, signed, payload].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", String(req.headers["x-amz-date"]), `${date}/${region}/${service}/aws4_request`, sha256(canonical)].join("\n");
  const ok = createHmac("sha256", key).update(toSign).digest("hex") === signature && payload === sha256(body);
  return { ok, note: `${who}: ${ok ? "signature matches" : "SignatureDoesNotMatch"}` };
}

/** The provider's own "you may not" answer. */
function deny(res: http.ServerResponse, provider: string, status: number, message: string, awsType = "AccessDeniedException") {
  if (provider === "vertex") return res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: status, message, status: status === 404 ? "NOT_FOUND" : "PERMISSION_DENIED" } }));
  if (provider === "bedrock" || provider === "mantle") return res.writeHead(status, { "content-type": "application/json", "x-amzn-errortype": `${awsType}:http://internal.amazon.com/coral/com.amazon.bedrock/` }).end(JSON.stringify({ message }));
  return res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: status === 401 ? "authentication_error" : status === 404 ? "not_found_error" : "permission_error", message } }));
}

/** AWS event stream framing (application/vnd.amazon.eventstream): prelude + headers + payload, each part CRC32-checked. */
function eventStreamMessage(headers: Record<string, string>, payload: Buffer) {
  const h = Buffer.concat(
    Object.entries(headers).map(([k, v]) => {
      const name = Buffer.from(k);
      const value = Buffer.from(v);
      return Buffer.concat([Buffer.from([name.length]), name, Buffer.from([7, value.length >> 8, value.length & 255]), value]); // 7 = string
    }),
  );
  const prelude = Buffer.alloc(12);
  prelude.writeUInt32BE(12 + h.length + payload.length + 4, 0);
  prelude.writeUInt32BE(h.length, 4);
  prelude.writeUInt32BE(zlib.crc32(prelude.subarray(0, 8)) >>> 0, 8);
  const message = Buffer.concat([prelude, h, payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(message) >>> 0);
  return Buffer.concat([message, crc]);
}
async function* sseData(body: AsyncIterable<Uint8Array>) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
      const data = buf.slice(0, i).split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      buf = buf.slice(i + 2);
      if (data) yield data;
    }
  }
}

const cloud = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks);
  const url = new URL(req.url ?? "/", "http://cloud");
  const [, lane = "", provider = ""] = url.pathname.split("/");
  const rest = `/${url.pathname.split("/").slice(3).join("/")}`;
  const acct = accounts.get(lane) ?? {};
  const row: CloudRow = { at: Date.now(), lane, provider, method: req.method ?? "?", path: short(decodeURIComponent(rest)) + (url.search ? url.search : ""), kind: "", status: 200 };
  const done = (r: Partial<CloudRow> = {}) => (Object.assign(row, r), (calls.get(lane) ?? calls.set(lane, []).get(lane)!).push(row), cloudBus.emit("call", row));
  let body: any;
  try {
    body = raw.length ? JSON.parse(raw.toString("utf8")) : undefined;
  } catch {}
  try {
    // --- Google STS (Workload Identity Federation): a CI's OIDC token in, a Google access token out
    if (provider === "sts") {
      const form = new URLSearchParams(raw.toString("utf8"));
      const token = `ya29.lab-${lane}-${(acct.googleTokens?.size ?? 0) + 1}`;
      (acct.googleTokens ??= new Set()).add(token);
      accounts.set(lane, acct);
      done({ kind: "token exchange", note: `grant_type ${form.get("grant_type")?.split(":").pop()} · subject_token ${cut(form.get("subject_token") ?? "", 20)} → ${token}` });
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: token, issued_token_type: "urn:ietf:params:oauth:token-type:access_token", token_type: "Bearer", expires_in: 3600 }));
    }
    if (req.method === "HEAD") return done({ kind: "reachability" }), res.writeHead(200).end();

    // --- Who is calling? Each provider has its own credentials.
    const authz = String(req.headers.authorization ?? "");
    let auth: { ok: boolean; note: string } = { ok: !!acct.open, note: acct.open ? "no credentials: CLAUDE_CODE_SKIP_*_AUTH (the lane's account accepts that)" : "no credentials" };
    if (provider === "anthropic") auth = { ok: true, note: `x-api-key ${short(String(req.headers["x-api-key"] ?? "(none)"))}` };
    else if (authz.startsWith("AWS4-HMAC-SHA256")) auth = checkSigV4(req, url.pathname, url.search, raw, acct.awsKeys);
    else if (provider === "bedrock" && authz.startsWith("Bearer ")) auth = { ok: authz === `Bearer ${acct.bedrockApiKey}`, note: `Bedrock API key ${cut(authz.slice(7), 10)}` };
    else if (provider === "vertex" && authz.startsWith("Bearer ")) auth = { ok: !!acct.googleTokens?.has(authz.slice(7)), note: `Google access token ${authz.slice(7)}` };
    else if (provider === "foundry" && req.headers["x-api-key"]) auth = { ok: req.headers["x-api-key"] === acct.foundryKey, note: `x-api-key ${cut(String(req.headers["x-api-key"]), 10)}` };
    else if (provider === "gateway") auth = { ok: authz === `Bearer ${acct.gatewayToken}`, note: `Authorization ${cut(authz, 18)}${req.headers["x-team"] ? ` · x-team: ${req.headers["x-team"]}` : ""}` };
    else if (authz) auth = { ok: !!acct.open, note: `Authorization ${cut(authz, 30)}${authz.includes("skip-") ? " (a placeholder: CLAUDE_CODE_SKIP_*_AUTH)" : ""}` };
    if (acct.open && !auth.ok) auth = { ok: true, note: `${auth.note} (auth skipped: the lane's account is open)` };
    row.auth = auth.note;
    row.authOk = auth.ok;

    // --- Bedrock control plane: the inference profiles of the account
    if (provider === "bedrock" && req.method === "GET") {
      if (!auth.ok) return done({ kind: "control plane", status: 403 }), deny(res, provider, 403, "The security token included in the request is invalid.", "UnrecognizedClientException");
      if (rest.startsWith("/inference-profiles/")) {
        const arn = decodeURIComponent(rest.slice("/inference-profiles/".length));
        const backing = acct.appProfiles?.[arn];
        done({ kind: "GetInferenceProfile", status: backing ? 200 : 404, note: backing ? `→ backed by ${backing}` : "not found" });
        if (!backing) return deny(res, provider, 404, "Inference profile not found", "ResourceNotFoundException");
        return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ inferenceProfileArn: arn, inferenceProfileId: arn.split("/").pop(), inferenceProfileName: arn.split("/").pop(), type: "APPLICATION", status: "ACTIVE", models: [{ modelArn: `arn:aws:bedrock:us-east-1::foundation-model/${backing}` }] }));
      }
      const list = acct.profiles ?? [];
      done({ kind: "ListInferenceProfiles", note: list.length ? `${list.length} profiles: ${list.join(", ")}` : "0 profiles (Claude Code falls back to its built-in ids)" });
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ inferenceProfileSummaries: list.map((id) => ({ inferenceProfileId: id, inferenceProfileName: id, type: "SYSTEM_DEFINED", status: "ACTIVE" })) }));
    }

    // --- The model call, in each provider's format, turned into an Anthropic Messages API call
    const headers: Record<string, string> = { "content-type": "application/json", "x-api-key": LAB_KEY(), "anthropic-version": "2023-06-01" };
    let upstream = { ...body };
    let bedrockStream = false;
    let wireModel = "";
    if (provider === "bedrock") {
      // POST /model/<model id or ARN>/invoke | invoke-with-response-stream. No model and no stream in the body.
      const m = rest.match(/^\/model\/(.+)\/(invoke|invoke-with-response-stream)$/);
      if (!m) return done({ kind: "?", status: 404 }), deny(res, provider, 404, `Unknown operation ${rest}`, "UnknownOperationException");
      wireModel = decodeURIComponent(m[1]);
      bedrockStream = m[2] === "invoke-with-response-stream";
      const { anthropic_version, anthropic_beta, ...b } = body;
      row.version = anthropic_version;
      row.betas = anthropic_beta ?? [];
      upstream = { ...b, model: anthropicModel(acct.appProfiles?.[wireModel] ?? wireModel), stream: bedrockStream };
      if (anthropic_beta?.length) headers["anthropic-beta"] = anthropic_beta.join(",");
    } else if (provider === "vertex") {
      // POST /v1/projects/<p>/locations/<region>/publishers/anthropic/models/<model>@<date>:streamRawPredict | rawPredict
      const m = rest.match(/\/models\/([^/:]+):(\w+)$/);
      wireModel = decodeURIComponent(m?.[1] ?? "");
      const { anthropic_version, ...b } = body;
      row.version = anthropic_version;
      upstream = { ...b, model: anthropicModel(wireModel) };
    } else {
      // foundry, mantle, aws, gcloud, gateway, anthropic: the Messages API itself, model in the body
      wireModel = String(body?.model ?? "");
      upstream = { ...body, model: anthropicModel(wireModel) };
    }
    if (provider !== "bedrock") {
      row.betas = String(req.headers["anthropic-beta"] ?? "").split(",").filter(Boolean);
      if (req.headers["anthropic-beta"]) headers["anthropic-beta"] = String(req.headers["anthropic-beta"]);
    }
    if (req.headers["anthropic-workspace-id"]) row.note = `anthropic-workspace-id: ${req.headers["anthropic-workspace-id"]}`;
    row.kind = kindOf(body);
    row.wireModel = wireModel;
    row.model = upstream.model;

    if (!auth.ok) {
      done({ status: 403 });
      if (provider === "bedrock") return deny(res, provider, 403, auth.note.includes("SignatureDoesNotMatch") ? "The request signature we calculated does not match the signature you provided." : "The security token included in the request is invalid.", auth.note.includes("SignatureDoesNotMatch") ? "InvalidSignatureException" : "UnrecognizedClientException");
      return deny(res, provider, provider === "foundry" || provider === "gateway" ? 401 : 403, "Invalid credentials");
    }
    if (acct.enabled && !acct.enabled.test(String(upstream.model))) {
      if (provider === "vertex") return done({ status: 404, note: "model not enabled for this project" }), deny(res, provider, 404, `Publisher Model \`projects/lab-project/locations/us-east5/publishers/anthropic/models/${wireModel}\` not found or your project does not have access to it.`);
      return done({ status: 403, note: "model not enabled for this account" }), deny(res, provider, 403, "You don't have access to the model with the specified model ID.");
    }
    if (acct.fault && (!acct.fault.models || acct.fault.models.test(String(upstream.model)))) return done({ status: acct.fault.status, note: "fault injected by the lab" }), res.writeHead(acct.fault.status, { "content-type": "application/json", ...acct.fault.headers }).end(JSON.stringify(acct.fault.body));

    const up = await fetch(`${UPSTREAM}/v1/messages${url.search.includes("beta=true") ? "?beta=true" : ""}`, { method: "POST", headers, body: JSON.stringify(upstream) });
    done({ status: up.status });
    if (!bedrockStream || up.status !== 200) {
      const out: Record<string, string> = {};
      up.headers.forEach((v, k) => void (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k) && (out[k] = v)));
      res.writeHead(up.status, out);
      for await (const c of up.body ?? []) res.write(c);
      return res.end();
    }
    // Bedrock streams the same events, each one base64 JSON inside an AWS event stream "chunk" message.
    res.writeHead(200, { "content-type": "application/vnd.amazon.eventstream", "x-amzn-requestid": `lab-${Date.now()}` });
    for await (const data of sseData(up.body as any)) res.write(eventStreamMessage({ ":event-type": "chunk", ":content-type": "application/json", ":message-type": "event" }, Buffer.from(JSON.stringify({ bytes: Buffer.from(data).toString("base64") }))));
    res.end();
  } catch (err) {
    if (!row.kind) done({ kind: "error", status: 502, note: errText(err) });
    if (!res.headersSent) res.writeHead(502);
    res.end();
  }
});
const cloudReady = new Promise<string>((resolve) => cloud.listen(0, "127.0.0.1", () => resolve((cloudBase = `http://127.0.0.1:${(cloud.address() as AddressInfo).port}`))));

/** A lane: a fresh account and call log; the base URL the provider's *_BASE_URL gets. */
async function openLane(lane: string, account: Account = { open: true }) {
  accounts.set(lane, account);
  calls.set(lane, []);
  return `${await cloudReady}/${lane}`;
}
// #endregion

// ---------------------------------------------------------------------------------------------
// The providers: one env switch each, the endpoint override, and "skip auth" (the lab's cloud checks credentials itself)
// ---------------------------------------------------------------------------------------------

// #region providers
export type ProviderId = "firstParty" | "bedrock" | "vertex" | "foundry" | "mantle" | "anthropicAws" | "anthropicGoogleCloud";

/** The env that selects each provider. In production you drop *_BASE_URL (the default endpoint is used) and SKIP_*_AUTH. */
function providerEnv(p: ProviderId, lane: string, skipAuth = true): Record<string, string> {
  const base = `${cloudBase}/${lane}`;
  switch (p) {
    case "firstParty": // the default. Here too through the lab's cloud, so every lane's calls are seen the same way
      return { ANTHROPIC_API_KEY: LAB_KEY(), ANTHROPIC_BASE_URL: `${base}/anthropic` };
    case "bedrock": // default endpoint https://bedrock-runtime.<region>.amazonaws.com; credentials: the AWS SDK chain
      return { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1", ANTHROPIC_BEDROCK_BASE_URL: `${base}/bedrock`, ...(skipAuth && { CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1" }) };
    case "vertex": // default endpoint https://<region>-aiplatform.googleapis.com (or aiplatform.googleapis.com for global); Google ADC
      return { CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_VERTEX_PROJECT_ID: "lab-project", CLOUD_ML_REGION: "us-east5", ANTHROPIC_VERTEX_BASE_URL: `${base}/vertex/v1`, ...(skipAuth && { CLAUDE_CODE_SKIP_VERTEX_AUTH: "1" }) };
    case "foundry": // default endpoint https://<ANTHROPIC_FOUNDRY_RESOURCE>.services.ai.azure.com/anthropic; a key or Entra ID
      return { CLAUDE_CODE_USE_FOUNDRY: "1", ANTHROPIC_FOUNDRY_BASE_URL: `${base}/foundry/anthropic`, ...(skipAuth && { CLAUDE_CODE_SKIP_FOUNDRY_AUTH: "1" }) };
    case "mantle": // Bedrock's Messages-API endpoint: https://bedrock-mantle.<region>.api.aws
      return { CLAUDE_CODE_USE_MANTLE: "1", AWS_REGION: "us-east-1", ANTHROPIC_BEDROCK_MANTLE_BASE_URL: `${base}/mantle`, ...(skipAuth && { CLAUDE_CODE_SKIP_MANTLE_AUTH: "1" }) };
    case "anthropicAws": // Claude Platform on AWS: https://aws-external-anthropic.<region>.api.aws, a workspace
      return { CLAUDE_CODE_USE_ANTHROPIC_AWS: "1", AWS_REGION: "us-east-1", ANTHROPIC_AWS_WORKSPACE_ID: "wrkspc_lab", ANTHROPIC_AWS_BASE_URL: `${base}/aws`, ...(skipAuth && { CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH: "1" }) };
    case "anthropicGoogleCloud": // Claude Platform on Google Cloud: https://claude.googleapis.com
      return { CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: "1", ANTHROPIC_GOOGLE_CLOUD_PROJECT: "lab-project", ANTHROPIC_GOOGLE_CLOUD_BASE_URL: `${base}/gcloud`, ...(skipAuth && { CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH: "1" }) };
  }
}
export const PROVIDER_LANES: [ProviderId, string][] = [
  ["firstParty", "p-first"],
  ["bedrock", "p-bedrock"],
  ["vertex", "p-vertex"],
  ["foundry", "p-foundry"],
  ["mantle", "p-mantle"],
  ["anthropicAws", "p-aws"],
  ["anthropicGoogleCloud", "p-gcloud"],
];

/** Env for the Claude Code process: none of the server's own provider, cloud or Claude variables (Tab16), a config dir per lane. */
const CLOUDY = /^(CLAUDE|ANTHROPIC|AWS_|GOOGLE_|GCLOUD|CLOUDSDK|AZURE_|CLOUD_ML_REGION|VERTEX_REGION|OTEL)/;
function laneEnv(lane: string, extra: Record<string, string>) {
  const env: Record<string, string | undefined> = Object.fromEntries(Object.entries(process.env).filter(([k]) => !CLOUDY.test(k)));
  const config = path.join(LAB, "config", lane);
  rmSync(config, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(config, { recursive: true });
  // AWS_CONFIG_FILE / AWS_SHARED_CREDENTIALS_FILE: no ~/.aws of this machine; only what the lane passes counts.
  return { ...env, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", AWS_CONFIG_FILE: path.join(config, "aws-config"), AWS_SHARED_CREDENTIALS_FILE: path.join(config, "aws-credentials"), ...extra };
}
/** The env as the tab shows it: the lab's key and the cloud's address hidden. */
const shownEnv = (env: Record<string, string>) => Object.fromEntries(Object.entries(env).map(([k, v]) => [k, k === "ANTHROPIC_API_KEY" ? "sk-ant-… (the lab's key)" : short(v)]));

function workDir(lane: string) {
  const dir = path.join(LAB, "work", lane);
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "notes.txt"), "Ticket 42: the refund was approved. Refund number RF-7781.");
  return dir;
}

function base(lane: string, abort: AbortController, env: Record<string, string>, extra: Partial<Options> = {}): Options {
  return {
    model: MODEL,
    cwd: workDir(lane),
    env: laneEnv(lane, env),
    tools: ["Read"],
    allowedTools: ["Read"],
    settingSources: [],
    thinking: { type: "disabled" },
    maxTurns: 4,
    abortController: abort,
    ...extra,
  };
}
// #endregion

// ---------------------------------------------------------------------------------------------
// One run, as rows: the SDK stream (init, account, tools, retries, the result's modelUsage)
// ---------------------------------------------------------------------------------------------

// #region run
export type RunResult = { subtype: string; isError: boolean; error?: string; text: string; cost: number; initModel?: string; provider?: string; usage: { key: string; canonicalModel?: string; provider?: string; costUSD: number; costBasis?: string; input: number; cacheRead: number; cacheWrite: number }[]; retries: number; ms: number };

async function runAgent(prompt: string, options: Options, emit: Emit) {
  const t0 = Date.now();
  const out: RunResult = { subtype: "none", isError: false, text: "", cost: 0, usage: [], retries: 0, ms: 0 };
  const q = query({ prompt, options });
  try {
    for await (const m of q) {
      if (m.type === "system" && m.subtype === "init") {
        out.initModel = m.model;
        emit("init", { model: m.model, apiKeySource: m.apiKeySource, tools: m.tools });
        const account = await q.accountInfo().catch(() => undefined);
        out.provider = account?.apiProvider;
        emit("account", { account });
      }
      if (m.type === "system" && m.subtype === "api_retry") out.retries++, emit("retry", { attempt: m.attempt, max: m.max_retries, delay: m.retry_delay_ms, status: m.error_status, error: m.error });
      if (m.type === "assistant") {
        if (m.error) out.error = m.error;
        for (const b of m.message.content) {
          if (b.type === "text" && b.text.trim()) emit("text", { text: cut(short(b.text), 600), error: m.error, model: m.message.model });
          if (b.type === "tool_use") emit("tool", { id: b.id, name: b.name, input: JSON.parse(short(JSON.stringify(b.input))) });
        }
      }
      if (m.type === "user" && Array.isArray(m.message.content))
        for (const b of m.message.content) if (b.type === "tool_result") emit("toolResult", { isError: !!b.is_error, text: cut(short(typeof b.content === "string" ? b.content : JSON.stringify(b.content)), 200) });
      if (m.type === "result") {
        out.subtype = m.subtype;
        out.isError = m.is_error;
        out.cost = m.total_cost_usd;
        out.text = m.subtype === "success" ? short(m.result) : short((m.errors ?? []).join("; "));
        out.usage = Object.entries(m.modelUsage).map(([key, u]) => ({ key, canonicalModel: u.canonicalModel, provider: u.provider, costUSD: u.costUSD, costBasis: u.costBasis, input: u.inputTokens, cacheRead: u.cacheReadInputTokens, cacheWrite: u.cacheCreationInputTokens }));
        emit("result", { subtype: m.subtype, isError: m.is_error, text: cut(out.text, 400), cost: m.total_cost_usd, turns: m.num_turns, usage: out.usage });
      }
    }
  } catch (err) {
    // An error result (is_error: true) also ends the loop with a throw: "Claude Code returned an error result: …"
    if (!options.abortController?.signal.aborted && !String(err).includes("returned an error result")) throw err;
  }
  out.ms = Date.now() - t0;
  return out;
}
// #endregion

/** An SSE route: parse the body, stream the rows (with their time), and the cloud's calls for the run's lanes. */
function sseRoute<T extends z.ZodTypeAny>(schema: T, body: (b: z.infer<T>, abort: AbortController, emit: Emit) => Promise<void>) {
  return async (req: any, res: any) => {
    const parsed = schema.safeParse(req.body ?? {});
    const { abort, send } = openSse(req, res);
    const startedAt = Date.now();
    const emit: Emit = (e, d) => send(e, { ...d, at: (d as any).at > 1e12 ? (d as any).at - startedAt : Date.now() - startedAt });
    const lanes = new Set<string>();
    (emit as any).lanes = lanes;
    const onCall = (r: CloudRow) => lanes.has(r.lane) && emit("cloud", { ...r });
    cloudBus.on("call", onCall);
    try {
      if (!parsed.success) throw new Error(badRequest(parsed.error));
      await cloudReady;
      await body(parsed.data, abort, emit);
    } catch (err) {
      if (!abort.signal.aborted) emit("error", { message: errText(err) });
    } finally {
      cloudBus.off("call", onCall);
      send("done", {});
      res.end();
    }
  };
}
function laneEmit(emit: Emit, lane: string): Emit {
  ((emit as any).lanes as Set<string>).add(lane);
  return (e, d) => emit(e, { ...d, lane });
}
const lanesAll = (list: (() => Promise<void>)[], emit: Emit) => Promise.all(list.map((f) => f().catch((err) => emit("error", { message: errText(err) }))));
/** A short summary of a lane's model calls, for the verdicts. */
const modelCalls = (lane: string) => (calls.get(lane) ?? []).filter((c) => ["turn", "session title", "access check"].includes(c.kind));

// ---------------------------------------------------------------------------------------------
// GET /facts
// ---------------------------------------------------------------------------------------------

concept45.get("/facts", async (_req, res) => {
  try {
    const url = await cloudReady;
    const dts = readFileSync(path.resolve("node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts"), "utf8");
    const version = JSON.parse(readFileSync(path.resolve("node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8")).claudeCodeVersion;
    res.json({ cloud: url, claudeCodeVersion: version, apiProvider: dts.match(/apiProvider\?: ([^;]+);/)?.[1] ?? "not found" });
  } catch (err) {
    res.status(500).json({ error: errText(err) });
  }
});

// ---------------------------------------------------------------------------------------------
// POST /catalog: no prompt at all. initializationResult() answers from the CLI: the account, the models. $0.
// ---------------------------------------------------------------------------------------------

// #region scenario-catalog
concept45.post(
  "/catalog",
  sseRoute(z.object({}).strict(), async (_b, abort, emit) => {
    await lanesAll(
      PROVIDER_LANES.map(([p, lane]) => async () => {
        const e = laneEmit(emit, lane);
        await openLane(lane);
        const env = providerEnv(p, lane);
        e("options", { env: shownEnv(env) });
        // A prompt that never yields: the process starts and answers control requests, but no turn is ever sent.
        let release = () => {};
        async function* never(): AsyncGenerator<SDKUserMessage> {
          await new Promise<void>((r) => (release = r));
        }
        const ctl = new AbortController();
        abort.signal.addEventListener("abort", () => ctl.abort());
        const q = query({ prompt: never(), options: { ...base(lane, ctl, env), tools: undefined, allowedTools: undefined } });
        const drain = (async () => {
          try {
            for await (const _ of q);
          } catch {}
        })();
        try {
          const init = await q.initializationResult();
          e("catalog", { account: init.account, models: init.models.map((m) => ({ value: m.value, displayName: m.displayName, description: m.description })) });
        } finally {
          ctl.abort();
          release();
          await drain;
        }
      }),
      emit,
    );
  }),
);
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /same: the same agent on seven providers, and what went over the wire
// ---------------------------------------------------------------------------------------------

// #region scenario-same
concept45.post(
  "/same",
  sseRoute(z.object({}).strict(), async (_b, abort, emit) => {
    await lanesAll(
      PROVIDER_LANES.map(([p, lane]) => async () => {
        const e = laneEmit(emit, lane);
        await openLane(lane);
        const env = providerEnv(p, lane);
        e("options", { model: MODEL, env: shownEnv(env) });
        const run = await runAgent("Read notes.txt and tell me the refund number. One line.", base(lane, abort, env), e);
        const turns = modelCalls(lane).filter((c) => c.kind === "turn");
        e("verdict", { provider: p, run, wire: turns[0] ? { method: turns[0].method, path: turns[0].path, wireModel: turns[0].wireModel, model: turns[0].model, version: turns[0].version, betas: turns[0].betas, auth: turns[0].auth, note: turns[0].note } : null, calls: modelCalls(lane).length });
      }),
      emit,
    );
  }),
);
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /auth: the cloud's credentials. The lab's cloud checks them; no SKIP_*_AUTH here.
// ---------------------------------------------------------------------------------------------

// #region scenario-auth
const AWS_KEY = { id: "AKIALABEXAMPLE000001", secret: "lab-secret-access-key" };
const EXPORT_SCRIPT = `// awsCredentialExport: Claude Code runs it and reads the JSON it prints (the shape of aws sts assume-role / get-session-token)
console.log(JSON.stringify({ Credentials: { AccessKeyId: "ASIALABTEMPORARY0001", SecretAccessKey: "lab-temporary-secret", SessionToken: "lab-session-token", Expiration: new Date(Date.now() + 3600e3).toISOString() } }));
`;
/** Workload Identity Federation: a CI's OIDC token (a file) is exchanged at Google STS for an access token. */
const wifCredentials = (dir: string, sts: string) => ({
  type: "external_account",
  audience: "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/ci/providers/github",
  subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
  token_url: sts, // normally https://sts.googleapis.com/v1/token
  credential_source: { file: path.join(dir, "oidc-token.txt") },
});

type AuthLane = { title: string; provider: ProviderId; account: Account; env?: (dir: string, base: string) => Record<string, string>; settings?: (dir: string) => object; setup?: (dir: string, base: string) => void };
export const AUTH_LANES: Record<string, AuthLane> = {
  "au-sigv4": { title: "Bedrock · AWS access keys (SigV4)", provider: "bedrock", account: { awsKeys: { [AWS_KEY.id]: AWS_KEY.secret } }, env: () => ({ AWS_ACCESS_KEY_ID: AWS_KEY.id, AWS_SECRET_ACCESS_KEY: AWS_KEY.secret }) },
  "au-apikey": { title: "Bedrock · a Bedrock API key (AWS_BEARER_TOKEN_BEDROCK)", provider: "bedrock", account: { bedrockApiKey: "ABSKlab-bedrock-api-key" }, env: () => ({ AWS_BEARER_TOKEN_BEDROCK: "ABSKlab-bedrock-api-key" }) },
  "au-export": { title: "Bedrock · awsCredentialExport (temporary credentials)", provider: "bedrock", account: { awsKeys: { ASIALABTEMPORARY0001: "lab-temporary-secret" } }, settings: (dir) => ({ awsCredentialExport: `node "${path.join(dir, "export-credentials.mjs")}"` }), setup: (dir) => writeFileSync(path.join(dir, "export-credentials.mjs"), EXPORT_SCRIPT) },
  "au-none": { title: "Bedrock · no credentials at all", provider: "bedrock", account: { awsKeys: { [AWS_KEY.id]: AWS_KEY.secret } } },
  "au-badsig": { title: "Bedrock · the right key id, a wrong secret", provider: "bedrock", account: { awsKeys: { [AWS_KEY.id]: AWS_KEY.secret } }, env: () => ({ AWS_ACCESS_KEY_ID: AWS_KEY.id, AWS_SECRET_ACCESS_KEY: "not-the-secret", CLAUDE_CODE_MAX_RETRIES: "1" }) },
  "au-wif": {
    title: "Vertex · Workload Identity Federation (a CI's OIDC token)",
    provider: "vertex",
    account: {},
    env: (dir) => ({ GOOGLE_APPLICATION_CREDENTIALS: path.join(dir, "wif-credentials.json") }),
    setup: (dir, b) => {
      writeFileSync(path.join(dir, "oidc-token.txt"), "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJyZXBvOmFjbWUvc3VwcG9ydDpyZWY6cmVmcy9oZWFkcy9tYWluIn0.lab");
      writeFileSync(path.join(dir, "wif-credentials.json"), JSON.stringify(wifCredentials(dir, `${b}/sts/v1/token`), null, 2));
    },
  },
  "au-foundry": { title: "Foundry · an API key (ANTHROPIC_FOUNDRY_API_KEY)", provider: "foundry", account: { foundryKey: "lab-foundry-key" }, env: () => ({ ANTHROPIC_FOUNDRY_API_KEY: "lab-foundry-key" }) },
  "au-gateway": { title: "An LLM gateway · ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN", provider: "firstParty", account: { gatewayToken: "lab-gateway-token" }, env: (_dir, b) => ({ ANTHROPIC_BASE_URL: `${b}/gateway`, ANTHROPIC_AUTH_TOKEN: "lab-gateway-token", ANTHROPIC_CUSTOM_HEADERS: "x-team: support" }) },
};

concept45.post(
  "/auth",
  sseRoute(z.object({}).strict(), async (_b, abort, emit) => {
    await lanesAll(
      Object.entries(AUTH_LANES).map(([lane, L]) => async () => {
        const e = laneEmit(emit, lane);
        const b = await openLane(lane, L.account);
        const options = base(lane, abort, {}, { tools: [], allowedTools: [], maxTurns: 1 });
        L.setup?.(options.cwd!, b);
        // No SKIP_*_AUTH: Claude Code must bring real credentials. The gateway lane is first party, pointed elsewhere.
        const env = { ...(L.provider === "firstParty" ? {} : providerEnv(L.provider, lane, false)), CLAUDE_CODE_MAX_RETRIES: "2", ...L.env?.(options.cwd!, b) };
        options.env = laneEnv(lane, env);
        if (L.settings) options.settings = L.settings(options.cwd!) as Options["settings"];
        e("options", { env: shownEnv(env), ...(L.settings && { settings: JSON.parse(short(JSON.stringify(L.settings(options.cwd!)))) }) });
        const run = await runAgent("Say hi in three words.", options, e);
        e("verdict", { run, auth: [...new Set((calls.get(lane) ?? []).map((c) => c.auth).filter(Boolean))], rejected: (calls.get(lane) ?? []).filter((c) => c.authOk === false).length, accessChecks: (calls.get(lane) ?? []).filter((c) => c.kind === "access check").map((c) => `${c.wireModel} ${c.status}`) });
      }),
      emit,
    );
  }),
);
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /models: how "haiku" becomes a provider's model id, and the knobs that change it
// ---------------------------------------------------------------------------------------------

// #region scenario-models
const APP_PROFILE = "arn:aws:bedrock:us-east-1:111122223333:application-inference-profile/support-team";
const PROFILES = ["us.anthropic.claude-haiku-4-5-20251001-v1:0", "eu.anthropic.claude-haiku-4-5-20251001-v1:0", "global.anthropic.claude-haiku-4-5-20251001-v1:0", "us.anthropic.claude-sonnet-4-5-20250929-v1:0", "global.anthropic.claude-sonnet-4-5-20250929-v1:0"];
type ModelLane = { title: string; provider: ProviderId; model: string; account?: Account; env?: Record<string, string>; settings?: object };
export const MODEL_LANES: Record<string, ModelLane> = {
  "mo-default": { title: "Bedrock · the default: AWS_REGION=us-east-1", provider: "bedrock", model: "haiku" },
  "mo-eu": { title: "Bedrock · AWS_REGION=eu-west-1", provider: "bedrock", model: "haiku", env: { AWS_REGION: "eu-west-1" } },
  "mo-global": { title: "Bedrock · the account's profiles + ANTHROPIC_BEDROCK_REGION_PREFIX=global", provider: "bedrock", model: "haiku", account: { open: true, profiles: PROFILES }, env: { ANTHROPIC_BEDROCK_REGION_PREFIX: "global" } },
  "mo-apac": { title: "Bedrock · the same, REGION_PREFIX=apac (no apac profile)", provider: "bedrock", model: "haiku", account: { open: true, profiles: PROFILES }, env: { ANTHROPIC_BEDROCK_REGION_PREFIX: "apac" } },
  "mo-arn": { title: "Bedrock · model = an application inference profile ARN", provider: "bedrock", model: APP_PROFILE, account: { open: true, appProfiles: { [APP_PROFILE]: "anthropic.claude-haiku-4-5-20251001-v1:0" } } },
  "mo-override": { title: "Bedrock · modelOverrides (settings): haiku → the ARN", provider: "bedrock", model: "haiku", account: { open: true, appProfiles: { [APP_PROFILE]: "anthropic.claude-haiku-4-5-20251001-v1:0" } }, settings: { modelOverrides: { "claude-haiku-4-5-20251001": APP_PROFILE } } },
  "mo-pin": { title: "Bedrock · ANTHROPIC_DEFAULT_HAIKU_MODEL pins the alias", provider: "bedrock", model: "haiku", env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: "eu.anthropic.claude-haiku-4-5-20251001-v1:0" } },
  "mo-vertex-region": { title: "Vertex · VERTEX_REGION_CLAUDE_HAIKU_4_5=europe-west1", provider: "vertex", model: "haiku", env: { VERTEX_REGION_CLAUDE_HAIKU_4_5: "europe-west1" } },
};

concept45.post(
  "/models",
  sseRoute(z.object({}).strict(), async (_b, abort, emit) => {
    await lanesAll(
      Object.entries(MODEL_LANES).map(([lane, L]) => async () => {
        const e = laneEmit(emit, lane);
        await openLane(lane, L.account);
        const env = { ...providerEnv(L.provider, lane), ...L.env };
        e("options", { model: short(L.model), env: shownEnv(L.env ?? {}), ...(L.settings && { settings: L.settings }) });
        const run = await runAgent("Say hi in three words.", base(lane, abort, env, { model: L.model, tools: [], allowedTools: [], maxTurns: 1, settings: L.settings as Options["settings"] }), e);
        const turn = modelCalls(lane).find((c) => c.kind === "turn");
        e("verdict", { asked: L.model, run, wire: turn && { path: turn.path, wireModel: turn.wireModel, model: turn.model }, lookups: (calls.get(lane) ?? []).filter((c) => c.kind.includes("InferenceProfile")).map((c) => `${c.kind}: ${c.note}`) });
      }),
      emit,
    );
  }),
);
// #endregion

// ---------------------------------------------------------------------------------------------
// POST /failures: the cloud says no. What the SDK stream shows, and how long it takes.
// ---------------------------------------------------------------------------------------------

// #region scenario-failures
type FailLane = { title: string; provider: ProviderId; model: string; account: Account; env?: Record<string, string>; fallbackModel?: string };
export const FAIL_LANES: Record<string, FailLane> = {
  "fa-bedrock-denied": { title: "Bedrock · Sonnet is not enabled in the account (403)", provider: "bedrock", model: "sonnet", account: { open: true, enabled: /haiku/ }, env: { CLAUDE_CODE_MAX_RETRIES: "2" } },
  "fa-vertex-denied": { title: "Vertex · Sonnet is not enabled in the project (404)", provider: "vertex", model: "sonnet", account: { open: true, enabled: /haiku/ } },
  "fa-throttle": { title: "Bedrock · ThrottlingException (429)", provider: "bedrock", model: "haiku", account: { open: true, fault: { status: 429, headers: { "x-amzn-errortype": "ThrottlingException:http://internal.amazon.com/coral/com.amazon.bedrock/" }, body: { message: "Too many requests, please wait before trying again." } } }, env: { CLAUDE_CODE_MAX_RETRIES: "2" } },
  "fa-fallback-denied": { title: "Bedrock · Sonnet not enabled + fallbackModel: haiku", provider: "bedrock", model: "sonnet", account: { open: true, enabled: /haiku/ }, env: { CLAUDE_CODE_MAX_RETRIES: "2" }, fallbackModel: "haiku" },
  "fa-fallback-overloaded": { title: "Bedrock · Sonnet overloaded (529) + fallbackModel: haiku", provider: "bedrock", model: "sonnet", account: { open: true, fault: { status: 529, models: /sonnet/, headers: { "x-amzn-errortype": "ServiceUnavailableException" }, body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } } }, env: { CLAUDE_CODE_MAX_RETRIES: "2" }, fallbackModel: "haiku" },
};

concept45.post(
  "/failures",
  sseRoute(z.object({}).strict(), async (_b, abort, emit) => {
    await lanesAll(
      Object.entries(FAIL_LANES).map(([lane, L]) => async () => {
        const e = laneEmit(emit, lane);
        await openLane(lane, L.account);
        const env = { ...providerEnv(L.provider, lane), ...L.env };
        e("options", { model: L.model, ...(L.fallbackModel && { fallbackModel: L.fallbackModel }), env: shownEnv(L.env ?? {}) });
        const run = await runAgent("Say hi in three words.", base(lane, abort, env, { model: L.model, fallbackModel: L.fallbackModel, tools: [], allowedTools: [], maxTurns: 1 }), e);
        const all = modelCalls(lane);
        e("verdict", { run, calls: all.length, statuses: [...new Set(all.map((c) => c.status))], models: [...new Set(all.map((c) => c.wireModel))] });
      }),
      emit,
    );
  }),
);
// #endregion

// ---------------------------------------------------------------------------------------------
// GET /code: the lab's code, cut at the #region markers
// ---------------------------------------------------------------------------------------------

const SOURCE = fileURLToPath(import.meta.url);

concept45.get("/code", (_req, res) => {
  const src = readFileSync(SOURCE, "utf8").replaceAll("\r\n", "\n");
  res.json(Object.fromEntries([...src.matchAll(/\/\/ #region ([\w-]+)\n([\s\S]*?)\/\/ #endregion/g)].map(([, name, c]) => [name, c.trimEnd()])));
});
