# Runtime and durability

Hyperchart stores external and accepted workflow facts, then recomputes control state from those facts and the current chart.

This page describes the host-neutral runtime contract. For operator procedures, use [Recovery and safety](safety.md).

## The execution loop

A runtime iteration is:

1. read the normalized chart and ordered durable records;
2. project visits, accepted results, map instances, and pending actions;
3. ask the pure machine for the next output;
4. append requested records;
5. execute requested effects;
6. convert acknowledgements and completions into machine events;
7. repeat until the root reaches final or execution stops.

The machine does not call an agent provider, spawn a process, write a log file, or update Pi status. It returns data describing what the runtime must do.

## Machine output

The machine returns one of:

- `MachineOutputEffect` — append records, invoke an action, validate, start a timer, reject/resume, or cancel work;
- `MachineOutputFinal` — the root chart is complete;
- `MachineOutputError` — the machine reports a protocol or consistency error (e.g. a missing transition, a validation with no pending action) and the runtime throws.

Effect interpreters live in the runtime. This boundary keeps transition semantics testable without Pi.

The machine alone owns the pending-validation execution gate. It returns `MachineOutputError` before emitting obsolete effects. Runner and inspector do not repeat this check; projection restores facts and history remains inspectable.

## Append-only branch storage

`log.jsonl` is a flat v2 journal. Every line is either one branch create/move entry or one immutable `DurableLogRecord`, and every entry shares one positive per-run `seqId` namespace: the root `branch/create` owns `1`, then each record or branch operation consumes exactly the next id. Records also carry ancestry `parentId`, mandatory durable provenance `branchId`, and `timestamp`; gaps in record ids therefore identify intervening branch operations rather than missing records. Branch entries never enter chart projection.

A new run creates `main` before its first record. Only the v2 writer-produced format is supported; storage readers trust durable bytes instead of scanning for structural corruption or migrating legacy layouts.

JSONL parses the file and builds one private in-memory index when a read or write first needs the journal. It does not repair, truncate, or validate stored entries: malformed JSON fails the operation and leaves the file untouched. Branch handles created with `forBranch()` share that index, while independent readers open independent one-read views. Commits allocate from the shared writer index, reject a changed byte boundary, append only new flat entries, and publish them after the append succeeds.

PostgreSQL does not materialize the run journal on open. Branches, individual records, counts, and selected ancestry use SQL over the record `parent_id` chain. A transaction atomically reserves ids from the run's `hyperchart_run_meta.next_seq` counter, immediately inserts its rows inside `BEGIN`, and therefore sees its own writes without rereading or replay-validating the run. Counter reservations roll back with the transaction. PostgreSQL constraints and the session advisory writer claim are the storage contract. Replay compatibility still projects the selected ancestry against the current chart; that is a semantic check, not storage-integrity validation.

Hosts configure `storage: { kind: "jsonl" | "postgres", rootDir, layout: "run-id" | "sha256", dsn? }`; PostgreSQL requires `dsn`. One async scope captures backend, root and declared layout together. Public operations accept only `runId`; no path aliases, basename inference, persisted-backend override, environment fallback or global environment mutation occurs. Existing framework literal layouts and AutoDiscovery hashed layouts are preserved without migration or probing. See [run identity and storage scope](api/runtime.md#run-identity-and-storage-scope).

Public history uses a captured `{branchId, headSeqId}` and opaque stateless cursors. Record, state-visit, map-visit, actor-generation, and actor-message reads always return newest-first chunks of at most 100 items; cursors are bound to the exact snapshot and typed subject. Branch enumeration is read-committed keyset pagination rather than a history snapshot. The execution-only replay port is oldest-first and returns at most 500 facts to JavaScript per backend call. Storage returns AST-free durable record groups; host presentation mapping remains outside storage.

Inspector overview loading restores current graph/control state from a checkpoint and bounded tail, without embedding elapsed visits, map launches, actor histories, record trees, or transcripts. Expanding a Runtime history issues one stateless subject request. React virtualizes variable-height rows with `@tanstack/react-virtual`, retains at most 1,000 rows, and preserves reload cursors when evicting the opposite edge. Polling does not move an open history snapshot; refresh is explicit. Pi's compact TUI polls a projection-free execution overview plus one recent-record chunk. Actor-message history preserves one row per atomic enqueue batch, so multi-message transactions cannot overflow or corrupt page cursors by flattening.

The current PostgreSQL implementation is explicitly temporary correctness scaffolding: it may traverse and materialize the complete captured ancestry internally, then filters and caps the response. This is intentionally inefficient but does not leak an unbounded public result. `RunLogStore` has no `readAncestry()` or full-history snapshot method; host and UI layers receive only snapshot-pinned cursor chunks. A deferred version-order predecessor catalog will replace the backend implementation after a separate benchmark gate. JSONL answers the same contract from its private complete in-memory index and adds no on-disk sidecar.

Checkpoints are disposable cache, never journal truth. Runtime/storage sees only `{checkpointId, headSeqId, selectorKey, blob, createdAt}` and never imports projection code or interprets the selector/blob. The internal execution layer owns the projector/codec version, canonical AST digest, exact/nearest compatibility checks, replay diagnostics, synchronous `projectBranch()`/compaction, warning taint, and 512-record cadence. It supplies storage a synchronous callback over stamped records; storage invokes it before durability, atomically commits returned opaque envelopes with facts, and confirms execution only after commit and before releasing the branch writer. PostgreSQL uses generic `hyperchart_checkpoint(selector_key, blob)` columns. JSONL keeps envelopes only in shared process memory and writes no sidecar. Fork/rewind include an optional opaque envelope in the same branch mutation; clean shutdown asks execution to store an exact envelope after admitted work drains. Rewind compatibility/state selection may temporarily materialize ancestry inside the private control operation; this approved interim scaffolding returns only one match and is replaced when the deferred predecessor catalog lands.

A multi-record `appendDrafts()` call is the atomicity hint: PostgreSQL inserts its flat rows in one transaction, while JSONL concatenates its flat lines into one buffer and issues one `O_APPEND` write. JSONL serializes writes only within one Node process and intentionally provides neither cross-process writer consistency nor crash-atomic all-or-none recovery for a short or torn write. Each record owns its universal sequence id, and the final record becomes the branch head. Fork creates a head without selection; checkout/view is a non-durable handle; rewind appends a head move and preserves every prior record and downstream file. A live head move is routed through the owning runner: it closes new admission, drains the affected durable branch subtree, commits the move plus opaque checkpoint, and requires replay-gated readmission before execution resumes. Its generic storage acknowledgement includes the previous head and durable record count observed at the serialized move boundary, so live rewind results cannot report a stale pre-request snapshot.

One detached runner process may execute a dynamic, non-empty set of live branch reservations concurrently. It replay-gates all initial branch seeds before starting any initial runtime; dynamically admitted branches gate independently. Each admitted branch gets one `ChartRuntime` and one host executor over the shared journal. Executor instances are deliberately branch-scoped: Pi/Claude live-session maps cannot collide across branches. The process is failed if any branch fails; `status.json` v2 publishes current live `branchIds` and terminal states use `[]`. A singleton `branchId` runner config remains accepted and is normalized to one branch.

The run owns two different filesystem locations. `projectDir` is the repository/project directory recorded as `meta.workDir`; it scopes discovery and ownership but is not an action cwd. Each branch executes in `branchWorkspace = <runDir>/workspaces/<branchId>`, materialized only from pinned Hyperchart artifacts. Agent system context names both paths and warns that the branch workspace is not a repository checkout. Scripts receive authoritative `HYPERCHART_PROJECT_DIR` and `HYPERCHART_BRANCH_WORKSPACE` variables while retaining the branch workspace as `cwd`. Editing `projectDir` explicitly is outside branch-workspace isolation.

## Bounded live projection

`BranchProjection` is current machine state, not a history view. It retains only open journal-native interactions (`user_interaction/opened` and `gate/opened`); resolving, closing, or global failure removes them, while exact historical response lookup and UI history come from the storage history API. `liveActorMessages` is the sole mutable owner of queued, current, or unresolved-call messages; endpoint mailboxes, workers, and pending calls retain message IDs only. Settled non-call message history is reconstructed from durable record groups rather than accumulated in each endpoint. The retained `actorProducerVisits` counter is exact and monotonic: replay requires each enqueue to use the next producer visit and canonical `<producer>:message:<visit>:<batchIndex>` identity, preserving durable global message-id uniqueness after settled payloads leave live state.

Accepted completion pins are projected into `artifactPins`, keyed by rendered authored path. `machine` attaches the current pin to each rendered artifact read, so `ChartRuntime` restores the accepted revision without reading ancestry or performing storage I/O from synchronous machine code.

The internal execution retention policy records statically discovered result readers, externally read map scopes, resumable actions, and re-enterable states. Compaction is synchronous and prunes only values proven dead; inputs, results, spawns, actor generations, and other values are retained whenever loops, guards, dynamic map paths, actor-local control, or future readers make liveness ambiguous. A stronger whole-chart data-flow analysis is deferred rather than guessed. Runtime/storage cannot import this policy.

## Why store facts instead of current state

A mutable checkpoint answers “where did the old program say it was?” A fact log lets Hyperchart ask “what state follows from these accepted facts under this chart?”

That distinction supports:

- deterministic projection;
- visit and result history;
- pinned map instances;
- replay compatibility checks after chart edits;
- detection of missing action provenance;
- independent validation against the TLA+ model.

It also means chart changes are not automatically safe. If an old event would route differently, `explainReplay()` reports the mismatch. Resolved state `input` copied onto `state_action/invoke`, `state_action/complete`, `state_action/validated`, `user_interaction/opened`, and `gate/opened` facts is informational durable provenance for journal consumers. It is intentionally excluded from replay identity, so changing a copy cannot mask or relax action-definition, guard, interaction-contract, transition, or artifact provenance checks.

## Projection

Projection derives:

- the active branch;
- one visit identity per entry;
- accepted results by runtime state path;
- transition inputs bound to visits from event selectors and durable refs;
- map spawn generations and instance paths;
- pending action invocations;
- completed and stale visits;
- deadlines and validation attempts.

Runtime map paths include keys:

```text
chapters#intro.write
```

Template paths omit keys:

```text
chapters.write
```

The distinction matters for artifact lookup, state selection, rewind, and replay diagnostics.

## Invocations and provenance

Every new `state_action / invoke` record stores an `actionUid`, the normalized action definition, `validation` (the guard or explicit `null`), and—when declared—a JSON snapshot of the visit's resolved input. Replay compares the definition with the current chart and treats the input snapshot as informational only. The same snapshot is copied to `complete` and `validated` phase facts so journal consumers do not need to navigate ancestry to recover state identity carried through transition refs.

The definition includes the action kind and settings needed to establish meaning: agent name and invocation overrides, script command/args/environment templates, schemas, reads, and artifact declarations.

A historical log without required provenance is structurally incompatible. Hyperchart must detect it as broken instead of assigning the current definition retroactively.

## Completion and validation

An action completion is a claim. The runtime checks:

1. event type is allowed;
2. reply output matches the declared schema;
3. declared artifacts exist and match their shapes;
4. an optional validator accepts the claim.

A validation verdict is durable. Replay reads the stored verdict; it does not run validator code again.

Transition ref bindings and declared emit payloads resolve at the accepted completion boundary (or positive verdict), after the result has entered the replay-derived result map and before the target state enters. They use the same resolver as prompt/effect refs, so an emit may read its own action result. Missing results or selectors and non-JSON payloads fail before any acceptance batch is appended.

A successful unguarded completion or interaction resolution is appended together with all of its `emit` records; for guarded actions, the positive `state_action/validated` fact and emits form that batch instead. Emit order is declaration order. Each emit fact stores the action identity, event, resolved JSON payload, and journal coordinates. A rejected verdict and `FAILED` outcome append none. Projection treats emit records as inert ordered journal facts: they advance sequence bookkeeping but do not route the chart or dispatch effects.

Removing a validator is a supported warning-level replay change, not permission to accept old claims. `guard_removed` warnings are informational: matching recorded positive verdicts accept; recorded rejections keep the same invocation/retry cycle and do not publish results or pins. New invocations use the current chart's explicit unguarded policy. A different current guard remains a blocking stale diagnostic by default.

An invoke without `validation` has unknown legacy policy. With no current guard, its completion stays provisional until a verdict is recorded; even genuinely unguarded legacy completions are blocked when their policy cannot be proved. Unresolved historical guarded/unknown invocations cannot resume under the unguarded chart, including with `ignoreReplayWarnings`. No historical AST is fabricated and no later/sibling snapshot is consulted. See [the recovery procedure](safety.md#a-validator-was-removed).

Projection checkpoint contract version 6 retains per-invocation validation policy and open user/host interactions across bounded replay batches and invalidates prior projector caches. Histories with compatibility diagnostics, including informational removed-guard warnings, remain non-checkpointable so a cache cannot hide warnings.

## Artifact pins

A declared deliverable file is mutable on disk, but the state the workflow *accepted* is a fact. When a run directory is configured, completion admission snapshots each declared artifact into a content-addressable store inside the run directory and records a pin on the completion fact:

- the file is copied first and the copy is hashed, so the pin references exactly the stored bytes even if the working file keeps changing;
- a no-replace hard link installs the hashed copy only if its object path is absent; concurrent puts of identical bytes reuse and verify the existing object rather than replacing it, so readers never encounter a transient missing path during replacement (including on `virtiofs`);
- schema checks at admission run against the snapshotted bytes, so the accepted revision is the validated one;
- the completion fact stores `artifacts: { <renderedPath>: { hash, size } }`; the pin is provenance — replay never re-hashes;
- store objects live at `<runDir>/artifact_store/objects/<aa>/<rest-of-sha256>` and are externally verifiable with `sha256sum`;
- identical content across branches or retries maps to one object.

On action entry the runtime restores each declared read to its pinned revision: if the file at the authored path no longer hashes to the producer's pin (a sibling branch overwrote it, or it was edited out of band), the pinned bytes are copied back before the action starts. Reads whose producer completion carries no pin keep current-file semantics. Files touched outside declared channels are outside the guarantee.

Completions recorded without pins — pre-versioning logs or runtimes without a run directory — are reported by `explainReplay()` as `unpinned` diagnostics: valid history whose historical artifact values are unverifiable.

Authored paths keep their public semantics: the working file stays where the chart declared it; the store is an append-only shadow, never a replacement.

## Map durability

A map appends `spawned` with the exact keys and items resolved on entry. Replay uses that record rather than re-reading a changed upstream value.

`concurrency` affects when instances may invoke actions. It does not change the persisted spawn set. Runtime inspection marks active instances held before invoke as `waiting`; only admitted instances are `running`.

Re-entering a map can create a new generation. Runtime inspection distinguishes generations so completions from an older traversal are shown as stale rather than pending in the current one.

## Operational overlays

The Pi package adds files that are useful but not semantic history:

| File | Meaning |
|---|---|
| `status.json` | v2 pid, heartbeat, process state, current live `branchIds`, opaque runner-attempt identity, terminal error, timestamps (JSONL backend; PostgreSQL keeps the same fields in `hyperchart_run_status`) |
| `terminal-notification/request.json` | persist-once terminal prompt/outcome/artifact-path outbox with a fresh per-attempt UUID, written before terminal status |
| `terminal-notification/receipts/<request-hash>/*.json` | generation-isolated, recoverable per-host/session terminal-delivery leases and confirmed receipts |
| `terminal-notification-history/<generation>/` | complete outboxes archived when a terminal run starts another attempt; prior requests and receipts remain auditable but are no longer deliverable |
| journal `state_action/{invoke,complete,validated}` | executor action phase fact plus the resolved state input object when declared; the optional copy is informational and replay-compatible with old records |
| journal `user_interaction/opened` | fully rendered durable human interaction plus informational state input; its record seqId is the external interaction identity |
| journal `user_interaction/resolved` | validated external input that directly completes the user action |
| journal `gate/opened` | fully rendered host request event/payload/reply contract plus informational state input; its record seqId is the external interaction identity |
| journal `gate/resolved` | validated external input that directly completes the host gate |
| journal `emit` | inert ordered domain event and resolved JSON payload appended with accepted completion |
| `user-interactions/<branchId>/<seqId>/receipts/*.json` | non-semantic per-host/session presentation claims and confirmations |
| `user-interactions/<branchId>/<seqId>/receipts/*.published` | internal immutable publication-order markers used only for cross-process presentation arbitration |
| `runner-control/user-responses/{requests,results}/*.json` | attempt-fenced, non-semantic command/ack transport to the sole live runtime writer; journal facts remain authoritative. PostgreSQL keeps the same mailbox in `hyperchart_control` |
| `sessions/progress.json` | optional branch-tagged agent progress summaries |
| `sessions/<sanitized-branch-prefix>-<hash>/<actionUid>/<invocation>/` | collision-resistant branch-separated host conversation state and usage; there is no legacy-directory migration |
| `sessions/steering/*.json` | requests carrying `branchId`; the runner routes each only to that branch's executor |

A run may have a valid log and a stale process status. Conversely, a process can be alive while replay is incompatible. Operators must inspect both.

## Generic runtime components

`@surprisal/hyperchart/runtime` exports the supported runtime building blocks:

- the `Runtime` effect-interpreter interface;
- `ChartRuntime`;
- `AgentExecutor` and journal-native user/host interaction admission;
- `ScriptRunner`;
- `JsonlLogStore`;
- run-directory and metadata helpers;
- artifact, guard, schema, and terminal-outcome helpers.

The generic runtime receives a host `AgentExecutor`. It owns effect interpretation and log mechanics; the host owns actual agent transport and session lifecycle.

Terminal notification metadata is a runner/host outbox protocol, not a durable machine transition or log fact. Delivery waits until `status.json` matches the request outcome. Each host launch opens a fresh opaque runner-attempt identity, and terminal requests record that identity. A new runner attempt archives any prior attempt's complete outbox, so a recovered run may publish a different eventual outcome without rewriting the old request; stale recovery also rejects a predecessor request if the process dies before archival. Receipt claims and confirmations are fenced by the caller's observed request UUID, preventing an in-flight old generation from confirming and suppressing its replacement. Human user interactions are a second file-backed rendezvous: the runner persists every open user request immediately and remains alive while waiting, but only the containing branch blocks. Hosts select one owned request across parallel/map branches and runs by lexical `runId`, then numeric `seqId`, pinning it until response or close. Exact `originSessionId + canonical workDir` checks prevent another session or checkout from answering it. Host-resolved `gate()` actions do not enter this presentation scan or create request/receipt files.

A host validates the exact active `(runId, branchId, seqId)` coordinate, non-`FAILED` allowed event, and optional reply schema before atomically publishing either interaction resolution through the shared controller/offline APIs. Identical responses are idempotent; divergent ones conflict. Machine cancellation closes an abandoned phase, while executor disposal on operator stop preserves it for resume. User gate files remain inspectable; only the exact live runner branch may accept a response, and global sequence ids are never reused.

## Agent executor contract

A host executor receives a normalized agent effect and must report a completion event or failure through the runtime contract. It is also responsible for cancellation and cleanup of live work.

The executor must not invent transition targets. It returns events; the machine resolves targets from the chart.

For a custom host:

1. normalize the chart;
2. create a `JsonlLogStore` and runtime working directory;
3. implement `AgentExecutor` with stable invocation identity;
4. preserve event and artifact validation;
5. propagate cancellation;
6. expose semantic logs separately from host status.

See the exact exports in [Core API](api/core.md) and [Runtime API](api/runtime.md), and canonical UI models in [Host API](api/host.md).

## Replay compatibility

`explainReplay()` returns compatible, stale, skipped, and broken findings. The runner blocks stale/skipped replay unless the operator explicitly overrides warnings. Broken records remain unsafe.

Typical causes:

- an event now targets another state;
- a state or action no longer exists;
- an invocation definition changed;
- validator provenance changed;
- map or hierarchy structure changed;
- old logs lack mandatory provenance;
- a record belongs to a traversal skipped by the current chart.

Do not treat an override as migration. For recovery steps, read [Replay warnings](safety.md#replay-warnings).

## Crash ambiguity

The log append and an external side effect are not one atomic transaction. The critical ambiguous window is:

```text
invoke persisted → external side effect → crash → no completion persisted
```

The runtime can show the pending invocation and associated session/process information. It cannot infer whether a remote side effect happened. Reconciliation belongs to the host action and operator.

## Formal trace validation

The repository records a sample run from the TypeScript engine and checks that its exported trace is a behavior accepted by `tla/spec/HyperchartTrace.tla`.

```sh
node tla/tests/trace/record-sample.mjs
tla/tools/validate.sh tla/tests/trace/sample_chart.ts tla/.cache/trace/sample-run.jsonl main
```

`TRACE ACCEPTED` means the sampled engine and formal spec agree. The sample exercises an emitted domain fact plus both human and host-resolved interaction records; trace refinement consumes their exact journal order while keeping opened/emit facts control-inert. It does not prove external agent or script side effects or storage appends are transactional; append-batch atomicity remains covered by runtime/store tests.

## Related pages

- [Recovery and safety](safety.md)
- [Architecture and TLA+](architecture.md)
- [Host and React integration](integration.md)

## Actor mailbox facts

Explicit actors use the durable log as their only state. Creation, atomic enqueue, receive acceptance, reply validation, settlement/call wake-up, closing, drain, stop, and failure intent are semantic facts. Replay never reads an actor snapshot. Typed `actorRef()` forward targets are resolved during normalization to the same static declaration paths used by direct targets; authoring binding identities and symbolic names are absent from the AST and journal. Map occurrence and actor generation resolution therefore remain producer-relative and replay-stable. See [Explicit event-sourced actors](./explicit-actors.md).

## Completion endpoint facts

A chart-owned completion has two journal facts: `completion/notified` contains the root endpoint name, event, exact-validated payload, source action/visit, normalized notify definition, and endpoint declaration; `completion/consumed` binds that notification sequence to one exact `waitFor` action visit. Projection retains the notification before the wait is active, making notify-before-wait deterministic. It rejects a second notification, a second consumption, changed provenance, or a stale wait visit.

The machine appends `completion/notified` with the actor notify action's `state_action/complete` in one `appendDrafts()` unit. It appends `completion/consumed` with the wait action's completion/result in another unit. Thus replay exposes neither a published completion whose notify action stayed pending nor a consumed completion whose wait failed to advance. Exact schema validation is a dedicated runtime effect before publication; invalid payloads become global failure intent and publish no completion fact.

Completion state lives only in `BranchProjection.completions`, so ordinary run log ownership and branch ancestry isolate it without a process-global registry. A stopped runner reconstructs it from the journal and resumes waiting or consuming without polling. Actor scope exit cancels ordinary pending effects; late effect responses are stale and cannot publish. Authoring `completionRef()` identity is discarded during normalization, and runtime facts use only the static root declaration name.

## Actor pools and batch facts

`actor_created.definition` contains the endpoint union; a pool record carries declared concurrency and the worker graph and materializes exactly that many workers. `actor_messages_enqueued.source.kind` remains one of `send | sendBatch | call | callBatch`, and every envelope preserves `callId` when present plus authored `batchIndex`. A normalized self-send retains `definition.self: true`, while `targetDeclaration` and `occurrence` record the resolved endpoint; for a pool this is the shared endpoint and `workerIndex` appears only when admission later assigns the message. Pool `actor_message` accepted/replied/settled facts require `workerIndex`; `occurrence` continues to name the endpoint. `actor_batch_call_resolved` stores `callId`, caller state, and ordered `messageIds`, while reply payloads stay in item reply facts. Projection derives the public `result(callBatchState)` array only from that all-settled fact plus its validated item replies, so checkpoints, replay, and resume cannot expose partial results.

Replay validates the FIFO head, that the durably selected worker was idle and receive-compatible at that prefix, assignment/reply/settlement identity, group membership and order, and full settlement before resolution. Fresh execution may select any eligible worker. While a pool acceptance append is unprojected, the machine keeps an ordered pool-local reservation that virtually dequeues its message and occupies its worker; it does not gate ordinary actors, unrelated pools, or other durable work. Projection becomes the sole owner of active worker state when the matching acknowledgement is applied. Closing stops external admission but continues pool assignment and active work; stop requires an empty mailbox and no worker current message.

### Guarded artifact acceptance

Completion facts snapshot declared action artifacts before validation, but guarded snapshots remain provisional. Only `validated(true)` promotes that completion's pins into accepted ancestry. A rejection preserves provisional bytes for retry/recovery of the same invocation on its originating branch; forks inherit accepted pins only. Unguarded completions retain immediate acceptance. A guard's `artifactOf` read of its own action resolves the working output, never a stale accepted revision. Guard-produced auxiliary files retain their existing validation-only behavior; this does not introduce a second artifact publication channel.

Projection checkpoints use projector version 4; earlier caches are discarded and existing completion/verdict facts rebuild this distinction without journal changes. Old guarded completions are interpreted according to their recorded verdicts, not revalidated. Workspace overlays are recovery state, not accepted history. Artifact bytes/pins are outside the control-flow TLA state space; the acceptance transition corresponds to its existing successful-validation transition, exercised by runtime replay/fork tests.

A fork at a pending or rejected guarded completion must produce a fresh branch-local completion before it can accept the result. Foreign provisional validation is rejected before invoking the guard; inherited rejection feedback requests local artifacts. The declared `onReject` resume/restart policy and retry budget apply normally, including fail-closed exhaustion at `retries: 0`. Projection rejects a foreign positive verdict rather than pairing its result with older accepted bytes. No retry budget or invocation identity is reset implicitly.
