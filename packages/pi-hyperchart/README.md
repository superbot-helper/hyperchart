# `@surprisal/pi-hyperchart`

Pi extension, run manager, agent executor, terminal UI, React inspector, and bundled Hyperchart skill.

## Install in Pi

Run from your shell:

```sh
pi install npm:@surprisal/pi-hyperchart
```

Start Pi after the install, or restart an existing Pi process. The package declares:

- `extensions/hyperchart.ts`;
- `skills/hyperchart/`.

It requires Node.js 22.19 or newer and the exact matching version of `@surprisal/hyperchart`. Pi host libraries remain optional peers supplied by Pi's extension loader. On filesystem-backed Node.js installations, detached runners receive absolute module entries from the active Pi process and therefore use that same Pi installation rather than a separately resolved copy. Compiled Bun Pi binaries do not expose their embedded host modules as files and are not currently supported for detached runners.

## Start a chart

Place a chart in `.pi/hypercharts/name.chart.ts`, then run:

```text
/hyperchart run name          # asynchronous
/hyperchart run name --wait   # synchronous
```

The TUI stays compact: it shows active states and path-aware percentage progress. Run `/hyperchart` to select recent runs; Enter opens the selected run in the full localhost browser inspector. Map actions held behind a `concurrency` limit appear as `waiting`; only admitted work appears as `running` and can expose an active session. Agent cards show declared role/toolset names and their resolved model/tool allowlists; the selected state's run-specific `Runtime` section shows the actual launch plan plus transcript/current-tool polling and steering. Run metadata and every agent system context distinguish the owning repository/project directory from the isolated branch action workspace; the latter is not an implicit repository checkout.

The compact TUI polls current projection plus one recent-record chunk; it never loads full ancestry. The browser inspector keeps an immutable history snapshot, lazily pages expanded Runtime subjects, virtualizes at most 1,000 retained rows, and fetches a transcript only after **View session**.

The consolidated tool runs the same TypeScript/source-lint preflight for `inspect` and `run`. Fresh runs default to branch `main`; existing single-branch runs can infer their only head, while multi-branch run inspection/view/resume requires an explicit selector. Run-target actions accept only `runId`; directory aliases are rejected; `respond` keeps exact `(runId, branchId, seqId)` identity. See the canonical [Pi tool API](https://github.com/surprisal-io/hyperchart/blob/main/docs/api/pi.md).

Asynchronous runs inject only a compact terminal boundary notice into the exact originating Pi session/workDir. An active owned user gate defers terminal delivery without receipting it. The extension never answers a gate automatically: hidden context tells the model to call `respond` only when the current prompt actually answers the displayed question; unrelated requests leave it open.
`--wait`/`wait: true` waits for terminal status or a user boundary and returns bounded identifiers/status only. Gate response identities remain exact; bounded prompt/option labels carry original/omitted character counts and are separate from exact option values. Structured user gates carry a bounded recursive, non-executable output contract; if any identity or contract cannot remain sufficient within its caps, delivery fails closed and directs the operator to the browser inspector.
Terminal notifications support JSONL and PostgreSQL storage; automatic Pi user-gate presentation remains JSONL-only. Background completion errors are contained and logged, with undelivered notifications recoverable on startup or agent settlement.
Stop waits for the runner process to exit. If it dies before writing its final status, a lingering `stopping` state is reconciled with an explicit cleanup-unconfirmed diagnostic rather than hanging the tool.
Terminal-notification delivery uses at-least-once semantics.
Durable terminal request IDs and recoverable claims prevent permanent suppression after crash.
The host may redeliver the same terminal notification after a crash between delivery and confirmation.
Treat each terminal `requestId` idempotently; user gates instead use exact `(runId, branchId, seqId)` coordinates.

## Pi agent tool

The consolidated `hyperchart` tool supports bounded responses only. Full definitions, schemas, runtime snapshots, visit histories, and transcripts never enter Pi tool results/session JSONL; `action: "view"` is the sole full inspection surface and returns exactly `{ "url": string }`. Deprecated `verbose: true` inspection calls are rejected.

Supported actions:

- `action: "list"`
- `action: "inspect"`
- `action: "run"`
- `action: "run_inspect"`
- `action: "view"` — open the localhost inspector and return its URL; pass `open: false` to return the URL only
- `action: "branches"` — return at most 100 durable heads plus `totalCount` and opaque `next`; pass `cursor: next` for the following page
- `action: "fork"`
- `action: "rewind"`
- `action: "stop"`
- `action: "respond"`

## Application entry points

| Import | Purpose |
|---|---|
| `@surprisal/pi-hyperchart` | same in-process command API as `/command` |
| `@surprisal/pi-hyperchart/command` | in-process `/hyperchart` request event |
| `@surprisal/pi-hyperchart/pi-runner` | embedded Pi executor, session services and typed extension policy |
| `@surprisal/pi-hyperchart/pi-host` | Pi host adapter: summary-only session lists plus on-demand full chart definitions (including launch metadata) and inspector runs; exposes originating Pi session for new runs |
| `@surprisal/pi-hyperchart/react` | inspector, graph, run strip, launch dialog, UI providers |
| `@surprisal/pi-hyperchart/react/styles.css` | required React stylesheet |
| `@surprisal/pi-hyperchart/package.json` | package metadata and Pi manifest |

Embedded background workers can set `PiExecutorOptions.extensionPolicy: "isolated"`
to avoid initializing interactive host extensions. The generic default is `"ambient"`. Ambient workers initialize Pi session services and extension providers before resolving the requested model; session creation reuses those services. Unknown explicit models still fail rather than falling back.
Completed/replaced sessions are shut down and released after transcript durability and
local retries; see the canonical [runtime API](https://github.com/surprisal-io/hyperchart/blob/main/docs/api/runtime.md#embedded-pi-workers).

Custom host configurations can import `createPiFileTranscriptReader(runId)` from `@surprisal/pi-hyperchart/pi-runner` for detached Pi sessions, independently of the journal backend. Embedded workers with a custom session store require its own transcript reader. See the [Pi API](../../docs/api/pi.md#file-backed-pi-transcripts).

## Bundled documentation

The published package includes `docs/`, runnable `examples/`, and the architecture diagram. The bundled skill links to these local, version-matched files so an agent does not need network access for authoring, tool schemas, or recovery guidance.

## Documentation

- [Pi extension](https://github.com/surprisal-io/hyperchart/blob/main/docs/pi.md)
- [Pi API and agent tools](https://github.com/surprisal-io/hyperchart/blob/main/docs/api/pi.md)
- [React API](https://github.com/surprisal-io/hyperchart/blob/main/docs/api/react.md)
- [Run your first chart](https://github.com/surprisal-io/hyperchart/blob/main/docs/quickstart.md)
- [Recovery and safety](https://github.com/surprisal-io/hyperchart/blob/main/docs/safety.md)
- [React and host integration](https://github.com/surprisal-io/hyperchart/blob/main/docs/integration.md)

MIT · experimental `0.6.0`

## Named branches

The consolidated `hyperchart` tool accepts `branchId`, non-empty unique `branchIds`, or omission for run. Omission starts fresh `main` or infers an existing run's only durable branch; multi-branch resume requires an explicit selector. Start `main`, fork durable heads, then resume with `branchId` or `branchIds` to execute the fixed set concurrently in one detached runner with a separate Pi executor per branch. Run inspection and view also infer only a single unambiguous branch; response, steering, and rewind select one explicit `branchId`. `action: "branches"` lists heads and `action: "fork"` creates a head without selecting or starting it. Rewind preserves all history and downstream files. `status.json` v2 persists stable `branchIds`, and session state is stored under collision-resistant `sessions/<sanitized-branch-prefix>-<hash>/...` paths.

Embedded session overrides expose the original durable `invocationId` for tool provenance; guards receive the same identity. See [integration](../../docs/integration.md#invocation-identity-for-custom-tools-and-guards).

Runs are addressed only by `runId`. Host storage config declares backend, root and `run-id` or `sha256` layout; existing literal framework and hashed AutoDiscovery layouts remain unchanged. See the [canonical runtime identity contract](../../docs/api/runtime.md#run-identity-and-storage-scope). Active-run state and metadata-backed, owned stopped-run completions are registration-scoped; see the [Pi API](../../docs/api/pi.md).
