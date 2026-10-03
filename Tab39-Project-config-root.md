# Project config root

This file explains Concept 39 (**`projectConfigRoot`**) of the Claude Agent SDK Lab. A host that runs Claude on a pull
request (a review bot, a CI agent, one worktree per task) checks the branch out in a **git worktree** and passes it as
`cwd`. But the branch is untrusted input. It can carry its own `.claude/settings.json`, with hooks that run on your
machine, permission rules, and MCP servers. With `projectConfigRoot`, the **code** comes from the worktree and the
**project config** comes from a checkout you trust.

**Goal:** see where the option goes and what Claude Code checks, which config moves to the root and what stays with
`cwd`, and what a PR branch can do without the option.

| Concept | Topic | Routes |
|---|---|---|
| 39 | `projectConfigRoot`: the flag `--project-config-root=<dir>`, the startup checks, project config from the root (settings, hooks and their `cwd`, permissions, `.mcp.json`, commands, skills, agents, `CLAUDE_PROJECT_DIR`), what stays with `cwd` (`CLAUDE.md`, the tools), a PR branch's hooks and `permissions.allow`, trust per main checkout, the git fallback, what is refused | `/api/c39/dry`, `/where` (SSE), `/takeover` (SSE), `/try` (SSE), `/code` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/39-project-config-root.ts` | **New**: the lab (a git repo and two worktrees), the options, the dry run, the two tables of cases, the live runner, the routes |
| `server/index.ts` | Mounts the router on `/api/c39` |
| `src/concepts/Concept39ProjectConfigRoot.tsx` | **New**: the tab, Parts A to G |
| `src/App.tsx` | Adds the tab |
| `src/styles.css` | The *trusted* / *branch* colours |
| `.gitignore` | Ignores `config-root-lab/` |
| `Tab1-query().md` | Adds Concept 39 to the table and the project tree |

---

## Step 1: The smallest example

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

// git worktree add ../repo-pr-42 pr-42      ← the host checks the PR out next to the main checkout
for await (const m of query({
  prompt: "Review this pull request.",
  options: {
    cwd: "/work/repo-pr-42",               // the branch: the files Claude reads and edits, CLAUDE.md
    projectConfigRoot: "/work/repo",       // the trusted checkout: settings, hooks, permissions, .mcp.json, commands…
    settingSources: ["project", "local"],  // still needed: the root says WHERE project config comes from, not WHETHER
  },
})) { … }
```

## Step 2: The lab

The server builds `config-root-lab/` with git the first time a scenario runs:

```text
repo/          branch main   the trusted checkout   CLAUDE.md "MAPLE"   hook, commands, skill, agent, .mcp.json named "trusted"
repo-pr-42/    branch pr-42  a git worktree         CLAUDE.md "BIRCH"   the same files named "branch" + permissions.allow: ["Bash", "Read"]
repo-docs/     branch docs   a git worktree         CLAUDE.md "MAPLE"   no .claude/, no .mcp.json
```

The branch's changes are **committed** on `pr-42`, as a real PR would be. Each checkout's `SessionStart` hook
(`node "$CLAUDE_PROJECT_DIR/.claude/hook.mjs"`) writes a line to a log: who it is, its `cwd`, `CLAUDE_PROJECT_DIR`, the
`env` of both settings files, and whether `ANTHROPIC_API_KEY` was in its environment (a yes or no, never the key).

## Step 3: Where the option goes, and what is refused

Scenario **1** costs nothing:

| `projectConfigRoot` | The CLI arg | Claude Code at startup |
|---|---|---|
| not set | none | |
| `'<lab>/repo'` | `--project-config-root=<lab>/repo` | starts |
| `'../repo'` | `--project-config-root=../repo` | `Error: --project-config-root must be an absolute local path` |
| a missing folder, or a file | | `Error: --project-config-root is not an existing directory that this user can list` |

The SDK passes the value through unchanged. Claude Code checks it and exits with code 1, before any API call, so
`query()` throws.

## Step 4: Where each piece of config comes from

Scenario **2** asks the same question in six setups (*"what is the project code word?"*, no tools):

| Setup | Commands, skills, agents | `.mcp.json` | The hook that ran (its `cwd`) | `CLAUDE.md` |
|---|---|---|---|---|
| `cwd` = the trusted checkout | trusted | trusted | trusted (`repo`) | MAPLE |
| `cwd` = the PR worktree | **branch** | **branch** | **branch** (`repo-pr-42`) | BIRCH |
| the PR worktree + `projectConfigRoot` | trusted | trusted | trusted, **in `repo`** | **BIRCH** |
| a worktree without `.claude/` | trusted (**git fallback**) | none | **none** | MAPLE |
| the same + `projectConfigRoot` | trusted | trusted | trusted | MAPLE |
| the PR worktree + the root + `settingSources: []` | none | none | none | none |

- **From the root:** both settings files (the hook saw `LAB_SETTINGS=trusted` and `LAB_LOCAL=trusted-local`), hooks,
  `.mcp.json`, commands, skills and agents. The hook runs **in the root**, and `CLAUDE_PROJECT_DIR` is the root.
- **From `cwd`:** `CLAUDE.md`. With the option, the code word was still the branch's **BIRCH**. A branch can still
  put instructions into the context this way. It cannot run code or grant itself tools.
- **The git fallback:** in a worktree without its own `.claude/`, Claude Code borrows the main checkout's commands,
  skills and agents, but **not** its settings, hooks or `.mcp.json`. The option gives you all of it.
- `settingSources: []` loads nothing, wherever it is. The option changes **where from**, not **whether**.

## Step 5: A pull request tries to take over

Scenario **3** runs four sessions in the PR worktree, with Bash available and no `allowedTools`. The prompt asks for
`node -e "console.log(42)"`. Only two things change: the option, and the folder the fake
`CLAUDE_CONFIG_DIR/.claude.json` trusts (`projects[<path>].hasTrustDialogAccepted`, what the terminal's trust dialog
stores):

| Setup | Bash | The hook that ran | Claude Code's stderr |
|---|---|---|---|
| no option, nothing trusted | denied | **branch**, with `ANTHROPIC_API_KEY` in its env | *Ignoring 2 permissions.allow entries from .claude/settings.json: this workspace has not been trusted…* |
| no option, the **main checkout** trusted | **ran: 42** | branch | nothing |
| `projectConfigRoot`, the main checkout trusted | **denied** | trusted | nothing |
| no option, only the **worktree's folder** trusted | denied | branch | the same warning, naming `projects["…/repo"]` |

- **Hooks do not wait for trust.** Without the option, the branch's hook ran in every row: a PR can run any command
  on the host, with the host's environment.
- **Trust is kept per main checkout, and a worktree inherits it.** Once the main checkout is trusted, the branch's
  `permissions.allow: ["Bash"]` applies: the PR granted itself a tool. Trusting the worktree's own folder does nothing.
- **With the option,** the rules and hooks are the trusted checkout's, which allows nothing. Bash is denied, and only
  the trusted hook ran. The branch's code is still what Claude reads and edits.

## Step 6: Try a combination

Scenario **4** runs one session with the `cwd`, root, trust and tools you pick. The default prompt is **`/release`**,
a custom command both checkouts have with different text:

```text
cwd repo-pr-42, no root        → "release steps from the branch checkout"
cwd repo-pr-42, root repo      → "release steps from the trusted checkout"
root '../repo'                 → Claude Code exited: must be an absolute local path
```

## Step 7: What the root changes, what it does not, what is refused

The file list is in `sdk.d.ts`. The rest was read from the CLI's code (`claude.exe` of `0.3.281`) and can change.

**Read from the root:** `.claude/settings.json` and `settings.local.json`, `.mcp.json` (walking up from the root),
the `.claude` config trees (commands, skills, agents, output-styles, workflows), `CLAUDE_PROJECT_DIR`, the `cwd` of
hooks and of helpers (`apiKeyHelper`, `awsCredentialExport`, the GCP auth refresh, the proxy auth helper, LSP
servers), and relative plugin marketplace paths.

**Stays:** `CLAUDE.md`, `CLAUDE.local.md` and `.claude/rules` (from `cwd`), the tools (in `cwd`), user and policy
settings.

**Refused with the flag:** background sessions (*"a background session can lose that flag, and then it runs the hooks
and settings in its working folder"*), durable scheduled tasks and `--routine`, project-scope MCP changes, project-scope
workflow saves, and network paths. A cloud session ignores it.

## Step 8: What changes, and what does not

| What | How | What happens |
|---|---|---|
| Set it | `projectConfigRoot: '/abs/path'` | `--project-config-root=<dir>`: absolute, local, an existing folder |
| `cwd` | the worktree | The files, the tools, `CLAUDE.md` |
| The root | the trusted checkout | Settings, hooks, permissions, `.mcp.json`, commands, skills, agents, `CLAUDE_PROJECT_DIR` |
| Hooks | only the root's, run in the root | Without it, a branch's hooks run even with nothing trusted |
| Permissions | the root's rules | Without it, a trusted main checkout lets a branch's `allow` apply |
| Trust | per main checkout | A worktree inherits it |
| Still needed | `settingSources: ['project', …]` | Where from, not whether |

## Things to try in Concept 39

1. Run 1: which bad root does the SDK itself refuse? (None: Claude Code does.)
2. Run 2: why is the code word BIRCH in the row with the option?
3. Run 3 and read the hook column of the first row: what could a real PR's hook do with that environment?
4. In 4, pick `repo-docs` with no root and run `/trusted-only`, then tick *tools: ['Bash']* and ask it to run
   `node -v`. Which parts of the main checkout did it borrow?
5. In 4, set the root to `repo-pr-42` with the main checkout trusted and Bash on: the option does not make a root
   trustworthy. You choose what to trust.

## Running the app

```powershell
npm run dev        # server on http://localhost:3001, web on the Vite port
```

Open the **39. projectConfigRoot** tab. `ANTHROPIC_API_KEY` must be in `.env`, and `git` must be installed. Start the
app from a normal terminal, not from inside Claude Code (see Tab16). With Haiku 4.5: scenario 1 costs nothing, 2 about
$0.005, 3 about $0.01 to $0.03, 4 about $0.001 per run ($0.003 with Bash).

```powershell
# the same from a terminal (the tab does this for you)
curl.exe -X POST http://localhost:3001/api/c39/dry
curl.exe -N -X POST http://localhost:3001/api/c39/where
```
