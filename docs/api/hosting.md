# Hosting API

`@surprisal/hyperchart/inspect` and `@surprisal/hyperchart/sessions` are the host-neutral surfaces a Hyperchart host builds on: chart/run inspection, the localhost browser inspector, and the on-disk session protocols (progress, steering, run status). Static `inspectChartAst()` results include optional serializable launch argument metadata; hosts should expose it through on-demand definition inspection rather than lightweight session summaries. Both the Pi extension and the Claude Code plugin are implemented on top of these surfaces.

## `@surprisal/hyperchart/inspect`

| Export | Purpose |
|---|---|
| `hyperchartRunFromRunId(runId, options?)` | Build a `HyperchartRunInfo` from a run identity in the configured storage scope: meta, parsed chart, durable log, status, and per-visit session progress. Transcript message payloads are omitted by default; pass `options.includeTranscripts: true` only for an on-demand browser inspector load. Model-facing Pi/Claude tool responses must never use that option. In that mode full transcript files are cached once per inspection, segmented by durable visit timestamps, then bounded for display. `options.readTranscript` plugs in a host transcript format; `options.agentDefaults` supplies declared agent metadata. When valid `runner.config.json` exists, its persisted role/model and toolset/tool mappings override mutable current settings for `resolvedModel`/`resolvedTools`; an invalid snapshot leaves those resolved fields absent rather than silently using current settings. |
| `readNeutralSessionTranscript(sessionsDir, sessionFile, options?)` | Default transcript reader: header-tagged JSONL of pre-flattened `HyperchartSessionMessageInfo` records. The default returns the newest 120 messages; `{limit: false}` returns the full transcript for visit segmentation. |
| `resolveContainedSessionFile(sessionsDir, sessionFile)` | Realpath containment guard shared by transcript readers. |
| `combineToolLifecycle(messages)` / `truncateTranscriptText(value)` / `limitTranscriptMessages(messages, options?)` | Shared transcript shaping: fold tool call + result into one lifecycle entry; cap displayed text or bound message counts. |
| `openRunInspector({ runId, loadRun, steerSession?, openBrowser? })` | Register a run with the process-wide localhost inspector and return its tokenized URL. `HYPERCHART_INSPECTOR_PORT` pins the port (falling back to an ephemeral port when it is already taken by another process); `HYPERCHART_INSPECTOR_HOST` sets the bind host (default loopback; `0.0.0.0` advertises the machine's LAN address in URLs). Under SSH no server-side browser is opened. |
| `closeRunInspectorServer()` | Test/shutdown hook for the inspector singleton. |
| Types | `HyperchartRunFromRunIdOptions`, `SessionTranscriptReader`, `SessionTranscriptReadOptions`, `NeutralTranscriptHeader`, `RunInspectorSource`, `OpenRunInspectorOptions`, `MAX_TRANSCRIPT_MESSAGES`, `MAX_TRANSCRIPT_TEXT_LENGTH`. |

## `@surprisal/hyperchart/sessions`

| Export | Purpose |
|---|---|
| `readSessionProgress(sessionsDir)` / `updateSessionProgress(sessionsDir, actionUid, patch, effectId?, branchId?)` | The `sessions/progress.json` protocol: branch-scoped, per-invocation agent sessions with status, launch plan, transcript file, counts, and current streamed activity. Pass the machine effect id and branch id so repeated visits and sibling branches retain independent records. |
| `sessionProgressKey(actionUid, effectId?, branchId?)` | Returns the storage key `<branchId>:<actionKey>:invoke:<invokeSeqId>` (`unknown` when the effect id has no durable seqId). This storage key is not the public semantic `session.actionKey`. |
| `createThrottledProgressWriter(sessionsDir, actionUid, actionName, effectId?, branchId?)` | Buffers streaming text/thinking deltas and writes them at most every 250ms while preserving branch/invocation identity. |
| `queueLiveSessionSteering(sessionsDir, branchId, actionKey, message)` / `queueSessionSteering(sessionsDir, branchId, actionKey, message)` / `watchSessionSteering(sessionsDir, deliver)` | Resolve a public semantic action key to exactly one live session before queueing; the low-level queue writes branch-addressed requests, and the runner drains each only into that branch-scoped executor. |
| `readRunStatus` / `patchRunStatus` / `markRunHeartbeat` | Async operational status v2 protocol with dynamic live `branchIds` and heartbeats. They open the configured run log store, so status lives in `status.json` for JSONL and in `hyperchart_run_status` for PostgreSQL; `patchRunStatus` is an atomic read-merge-write and is allowed while another process holds the journal writer claim. |
| `isRunLive` / `isTerminalRunState` / `isPidAlive` | Liveness checks used by hosts to attach, stop, or fail runs. |
| `actionUidKey` / `sessionProgressPath` / `runStatusPath` | Key and path helpers (`runStatusPath` is the JSONL-backend file only). |
| Types | `HyperchartSessionProgress` (including optional durable `visit` identity), `HyperchartSessionProgressFile`, `HyperchartSessionStatus`, `SessionSteeringRequest`, `HyperchartRunStatus`, `HyperchartRunState`, `StreamingProgressWriter`. |

Effect/storage building blocks (`AgentExecutor`, the finish protocol, prompt builders, `runAcceptanceLoop`, `GenerationTracker`, agent-definition loading, `createHostPaths`) are exported from [`@surprisal/hyperchart/runtime`](runtime.md). Runner and branch controls (`createHyperchartRunnerController`, `runHyperchartRunner`, fork/rewind and user interactions) are exported separately from `@surprisal/hyperchart/runner`. Dynamic branch admission is available only through the in-process controller API.
