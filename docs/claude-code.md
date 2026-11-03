# Claude Code plugin

Monitor calls resolve storage from explicit options: `storage` when provided, otherwise literal JSONL under `runsRoot`. An unrelated ambient storage scope never overrides that root. MCP passes its configured backend/root/layout explicitly to monitor scans.

`@surprisal/claude-hyperchart` runs Hyperchart workflows from Claude Code. Chart agent actions execute as real Claude sessions through the Claude Agent SDK; runs are detached background processes with durable state, a live browser inspector, and session steering.

## Install and launch

The plugin is loaded per session from a checkout:

```sh
claude --plugin-dir /path/to/hyperchart/packages/claude-hyperchart
```

Requires Node.js 22.19+ and a working Claude Code login: the detached runner inherits the environment, so agent sessions resolve the same credentials as the host session. A SessionStart hook lists this directory's live runs as context whenever a session starts.

## Tools

The bundled MCP server exposes nine tools. Claude picks them up through the `hyperchart` skill; in conversation you normally just describe what you want.

| Task | Tool |
|---|---|
| List chart definitions and this directory's runs | `hyperchart_list` |
| Validate and inspect a chart definition | `hyperchart_inspect` |
| Start a chart or resume an existing run | `hyperchart_run` |
| Commit a real `AskUserQuestion` answer | `hyperchart_respond` |
| Inspect durable state for one run | `hyperchart_run_inspect` |
| Queue a steering message for a live agent session | `hyperchart_steer` |
| Stop one or all active runs | `hyperchart_stop` |
| Move a stopped named branch head without deleting history | `hyperchart_rewind` |
| Open the browser inspector and return its URL | `hyperchart_view` |

All MCP responses are hard-bounded digests. `hyperchart_inspect` and `hyperchart_run_inspect` never return full definitions, schemas, runtime states, visit histories, or transcripts; the deprecated `verbose: true` input is rejected. `hyperchart_run` returns only run/branch identifiers, compact status/boundary fields, and bounded diagnostics. `hyperchart_view` is the only full inspection surface and returns exactly `{ "url": string }` while the browser fetches complete data on demand, so full inspection payloads never enter Claude session logs.

`hyperchart_run` accepts exactly one of `branchId` or a non-empty unique `branchIds` array and is asynchronous by default. A fresh chart must select exactly the singleton `main`; start it, fork durable branch heads, then resume the existing run with `branchId` or `branchIds`. One detached process replay-gates that resumed initial set, then runs one runtime and one branch-scoped Claude executor per branch concurrently over one shared incremental journal. Its run status v2 (`status.json`, or `hyperchart_run_status` under PostgreSQL) keeps those `branchIds` stable and reports failure if any branch fails. A live run is attached rather than duplicated. The plugin's always-on monitor scans immediately and periodically for both terminal requests and durable `user()` gates owned by the exact Claude session and canonical working directory. Each notification is emitted as one physical stdout line through an awaited asynchronous write and confirmed only after the stream accepts it; embedded prompt newlines remain escaped in JSON. Terminal delivery waits for the run status to match the request outcome, and stale dead runs are recovered through the same durable outbox operation used by waited calls.

Every user branch appends its rendered opened fact immediately, while the shared presentation arbiter exposes one journal-open gate across all owned runs: lexical `runId`, branch, then numeric `seqId`. A presented gate stays pinned until its branch ancestry closes or resolves it, so parallel/map branches continue without presenting competing questions. No runtime `effectId` or extra request identifier is exposed.

When a `hyperchart-user-request` arrives, Claude receives a bounded question preview, authored options with bounded labels separated from exact values, exact allowed event names, and a recursive non-executable output contract covering allowed values, nested required/optional fields, arrays, alternatives, defaults, nullability, and supported constraints (never the full prompt or raw reply schema). Every display string reports `originalChars` and `omittedChars`; `runId`, `seqId`, option values, and allowed events are never ellipsized or dropped. If an identity or contract cannot fit its per-field/collection/depth/node/value/byte caps, or the complete gate would make the model envelope unsafe, delivery fails closed and directs the operator to the browser inspector instead of presenting a partial gate. Claude must finish the current safe action, start no unrelated work, then call native `AskUserQuestion` once for that delivery attempt. It must never infer or fabricate the answer. Immediately after the human responds, Claude calls `hyperchart_respond` with `{ runId, seqId, event, output? }` and waits for the durable commit before continuing. If recovery repeats the same unanswered gate and no question remains in flight, invoke `AskUserQuestion` again; never open concurrent duplicate questions.

The response tool enforces the exact owner/cwd and active coordinate, an allowed non-`FAILED` event, and the optional reply schema. For a live run it sends an attempt-fenced control command to the owning detached runtime, which performs the sole journal write and returns a durable acknowledgement; only a stopped run opens the writer temporarily. An identical retry is idempotent; a divergent answer conflicts. Stale, closed, queued, wrong-session, and wrong-cwd replies are rejected.

Claude provides no acknowledgement that the host consumed a monitor stdout line, so automatic presentation is at least once. A stale monitor claim can retry the same gate; session-start recovery also surfaces a pinned unanswered gate before queued ones. Pass `wait: true` only when the current task must block: the call participates in the same cross-run arbiter and returns either the waited run's terminal status or the globally active gate, which may belong to another owned run. A waited gate uses a longer delivery lease so the normal monitor does not duplicate it while `AskUserQuestion` is normally open; if that waited delivery stalls or crashes past the lease, the monitor may redeliver the same pinned coordinate for recovery. Do not start Bash or Monitor polling watchers.

## Locations

| What | Where |
|---|---|
| Project charts | `<projectRoot>/.claude/hypercharts/` (project root = nearest ancestor with `.claude`, `.hypercharts`, or `.agents`) |
| User charts | `${CLAUDE_CONFIG_DIR:-~/.claude}/hypercharts/` |
| Run directories | `${HYPERCHART_RUNS_ROOT:-${CLAUDE_CONFIG_DIR:-~/.claude}/hypercharts/runs}` |
| Agent definitions | `<chartDir>/agents`, `<projectRoot>/.claude/agents`, `<projectRoot>/.agents`, `~/.agents`, `~/.claude/agents` |

Agent definitions use the same markdown + frontmatter format as the Pi host (`name`, `description`, `role`, `toolset`, `model`, `thinking`, `tools`, `systemPromptMode`; body = system prompt), so charts that ship agents next to the chart file are portable between hosts. Model ids are passed to the Claude Agent SDK verbatim (for example `claude-sonnet-5`, `claude-opus-4-8`); `thinking` levels map onto the SDK's effort control.

A `role` in frontmatter names a symbolic model tier and a `toolset` a symbolic tool list, both resolved through `settings.json` in the charts directories (`~/.claude/hypercharts/settings.json`, `<projectRoot>/.hypercharts/settings.json`, and `<projectRoot>/.claude/hypercharts/settings.json`; later entries win per key): `{ "roles": { "reviewer": "opus" }, "toolsets": { "reading": ["Read", "Grep"] } }`. Because each host maps these names in its own settings, a chart declaring them is portable even though model ids and tool names differ between hosts. An unconfigured role falls back to the frontmatter `model`, and an unconfigured toolset to the frontmatter `tools`; with no fallback declared (and no chart-level override) the action fails with an error instead of silently running on defaults. See [Core authoring](core-authoring.md) for the resolution order.

## Durable user-gate layout and recovery

A gate is a `user_interaction/opened` journal fact with exact identity `(runId, branchId, seqId)`; its answer is a `user_interaction/resolved` fact in selected ancestry. Only presentation receipts remain under `<runDir>/user-interactions/<branchId>/<seqId>/receipts/`. A stopped run may accept an answer, and resume applies it through replay.

The SessionStart hook scans the same exact session/cwd ownership scope and recovers the pinned journal gate before queued gates. If no interactive host is available, the opened fact remains durably inspectable and the run can be stopped, answered, and resumed.

## How agent sessions run

Each agent action becomes one SDK `query()` session in the run's working directory. Steering resolves one live branch/action invocation, persists its durable invoke seqId, and is delivered only while that exact invocation remains live, so a delayed message cannot jump to a later visit. Session state lives under `sessions/<sanitized-branch-prefix>-<hash>/<actionUid>/<invocation>/`, so distinct branch ids cannot alias on disk; the former unscoped layout is not migrated. Sessions run headless with permission checks bypassed and without user or project settings, so chart behavior does not depend on the machine's Claude configuration; the chart's guards and validators are the control surface. The executor streams text and thinking deltas into session progress, writes a neutral JSONL transcript per session, and delivers a steering request only when its `branchId` matches that executor. If the runner restarts, an already-captured `finish` is recovered from the transcript instead of re-prompting the agent.

## Inspector

`hyperchart_view` registers the run with a localhost inspector server (it lives inside the long-running MCP server process) and returns exactly `{ "url": string }` with a tokenized URL. The browser then fetches the chart graph with runtime overlay, per-state details, live agent transcripts, and steering composer on demand. Agent cards show declared role/toolset names and their resolved model/tool allowlists. Concrete runs resolve against their persisted `runner.config.json`; session progress records the actual launch plan.

Remote setups are configured through environment variables — set them in the `env` block of Claude Code's `settings.json` so the MCP server and runners inherit them:

- `HYPERCHART_INSPECTOR_PORT` — fixed port, so an `ssh -L <port>:127.0.0.1:<port>` tunnel can be configured once. The fixed port serves one process; when another session already holds it, the inspector falls back to an ephemeral port and the returned URL carries the actual port. Under SSH the server does not attempt to open a remote browser; open the returned URL locally through the tunnel.
- `HYPERCHART_INSPECTOR_HOST=0.0.0.0` — bind all interfaces and advertise the machine's LAN address in inspector URLs, so links open directly from another device. The unguessable per-run URL token is the only access control in this mode (including steering); use it on trusted networks only and prefer the SSH tunnel otherwise.

## Safety

- Chart modules are executable TypeScript; loading one can execute top-level code.
- Agent sessions can act anywhere the runner's process can inside the working directory — start runs only in directories you trust, and put substantial results into declared artifacts with schemas so invalid output is caught and retried at the runtime boundary.
- Stop and deletion do not undo external side effects. See [Recovery and safety](safety.md).

## Not yet included

Marketplace packaging, model-id mapping between hosts, and cross-host run interop (Pi and Claude use separate run roots).

All MCP run-target inputs use `runId` only. `runDir` and arbitrary path aliases are rejected. `HyperchartMcpDeps.storage` selects backend/root/layout; the default retains the existing Claude literal-ID layout. See [runtime storage scope](api/runtime.md#run-identity-and-storage-scope).
