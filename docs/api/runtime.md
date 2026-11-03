# Runtime API

Import the generic runtime from `@surprisal/hyperchart/runtime`:

```ts
import {
  ChartRuntime,
  JsonlLogStore,
  MemoryLogStore,
  FunctionRunner,
  ScriptRunner,
  checkArtifactFile,
  checkSchema,
  checkSchemaAsync,
  createAgentDefaultsResolver,
  createRun,
  withRunStorage,
  deleteRunStorage,
  loadRunMeta,
  resolveAgentDefaults,
  resolveArtifactValue,
  runGuard,
  saveRunMeta,
  serializeEnvValue,
  type AgentDefinitionResolution,
  type AgentExecutor,
  type UserExecutor,
  type GuardContext,
  type RenderedGuardInvocation,
  type RenderedArtifact,
  type Runtime,
  type SchemaCheck,
  SchemaRegistry,
  type SchemaRegistryLike,
} from "@surprisal/hyperchart/runtime";
```

## Agent recovery backoff

The generic `ChartRuntime` delays **durable agent retries** after transient provider failures
(e.g. in-flight capacity exhaustion, HTTP 429, 502, 503 or 504). Provider errors
that indicate depleted credits/quota and unknown errors remain non-retryable. The
chart's `onFail` policy still determines the maximum nudge/restart attempts and
records each decision in the journal; the runtime does not retry requests outside
that policy. The default is two nudges and one restart.

Retries use exponential backoff (30 seconds initially, doubling up to four minutes),
respect a numeric `Retry-After` when included in the reported error as a minimum,
and add jitter.
The delay is recomputed from the durable retry fact when a branch resumes. Stopping
or cancelling a branch cancels a pending delay. This retries the **agent action**,
not just the failed HTTP request: tools may have run before the failure and may be
invoked again. Actions with side effects must therefore be idempotent or have their
own deduplication.

## Embedded Pi workers

`PiAgentExecutor` and `PiExecutorOptions` are exported from
`@surprisal/pi-hyperchart/pi-runner`. `extensionPolicy: "ambient" | "isolated"`
controls extension initialization, independently of the tool allowlist:

- `"ambient"` (generic default) uses Pi's normal project/user/configured extension discovery.
- `"isolated"` disables ambient extension loading for background workers. Built-in tools,
  invocation `customTools` (plus `finish`), agent instructions and model resolution through
  the supplied `ModelRuntime` remain available. This does not change interactive Pi or
  global settings. Hosts needing extension-provided tools/providers must select `"ambient"`
  or supply their required tools/models directly; isolation does not import those extensions.

Ambient workers use Pi's `createAgentSessionServices()` before resolving an explicit model. This loads extensions and registers both provider-config and native providers into the supplied model runtime before constructing the session. The same services are reused for session creation, so extensions are not loaded twice. Provider-registration errors surface as startup diagnostics; an unknown explicit model still fails rather than silently falling back. Isolated workers continue to skip ambient extensions.

The executor retains a session through prompt, finish and artifact retries. Before delivering
completion it stops progress subscriptions, aborts/settles Pi, emits `session_shutdown`
(`reason: "quit"`) while extension contexts are still valid, disposes Pi and closes/drains
its session recorder. Rejection resumes from the durable transcript (or starts a new attempt
for `onReject: "restart"`), not a retained `AgentSession`. Cancellation, replacement and
executor disposal share exactly-once session teardown. Teardown also waits for the actual
in-flight SDK prompt, including asynchronous extension preflight: SDK `abort()` alone may
report idle before `before_agent_start` has settled. Cancellation therefore waits for such
hooks to finish rather than invalidating a context they can still use. The prompt is tracked
separately from the enclosing run to avoid a cleanup/finally dependency cycle.
Cleanup does not create chart events
or mutate the journal; recorder failures prevent successful completion delivery.
A thrown shutdown notification error does not replace an accepted completion: disposal
and recorder close still run, and the error is reported by executor `dispose()`.

Known SDK compatibility boundary: versions enforcing alphanumeric/local session IDs reject
Hyperchart's existing `:attempt:N` ID for `onReject: "restart"`. This is independent of
session teardown; hosts using such SDK versions must not assume restart works. Resume uses
the unchanged original ID and is covered by the PostgreSQL embedding regression.

## `Runtime`

```ts
interface Runtime {
  readonly branchId: BranchId;
  runEffects(effects: Effect[]): Promise<void>;
  eventsQueue(): AsyncIterable<MachineEvent>;
  beginDrain?(): void;
  dispose?(): Promise<void>;
}
```

The internal execution layer owns machine semantics, projection restoration, replay diagnostics, retention, and checkpoint cadence. Projector contract version 5 carries the invoke's recorded validation policy: a guard, explicit unguarded `null`, or unknown legacy omission. Removed-guard histories accept only matching recorded positive verdicts. Warning-only completed histories resume without a generic override; unresolved historical validation is blocked before executor construction/workspace materialization, even with an override. See [Recovery and safety](../safety.md#a-validator-was-removed). A runtime only interprets effects, returns machine events, and performs durable I/O. Runtime and storage never receive `BranchProjection` or interpret a checkpoint blob.

`runEffects()` must arrange for every non-terminal effect except best-effort `cancel` to eventually produce the corresponding machine event. Effects are consumed in the supplied list order. Each `durable_records` effect is one indivisible storage commit: append every record in that effect together or append none, and never split it into multiple commits. Durable records must be committed before emitting `durable_records_added`; when one machine output contains multiple `durable_records` effects, each effect remains a separate atomic unit and both commits and acknowledgements preserve their supplied order.

The machine groups adjacent, simultaneously admitted action starts into bounded commits of at most 32 `state_action/invoke` facts. Each invocation keeps its own durable row, sequence, parent, definition, and session identity; only the commit/acknowledgement boundary is shared. Dispatch reservations remain per invocation, and executors cannot start before their invocation group is acknowledged. Map/pool admission limits are applied before grouping. Completion/emit transactions, responses, actor admission reservations, and intervening effects are not merged. A runtime must not regroup effects on its own. Replay still consumes the individual facts in order, including historical prefixes within a committed group.

## `ChartRuntime`

```ts
class ChartRuntime implements Runtime {
  constructor(options: ChartRuntimeOptions);
  runEffects(effects: Effect[]): void;
  eventsQueue(): AsyncIterable<MachineEvent>;
  beginDrain(): void;
  dispose(): Promise<void>;
}

type ChartRuntimeOptions = {
  ast: ChartAst; // authored effect schemas/rendering only
  logStore: LogStore & CheckpointRepository;
  prepareStampedCommit?: PrepareStampedCommit; // opaque execution callback
  validateArtifactSnapshot?: ValidateArtifactSnapshot; // execution semantic callback
  agentExecutor: AgentExecutor;
  workDir: string;
  chartDir: string;
  schemaRegistry?: SchemaRegistryLike;
  now?: () => number;
  onWarn?: (message: string) => void;
};
```

`ChartRuntime` provides:

- JSONL or custom durable logging;
- generic script and trusted in-process function execution;
- TypeScript and script guards;
- timers and cancellation;
- validation rejection dispatch;
- a pluggable agent executor;
- journal-native durable user and host interactions.

`user()` and `gate()` actions do not dispatch an executor. The machine appends a rendered `user_interaction/opened` or `gate/opened` fact and waits. For a live run, the typed runner-control API sends the answer to the detached runtime that already owns the journal; that sole writer appends the matching resolved fact and acknowledges it directly to its machine. A stopped run temporarily opens the same writer API and consumes the fact on later replay. Storage is not an event bus and `LogStore` has no subscription/watch contract. Only user interactions enter human presentation scanning and request/receipt machinery; host gates are resolved directly by application code.

`dispose()` is idempotent and begins by refusing new effects and callbacks. It clears timers, disposes function, script, and agent executors, drains effect preparation and completion-admission work already in flight, then closes the event queue. Function disposal aborts signals and retires tracked invocations immediately; it never waits for user function promises that may not settle.

`ChartRuntime` is composed by the runner with an internal execution-owned branch session. Direct callers do not load or pass projections. The only execution hook visible to runtime is a synchronous `PrepareStampedCommit` callback that receives storage-stamped facts and returns opaque checkpoint envelopes plus a post-commit confirmation.

## In-process runner controller

`createHyperchartRunnerController()` prepares one parsed chart and shared journal, reserves the configured `branchId` or `branchIds` as initial seeds, and returns before launching them. `start()` launches those seeds only after their all-initial replay barrier and resolves with a `RunnerOutcome` when the aggregate runner terminates: `state` (`complete`, `failed`, or `stopped`), the aggregate `error`, and each settled branch outcome, whose `results` are the accepted state results of a branch that reached a terminal state. A finished run replays to its terminal state and resolves without starting agents. `runHyperchartRunner()` is the compatibility wrapper that creates the controller and awaits `start()`. Signal shutdown waits for every branch disposal; cleanup failures are recorded in stopped status while the process still uses the signal-derived exit code.

```ts
const controller = await createHyperchartRunnerController(config, buildExecutor);
const completion = controller.start();

const fork = await controller.forkBranch({
  branchId: "experiment",
  sourceBranchId: "main",
  fromSeqId: 42,
}); // durable head only; no runtime starts

const outcome = await controller.startBranch(fork.branchId); // explicit admission
await completion;
```

`startBranch()` verifies the controller's compact durable-branch set, reserves a new branch before its replay gate or executor construction, then resolves with that branch's `complete`, `failed`, or externally `drained` outcome. Each admitted branch owns a branch-scoped agent executor and runtime. Dynamic branches replay-gate independently; a gate/setup failure builds no runtime, contributes a failed aggregate outcome, and does not stop siblings. Concurrent or live duplicate admission is rejected. After a settled failure without a cleanup cause, `startBranch()` may readmit the same branch only after replay proves that its selected durable history has no terminal `failure_intent`; the replay check claims admission first so concurrent retries cannot both reserve it. Failed cleanup remains fenced.

`stopAndDrain(branchId)` operates only on a branch currently live in the same started controller attempt. It closes public operation admission synchronously, lets in-flight setup publish readiness when an already enrolled operation needs it, then makes the reservation non-runnable and begins runtime drain before queueing the durable seal. It resolves only after setup, runtime execution, completion admission, durable appends already in flight, and executor/script disposal have settled. The durable branch head is unchanged and sibling reservations keep running. Concurrent calls while the same drain is pending return the same promise. The corresponding `startBranch()` promise resolves with `outcome: "drained"`; cleanup failure produces a failed branch outcome. A successfully drained branch remains sealed until `startBranch()` replay-gates and readmits it. A move whose cleanup fails rejects with `BranchDrainError`, preserving the original failure in `cause` (possibly an `AggregateError`). A retained admission fence rejects `startBranch()` with `BranchAdmissionError`, distinct from retryable `BranchSealedError`.

`canStartBranch(branchId)` checks current controller admission availability without reserving, waiting or replaying history. It returns false for live reservations and temporary move fences, may return true for a settled failure without a cleanup cause, and throws `BranchAdmissionError` with the original cause for failed cleanup. `startBranch()` owns the authoritative replay check and reservation; a readiness check grants no lease and does not establish that the durable branch is retryable. `onBranchChange(listener)` returns an unsubscribe function and notifies after reservation settlement and after a temporary move fence is released, including a rejected commit with no journal mutation. Notifications carry no move result or restart instruction. An external scheduler can subscribe before scanning durable unfinished work, refresh mandatory projection, and admit only eligible missing executors. It must discard decisions invalidated during asynchronous projection/capacity reads and count provisional admissions until they settle. Durable terminal work is not retried; failed cleanup must surface rather than hot-loop. AutoDiscovery's orchestrator uses capped exponential backoff to readmit non-terminal branch failures without filtering by error text or imposing an attempt limit. Hyperchart still refuses a selected history with a durable `failure_intent` and fences failed cleanup. Replaying an unfinished invocation may repeat external effects, so effectful actions need idempotency or reconciliation. No machine/log facts change.

`moveBranch(branchId, targetHeadSeqId)` seals the branch and every durable descendant, drains affected live reservations, then atomically appends the head move and an execution-prepared opaque target checkpoint. Independent branches remain writable while the subtree drains. A live `rewindHyperchartRun()` request uses the runner control channel rather than opening a competing writer. Readmission restores the current moved head while sealed, verifies that the head did not change during setup, and only then installs the runtime and removes the seal. `BranchSealedError` distinguishes rejected post-seal mutations from ordinary admission failures.

`await durableBranchIds()` returns the controller's compact durable-branch set, including branches that are not admitted in this attempt. `liveBranchIds` and status-v2 `branchIds` are current live reservations, not durable branch selection; a branch remains listed while `stopAndDrain()` is still disposing it and disappears only at the drain boundary. `await activeBranchIds()` queries only each live branch head and includes draining reservations until disposal finishes but excludes branches suspended at a journal-native open user gate, so an external scheduler can bound actual execution without counting idle decision points. Forking adds the durable branch to the compact set but does not add a live reservation. A naturally terminal reservation is removed only after disposal, terminal notification persistence publishes `branchIds: []`, and the controller rejects fork/admission after it begins closing. Keep an existing reservation live while admitting more work; there is intentionally no filesystem, Pi-command, or MCP control plane for dynamic admission.

## Journal-native interaction input

Execution restores the selected branch state and validates the response, then calls generic `appendDraftsAtHead()` with an expected branch head and an opaque prepare/confirm callback. Storage knows neither gates nor projection semantics. Expected-head mismatches use the typed `BranchHeadMovedError`; execution retries only that error, never participant/application failures. The public host helper routes a live response through the owning runner's typed control queue; it opens a temporary writer directly only when status proves the runner is stopped. The opened fact's `seqId` is the public gate identity. Identical selected-ancestry retries are idempotent and do not enqueue a second acknowledgement into the live machine; divergent retries conflict; a timed-out, exited, failed, missing, or off-ancestry gate is stale.

JSONL serializes writes only inside one Node process, allocates against its private opened index, trusts stored entries, and rejects a stale byte boundary when detected. It provides no consistency guarantee for concurrent writers in different processes. PostgreSQL holds one session advisory writer claim for the lifetime of the runtime/store; a second live writer is rejected.

For trusted in-process hosts that must commit application ownership together with a response, the controller exposes PostgreSQL-only composite operations:

```ts
await controller.commitUserInteraction(
  { branchId: "main", gateSeqId: 42, event: { type: "SELECTED" } },
  (tx) => tx.query("insert into app.selection_claims (...) values (...)", values),
);

const committed = await controller.forkAndCommitUserInteraction(
  {
    branchId: "experiment",
    sourceBranchId: "main",
    fromSeqId: 42,
    responseBranchId: "experiment",
    gateSeqId: 42,
    event: { type: "SELECTED" },
  },
  (tx) => tx.query("insert into app.selection_claims (...) values (...)", values),
);
await controller.startBranch(committed.branch.branchId);
```

The callback receives only `query()`, not journal mutation methods. Branch creation, the matching `user_interaction/resolved` or `gate/resolved` fact, and participating SQL share the run writer's existing `BEGIN/COMMIT`. A failure rolls all of them back and leaves the in-memory journal snapshot unchanged. The fork point may be a historical record in the selected source branch ancestry; the source branch does not have to remain parked there after its first response. An identical branch/response retry is accepted only when branch ancestry, metadata, event, and application ownership agree exactly. JSONL and memory stores retain journal-native responses but reject cross-database composite commits because they cannot join a PostgreSQL transaction.

## `AgentExecutor`

```ts
type EmitCompletion = (event: ChartEvent) => void;

interface AgentExecutor {
  start(effect: AgentEffect, emit: EmitCompletion): void;
  reject(effect: RejectedEffect, emit: EmitCompletion): void;
  cancel(actionUid: ActionUID): void;
  dispose(): Promise<void>;
}
```

| Method | Contract |
|---|---|
| `start` | Start the rendered invocation. Call `emit()` with exactly one current completion claim. |
| `reject` | Apply `effect.onReject` using the rendered original invocation and rejection context, then call `emit()` with the next claim. |
| `cancel` | Stop live work identified by the concrete action UID. |
| `dispose` | Release sessions, processes, and other resources owned by the executor. |

The executor must not append Hyperchart durable facts directly. It reports chart events; the machine decides what becomes durable.

## Agent definition inspection

```ts
type AgentDefinitionResolution = {
  defaultModel?: string;
  modelRoles?: Readonly<Record<string, string>>;
  toolsets?: Readonly<Record<string, readonly string[]>>;
};

function createAgentDefaultsResolver(
  dirs: string[],
  parse?: FrontmatterParser,
  resolution?: AgentDefinitionResolution,
): (agentName: string) => HyperchartInspectAgentDefaults;

function resolveAgentDefaults(
  defaults: HyperchartInspectAgentDefaults,
  resolution: AgentDefinitionResolution,
): HyperchartInspectAgentDefaults;
```

`createAgentDefaultsResolver()` loads markdown definitions, preserves declared `role`/`toolset` plus model/tool fallbacks, and computes `resolvedModel`/`resolvedTools` from the supplied host mappings. Explicit resolved tool lists include the injected `finish` protocol tool. `resolveAgentDefaults()` reapplies another immutable mapping snapshot, which run-directory inspection uses for `runner.config.json` settings.

These helpers describe inspection configuration. Runtime launch strictness and chart-level override precedence remain owned by `buildSessionPlan()`.

## Log stores

`RunLogStore` owns the journal, branch heads, immutable run metadata, opaque disposable checkpoint rows, and the operational run status (`readRunStatus()` / `patchRunStatus()`). Writes use async `appendDrafts()`; the writer assigns durable coordinates and returns the committed facts. JSONL owns `meta.json`, `log.jsonl`, and `status.json`; PostgreSQL owns `hyperchart_run_meta`, `hyperchart_journal`, `hyperchart_checkpoint`, and `hyperchart_run_status`. Status is operational, not journal truth: `patchRunStatus()` is an atomic read-merge-write that read-access handles may call, because hosts publish `starting`/`stopping` while the live runner holds the journal writer claim, and a runner whose journal became unusable must still record its terminal outcome. `deleteRunData()` removes status together with identity and journal. `run_dir.ts` performs lifecycle orchestration and never selects a backend.

PostgreSQL read handles (`access: "read"`, the default for hosts, Inspector, status reads, and wait loops) borrow a connection from one process-wide pool per DSN and return it on `close()`; they hold no session state, so opening and closing them per operation costs no handshake once the pool is warm, and idle pooled connections never keep the process alive. Writer handles keep a dedicated connection for the run advisory lock and allocation head, and end it on `close()`.

### Runner control mailbox and change notifications

The store also carries the runner control transport: `publishControlRequest()` / `listControlRequests()` / `discardControlRequest()` on the request side and `publishControlResult()` / `readControlResult()` / `discardControlResult()` on the acknowledgement side. Publication is exclusive by id, so an acknowledgement is never replaced. JSONL keeps the mailbox under `runner-control/user-responses/{requests,results}/`; PostgreSQL keeps it in `hyperchart_control`, written by read-access handles like status. Commands are transport only; journal facts remain authoritative.

Waiting is event-driven. `watchRunChange(topics, { timeoutMs, signal?, persistent? })` arms a wait and returns `{ changed, cancel() }`; `changed` resolves when a `status` or `control` fact may have changed, or at the fallback timeout. Arm it before reading the state you wait on, then read, then await `changed`: a change landing during the read is already captured, so nothing is lost to the fallback. Call `cancel()` when the read already satisfied the condition. JSONL has no change signal worth trusting (macOS FSEvents can lag by seconds under load and would make waits nondeterministic), so it re-checks on a fixed 100 ms local interval that the caller's timeout only caps; a local re-read is a cheap readdir or stat. PostgreSQL holds one `LISTEN` connection per DSN per process (created by the first waiter, ended shortly after the last one leaves) on the `hyperchart_run_status` and `hyperchart_control` channels, which every status patch and mailbox publication notifies with the run id. Wake-ups are hints: every waiter re-reads state after waking and always has a fallback timeout, so a lost notification costs latency, never correctness. `persistent: true` keeps the process alive while waiting; the detached runner uses it so a run parked at a user gate stays resident, hosts do not.

### Snapshot-pinned history

History reads are stateless serializable request/response operations. There is no public `readAncestry()`, materialized log, full-history array, stateful reader, offset, `seek`, or `readAll()` API. Concrete stores expose only the bounded `RunHistoryStore` contract below; projection replay is not a store method or package entrypoint export.

```ts
type HistorySnapshot = { branchId: string; headSeqId: number | null };
type HistoryCursor = string; // opaque, versioned, snapshot + subject bound

type HistoryChunk<T> = {
  snapshot: HistorySnapshot;
  items: readonly T[];       // always newest-first, maximum 100
  older?: HistoryCursor;
  newer?: HistoryCursor;
};

interface RunHistoryStore {
  captureSnapshot(branchId: string): Promise<HistorySnapshot>;
  listBranches(cursor?: BranchListCursor): Promise<BranchListChunk>;
  getBranch(branchId: string): Promise<BranchHead>;
  getRecord(seqId: number): Promise<DurableLogRecord | undefined>;
  containsInHistory(input: { headSeqId: number | null; seqId: number }): Promise<boolean>;
  readRecords(input: { snapshot: HistorySnapshot; cursor?: HistoryCursor }): Promise<HistoryChunk<DurableLogRecord>>;
  readStateVisits(input: { snapshot: HistorySnapshot; state: StatePath; cursor?: HistoryCursor }): Promise<HistoryChunk<StateVisitHistoryItem>>;
  readMapVisits(input: { snapshot: HistorySnapshot; mapPath: StatePath; cursor?: HistoryCursor }): Promise<HistoryChunk<MapVisitHistoryItem>>;
  readActorGenerations(input: { snapshot: HistorySnapshot; logicalOccurrence: StatePath; cursor?: HistoryCursor }): Promise<HistoryChunk<ActorGenerationHistoryItem>>;
  readActorMessages(input: { snapshot: HistorySnapshot; occurrence: StatePath; cursor?: HistoryCursor }): Promise<HistoryChunk<ActorMessageHistoryItem>>;
  cursorAt(input: { snapshot: HistorySnapshot; subject: HistorySubject; seqId: number }): Promise<HistoryCursor | undefined>;
}
```

A cursor is valid only for the exact snapshot and typed subject that minted it; misuse throws `HistoryCursorError`. `cursorAt()` returns `undefined` when the durable coordinate is outside that snapshot/subject. Cursor absence is the only edge marker. Branch enumeration is separately read-committed and keyset-paginated in creation-coordinate order; each page contains at most 100 heads.

Storage returns AST-free durable record groups for state visits, map visits, actor generations, and actor message batches. State/map groups include their one-based ancestry ordinal for presentation. It never imports the chart AST, projector, or host presentation models. The host adapter performs AST-aware mapping in the inspector layer. Actor message history intentionally stays grouped by the durable enqueue transaction: one `HyperchartActorMessageBatchInfo` may contain several authored-order messages, and chunk/window caps count batch rows.

### Physical PostgreSQL journal pages

`readPostgresJournalPage(db, { runId, afterSeq, limit? })` from
`@surprisal/hyperchart/runtime` reads a single physical journal page in ascending
per-run sequence order. Unlike branch history, it includes records from **all**
branches plus `branch/create` and `branch/move` mutations, returning original
`StorageEntry` values. `db` supplies `query()` (a PostgreSQL pool or client).

`afterSeq` is an exclusive nonnegative safe-integer cursor; `limit` is 1–500
(default 500). The function issues one query, rejects sequence gaps and unsafe
coordinates, and returns an empty array at the current tail. Pages are
read-committed, not snapshot-stable. Callers own scheduling and durable consumer
cursors. This API does not write records, acquire writer ownership, subscribe to
notifications, or perform projection replay.

For application-owned SQL joins, `decodePostgresJournalRow(row)` and
`PostgresJournalRow` expose the same decoder used by the page reader. Input rows
must come from the trusted Hyperchart journal; payloads are not revalidated.

### Lazy inspector history

`hyperchartRunOverviewFromRunId()` asks the internal execution service for current graph/control state and returns a captured `HistorySnapshot`, the first keyset branch page, and an overview run with no elapsed `visitHistory`, map history, actor generation/message history, record tree, transcript arrays, queued mailbox `entries`, per-generation processed messages, or pool-worker message/visit histories. It retains only counts, mailbox head/current message, and current worker/session summaries. `createRunInspectorDataSource()` exposes serializable `readStateVisits`, `readMapVisits`, `readActorGenerations`, `readActorMessages`, `readRecords`, `cursorAt`, and `readVisitSession` requests bound to one run.

React Runtime histories share `VirtualizedHistoryList` and `useHistoryWindow`. A browser `?seqId=<durable coordinate>` deep link mints a subject-bound starting cursor through `cursorAt()` after the user selects the corresponding state. The DOM is virtualized by `@tanstack/react-virtual` with 20-row overscan; decoded state is capped at 1,000 rows. Older/newer errors are independent and remain stable until explicit retry, overlapping chunks deduplicate by durable identity, opposite-edge eviction retains a reload cursor, and snapshot/subject changes abort or ignore stale work. Inspector polling preserves the opened snapshot until **Refresh history** is chosen. Transcript messages load only through `readVisitSession` when a visit session is opened. Pi and Claude browser inspectors use the same stateless HTTP bridge; steering requests carry and validate the currently selected branch. Pi's compact TUI polls a projection-free execution overview plus one recent-record page and never requests complete ancestry.

Projection replay is a package-internal oldest-first `AsyncIterable`; each yielded batch contains at most 500 facts. It is absent from exported store interfaces and concrete class declarations and is not a host/UI history API.

The current PostgreSQL implementation deliberately computes these bounded results by traversing and filtering the captured journal history. This correctness scaffolding may consume work/memory proportional to history. The public contracts, snapshots, cursors, result caps, and replay-batch caps are final; the deferred version-order predecessor catalog will replace only backend internals. JSONL continues to use its complete private in-memory index and writes no index sidecar.

`JsonlLogStore` trusts parsed entries, fails malformed/incomplete JSON without changing the file, shares one private index across `forBranch()` handles, and rejects stale byte boundaries. `MemoryLogStore` provides the same history contract for tests and ephemeral execution.

### Opaque execution checkpoints

Runtime/storage exposes only this generic envelope:

```ts
type OpaqueCheckpointEnvelope = {
  checkpointId: string;
  headSeqId: number | null;
  selectorKey: string;
  blob: unknown;
  createdAt: number;
};
```

The internal execution layer computes the deterministic selector, AST identity, codec version, projection payload, replay diagnostics, compaction, and 512-record cadence. None of those concepts appear in runtime or backend declarations. Storage compares only `selectorKey` and ancestry coordinates and persists `blob` without opening it.

PostgreSQL stores envelopes in `hyperchart_checkpoint(selector_key, blob)` and commits due envelopes atomically with their journal facts. JSONL and memory keep envelopes in process memory only. The store stamps records under its branch writer boundary, calls the execution-owned synchronous prepare callback before durability, commits facts plus opaque envelopes, then calls its confirmation only after commit and before admitting another branch write. Preparation failure writes nothing; uncertain PostgreSQL commit or failed post-commit confirmation poisons the writer. Malformed, stale, incompatible, skipped, or warning-bearing projection payloads are handled exclusively by execution and never reinterpreted by storage.

## Script execution

### `ScriptRunner`

```ts
class ScriptRunner {
  constructor(options: { workDir: string; projectDir?: string; schemaRegistry?: SchemaRegistryLike; killGraceMs?: number });
  run(
    effect: ScriptEffect,
    validationAttempt?: { n: number; reason?: string },
  ): Promise<ChartEvent>;
  runGuard(
    guard: Extract<GuardRefAst, { kind: "script" }>,
    event: ChartEvent,
    renderedEnv?: Readonly<Record<string, string | RenderedArtifact>>,
    artifacts?: readonly RenderedArtifact[],
    reply?: SchemaAst,
    actionUid?: ActionUID,
  ): Promise<GuardOutcome>;
  cancel(actionUid: ActionUID): void;
  dispose(): Promise<void>;
}
```

`run()`:

1. resolves declared environment values;
2. spawns `command` with static `args` in `workDir`;
3. captures stdout and stderr;
4. maps a non-zero exit to `FAILED`;
5. reads the last non-empty stdout line as a JSON completion envelope when present;
6. validates the event type, reply schema, and declared artifacts.

`workDir` is the action cwd. Detached runners supply the isolated branch workspace there and pass the owning repository separately as `projectDir`. Every process receives authoritative `HYPERCHART_PROJECT_DIR` and `HYPERCHART_BRANCH_WORKSPACE` variables after authored env rendering. Direct/custom runtimes that omit `projectDir` expose `workDir` as both values.

Completion envelope:

```json
{"type":"DONE","output":{"count":3}}
```

If there is exactly one reachable non-`FAILED` event, exit 0 without an envelope emits that event. Otherwise the result is `FAILED` with an ambiguity error.

On a validation retry, the runner adds:

```text
HYPERCHART_VALIDATION_ATTEMPT=<1-based rejection count>
HYPERCHART_REJECT_REASON=<reason, when present>
```

`cancel()` sends `SIGTERM`, then schedules `SIGKILL` after `killGraceMs` (default five seconds) if needed.

Script and function actions use the exported `validateActionCompletion()` boundary for allowed-event, `FAILED`, reply, and artifact validation. `ChartRuntime` then applies the shared artifact admission/pinning boundary to successful completions.

## In-process function execution

### `FunctionRunner`

```ts
type ValidationAttempt = Readonly<{ n: number; reason?: string }>;

type ImportedActionContext = Readonly<{
  input?: Readonly<Record<string, JsonValue>>;
  events: readonly string[];
  actionUid: ActionUID;
  chartDir: string;
  workDir: string;
  projectDir: string;
  artifacts: Readonly<Record<string, string>>; // absolute paths
  signal: AbortSignal;
  validationAttempt?: ValidationAttempt;
}>;

type ImportedActionFunction = (
  params: Readonly<Record<string, unknown>>,
  context: ImportedActionContext,
) => ChartEvent | Promise<ChartEvent>;

class FunctionRunner {
  constructor(options: {
    chartDir: string;
    workDir: string;
    projectDir?: string;
    schemaRegistry?: SchemaRegistryLike;
  });
  run(
    effect: ImportedActionEffect,
    validationAttempt?: ValidationAttempt,
    prepare?: () => Promise<void>,
  ): Promise<ChartEvent | undefined>;
  cancel(actionUid: ActionUID): Promise<void>;
  dispose(): Promise<void>;
}
```

Relative action modules resolve from absolute `chartDir`; bare package specifiers pass to native `import()`. Rendered effect env becomes `params`: strings stay strings and selected artifact values are loaded, decoded, and schema-checked. The context receives a cloned resolved visit input, allowed events, copied identity, absolute runtime directories, and absolute paths keyed by artifact name. The function must return an explicit ChartEvent; unlike script stdout, there is no implicit single-event success.

A validation retry invokes the function again with one-based `{ n, reason? }` metadata. Exceptions and rejected promises become `FAILED` at `ChartRuntime`. Normal returns pass through `validateActionCompletion()` and then artifact admission/pinning.

`cancel()` aborts the signal and immediately settles the tracked invocation without awaiting user code. A result or rejection that arrives after abort is observed and discarded. `dispose()` aborts all live invocations and also returns immediately, allowing branch drain and rewind to finish even when a function ignores its signal or never settles. This only prevents late completion admission; continuing CPU work and side effects cannot be terminated in-process. Native imports are cached for the runner lifetime. See [Recovery and safety](../safety.md#in-process-function-actions).

## Guards

### `runGuard()`

```ts
type GuardContext = Readonly<{
  chartDir: string;
  workDir: string;
}>;

type RenderedGuardInvocation = Readonly<{
  scripts?: ScriptRunner;
  env?: Readonly<Record<string, string | RenderedArtifact>>;
  artifacts?: readonly RenderedArtifact[];
  reply?: SchemaAst;
  actionUid?: ActionUID;
}>;

function runGuard(
  guard: GuardRefAst,
  event: ChartEvent,
  context: GuardContext,
  invocation?: RenderedGuardInvocation,
): Promise<GuardOutcome>;
```

For `tsImport` guards:

- relative modules resolve from `chartDir`;
- package specifiers are imported directly;
- the named export must be a function;
- the function receives `(event, context, invocation?)`; existing one-argument guards remain valid;
- declared `env` is structurally validated and rendered into `invocation.env` by ChartRuntime;
- imported guards do not support artifact declarations or reply schemas; use a script guard for checked outputs;
- the result must be `boolean` or `{ ok: false, reason: string }`.

For script guards:

- simple static guards can be called directly; guards carrying `env`, `artifacts`, or `reply` must receive a `RenderedGuardInvocation` from ChartRuntime or fail with an actionable error;
- the process runs in `workDir`;
- stdin is the unchanged plain ChartEvent root object (`type`, `output`, or `error`); no guard-only artifacts field is added;
- dynamic env values use the same rendered script-action contract, including the validating action's own `artifactOf` and joined path refs;
- selected artifact reads resolve through the shared env resolver, including chart-scoped runtime-contract validation, failing closed when an exact contract is unavailable;
- when no `reply` is declared, stdout is ignored; when `reply` is declared, the last completion envelope is validated with the shared script reply checker;
- declared guard artifacts are checked with the shared artifact checker after exit;
- exit 0 accepts only after reply/artifact checks pass;
- non-zero rejects using trimmed stderr or the exit status as reason.

Guard env and artifacts are resolved only while a completion is pending validation. Reply output is validation-only, guard artifact declarations remain part of AST/provenance and the containing state's Files surface, and accepted durable verdicts are replayed without re-running the guard.

The function throws for import failures, missing exports, process-spawn failures, and invalid TypeScript-guard return values.

## Schema validation

### `checkSchema()`

```ts
type SchemaCheck = { ok: true } | { ok: false; errors: string[] };

function checkSchema(
  schema: SchemaAst,
  value: unknown,
  registry?: SchemaRegistryLike,
): SchemaCheck;

function checkSchemaAsync(
  schema: SchemaAst,
  value: unknown,
  registry?: SchemaRegistryLike,
): Promise<SchemaCheck>;
```

For ordinary schemas, validates against the normalized JSON Schema using TypeBox. For a `runtimeContract`, synchronous callers may validate only synchronous refinements; use `checkSchemaAsync` for exact validation. Contract metadata without its chart-scoped registry fails closed and never falls back to JSON Schema. Results retain original input values; Zod transform outputs are not substituted into the workflow.

```ts
const checked = checkSchema(schema, value);
if (!checked.ok) console.error(checked.errors);
```

## Artifact utilities

`RenderedArtifact` is exported by both the root and runtime entry points:

```ts
type RenderedArtifact = {
  name?: string;
  sourceState?: string; // producer for artifact-backed reads
  path: string;
  shape?: SchemaAst;
  select?: string;
};
```

### `resolveArtifactValue()`

```ts
function resolveArtifactValue(
  artifact: RenderedArtifact,
  workDir: string,
  registry?: SchemaRegistryLike,
): Promise<unknown>;
```

- resolves `artifact.path` inside `workDir`;
- rejects paths escaping `workDir`;
- returns raw UTF-8 text when neither `shape` nor `select` is present;
- otherwise parses JSON;
- validates the full parsed value when `shape` exists, including the original runtime Zod contract when one is declared;
- returns the selected dot-path when `select` exists.

Guard env resolution uses this resolver for selected `artifactOf()` reads; declared guard output artifacts are checked with `checkArtifactFile()` after exit. Duplicate or missing artifact names fail closed.

It throws for unreadable files, invalid JSON, schema mismatch, and unresolved selectors.

### `checkArtifactFile()`

```ts
function checkArtifactFile(
  artifact: RenderedArtifact,
  workDir: string,
  registry?: SchemaRegistryLike,
): Promise<{ ok: true } | { ok: false; errors: string[] }>;
```

Checks containment and readability. If a shape is declared, it also parses and validates JSON. It returns errors instead of throwing.

### `serializeEnvValue()`

```ts
function serializeEnvValue(value: unknown): string;
```

Returns strings unchanged and serializes every other value with `JSON.stringify()`. It throws `Environment value is not JSON-serializable` when serialization produces no string, including `undefined`, functions, and symbols.

## Run identity and storage scope

`runId` is the only public run selector. Never pass a run directory, infer an ID
from an arbitrary path, or provide both coordinates. All metadata, inspection,
history, branch, status, control, and notification helpers share one declared
backend/root/layout scope:

```ts
type RunStorage = {
  rootDir: string;
  layout: "run-id" | "sha256";
} & ({ kind: "jsonl" } | { kind: "postgres"; dsn: string });

await withRunStorage({ kind: "jsonl", rootDir: "/my/runs", layout: "run-id" }, async () => {
  const runId = await createRun("review");
  await saveRunMeta(runId, {
    chartPath: "/project/chart.ts", workDir: "/project",
    chartId: "review", createdAt: new Date().toISOString(),
  });
  const meta = await loadRunMeta(runId);
});
```

`createRun(chartId)` returns a generated ID (sanitized chart name plus UUID).
`initializeRun(runId)` creates the root branch for a known ID. `listRunIds()`
enumerates authoritative backend keys. `openRunLogStore(runId, {storage?})` uses
explicit configuration or the current async scope, never per-run persisted
backend inference or `HYPERCHART_PG_DSN`. The environment is not changed.

The existing framework layout is `rootDir/<runId>`; literal keys must be single
segments. AutoDiscovery explicitly uses `rootDir/sha256(runId)`. Hashed IDs may
contain semantic separators; they are hashed as opaque bytes, never resolved as
paths. No alternate-layout probing, registry, relocation, or metadata migration
is performed. Existing literal JSONL metadata remains readable without a stored
ID. New hashed JSONL metadata includes its ID for enumeration; PostgreSQL's
`run_id` primary key remains authoritative. Symlink escapes are rejected.

```ts
type RunMeta = {
  runId?: string; // populated by loadRunMeta; stored for new hashed JSONL runs
  chartPath: string;
  exportName?: string;
  workDir: string;
  chartId: string;
  createdAt: string;
  originSessionId?: string;
};
function saveRunMeta(runId: string, meta: RunMeta): Promise<void>;
function loadRunMeta(runId: string): Promise<RunMeta>;
function deleteRunStorage(runId: string): Promise<void>;
```

Missing metadata raises `ENOENT`; host ownership checks reject a foreign working
directory separately. Physical artifact/session/workspace paths remain storage
implementation details, not selectors. Controllers capture their storage scope
at construction; deferred inspection/history and control callbacks retain their
own scope even when another host registers a different backend later.

Run inspection exports are `hyperchartRunFromRunId`,
`hyperchartRunOverviewFromRunId`, and `createRunInspectorDataSource(runId, options)`.
There are no `FromRunDir` aliases.

## Terminal outcome helpers

### `RunTerminalState`

```ts
type RunTerminalState = "complete" | "failed";
```

### `terminalStateForFinalMachine()`

```ts
function terminalStateForFinalMachine(state: MachineState): RunTerminalState;
```

Returns `failed` when durable global failure intent exists or any active terminal leaf has `outcome: "failed"`; otherwise returns `complete`. This includes failed leaves in completed parallel regions. Terminal names do not infer run outcome.

When a non-user action declares input, `state_action/invoke`, `state_action/complete`, and `state_action/validated` carry a snapshot of the fully resolved input object. The optional copy is restricted to plain finite acyclic JSON and is informational durable provenance: replay derives transition input again, excludes the copy from identity, and remains compatible with old records that omit it.

Transition inputs accept `event()` selectors and ordinary refs. Ref bindings use the same replay-derived resolver as templates at transition-fire time; a missing result or selector throws before target entry.

## Journal-native interactions

Each user phase appends `user_interaction/opened` with its fully rendered prompt, options, allowed events, reply schema, action identity, and rejection metadata. Each host gate phase appends `gate/opened` with its rendered request event and payload, reply schema, action identity, and phase; allowed response events are derived from the selected chart transitions during admission and replay. The opened record's global `seqId` is the public `(runId, branchId, seqId)` interaction coordinate. An accepted external answer appends the matching resolved fact referencing that `gateSeqId`; projection applies it directly as the completion.

Human host scans restore each selected branch projection and select only open `user_interaction` records from `openUserInteractions`; `gate` records remain available to direct projection and targeted application lookup. Response admission and storage lookup accept either opened record type. Admission validates the restored open gate/pending action and commits an AST-free prepared response against the captured head, retrying rather than silently admitting across branch movement. When a stamped response reaches a 512-record boundary, execution synchronously prepares the opaque cache row and PostgreSQL commits it in the same managed transaction as the response and optional host participant. Ownership still requires exact `originSessionId` and canonical `workDir`. Presentation arbitration remains lexical by run, branch, and opened seqId, with claimed/confirmed gates pinned. The only files under `user-interactions/<branchId>/<seqId>/` are non-semantic delivery receipts and publication markers.

`validateAndPersistUserInteractionResponse()` performs ownership checks for either interaction kind and selects one of two modes. A live status with an exact runner-attempt identity queues a typed non-semantic control command; the owning runtime commits and acknowledges it. Only a stopped run opens a temporary writer directly. Allowed non-`FAILED` events and reply payloads are validated before append. Identical selected-ancestry retries are idempotent, divergent retries conflict, and closed or off-ancestry gates are stale. A crash between commit and acknowledgement is safe because retry observes the same resolved fact.

Rewind changes selected ancestry only. A resolved fact outside that ancestry neither answers nor conflicts with the selected gate.

## Terminal notification outbox

The runner persists `terminal-notification/request.json` before changing the run status to `complete` or `failed`. A request is deliverable only when its payload outcome exactly matches terminal status. Every newly created outbox request has a fresh UUID and records the host-generated runner-attempt identity from the run status. When a stopped or terminal run is started again, status opens a fresh attempt identity before the runner moves the previous outbox (including receipts) under `terminal-notification-history/`; the new attempt can then publish and deliver its own outcome without conflicting with an earlier failure. If the runner dies before that archival step, stale recovery detects the attempt mismatch, archives the predecessor, and publishes failure for the current attempt instead of inheriting the old outcome. Rewind does not move or delete an outbox; branch identity in payload and status prevents sibling delivery.

Delivery uses a recoverable per-host/session claim and a separate confirmed receipt under a request-hashed generation directory. Claims and confirmations require the caller's observed `requestId`; a host holding an archived generation can neither claim, overwrite a replacement's receipt, nor accidentally confirm it. Pi sends first, then confirms; if confirmation is interrupted, the persisted Pi custom message `requestId` supplies the acknowledgement during recovery. Claude's monitor writes one JSON notification per physical stdout line, then confirms. Claude exposes no host acknowledgement after stdout, so delivery is **at least once**: a crash after the line is written but before confirmation can cause a duplicate after the stale claim lease expires. A crash before stdout never permanently suppresses delivery.

Key helpers are:

- `archiveTerminalNotificationGeneration()` — retire a previous attempt's outbox after status becomes non-terminal;
- `persistTerminalNotificationRequest()` — persist once and fail on a divergent payload within one runner attempt;
- `readDeliverableTerminalNotificationRequest()` — require matching terminal status;
- `claimTerminalNotificationReceipt()` / `markTerminalNotificationReceipt()` / `hasTerminalNotificationReceipt()` — request-id-fenced, leased per-session delivery arbitration and confirmation;
- `recoverStaleRunTerminalNotification()` — fail a stale dead runner, preserving an already-written outbox and its error;
- `removeTerminalNotificationOutbox()` — cleanup used by rewind.

Notification artifact entries are authoritative absolute paths under `workDir`; file contents are never copied into the prompt.

## Complete export inventory

`@surprisal/hyperchart/runtime`:

```text
Runtime, AgentExecutor, EmitCompletion
ChartRuntime, ChartRuntimeOptions
JsonlLogStore, MemoryLogStore, PostgresLogStore, openRunLogStore, BranchHeadMovedError
LogStore, RunHistoryStore, RunLogStore
OpaqueCheckpointEnvelope, CheckpointQuery, PrepareStampedCommit, PreparedStampedCommit
HistorySnapshot, HistoryCursor, HistorySubject, HistoryChunk
BranchListCursor, BranchListChunk
StateVisitHistoryItem, MapVisitHistoryItem, ActorGenerationHistoryItem, ActorMessageHistoryItem
JOURNAL_CHANNEL, JOURNAL_TABLE, CHECKPOINT_TABLE, supportsSqlTransactions
PostgresRunTransaction, PostgresForkAndAppendInput, SqlCommitParticipant
ScriptRunner, FunctionRunner, validateActionCompletion, runGuard, checkSchema, checkSchemaAsync
artifact, schema, executor, run-directory, settings, status, and notification I/O helpers
```

`@surprisal/hyperchart/runner`:

```text
createHyperchartRunnerController, runHyperchartRunner, readRunnerConfig
listHyperchartBranchPage, getHyperchartBranch, forkHyperchartRun, rewindHyperchartRun
user-interaction scanning, receipt, response, and arbitration controls
runner/branch/rewind/user-interaction option and result types
```

Projection restoration, checkpoint selectors/codecs, retention plans, cadence constants, and `BranchExecution` are internal execution modules and are deliberately absent from both public entrypoints.

## Live projection retention

`BranchProjection` contains current synchronous machine state rather than elapsed history. `openUserInteractions` contains open `user_interaction` and `gate` records only; human scanners filter to `user_interaction`. Actor message lifecycle state has one authoritative entry in `liveActorMessages`, keyed by durable message ID; endpoint mailboxes, current worker slots, and `pendingActorCalls` retain IDs rather than duplicate mutable message objects. Settled non-call messages are removed immediately, while settled call messages remain only until the matching call-resolution fact. `artifactPins` contains the latest accepted revision for each rendered authored path and is attached to rendered artifact reads before the runtime performs asynchronous restoration.

The internal execution retention policy deletes session references proven non-resumable and canonical actor-message entries that have no mailbox, current-worker, or pending-call reference. Inputs, results, spawns, actor generations, and counters remain when future liveness is ambiguous. Compaction runs after projected batches and before execution encodes a checkpoint blob; runtime/storage cannot invoke or import it.

## Actor pool runtime behavior

Runtime adapters execute the same `actor_create`, `actor_enqueue`, and `actor_reply` effect kinds for ordinary actors and pools. The core scheduler may choose any idle, receive-compatible pool worker and emits that choice as an accepted fact before worker workflow invocation. Hosts must append each `durable_records` effect atomically and acknowledge multiple effects in their supplied order. Until an accepted append is projected, the machine keeps an ordered reservation for that pool so the message is virtually dequeued and the chosen worker virtually occupied; ordinary actors and unrelated pools continue independently. On restart, the internal execution service restores bounded replay batches to recover endpoint generations, worker ownership, partial batches, and drain state—never reconstruct or reassign from external worker sessions. Global failure best-effort cancels pending concrete worker actions.

## Named branch storage API

`RunHistoryStore.listBranches()` returns read-committed keyset pages of at most 100 durable branch heads. `listHyperchartBranchPage(runId, cursor?)` exposes the same bounded page contract for run-ID callers; its opaque `next` cursor continues from the following creation coordinate. No branch collector is exported. Runner/control helpers are imported from `@surprisal/hyperchart/runner`, separately from the projection-free runtime/storage package. Package-internal control paths may consume bounded pages when orchestration requires it. `appendDrafts()` numbers from the full journal and appends from the selected durable head. `listHyperchartBranchPage()`, `getHyperchartBranch()`, `forkHyperchartRun()`, and `rewindHyperchartRun()` expose named heads. Fork does not select/start. Rewind is an append-only move; live moves use the owning runner transport. It has no cleanup/backup options.
