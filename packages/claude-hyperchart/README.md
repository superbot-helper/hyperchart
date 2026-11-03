# @surprisal/claude-hyperchart

Claude Code plugin for [Hyperchart](https://github.com/surprisal-io/hyperchart): durable, typed statechart workflows whose agent actions run as real Claude sessions via the Claude Agent SDK, with a live localhost browser inspector and session steering.

## What you get

- **`hyperchart_*` MCP tools** — `list`, `inspect`, `run`, `respond`, `run_inspect`, `rewind`, `steer`, `stop`, `view` — exposed to Claude by a bundled stdio MCP server. Every response is bounded: full definitions, schemas, runtime snapshots, visit histories, and transcripts never enter Claude session logs. Deprecated `verbose: true` inspection calls are rejected; `view` is the sole full inspection surface.
- **Detached background runs** — chart runner survives Claude session.
  Run directory stores durable state.
  Always-on plugin monitor routes terminal prompts and durable user gates to the exact originating Claude session/canonical workDir. Explicit monitor root/storage options take precedence over unrelated ambient storage; see the [Claude integration contract](../../docs/claude-code.md).
  `wait: true` uses the same cross-run arbiter and returns terminal status or the globally active gate.
  Delivery/presentation uses at-least-once recovery semantics.
  A user gate is identified by `(runId, branchId, seqId)`; identical response retries are idempotent and divergent answers conflict.
- **Agent actions as Claude sessions** — each chart agent runs through `@anthropic-ai/claude-agent-sdk` `query()` headless (permission checks bypassed inside the chart's working directory; the chart's guards and validators are the control surface). Every session names both the owning repository/project directory and its isolated branch action workspace, warning that the latter is not an implicit repository checkout. Model ids from agent definitions are passed to the SDK verbatim.
- **Live inspector** — `hyperchart_view` returns exactly `{ "url": string }` with a tokenized localhost URL; the browser fetches a projection-backed overview first, then snapshot-pinned Runtime chunks and visit transcripts on demand. Lists are virtualized and retain at most 1,000 rows; polling never shifts an open history snapshot. Pass `chartPath` for a static view of a chart definition (no run required; reloads on refresh).
- **Durable human input** — the monitor directs Claude to native `AskUserQuestion` once per delivery attempt, then Claude immediately commits the real answer with `hyperchart_respond`. Response coordinates, event names, and option values remain exact; bounded display labels report original/omitted characters. Structured gates carry a bounded recursive, non-executable output contract; if any identity or contract cannot remain sufficient within its caps, delivery fails closed and directs the operator to the browser inspector. One gate is presented across parallel/map branches and owned runs in lexical `runId`, then numeric `seqId` order; other branches keep running.
- **SessionStart hook** — live runs and the pinned unanswered gate for the current directory are surfaced as context when a Claude session starts.

## Install

Local development loop from this repository:

```bash
claude --plugin-dir packages/claude-hyperchart
```

Requires Node.js 22.19+ and a working Claude Code login (the detached runner inherits the environment, so the Agent SDK resolves the same credentials as the host session).

## Locations

| What | Where |
|---|---|
| Project charts | `<projectRoot>/.claude/hypercharts/` (project root = nearest ancestor with `.claude`, `.hypercharts`, or `.agents`) |
| User charts | `${CLAUDE_CONFIG_DIR:-~/.claude}/hypercharts/` |
| Run directories | `${HYPERCHART_RUNS_ROOT:-${CLAUDE_CONFIG_DIR:-~/.claude}/hypercharts/runs}` |
| Agent definitions | `<chartDir>/agents`, `<projectRoot>/.claude/agents`, `<projectRoot>/.agents`, `~/.agents`, `~/.claude/agents` |

Agent definitions use the same markdown + frontmatter format as the Pi host (`name`, `description`, `model`, `thinking`, `tools`, `systemPromptMode`; body = system prompt), so charts that ship agents next to the chart file are portable between hosts.

## Remote / SSH

By default the inspector binds `127.0.0.1` on the machine where Claude Code runs. Two ways to reach it from your own machine, configured via environment variables — the supported settings channel is the `env` block in Claude Code's `settings.json`, which the plugin's MCP server and spawned runners inherit:

```json
{
	"env": {
		"HYPERCHART_INSPECTOR_PORT": "8377",
		"HYPERCHART_INSPECTOR_HOST": "127.0.0.1"
	}
}
```

**Option A — SSH tunnel (recommended).** Pin the port and forward it once:

```bash
ssh -L 8377:127.0.0.1:8377 <server>
```

Under SSH the plugin does not try to open a server-side browser; `hyperchart_view` returns the URL — open it locally through the forwarded port.

**Option B — LAN binding (trusted networks only).** Set `HYPERCHART_INSPECTOR_HOST=0.0.0.0`; the inspector then listens on all interfaces and advertises the machine's LAN address in its URLs, so `hyperchart_view` returns a link that opens directly from your machine. The unguessable per-run URL token is the only access control in this mode (including session steering) — use it only on networks you trust (home LAN, VPN); prefer the SSH tunnel otherwise.

## Run layout

Each run directory contains `status.json` v2 (heartbeat, terminal state, and current live `branchIds`), `terminal-notification/`, `user-interactions/<branchId>/<seqId>/`, `runner.config.json`, runner stdout/stderr logs, and collision-resistant `sessions/<sanitized-branch-prefix>-<hash>/...` paths with branch-separated agent state plus the branch-addressed steering queue. Run identity, journal facts, and operational status use `meta.json`/`log.jsonl`/`status.json` by default; with `HYPERCHART_PG_DSN` they use `hyperchart_run_meta`/`hyperchart_journal`/`hyperchart_run_status`, and those local files are not required. `hyperchart_run` accepts exactly one of singleton `branchId` or non-empty unique `branchIds`; a fresh chart must select exactly the singleton `main`, after which durable heads can be forked and the existing run resumed with `branchId` or `branchIds` so one detached process runs the selected static set concurrently with one Claude executor per branch. Stop/resume preserves open gates; rewind preserves every prior record. The old unscoped session layout is not migrated.

## Testing

The executor and MCP integration suites are separate from the fast `npm run check`; run `npm run test:integration` when changing the Claude host/MCP integration or before release. The opt-in end-to-end test drives a one-agent chart through the real SDK:

```bash
HYPERCHART_E2E=1 npx vitest run --config vitest.integration.config.ts tests/integration/claude_e2e.test.ts
```

## Not yet included

Marketplace packaging, model-id mapping between hosts, and cross-host run interop (Pi runs and Claude runs use separate run roots) are deliberately out of scope for this first version.

## Named branches

Claude tools require explicit branch handles for run/inspection/view/response/rewind and provide cursor-paged `hyperchart_branches` (at most 100 heads, `totalCount`, optional `next`) plus `hyperchart_fork`. Checkout is read-only; fork never selects; rewind only moves the named durable head.

Runs are addressed only by `runId`. Host storage config declares backend, root and `run-id` or `sha256` layout; existing literal framework and hashed AutoDiscovery layouts remain unchanged. See the [canonical runtime identity contract](../../docs/api/runtime.md#run-identity-and-storage-scope).
