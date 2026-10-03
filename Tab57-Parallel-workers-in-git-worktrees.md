# 57. Parallel workers in git worktrees

Run `npm ci`, then `npm run dev` with Node 24 or newer and Git on PATH. Open **Multi-agent systems → 57. Parallel workers in git worktrees**, or `?lesson=57`. Sample57 uses backend port **3057**, with Vite on **5173** or the next available port.

## What you will learn

Lesson 47 covers orchestration and lesson 56 covers coordination and messaging. This lesson adds separate Git checkouts: one base SHA, one branch and index per worker, and a coordinator that validates and integrates results. Worktrees share repository history, objects, refs and repository configuration; they are not an operating system sandbox. See the [Git worktree reference](https://git-scm.com/docs/git-worktree) and [Claude Code worktree documentation](https://code.claude.com/docs/en/worktrees).

The application creates its own fixture repository under `worktrees-lab/run-*`. The course directory does not need to be a Git repository. The endpoint accepts only a mode and scenario; callers cannot supply repository paths, prompts, shell commands or branch names.

## Offline walkthrough

Choose **Independent: greeting and tax** and click **Run offline worktree lab**. This makes no model calls, but executes real Git commands:

1. Initialize a small repository on `main` and commit the fixture. Record the base SHA.
2. Create `worker/greeting` and `worker/tax` worktrees from that exact SHA.
3. Start both workers before awaiting either. Each modifies its own assigned file.
4. Wait for both with `Promise.allSettled`. Inspect changed and untracked files and reject changes outside the assignment. Run independent behavior assertions before the host commits each worker's changes.
5. Confirm the integration checkout still matches the base and is clean. Cherry-pick worker commits serially onto `main`.
6. Run both combined application tests. Only then remove clean worker checkouts with `git worktree remove`, without force.
7. Keep worker branches, commits, the integration repository and `report.json`. Inspect the validated diffs, test output and remaining worktree listing in the browser.

Each run creates a new directory. Reports record the base, assignments, original worker commit SHAs, diffs, integrated commits, events, test output and cleanup status. The original worker SHA can differ from the cherry-picked integration SHA. The lab does not automatically delete old run repositories or branches.

Choose **Conflict: both edit the same greeting line** and run again. The first worker returns `Hello`; the second returns `Hi`. Each passes its own acceptance check, but the second cherry-pick conflicts. The coordinator aborts that pick, leaves the first integration in place and keeps both worker worktrees and branches. Combined tests have not run. Compare the diffs and decide which behavior you want before resuming manually. The UI can start a fresh exercise; it does not resolve or resume a previous conflict.

Any worker failure prevents all integration. Failed combined tests preserve the integration checkout and worker directories. Cancellation waits for both worker promises to settle and saves evidence. An interrupted run may include prior successful cherry-picks; inspect its report before continuing. If cleanup cannot verify a clean checkout, it stops and retains the remaining worktrees.

## Optional live workers

**Run live SDK workers (billed)** uses two independent Haiku `query()` sessions, each with its own `cwd` and configuration directory. The [SDK TypeScript reference](https://platform.claude.com/docs/en/agent-sdk/typescript) describes these options. API credentials must be provided through `ANTHROPIC_API_KEY` in `.env`. This exercise uses isolated configuration instead of an existing CLI login.

The supplied tools are Read, Edit and Write for the assigned file. Workers do not run shell commands or commit. The coordinator applies the same ownership checks, behavior assertions, commits, serial integration and combined tests as the offline mode. A successful SDK result alone does not bypass validation.

Each worker is limited to four turns and a $0.08 SDK budget threshold. The shared host deadline is 90 seconds. These budgets are SDK stop thresholds, not prepayment caps. The UI reports each terminal SDK result and its cost. Cancel or navigating away disconnects the stream and aborts both sessions; sessions close in `finally`. Offline requests have a 30-second host deadline. Git and Node commands also have individual timeouts. The route allows one active lesson 57 run per server process; multiple deployed processes would need a shared concurrency limit.

## Apply the pattern to a project

### Use GitHub

GitHub is the hosting choice for this lesson's project workflow. The browser exercise uses local Git repositories and requires no hosting account. “Git lab” means a local exercise; it does not refer to GitLab.

For your GitHub repository:

1. Clone the repository locally and choose the base commit.
2. Create one branch and worktree per worker using the commands below.
3. Validate each worker's changes and inspect its commit and diff.
4. Push the reviewed worker branches to GitHub and open pull requests against your integration branch.
5. Review and integrate changes one at a time, run the combined tests, then remove clean local worktrees.

The browser exercise does not push branches or create pull requests. Its disposable fixture stays local.

Inspect local changes and select the base SHA explicitly. Uncommitted changes do not appear in new worktrees. Give workers precise file ownership and acceptance criteria. Install dependencies in each fresh checkout and choose distinct service ports, databases and environment files. Review diffs and test the combined result before integrating it into a shared branch.

```powershell
git worktree add -b worker/greeting ../greeting HEAD
git worktree add -b worker/tax ../tax HEAD
# Launch one SDK session per cwd; await and validate both results.
git cherry-pick <greeting-commit>
git cherry-pick <tax-commit>
node --test app.test.mjs
git worktree remove ../greeting
git worktree remove ../tax
```

The paths above are a manual example; the browser lab always creates paths inside its own run folder. On conflict, inspect the evidence and use `git cherry-pick --abort` to undo the current pick while retaining earlier successful picks. Do not use force removal as a substitute for inspecting dirty worktrees.

For native interactive Claude Code sessions, run `claude --worktree greeting` and `claude --worktree tax` in separate terminals inside your Git repository. Native worktree lifecycle and configuration differ from this application-owned SDK coordinator; consult the linked documentation for your installed runtime.

## Implementation and verification

- `server/worktrees/workshop.ts`: real Git coordinator and deterministic offline workers.
- `server/concepts/57-parallel-worktrees.ts`: validated SSE endpoint and optional SDK workers.
- `src/concepts/Concept57ParallelWorktrees.tsx`: scenarios, progress, diff evidence, SDK observations and source.
- `server/worktrees/worktrees.test.ts`: real Git integration, conflicts, worker failures, ownership rejection, behavior validation, cancellation, dirty integration state and HTTP checks.

```powershell
npm run typecheck
npm run test:worktrees
npm run test:offline
npm run build
```

Tests create retained fixture repositories under ignored `worktrees-lab/tests/`. Offline tests use no model API. The optional billed run requires separate verification with credentials and credit.

To repeat the browser check, stop the app and run `node --import tsx server/worktrees/browser-smoke.mjs`. It requires Chrome at the default Windows installation path and free ports 3057, 5187 and 9230. It checks both offline scenarios and mobile width, saves a screenshot under ignored `worktrees-lab/browser-smoke/`, and closes its browser and local servers.

Implementation verification passed: type-check, production build, all 104 offline tests (including ten lesson 57 tests), and headless Chrome checks of navigation, successful integration, conflict evidence and mobile width. The optional billed SDK run was not executed.
