import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile, readdir, rmdir } from "node:fs/promises";
import path from "node:path";

const exec = promisify(execFile);
// Never inherit a host repository override into the disposable teaching repository.
const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
const nodeEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"));
export async function git(cwd: string, ...args: string[]) {
  const { stdout } = await exec("git", ["-c", "core.hooksPath=", "-c", "commit.gpgSign=false", "-c", "core.autocrlf=false", ...args], { cwd, env: gitEnv(), timeout: 15_000, maxBuffer: 1024 * 1024 });
  return stdout.trimEnd();
}
export type Scenario = "independent" | "conflict";
export type Assignment = { id: string; cwd: string; branch: string; file: string; expected: string; check: string };
export type Worker = (assignment: Assignment, signal: AbortSignal) => Promise<void>;
export type Evidence = Assignment & { commit?: string; diff?: string; error?: string; status: string };
export type Report = { run: string; scenario: Scenario; base: string; status: "success" | "conflict" | "failed"; workers: Evidence[]; events: { stage: string; detail: string }[]; integrated: string[]; tests: string; worktrees: string; cleaned: boolean; error?: string };
export const offlineWorker: Worker = async (assignment, signal) => {
  signal.throwIfAborted();
  await writeFile(path.join(assignment.cwd, assignment.file), assignment.expected);
};

export async function runWorkshop(options: { root: string; scenario: Scenario; worker?: Worker; signal?: AbortSignal; onEvent?: (event: { stage: string; detail: string }) => void }): Promise<Report> {
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  await mkdir(options.root, { recursive: true });
  const run = await mkdtemp(path.join(path.resolve(options.root), "run-"));
  const repo = path.join(run, "repo"); await mkdir(repo);
  const report: Report = { run, scenario: options.scenario, base: "", status: "failed", workers: [], events: [], integrated: [], tests: "Not run", worktrees: "", cleaned: false };
  const emit = (stage: string, detail: string) => { const event = { stage, detail }; report.events.push(event); options.onEvent?.(event); };
  try {
    emit("run", `Evidence folder: ${run}`);
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.name", "Lesson 57"); await git(repo, "config", "user.email", "lesson57@example.invalid");
    await writeFile(path.join(repo, "greeting.mjs"), 'export const greeting = () => "TODO";\n');
    await writeFile(path.join(repo, "tax.mjs"), "export const tax = (amount) => 0;\n");
    await writeFile(path.join(repo, "app.test.mjs"), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { greeting } from "./greeting.mjs";\nimport { tax } from "./tax.mjs";\ntest("integrated greeting", () => assert.equal(greeting(), "Hello"));\ntest("integrated tax", () => { assert.equal(tax(100), 20); assert.equal(tax(0), 0); });\n');
    await git(repo, "add", "."); await git(repo, "commit", "-m", "Seed lesson fixture");
    report.base = await git(repo, "rev-parse", "HEAD");
    const conflict = options.scenario === "conflict";
    const assignments: Assignment[] = [
      { id: "greeting", branch: "worker/greeting", cwd: path.join(run, "greeting"), file: "greeting.mjs", expected: 'export const greeting = () => "Hello";\n', check: 'import { greeting } from "./greeting.mjs"; assert.equal(greeting(), "Hello");' },
      { id: "tax", branch: "worker/tax", cwd: path.join(run, "tax"), file: conflict ? "greeting.mjs" : "tax.mjs", expected: conflict ? 'export const greeting = () => "Hi";\n' : "export const tax = (amount) => amount * 0.2;\n", check: conflict ? 'import { greeting } from "./greeting.mjs"; assert.equal(greeting(), "Hi");' : 'import { tax } from "./tax.mjs"; assert.equal(tax(100), 20); assert.equal(tax(0), 0); assert.equal(tax(50), 10);' },
    ];
    for (const assignment of assignments) {
      signal.throwIfAborted();
      await git(repo, "worktree", "add", "-b", assignment.branch, assignment.cwd, report.base);
      report.workers.push({ ...assignment, status: "ready" });
    }
    emit("setup", `Two branches start at ${report.base}. Each has its own checkout and index.`);
    // Both promises are started before either is awaited. Always settle both before integrating or cleaning up.
    await Promise.allSettled(report.workers.map(async (worker) => {
      worker.status = "running"; emit("worker-start", `${worker.id}: ${worker.cwd}`);
      try {
        signal.throwIfAborted(); await (options.worker ?? offlineWorker)(worker, signal); signal.throwIfAborted();
        const changed = (await git(worker.cwd, "status", "--porcelain", "--untracked-files=all")).split("\n").filter(Boolean);
        if (changed.length !== 1 || changed[0].slice(3) !== worker.file) throw new Error("Worker changed files outside its assignment or produced no change.");
        await exec(process.execPath, ["--input-type=module", "-e", `import assert from "node:assert/strict"; ${worker.check}`], { cwd: worker.cwd, timeout: 10_000, signal, env: nodeEnv() });
        // Only the host commits; workers never race on the integration index.
        await git(worker.cwd, "add", "--", worker.file); await git(worker.cwd, "commit", "-m", `Implement ${worker.id}`);
        worker.commit = await git(worker.cwd, "rev-parse", "HEAD");
        worker.diff = await git(worker.cwd, "diff", `${report.base}..${worker.commit}`, "--", worker.file);
        worker.status = "validated"; emit("worker-ready", `${worker.id}: tests passed, commit ${worker.commit}`);
      } catch (error) { worker.status = "failed"; worker.error = String(error); emit("worker-failed", `${worker.id}: ${worker.error}`); }
    }));
    signal.throwIfAborted();
    if (report.workers.some((worker) => worker.status !== "validated")) throw new Error("A worker failed validation. No commits were integrated; worktrees retained.");
    if (await git(repo, "rev-parse", "HEAD") !== report.base || await git(repo, "status", "--porcelain")) throw new Error("Integration checkout changed while workers ran.");
    for (const worker of report.workers) {
      signal.throwIfAborted();
      try { await git(repo, "cherry-pick", worker.commit!); }
      catch (error) {
        const unmerged = await git(repo, "diff", "--name-only", "--diff-filter=U");
        if (!unmerged) throw error;
        emit("conflict", `Integration stopped at ${worker.id}: ${unmerged}. Aborting this cherry-pick; preserving worker branches.`);
        await git(repo, "cherry-pick", "--abort"); report.status = "conflict"; return report;
      }
      report.integrated.push(worker.commit!); emit("integrated", `${worker.id}: cherry-picked serially onto main.`);
    }
    signal.throwIfAborted();
    try {
      const tests = await exec(process.execPath, ["--test", "--test-reporter=tap", "app.test.mjs"], { cwd: repo, timeout: 10_000, signal, env: nodeEnv() });
      report.tests = tests.stdout;
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      report.tests = `${failure.stdout ?? ""}${failure.stderr ?? ""}` || String(error);
      throw error;
    }
    emit("tests", "Both combined application tests passed.");
    for (const worker of report.workers) {
      signal.throwIfAborted();
      if (await git(worker.cwd, "status", "--porcelain")) throw new Error("Refusing to remove a dirty worker worktree.");
      try { await git(repo, "worktree", "remove", worker.cwd); }
      catch (error) {
        // Windows can briefly lock the empty directory after Git has removed
        // its files and registration. Only retry removal of that empty directory.
        const listing = await git(repo, "worktree", "list", "--porcelain");
        if (listing.includes(`worktree ${worker.cwd.replaceAll("\\", "/")}\n`)) throw error;
        const relative = path.relative(run, worker.cwd);
        if (relative.startsWith("..") || path.isAbsolute(relative)) throw error;
        for (let attempt = 0; ; attempt++) {
          try {
            if ((await readdir(worker.cwd)).length) throw error;
            await rmdir(worker.cwd); break;
          } catch (retryError) {
            if ((retryError as NodeJS.ErrnoException).code === "ENOENT") break;
            if (attempt >= 8) throw retryError;
            signal.throwIfAborted();
            await new Promise((resolve) => setTimeout(resolve, Math.min(100 * 2 ** attempt, 1000)));
          }
        }
      }
    }
    report.cleaned = true; report.status = "success";
    emit("cleanup", "Clean worker directories removed without force. Branches, commits, integration repository and report retained.");
  } catch (error) { report.error = String(error); emit("failed", report.error); }
  finally {
    try { report.worktrees = await git(repo, "worktree", "list", "--porcelain"); } catch { /* init may have failed */ }
    await writeFile(path.join(run, "report.json"), JSON.stringify(report, null, 2));
  }
  return report;
}

export async function sourceFiles() {
  return { "workshop.ts": await readFile(new URL("./workshop.ts", import.meta.url), "utf8"), "57-parallel-worktrees.ts": await readFile(new URL("../concepts/57-parallel-worktrees.ts", import.meta.url), "utf8") };
}
