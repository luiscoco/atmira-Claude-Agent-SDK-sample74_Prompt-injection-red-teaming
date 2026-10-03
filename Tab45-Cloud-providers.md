# Cloud providers

This file explains Concept 45 (**cloud providers**) of the Claude Agent SDK Lab. Every agent so far talked to the
Anthropic API. Many companies buy Claude through the cloud they already use instead: **Amazon Bedrock**, **Google
Vertex AI**, **Microsoft Foundry**, or the newer Claude Platform endpoints on AWS and Google Cloud. The agent code does
not change. One environment switch picks the provider, and Claude Code changes the whole call: the URL, where the model
id goes, `anthropic_version`, the credentials, the beta flags. The lab has no cloud account, so it runs **"the cloud"**:
a local server that speaks each provider's format, checks each provider's credentials, and forwards the call to the
Anthropic API with the lab's key.

**Goal:** run the same agent on any provider, know what changes on the wire and in the SDK stream, authenticate the way
each cloud expects, control the model id, and know what the stream says when the cloud refuses.

| Concept | Topic | Routes |
|---|---|---|
| 45 | Cloud providers: `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY` / `_MANTLE` / `_ANTHROPIC_AWS` / `_ANTHROPIC_GOOGLE_CLOUD`, the `*_BASE_URL` overrides and `CLAUDE_CODE_SKIP_*_AUTH`, `accountInfo().apiProvider`, `initializationResult().models`, `modelUsage[..].provider` / `canonicalModel`, the wire formats (Bedrock `invoke-with-response-stream` + AWS event stream, Vertex `streamRawPredict`, the Messages API), per-provider beta flags, SigV4, `AWS_BEARER_TOKEN_BEDROCK`, `awsCredentialExport`, Workload Identity Federation, `ANTHROPIC_FOUNDRY_API_KEY`, an LLM gateway (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_CUSTOM_HEADERS`), the startup access checks, inference profiles and `ANTHROPIC_BEDROCK_REGION_PREFIX`, application inference profile ARNs, `modelOverrides`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `VERTEX_REGION_<MODEL>`, 403 / 404 / 429 / 529, `CLAUDE_CODE_MAX_RETRIES`, `fallbackModel` | `/api/c45/facts`, `/catalog`, `/same`, `/auth`, `/models`, `/failures` (SSE), `/code` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/45-cloud-providers.ts` | **New**: the lab's cloud (seven wire formats, SigV4 verification, a Google STS, an AWS event stream encoder, per-lane accounts), the provider env helper, the run helper, the five scenarios, the routes |
| `server/index.ts` | Mounts the router on `/api/c45` |
| `src/concepts/Concept45CloudProviders.tsx` | **New**: the tab, Parts A to G, with the comparison tables |
| `src/App.tsx` | Adds the tab |
| `src/styles.css` | The cloud rows, the catalog and comparison tables |
| `.gitignore` | Ignores `cloud-lab/` |
| `Tab1-query().md` | Adds Concept 45 to the table and the project tree, the sample45 path |

No new package: the AWS, Google and Azure SDKs Claude Code needs are inside the CLI.

---

## Step 1: The smallest example

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

const q = query({
  prompt: "Read notes.txt and tell me the refund number.",
  options: {
    model: "haiku",                         // an alias: each provider turns it into its own id
    env: {
      ...process.env,
      CLAUDE_CODE_USE_BEDROCK: "1",         // the switch
      AWS_REGION: "us-east-1",              // required: Claude Code does not read the region from ~/.aws/config
      // credentials: whatever the AWS SDK finds (keys, AWS_PROFILE, SSO, an instance role), or AWS_BEARER_TOKEN_BEDROCK
    },
  },
});
for await (const m of q) {
  if (m.type === "system" && m.subtype === "init") console.log(m.model, (await q.accountInfo()).apiProvider);
  // us.anthropic.claude-haiku-4-5-20251001-v1:0  bedrock
}
```

There is **no provider option** in `Options`. Like telemetry (Concept 44) it is all environment variables of the Claude
Code process, so it goes in `options.env`. Remember Concept 16: `options.env` **replaces** the environment, and a server
that has `CLAUDE_CODE_USE_*` or `AWS_*` in its own env passes them to every agent. The lab removes `CLAUDE*`,
`ANTHROPIC*`, `AWS_*`, `GOOGLE_*`, `AZURE_*`, `CLOUD_ML_REGION` and `VERTEX_REGION_*` from the server's env, and points
`AWS_CONFIG_FILE` / `AWS_SHARED_CREDENTIALS_FILE` at empty files, so only what a lane passes counts.

The seven providers (`AccountInfo.apiProvider` also has `gateway`, an enterprise Cloud gateway sign-in, not covered here):

| apiProvider | Switch | Default endpoint · override | Credentials | `haiku` becomes | The call |
|---|---|---|---|---|---|
| `firstParty` | (none) | `api.anthropic.com` · `ANTHROPIC_BASE_URL` | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, a Claude login | `claude-haiku-4-5-20251001` | `POST /v1/messages` |
| `bedrock` | `CLAUDE_CODE_USE_BEDROCK` + `AWS_REGION` | `bedrock-runtime.<region>.amazonaws.com` · `ANTHROPIC_BEDROCK_BASE_URL` | the AWS SDK chain · `AWS_BEARER_TOKEN_BEDROCK` · `awsCredentialExport` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | `POST /model/<id>/invoke-with-response-stream` |
| `vertex` | `CLAUDE_CODE_USE_VERTEX` + `ANTHROPIC_VERTEX_PROJECT_ID` + `CLOUD_ML_REGION` | `<region>-aiplatform.googleapis.com` · `ANTHROPIC_VERTEX_BASE_URL` | Google ADC | `claude-haiku-4-5@20251001` | `POST …/publishers/anthropic/models/<id>:streamRawPredict` |
| `foundry` | `CLAUDE_CODE_USE_FOUNDRY` + `ANTHROPIC_FOUNDRY_RESOURCE` | `<resource>.services.ai.azure.com/anthropic` · `ANTHROPIC_FOUNDRY_BASE_URL` | `ANTHROPIC_FOUNDRY_API_KEY`, or Microsoft Entra ID | `claude-haiku-4-5` | `POST /anthropic/v1/messages` |
| `mantle` | `CLAUDE_CODE_USE_MANTLE` + `AWS_REGION` | `bedrock-mantle.<region>.api.aws` · `ANTHROPIC_BEDROCK_MANTLE_BASE_URL` | AWS credentials | `anthropic.claude-haiku-4-5` | `POST /v1/messages` |
| `anthropicAws` | `CLAUDE_CODE_USE_ANTHROPIC_AWS` + `ANTHROPIC_AWS_WORKSPACE_ID` | `aws-external-anthropic.<region>.api.aws` · `ANTHROPIC_AWS_BASE_URL` | AWS credentials · `ANTHROPIC_AWS_API_KEY` | `claude-haiku-4-5-20251001` | `POST /v1/messages` + `anthropic-workspace-id` |
| `anthropicGoogleCloud` | `CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD` + `ANTHROPIC_GOOGLE_CLOUD_PROJECT` | `claude.googleapis.com` · `ANTHROPIC_GOOGLE_CLOUD_BASE_URL` | Google ADC | `claude-haiku-4-5-20251001` | `POST /v1/messages` |

Each provider also has `CLAUDE_CODE_SKIP_<PROVIDER>_AUTH=1`: Claude Code sends no credentials of its own. That is meant
for a proxy or gateway in front of the cloud that signs the calls itself, and it is what the lab uses whenever a
scenario is not about credentials.

## Step 2: The lab's cloud (Part A)

`the cloud` is a Node `http` server on `127.0.0.1`, on a random port, inside the lab server. Every lane gets its own URL
prefix (`http://127.0.0.1:<port>/<lane>/<provider>/…`), and the lane's `*_BASE_URL` points there. Each lane also has
an **account**: which credentials it accepts, which models are enabled, a fault to inject, and (for Bedrock) the
account's inference profiles.

| Provider path | What the cloud does |
|---|---|
| `bedrock` `POST /model/<id>/invoke[-with-response-stream]` | Takes the model id out of the URL, removes `anthropic_version`, turns the body's `anthropic_beta` array into the `anthropic-beta` header, calls the Anthropic API. The streamed answer goes back as an **AWS event stream** (`application/vnd.amazon.eventstream`): each SSE event, base64, in a CRC32-checked `chunk` message |
| `bedrock` `GET /inference-profiles[/<arn>]` | `ListInferenceProfiles` (the account's cross-region profiles) and `GetInferenceProfile` (an application profile's backing model) |
| `vertex` `POST …/models/<id>@<date>:streamRawPredict` | Model id from the URL, `anthropic_version` removed, the SSE passed through |
| `foundry`, `mantle`, `aws`, `gcloud`, `gateway`, `anthropic` | The Messages API itself: the model id is mapped back to Anthropic's (`anthropic.claude-haiku-4-5` → `claude-haiku-4-5`) |
| `sts` `POST /v1/token` | A Google STS: exchanges a CI's OIDC token for an access token (Workload Identity Federation) |

A lane that skips auth shows `no credentials: CLAUDE_CODE_SKIP_*_AUTH` with a ✓: its account accepts calls without credentials on purpose.

The checks: for **SigV4** the cloud rebuilds the canonical request and signs it with the secret it knows for that
access key id (real verification, not a string compare). For Vertex it only accepts tokens its STS issued. Foundry and
the gateway compare a key. Every request is a **→ cloud** row in the tab: the kind of call (`turn`, `session title`,
`access check`, `ListInferenceProfiles`, …), the path, the model on the wire and what it became, the credential and the
verdict.

## Step 3: What each provider offers, before any call (scenario 1, $0)

Seven sessions whose prompt never yields a message. `initializationResult()` is answered by the CLI itself, so no model
is called:

| | Default model | Model ids in the catalog | `account` |
|---|---|---|---|
| firstParty | Opus 5.5 (1M context), with prices | aliases: `opus[1m]`, `sonnet`, `haiku`, `claude-fable-5-1` | `{ apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" }` |
| bedrock | Opus 5.5 | `us.anthropic.claude-opus-5-5`, `us.anthropic.claude-opus-4-1-20250805-v1:0`, … | `{ apiProvider: "bedrock" }` |
| vertex | Opus 5.5 | `claude-opus-5-5`, `claude-opus-4-1@20250805`, … | `{ apiProvider: "vertex" }` |
| foundry | **Sonnet 4.5** | `claude-sonnet-5`, `claude-opus-4-1`, … | `{ apiProvider: "foundry" }` |
| mantle | Opus 5.5 | `anthropic.claude-opus-5-5`, … (a shorter list) | `{ apiProvider: "mantle" }` |
| anthropicAws / anthropicGoogleCloud | Opus 5.5 | aliases, like first party | `{ apiProvider: … }` |

Two lessons: **do not rely on the default model** (it is not the same on every provider; set `model`), and the
catalog shows each provider's own ids, which is what a host's model picker should show. The only request any cloud got:
Bedrock's `ListInferenceProfiles`, at start-up.

## Step 4: The same agent on seven providers (scenario 2)

`model: "haiku"`, a `Read` of `notes.txt`, one line of answer. All seven answer "The refund number is RF-7781." for
about $0.0046 each. What the cloud received for the turn:

| Provider | On the wire | `anthropic_version` | Beta flags |
|---|---|---|---|
| firstParty | `POST /v1/messages?beta=true`, `model: claude-haiku-4-5-20251001`, `x-api-key` | header | interleaved-thinking, thinking-token-count, context-management, prompt-caching-scope, claude-code, advisor-tool |
| bedrock | `POST /model/us.anthropic.claude-haiku-4-5-20251001-v1:0/invoke-with-response-stream` (no `model` or `stream` in the body) | `bedrock-2023-05-31` (body) | `claude-code` only, **in the body** |
| vertex | `POST /v1/projects/lab-project/locations/us-east5/publishers/anthropic/models/claude-haiku-4-5@20251001:streamRawPredict` | `vertex-2023-10-16` (body) | web-search, claude-code |
| foundry | `POST /anthropic/v1/messages?beta=true`, `model: claude-haiku-4-5` | header | interleaved-thinking, context-management, web-search, prompt-caching-scope, claude-code |
| mantle | `POST /v1/messages?beta=true`, `model: anthropic.claude-haiku-4-5` | header | interleaved-thinking, context-management, claude-code |
| anthropicAws | `POST /v1/messages?beta=true` + `anthropic-workspace-id: wrkspc_lab` | header | interleaved-thinking, context-management, prompt-caching-scope, claude-code |
| anthropicGoogleCloud | `POST /v1/messages?beta=true` | header | the same |

And the SDK side:

| | What changes |
|---|---|
| `system/init.model` | the provider's id (`us.anthropic.claude-haiku-4-5-20251001-v1:0`, `claude-haiku-4-5@20251001`, …) |
| `accountInfo()` | `apiProvider`; only first party has `apiKeySource` / `tokenSource` |
| `result.modelUsage` | keyed by the provider's id, with `canonicalModel: "claude-haiku-4-5"`, `provider: "bedrock"`, `costBasis: "list"` |
| `total_cost_usd` | the same list price on every provider (Claude Code prices the `canonicalModel`); your cloud invoice may differ (see `modelPricing` in managed settings) |

**Features ride on beta flags.** Bedrock gets almost none, Vertex and Foundry do not get `thinking-token-count` or
`advisor-tool`, and the `web-search` beta flag goes only to Vertex and Foundry (the Anthropic API needs no flag for it). Before you move an
agent to another provider, check that the features it depends on exist there.

Each lane made three model calls: the session title and two turns.

## Step 5: Credentials (scenario 3)

No `SKIP_*_AUTH`: the cloud checks what arrives. All lanes set `CLAUDE_CODE_MAX_RETRIES=2` (Step 7 explains why).

| Lane | Env / settings | What the cloud saw | The run |
|---|---|---|---|
| a · SigV4 | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `AWS4-HMAC-SHA256 Credential=AKIALABE…/<date>/us-east-1/bedrock/aws4_request` → **signature matches** | ✓ |
| b · Bedrock API key | `AWS_BEARER_TOKEN_BEDROCK` | `Authorization: Bearer ABSK…` (no signing) | ✓ |
| c · `awsCredentialExport` | `settings: { awsCredentialExport: "node export-credentials.mjs" }` | SigV4 with `ASIA…` temporary keys **+ `x-amz-security-token`** → matches | ✓ |
| d · nothing | (no credentials) | nothing: no request is sent | `cloud_credential_error`: "Could not load AWS credentials · Could not load credentials from any providers" |
| e · wrong secret | the right key id, a wrong secret | **SignatureDoesNotMatch**, 20 rejected requests | `authentication_failed` |
| f · Workload Identity Federation | `GOOGLE_APPLICATION_CREDENTIALS` = an `external_account` file (OIDC token file + `token_url`) | `token exchange` at the STS, then `Authorization: Bearer ya29.…` on Vertex | ✓ |
| g · Foundry key | `ANTHROPIC_FOUNDRY_API_KEY` | `x-api-key: lab-foundry-key` | ✓ |
| h · LLM gateway | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_CUSTOM_HEADERS: "x-team: support"` | `Authorization: Bearer lab-gateway-token` · `x-team: support` | ✓ |

What this shows:

- **The access checks.** With real AWS or Google credentials (lanes a, b, c, f), Claude Code starts with one
  `max_tokens: 1` call per model family (Haiku, Sonnet, Opus) to learn what the account may use. They are real,
  billable (tiny) calls, and they appear in your cloud logs. With `SKIP_*_AUTH` they are not sent. When they fail
  (lane e), Claude Code walks through older model ids looking for one that works: 20 rejected requests before the turn.
- **`awsCredentialExport`** is how you use short-lived credentials: the command prints the JSON of `aws sts
  assume-role` / `get-session-token`, and Claude Code signs with them (`x-amz-security-token`). `awsAuthRefresh` (a
  command such as `aws sso login`) and `gcpAuthRefresh` are the interactive cousins.
- **Workload Identity Federation** is the CI pattern for Vertex (GitHub Actions, GitLab): no service account key on
  disk. Google's auth library, inside the CLI, read the token file, called `token_url`, and used the token it got. A
  plain service account key file does not work with the lab: its token endpoint is always Google's.
- **An LLM gateway** (LiteLLM, Portkey, your own proxy) is just first party with another `ANTHROPIC_BASE_URL`;
  `ANTHROPIC_AUTH_TOKEN` is sent as `Authorization: Bearer` (not `x-api-key`), and `ANTHROPIC_CUSTOM_HEADERS` adds
  headers such as a team or cost-center tag.
- On the cloud lanes **the agent never has an Anthropic key**: the lab's cloud holds it. That is the real situation
  too: the cloud is who you pay.

## Step 6: Model ids (scenario 4)

The same alias through the knobs that decide the id (auth skipped, so there are no access checks):

| Lane | Setting | `system/init.model` | What happened |
|---|---|---|---|
| a | `AWS_REGION=us-east-1` (default) | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | the **cross-region inference profile** for the region's geography |
| b | `AWS_REGION=eu-west-1` | `eu.anthropic.…` | the `eu.` profile |
| c | the account lists 5 profiles + `ANTHROPIC_BEDROCK_REGION_PREFIX=global` | `global.anthropic.…` | chosen from `ListInferenceProfiles` |
| d | the same, `REGION_PREFIX=apac` | `us.anthropic.…` | no `apac.` Haiku profile: **silent fallback** (the CLI only logs "a preference, not a residency guarantee") |
| e | `model:` an application inference profile ARN | the ARN | `GetInferenceProfile` → backing model `anthropic.claude-haiku-4-5-20251001-v1:0`; priced as Haiku |
| f | `settings.modelOverrides: { "claude-haiku-4-5-20251001": "<ARN>" }` | the ARN | the alias is rewritten; the key is the **dated** first-party id |
| g | `ANTHROPIC_DEFAULT_HAIKU_MODEL=eu.anthropic.…` | `eu.anthropic.…` | the alias is pinned |
| h | `VERTEX_REGION_CLAUDE_HAIKU_4_5=europe-west1` | `claude-haiku-4-5@20251001` | the URL has `locations/europe-west1` (the other models stay in `CLOUD_ML_REGION`) |

The costs differ between lanes (about $0.0012 or $0.0003, which lanes changes from run to run) because of the **session title** call. It runs next to the turn (about 760 input tokens), and in a one-turn run the answer can come back first: then `total_cost_usd` and `modelUsage` do not count it (about 250 input tokens instead of about 1,016; no cache reads). The cloud still received and billed it. The tab shows each lane's input tokens. This is not provider-specific: a short run's `total_cost_usd` can be lower than what the provider bills.

Application inference profiles are how AWS customers tag cost per team or tenant; `modelOverrides` (usually in managed
settings) lets an administrator send everybody's `haiku` to one. If data residency matters, pin the full id
(`ANTHROPIC_DEFAULT_*_MODEL` or `model`) rather than trusting the prefix preference.

## Step 7: When the cloud says no (scenario 5)

| Lane | The cloud | `assistant.error` | `api_retry` | Time |
|---|---|---|---|---|
| a · Bedrock, Sonnet not enabled | `403 AccessDeniedException` | `authentication_failed`: "enable this model for your account and region in the Amazon Bedrock console" | 2 | 3.0 s |
| b · Vertex, Sonnet not enabled | `404 NOT_FOUND` | `model_not_found`: "not available on your vertex deployment. Try switching to claude-sonnet-4@20250514" | 0 | 1.4 s |
| c · Bedrock throttling | `429 ThrottlingException` | `rate_limit` | 2 | 3.4 s |
| d · a + `fallbackModel: "haiku"` | 403 | `authentication_failed` (no fallback) | 2 | 3.2 s |
| e · Sonnet `529` overloaded + `fallbackModel: "haiku"` | 529 ×3, then Haiku 200 | none: the answer comes from Haiku | 2 | 4.2 s |

The times are from scenario 5 run alone and include starting Claude Code; run next to other scenarios they grow (7 to 9 s in the first test). The retries (with their back-off) are what separate a, c, d and e from b.

What this shows:

- **A Bedrock 403 is treated as an auth failure and retried.** With the default `CLAUDE_CODE_MAX_RETRIES` (10) that
  takes about three minutes (the probe for this lab measured 10 retries, delays up to 38 s) before the run gives up.
  A host that wants to fail fast sets a lower value.
- **Vertex's 404 fails at once** with a suggestion of a model that might be enabled.
- All of them end with `result/success` + **`is_error: true`** (the error is the assistant's text), and `query()` then
  throws "Claude Code returned an error result". Check `assistant.error` / `is_error`, not only `subtype`.
- **`fallbackModel` is for an overloaded model**, not for a model the account may not use: lane e's `modelUsage` has
  only Haiku.

---

## Things to try in Concept 45

1. In scenario 2, remove `CLAUDE_CODE_SKIP_BEDROCK_AUTH` from the Bedrock lane. What does the cloud answer, and how long
   does the run take?
2. Give the account of the SigV4 lane `enabled: /haiku/`. Which access checks fail, and what does
   `initializationResult().models` show afterwards?
3. In scenario 4, set `ANTHROPIC_BEDROCK_REGION_PREFIX=eu` with `AWS_REGION=us-east-1`. Which id wins?
4. Point a Bedrock lane at a real account: drop `ANTHROPIC_BEDROCK_BASE_URL` and `SKIP_BEDROCK_AUTH`, set `AWS_PROFILE`
   and `AWS_REGION`, and compare the rows with the tab.
5. Run Concept 44's telemetry on a Bedrock lane: does the `api_request` event carry the provider's model id or the
   canonical one?

## Running the app

```powershell
npm install        # once (no new packages in this sample)
npm run dev        # server on http://localhost:3001, web on http://localhost:5173
```

Open the **45. Cloud providers** tab. `ANTHROPIC_API_KEY` must be in `.env`: the lab's cloud uses it to call the
Anthropic API. Everything else runs on your machine (the cloud is on 127.0.0.1). With Haiku 4.5: 1 is $0, 2 about
$0.035, 3 about $0.01, 4 about $0.01, 5 under $0.001. A full pass costs about $0.06.

```powershell
# the same from a terminal (the tab does this for you)
curl.exe http://localhost:3001/api/c45/facts
curl.exe -N -X POST http://localhost:3001/api/c45/catalog -H "Content-Type: application/json" -d "{}"
curl.exe -N -X POST http://localhost:3001/api/c45/same -H "Content-Type: application/json" -d "{}"
```

> **Only one sample can run at a time.** Every sample's server uses port **3001**. Stop the other samples'
> `npm run dev` first.

---

## Steps followed

How Concept 45 was added to the lab: what was read, what was probed, what was decided, how it was tested, and what the
tests changed.

### Build step 1: Choose the feature

The request asked for "sample 45: Cloud providers" (#2 in the list of features the course had not covered).
`sample45-prompts and presentation/sample45.docx` was empty, so the list was the spec. `sample45/` was a copy of
sample44 without `node_modules` and without the readme; `npm install` restored the packages.

### Build step 2: Read what the course already said

| Read | To learn |
|---|---|
| `Tab44-Observability-with-OpenTelemetry.md`, `44-otel-observability.ts`, `Concept44OtelObservability.tsx` | The latest style: a server on its own port inside the lab, lanes, `sseRoute()`, `#region` + `/code`, the retrying `/facts`, "Steps followed" |
| `28-errors-retries.ts` | `CLAUDE_CODE_MAX_RETRIES` and the `api_retry` message |
| `server/index.ts`, `src/App.tsx`, `src/lib/sse.ts`, `src/styles.css` | Mounting, the tab list, SSE, the CSS classes to reuse |

### Build step 3: Read the types and the CLI

| Found | Used for |
|---|---|
| sdk.d.ts: `AccountInfo.apiProvider` (8 values), `ModelUsage.provider` / `canonicalModel` / `costBasis`, `initializationResult()`, `modelOverrides`, `awsCredentialExport` / `awsAuthRefresh` / `gcpAuthRefresh`, `fallbackModel` ("overloaded or unavailable") | Steps 3 to 7 |
| The CLI binary (2.1.281): every `CLAUDE_CODE_USE_*`, `*_BASE_URL`, `CLAUDE_CODE_SKIP_*_AUTH`; the provider order (`BEDROCK`, `FOUNDRY`, `ANTHROPIC_AWS`, `ANTHROPIC_GOOGLE_CLOUD`, `MANTLE`, `VERTEX`); the default endpoints; `ListInferenceProfiles` / `GetInferenceProfile`; `ANTHROPIC_BEDROCK_REGION_PREFIX` ("a preference, not a residency guarantee") | Part A's table, Steps 2 and 6 |

### Build step 4: Probe before designing

Six scratchpad scripts (not part of the project) ran `query()` with Haiku 4.5 against a capturing server, then against a
prototype of the cloud:

| Probe | Result | Decision |
|---|---|---|
| Six providers → a server that answers 400 | The URL, body and headers of each format | The cloud's paths and translations |
| The prototype cloud, five providers, a `Read` agent | All work, including Bedrock through an AWS event stream written by hand | Scenario 2 |
| SigV4, Bedrock API key, `awsCredentialExport`, no credentials, Foundry key, a service account | Everything but the service account (its token endpoint is always Google's) | Scenario 3 uses Workload Identity Federation (its `token_url` is configurable) |
| Profiles + prefixes, ARN, `modelOverrides`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `VERTEX_REGION_*`, denied models | The access checks with real credentials; a Bedrock 403 retried 10 times (about 3 min); ARN needs `GetInferenceProfile`; `modelOverrides` needs the dated key | Scenarios 4 and 5, `CLAUDE_CODE_MAX_RETRIES=2` |
| 429 with `CLAUDE_CODE_MAX_RETRIES=2` | `rate_limit`, 2 retries | Scenario 5, lane c |
| A prompt that never yields, `initializationResult()` | The catalog per provider, $0 | Scenario 1 |

### Build step 5: Design the concept

- **The cloud** inside the lab server, one URL prefix per lane and one account per lane, and a `call` emitter: every
  request is a row in the tab.
- **One env helper** (`providerEnv()`) with every provider's switch and endpoint commented, **one run helper**
  (`runAgent()`) that reports `init`, `accountInfo()`, `api_retry`, the assistant's `error` and `modelUsage`.
- **Five scenarios**, each a route; lanes run in parallel, each with its own `CLAUDE_CONFIG_DIR` and work folder.

### Build step 6: Implement it

| File | What |
|---|---|
| `server/concepts/45-cloud-providers.ts` | The cloud (`checkSigV4()`, `eventStreamMessage()`, the STS, the translations), `providerEnv()`, `laneEnv()`, `runAgent()`, the five routes |
| `src/concepts/Concept45CloudProviders.tsx` | `CloudRowView`, `Trail`, `Lanes`, Parts A to G |
| `server/index.ts`, `src/App.tsx`, `src/styles.css`, `.gitignore`, `Tab1-query().md` | Mount, tab, styles, `cloud-lab/`, table row and tree |

`npx tsc --noEmit -p .` passed.

### Build step 7: Test the routes

Port 3001 was busy (another sample's server), so the router was mounted alone on a spare port and each route was called
with `curl -N`, the four paid ones at the same time. What the tests changed:

- The Foundry key lane failed and took 197 s: the cloud looked for an `api-key` header, but Claude Code sends
  `ANTHROPIC_FOUNDRY_API_KEY` as `x-api-key`. The cloud now reads `x-api-key`, and every credentials lane sets
  `CLAUDE_CODE_MAX_RETRIES=2` so a rejected credential cannot hold the tab for minutes.
- `fallbackModel` did nothing for a model that is not enabled (403). The docs say "overloaded or unavailable", so
  lane e was added: Sonnet answers 529 and Haiku takes over. Lane d stays, to show the difference.

After the fixes all five scenarios gave the results in Steps 3 to 7. The page itself was not opened in a browser in this
build (port 3001 was in use); `tsc` checks the tab's code.
