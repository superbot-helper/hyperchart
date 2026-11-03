# Architecture

![Hyperchart architecture from typed chart module through durable facts and Pi effects](../assets/readme/architecture.svg)

Hyperchart separates chart semantics from effect execution. The core package decides what a run means; a host runtime performs requested work and reports events back.

## Two packages

### `@surprisal/hyperchart`

The core package owns:

- authoring CST and typed refs;
- normalization into the frozen AST;
- generated source and static inspection;
- pure machine and projection;
- durable record contract and replay explanation;
- generic runtime, log, script, guard, artifact, and schema components;
- canonical host/inspector models;
- React inspector, launch dialog, run strip, and stylesheet.

Its runtime core (machine, projection, durable log, execution loop) has no dependency on Pi or React; the package also ships an optional React inspector subpath (`./react`) with optional peer dependencies on React, `react-dom`, `@xyflow/react`, `elkjs`, and `react-syntax-highlighter`.

### `@surprisal/pi-hyperchart`

The Pi package owns:

- Pi extension and command event API;
- chart, run, and agent-definition discovery;
- detached runner and heartbeat/status files;
- Pi agent executor and session progress;
- `/hyperchart` and the consolidated agent tool;
- terminal views;
- React integration surfaces (re-exports core inspector, launch dialog, and run strip; copies core's built stylesheet for the `.` export).

It depends on the exact matching core version. This avoids loading two semantic implementations into one run.

## Definition pipeline

```text
TypeScript chart module
        │ load executable module
        ▼
authoring CST + Zod schemas
        │ normalizeChartConfig()
        ▼
frozen serializable AST + diagnostics
        ├── generated source and static inspector model
        └── machine, projection, and replay
```

The authoring CST is optimized for TypeScript. The AST is flattened, serializable, and explicit about defaults. Normalization resolves paths, assigns action identities, converts schemas, validates transitions and refs, and rejects malformed structure before execution.

Static inspection begins at the AST boundary. It does not need a run, but loading the source module can execute top-level TypeScript.

## Pure decision loop

The machine receives state plus one machine event and returns one output. It does not perform I/O.

```text
ordered facts
    │
    ▼
projection ──► machine ──► append/effect requests
    ▲                          │
    └──── acknowledgements ◄── runtime
```

A runtime iteration:

1. project the branch from durable records;
2. derive the next machine request;
3. persist requested facts before dependent work;
4. dispatch agent, script, timer, validation, rejection, or cancellation effects;
5. feed completion and acknowledgement events back;
6. stop when the root reaches final or the runtime is stopped.

Persist-before-dispatch is important: after a crash, the log can show that an action was invoked even when completion is unknown.

## Facts, not transitions

The durable log records:

- run arguments;
- session references;
- map spawn sets;
- action invocations with normalized definition provenance;
- completion events;
- stored validation verdicts;
- deadline firing;
- rendered human interactions and their validated answers;
- rendered host-gate contracts and their validated answers;
- ordered domain events emitted atomically by accepted action outcomes.

Emit records are inert journal facts: they affect neither routing nor executor dispatch. They store the action identity, event, and resolved JSON payload. The journal does not record transition targets. Projection recomputes targets from completion events and the current AST.

This permits compatible chart edits while making incompatible edits detectable. If a historical event would now route differently, replay must report it rather than restore an old mutable state snapshot.

## Control and data

Control moves through events and transitions.

Data moves through named channels:

- run arguments;
- accepted reply payloads;
- transition inputs;
- pinned map keys/items;
- declared artifact paths;
- visit identity.

Templates resolve those channels immediately before dispatch. Transition bindings and emit payloads may select the accepted event output or resolve the same refs from the firing state's replay-derived scope; an unavailable ref fails before target entry or acceptance append. Prompt text and ambient files are not implicit workflow state. Executor-action invoke/complete/validated facts and opened user/host interactions snapshot the fully resolved declared state input for downstream journal consumers. Those optional JSON copies are informational provenance rather than replay identity, so replay continues to enforce the pre-existing action/guard/gate contracts and accepts older records that lack them.

## Hierarchy

Normalization flattens nested authoring states to absolute template paths for lookup while retaining parent/scope relationships.

- compound states enter one initial child and complete through a direct final child;
- parallel states enter every region and complete when every region is final;
- maps persist a spawn set, create keyed runtime paths, gate invocation concurrency, and complete when every instance is final.

A transition leaving a scope abandons active descendants. The runtime receives cancellation effects for work that is no longer part of the branch.

## Visits and generations

A state path identifies a node definition. A visit identifies one entry into that node.

Re-entry can create multiple visits of the same path. Maps also create generations: a later entry may spawn a new instance set while old completions remain historical. The runtime model marks those old completions `stale`; it does not present them as pending work in the current generation.

## Host boundary

The generic runtime accepts an `AgentExecutor`. The executor owns provider/session transport, but it must return chart events rather than choosing transition targets.

Pi adds:

- concrete agent definitions and defaults;
- agent sessions and finish tool;
- process lifecycle and heartbeat;
- project/user discovery;
- command, tool, TUI, and React surfaces.

Run status (`status.json`, or `hyperchart_run_status` under PostgreSQL) and session progress are operational overlays. They do not replace `log.jsonl`.

## Inspector boundary

Canonical inspection has two layers.

**Static:** normalized source, topology, contracts, schemas, transitions, artifact declarations, and definition issues.

**Runtime overlay:** process status, visits, resolved invocations/inputs, map generations, usage, sessions, validation attempts, artifacts, and replay issues.

Adapters produce canonical models. React components do not parse raw logs or rediscover agent definitions independently. Routine host/dashboard session snapshots contain only definition metadata and scalar run/status/progress summaries—never chart graphs, runtime state arrays, visit histories, prompts, schemas, session objects, or transcripts. A user-initiated inspector load requests the full run model on demand, keeps it inspector-local, and discards it when the inspector closes.

## Formal model

`tla/spec/Hyperchart.tla` is an independent articulation of machine semantics. It is not generated from TypeScript and should not be changed merely to make an implementation test pass. The control model abstracts both `user()` and `gate()` as actions whose opened facts are inert and whose resolved facts supply completion; emitted domain facts are likewise control-inert and occur only after the modeled acceptance transition.

Model-check scenarios cover review/fix, pipeline, validation gate, fan-out, map, and nesting:

```sh
for M in MCReviewFix MCPipeline MCGate MCFanout MCMap MCNested; do
  tla/tools/check.sh "$M"
done
```

The spec header documents fairness, micro-steps, and deliberately unmodeled host behavior. Read it before editing the machine or model.

## Real trace validation

The trace exporter records a sample run from the TypeScript engine. `tla/spec/HyperchartTrace.tla` checks that the exported trace is admitted by the formal spec.

```sh
node tla/tests/trace/record-sample.mjs
tla/tools/validate.sh tla/tests/trace/sample_chart.ts tla/.cache/trace/sample-run.jsonl main
```

`TRACE ACCEPTED` means the sampled engine behavior and spec agree. `DIVERGENCE` means the implementation, exporter, or model disagrees and must be investigated.

## Semantic change checklist

A change to normalization, machine, projection, execution loop, or durable facts is complete only when:

1. implementation semantics agree across normalization, projection, and machine;
2. durable-log replay either preserves old meaning or reports incompatibility;
3. replay-check tests cover the contract change;
4. the TLA+ model and model-check configurations agree;
5. the recorded sample trace is accepted;
6. user documentation describes the changed behavior.

Package moves, UI work, and documentation edits must not alter this contract accidentally.

## Related pages

- [Runtime and durability](runtime-and-durability.md)
- [Recovery and safety](safety.md)
- [Development and release](development.md)

## Explicit actor kernel

Static actor declarations normalize into lexical paths while runtime occurrences are projected from creation/mailbox facts. The authoring-only `self()` marker is placement-rebased during normalization into that declaration path while retaining `self: true` provenance; runtime occurrence resolution therefore reuses ordinary lexical/map/generation addressing. It is send-only, so the one-current-message call kernel is unchanged. The same finite occurrence input substrate now carries map `{key,item}` pairs. Machine effects perform exact async validation; only the single runner appends ordered facts. Details: [Explicit actors](./explicit-actors.md).

## Actor pool architecture

`ActorEndpointDeclarationAst` is the discriminated union of ordinary actors and actor pools. One `actor_created` fact for a pool generation materializes the declared fixed workers; workers use canonical `$worker` declaration paths and concrete `$worker-N` runtime paths. The endpoint, not a worker, owns the durable FIFO mailbox. `actorEndpointAdmission()` is the shared pure assignment view used by the machine and host adapter: it repeatedly takes the head and allows the scheduler to choose any compatible idle worker.

Assignments are durable facts, so replay validates the recorded worker's eligibility and never selects a worker again. Before acknowledgement, ordered reservations in `MachineState` make accepted messages and workers visible only to admission for that pool; after acknowledgement, projection is the durable owner of worker state. Per-worker current state, results, visits, artifacts, and sessions remain keyed by concrete paths. `Hyperchart.tla` mirrors endpoint creation, scheduler assignment, capacity, ordered batch resolution, closing, and quiescent stop; `ActorPool.tla` model-checks the bounded worker kernel, and the real trace retains pool provenance instead of collapsing it to a capacity-one actor.
