import { randomUUID } from "node:crypto";

export type Tenant = "acme" | "orbit";
export type Principal = { tenant: Tenant; user: string; role: "admin" | "viewer" };
// Public teaching credentials only. Production must verify an identity-provider token
// and resolve current membership server-side; never accept tenantId from a prompt.
export const demoAccounts = [
  { label: "Alice · Acme admin", token: "lesson67-alice", tenant: "acme", user: "alice", role: "admin" },
  { label: "Ava · Acme viewer", token: "lesson67-ava", tenant: "acme", user: "ava", role: "viewer" },
  { label: "Bob · Orbit admin", token: "lesson67-bob", tenant: "orbit", user: "bob", role: "admin" },
] as const;
export class AppError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function authenticate(header: string | undefined): Principal {
  const account = demoAccounts.find((entry) => header === `Bearer ${entry.token}`);
  if (!account) throw new AppError(401, "A valid demo bearer credential is required.");
  return { tenant: account.tenant, user: account.user, role: account.role };
}
type Project = { id: string; name: string; tenant: Tenant };
export type Session = { id: string; tenant: Tenant; owner: string; messages: { question: string; answer: string }[]; requests: Set<string> };
export type Runner = (input: { prompt: string; projects: () => Project[]; history: Session["messages"]; principal: Principal; sessionId: string; abort: AbortController }) => Promise<{ answer: string; costUsd: number }>;
export const limits = { runs: 5, concurrency: 1, budgetUsd: 0.20, liveReservationUsd: 0.05, sessions: 10, deadlineMs: 60000 };

export class SaaS {
  private projects: Project[] = [
    { id: "acme-roadmap", name: "Acme confidential roadmap", tenant: "acme" },
    { id: "orbit-launch", name: "Orbit private launch", tenant: "orbit" },
  ];
  private sessions = new Map<string, Session>();
  private state = new Map<Tenant, { runs: number; active: number; spentUsd: number; reservedUsd: number; audit: { event: string; user: string; at: string }[] }>();
  private usage(tenant: Tenant) {
    let row = this.state.get(tenant);
    if (!row) { row = { runs: 0, active: 0, spentUsd: 0, reservedUsd: 0, audit: [] }; this.state.set(tenant, row); }
    return row;
  }
  private audit(p: Principal, event: string) {
    const row = this.usage(p.tenant);
    row.audit.push({ event, user: p.user, at: new Date().toISOString() });
    row.audit = row.audit.slice(-50);
  }
  listProjects(p: Principal) { return this.projects.filter((row) => row.tenant === p.tenant).map((row) => ({ ...row })); }
  project(p: Principal, id: string) {
    const row = this.listProjects(p).find((entry) => entry.id === id);
    if (!row) { this.audit(p, "project access denied"); throw new AppError(404, "Project not found."); }
    return row;
  }
  createSession(p: Principal) {
    if (p.role !== "admin") throw new AppError(403, "Only admins can start agent conversations.");
    if ([...this.sessions.values()].filter((s) => s.tenant === p.tenant).length >= limits.sessions) throw new AppError(429, "Tenant session limit reached.");
    const session: Session = { id: randomUUID(), tenant: p.tenant, owner: p.user, messages: [], requests: new Set() };
    this.sessions.set(session.id, session); this.audit(p, "session created");
    return { id: session.id, messages: [] };
  }
  session(p: Principal, id: string) {
    const s = this.sessions.get(id);
    if (!s || s.tenant !== p.tenant || s.owner !== p.user) {
      this.audit(p, "session access denied"); throw new AppError(404, "Conversation not found.");
    }
    return s;
  }
  snapshot(p: Principal) {
    return { principal: p, projects: this.listProjects(p), sessions: [...this.sessions.values()].filter((s) => s.tenant === p.tenant && s.owner === p.user).map((s) => ({ id: s.id, messages: s.messages.map((m) => ({ ...m })) })), usage: structuredClone(this.usage(p.tenant)), limits };
  }
  async run(p: Principal, id: string, requestId: string, prompt: string, mode: "guided" | "live", runner: Runner, abort = new AbortController()) {
    if (p.role !== "admin") throw new AppError(403, "Only admins can run the agent.");
    const session = this.session(p, id), row = this.usage(p.tenant);
    if (abort.signal.aborted) throw new AppError(408, "Run cancelled before admission.");
    if (session.requests.has(requestId)) throw new AppError(409, "Request already accepted; refresh instead of retrying it.");
    const reserve = mode === "live" ? limits.liveReservationUsd : 0;
    // Admission and reservation happen synchronously, before any awaited work.
    if (row.active >= limits.concurrency || row.runs >= limits.runs || row.spentUsd + row.reservedUsd + reserve > limits.budgetUsd + 1e-9) throw new AppError(429, "Tenant concurrency, run or budget quota exceeded.");
    session.requests.add(requestId); row.active++; row.runs++; row.reservedUsd += reserve;
    this.audit(p, `${mode} run admitted`);
    const timer = setTimeout(() => abort.abort(), limits.deadlineMs);
    let cost = reserve; // Unknown live costs consume the reservation conservatively.
    try {
      const input = { prompt, projects: () => this.listProjects(p), history: session.messages.map((m) => ({ ...m })), principal: p, sessionId: id, abort };
      const result = mode === "guided"
        ? { answer: `Tenant-scoped list_projects returned: ${input.projects().map((project) => project.name).join(", ")}. Conversation has ${input.history.length} earlier turns. Tenant identity comes from authentication; mentioning another tenant cannot change tool scope.`, costUsd: 0 }
        : await runner(input);
      if (abort.signal.aborted) throw new AppError(408, "Run cancelled or deadline reached.");
      if (!Number.isFinite(result.costUsd) || result.costUsd < 0) throw new Error("Invalid usage report.");
      cost = result.costUsd;
      session.messages.push({ question: prompt, answer: result.answer.slice(0, 20000) });
      session.messages = session.messages.slice(-20);
      this.audit(p, "run completed");
      return { answer: result.answer.slice(0, 20000), costUsd: cost };
    } catch (error) { this.audit(p, "run failed; reservation charged if usage unknown"); throw error; }
    finally { clearTimeout(timer); row.active--; row.reservedUsd -= reserve; row.spentUsd += cost; }
  }
}
