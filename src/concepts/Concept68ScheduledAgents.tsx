import { useEffect, useRef, useState } from "react";
import type { Job } from "../../server/scheduled/workshop";
import { readJsonResponse } from "../lib/json-response";

type State = { now: number; schedule: { nextAt: number; enabled: boolean; everyMs: number } | null; jobs: Job[]; active: string | null; limits: { jobs: number } };
export function Concept68ScheduledAgents() {
  const [state, setState] = useState<State>(), [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [error, setError] = useState("");
  const [interval, setIntervalSeconds] = useState(10), [eventId, setEventId] = useState("incident-001"), [message, setMessage] = useState("Checkout latency exceeded two seconds."), [mode, setMode] = useState<"guided" | "fail" | "live">("guided");
  const [code, setCode] = useState<Record<string, string>>();
  const [eventFeedback, setEventFeedback] = useState({ pending: false, notice: "", error: "" });
  const [eventJobId, setEventJobId] = useState<string>();
  const eventJob = state?.jobs.find((job) => job.id === eventJobId);
  const alive = useRef(true);
  const generation = useRef(0);
  const refreshing = useRef(false);
  const requests = useRef(new Set<AbortController>());
  async function request(path: string, body?: unknown, headers?: Record<string, string>, raw?: string) {
    const abort = new AbortController(); requests.current.add(abort);
    // Vite can hold a request for 30 seconds while the backend starts.
    const timer = window.setTimeout(() => abort.abort(), path === "/work" ? 70_000 : 40_000);
    try {
      const response = await fetch(`/api/c68${path}`, { method: body === undefined && raw === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...headers }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), signal: abort.signal });
      return await readJsonResponse(response);
    } catch (err) {
      if (abort.signal.aborted) throw new Error("Request stopped or timed out. Check the server, then try Refresh queue. Accepted jobs remain on the server.");
      if (err instanceof TypeError) throw new Error("Cannot reach the lesson server. Check npm run dev, then try Refresh queue.");
      throw err;
    } finally { window.clearTimeout(timer); requests.current.delete(abort); }
  }
  async function refresh() {
    const epoch = generation.current;
    const next = await request("/state");
    if (alive.current && epoch === generation.current) { setState(next); setError(""); }
  }
  useEffect(() => {
    alive.current = true;
    const epoch = ++generation.current;
    const poll = async () => {
      if (refreshing.current) return;
      refreshing.current = true;
      try { await refresh(); }
      catch (err) { if (alive.current && epoch === generation.current) setError(String(err)); }
      finally { if (epoch === generation.current) refreshing.current = false; }
    };
    refreshing.current = false;
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 2000);
    return () => { alive.current = false; ++generation.current; window.clearInterval(timer); requests.current.forEach((abort) => abort.abort()); };
  }, []);
  async function action(work: () => Promise<string>, target: "page" | "event" = "page") {
    setBusy(true); setError(""); setNotice("");
    if (target === "event") { setEventFeedback({ pending: true, notice: "", error: "" }); setEventJobId(undefined); }
    try {
      const result = await work();
      if (alive.current) {
        if (target === "event") setEventFeedback({ pending: false, notice: result, error: "" });
        else setNotice(result);
        await refresh();
      }
    } catch (err) {
      if (alive.current) {
        if (target === "event") setEventFeedback((previous) => ({ ...previous, error: String(err) }));
        else setError(String(err));
      }
    } finally {
      if (alive.current) {
        setBusy(false);
        if (target === "event") setEventFeedback((previous) => ({ ...previous, pending: false }));
      }
    }
  }
  async function sendEvent() {
    const fixture = await request("/fixture", { eventId, type: "incident.created", message });
    const result = await request("/webhook", undefined, { "x-event-timestamp": fixture.timestamp, "x-event-signature": fixture.signature }, fixture.raw);
    if (alive.current) setEventJobId(result.job.id);
    return result.duplicate
      ? `Duplicate ${eventId}: existing job returned; no second execution queued. Change the Event ID to send a new incident.`
      : `Signed event ${eventId} accepted.`;
  }
  return <section>
    <h2>68. Scheduled and event-driven agents</h2>
    <p>Move agent work out of the request path. A scheduler or a verified webhook enqueues a job; a worker claims it and records an outcome.</p>
    <div className="grid">
      <div className="card"><b>Trigger → queue</b><p>Interval occurrences and event IDs identify work. Duplicate deliveries return the existing job.</p></div>
      <div className="card"><b>Queue → worker</b><p>One atomic claim, a 60-second deadline, three attempts and exponential retry delays. The worker owns cancellation.</p></div>
      <div className="card"><b>Worker → outcome</b><p>Inspect results, retries and dead letters. Enqueue acknowledgment means accepted work, not completed work.</p></div>
    </div>
    <p className="hint">Local, in-memory teaching fixture: restart resets jobs and schedules. Guided mode costs $0. Live mode calls Haiku with no tools, two turns and a $0.03 SDK threshold per attempt. Each live attempt requires a click.</p>
    <p role="status" aria-live="polite">{busy ? "Working…" : notice}</p>{error && <p className="card warn" role="alert">{error}</p>}
    <h3>A · Schedule an interval</h3>
    <div className="card">
      <label htmlFor="scheduled-interval">Interval in seconds </label><input id="scheduled-interval" type="number" min={5} max={3600} value={interval} disabled={busy} onChange={(e) => setIntervalSeconds(Number(e.target.value))} />{" "}
      <button disabled={busy || !Number.isInteger(interval) || interval < 5 || interval > 3600} onClick={() => action(async () => { await request("/schedule", { everySeconds: interval }); return "Schedule enabled. The server timer will enqueue the next occurrence."; })}>Enable schedule</button>{" "}
      <button disabled={busy || !state?.schedule?.enabled} onClick={() => action(async () => { await request("/pause", {}); return "Schedule paused. Already queued jobs remain."; })}>Pause schedule</button>{" "}
      <button disabled={busy} onClick={() => action(async () => { const result = await request("/advance", { seconds: 30 }); return `Clock advanced 30 seconds. Enqueued: ${result.enqueued}; missed intervals skipped: ${result.skipped}.`; })}>Advance clock 30 seconds</button>
      <p id="scheduled-clock">Lesson clock: {state ? new Date(state.now).toISOString() : "Loading…"}. Schedule: {state?.schedule ? state.schedule.enabled ? `enabled; next occurrence ${new Date(state.schedule.nextAt).toISOString()}` : "paused; no new occurrences will be queued" : "disabled"}.</p>
      <p className="hint">UTC interval scheduling avoids local daylight-saving ambiguity. Missed ticks coalesce into one job. Pause before exploring retries to keep the queue small. Advancing the lesson clock also makes delayed retries eligible.</p>
    </div>
    <h3>B · Deliver a signed event</h3>
    <div className="card">
      <label htmlFor="scheduled-event-id">Event ID </label><input id="scheduled-event-id" value={eventId} maxLength={100} disabled={busy} onChange={(e) => setEventId(e.target.value)} />
      <label htmlFor="scheduled-message"> Incident message</label><textarea id="scheduled-message" value={message} maxLength={2000} disabled={busy} onChange={(e) => setMessage(e.target.value)} />
      <button disabled={busy || !/^[a-zA-Z0-9_-]{1,100}$/.test(eventId) || !message.trim()} onClick={() => action(sendEvent, "event")}>{eventFeedback.pending ? "Sending signed webhook…" : "Send signed webhook"}</button>
      <p id="scheduled-event-status" role="status" aria-live="polite">
        {eventFeedback.pending ? "Signing and sending the incident…" : eventFeedback.notice}
        {!eventFeedback.pending && eventFeedback.notice && eventJob && <> Current job status: {eventJob.state}.
          {eventJob.state === "queued" && " Click Run next job in section C to process it."}
          {eventJob.state === "retry" && " Advance the clock if needed, then click Run next job to retry."}
          {eventJob.state === "running" && " The worker is processing this incident."}
          {eventJob.state === "succeeded" && " This incident has completed."}
        </>}
      </p>
      {eventFeedback.error && <p id="scheduled-event-error" className="warn" role="alert">{eventFeedback.error}</p>}
      {!/^[a-zA-Z0-9_-]{1,100}$/.test(eventId) && <p className="hint">Enter an Event ID with 1–100 letters, numbers, underscores or hyphens.</p>}
      {!message.trim() && <p className="hint">Enter an incident message before sending.</p>}
      <p className="hint">Send the same ID twice to see deduplication. Change the ID to queue a new incident. The local sender signs exact JSON bytes; the receiver checks HMAC and a five-minute timestamp window before parsing. The sender fixture is public for this lesson.</p>
    </div>
    <h3>C · Run and inspect the worker</h3>
    <div className="card">
      <label htmlFor="scheduled-mode">Execution mode </label><select id="scheduled-mode" disabled={busy} value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}><option value="guided">Guided · no API</option><option value="fail">Inject failure · no API</option><option value="live">Live Haiku · billed</option></select>{" "}
      <button disabled={busy || Boolean(state?.active)} onClick={() => action(async () => { const result = await request("/work", { mode }); return result.worked ? `Attempt ${result.job.attempts}: ${result.job.state}.` : "No eligible job. Advance the clock if a retry is waiting."; })}>Run next job</button>{" "}
      <button disabled={busy} onClick={() => action(async () => "Queue refreshed.")}>Refresh queue</button>
      {state && <p>{state.jobs.filter((job) => job.state === "queued").length} queued jobs. Each click on Run next job processes one eligible job. Pause the schedule to stop adding new jobs while you work through the queue.</p>}
      {state && state.jobs.length >= state.limits.jobs && <p className="warn" role="status">Queue history is full ({state.limits.jobs} jobs, including completed jobs). Existing jobs remain available. Pause the schedule, then restart the teaching server when you are ready to clear its history.</p>}
      <p>Choose Inject failure, run a job, advance the clock, and repeat three times to produce a dead letter. Choose Guided after a failure to recover on the next attempt.</p>
    </div>
    {state?.jobs.length === 0 && <p>No jobs yet. Enable a schedule or send an event.</p>}
    {state?.jobs.slice().reverse().map((job) => <article className="card" key={job.id}>
      <b>{job.source} · {job.state} · attempt {job.attempts}/3</b><p><code>{job.key}</code></p><p>{job.payload}</p>
      {job.state === "retry" && <p>Eligible at {new Date(job.availableAt).toISOString()}</p>}
      {job.error && <p>{job.error}</p>}{job.result && <pre>{job.result}</pre>}
      {["queued", "retry", "running"].includes(job.state) && <button onClick={() => { void request(`/jobs/${job.id}/cancel`, {}).then(refresh).catch((err) => { if (alive.current) setError(String(err)); }); }}>Cancel job</button>}
    </article>)}
    <h3>D · Production design</h3>
    <p>Use durable queue storage and transactional claims or leases for multiple workers. Preserve event IDs across restarts, authenticate control routes, rotate webhook secrets, and use a trusted external scheduler. For daily cron work, define a timezone and daylight-saving policy explicitly.</p>
    <p>Delivery is commonly at least once. Deduplicating enqueue does not guarantee exactly-once external effects: give tools an idempotency key and commit their effects transactionally. Add rate limits, tenant authorization at execution, cost accounting and dead-letter review before deployment. See lessons 60 and 67.</p>
    <button disabled={busy} onClick={() => action(async () => { const files = await request("/code"); if (alive.current) setCode(files); return "Source loaded."; })}>Load source code</button>
    {code && Object.entries(code).map(([name, content]) => <details key={name}><summary>{name}</summary><pre>{content}</pre></details>)}
  </section>;
}
