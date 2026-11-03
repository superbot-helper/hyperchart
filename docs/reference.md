# Reference

The complete API reference is split by public entry point.

## Published APIs

- [DSL reference](api/dsl.md) — every chart constructor, typed selector, state field, transition, artifact, guard, schema, and composition primitive, with examples.
- [Core API](api/core.md) — normalization, parsing, inspection, AST, projection, machine, durable records, replay, execution loop, and async utilities.
- [Runtime API](api/runtime.md) — runtime and agent contracts, log stores, script execution, guards, schemas, artifacts, run directories, and terminal outcomes.
- [Host API](api/host.md) — discovery contract, canonical chart/run/state models, visit history, issues, and static/runtime adapters.
- [Pi API](api/pi.md) — command bridge, Pi host adapter, all consolidated-tool actions, parameters, results, and errors.
- [React API](api/react.md) — components, props, providers, graph/display helpers, models, peers, and stylesheet contract.

The [API index](api/README.md) lists every supported package entry point and the stability boundary.

## File contracts

### Run directory

```text
<run-dir>/
├── meta.json              # filesystem backend only
├── log.jsonl              # filesystem backend only
├── status.json            # filesystem backend only
├── runner.config.json
├── runner.stdout.log
├── runner.stderr.log
├── user-interactions/
│   └── <branchId>/
│       └── <seqId>/
│           └── receipts/        # presentation only; gates and answers are journal facts
└── sessions/
    ├── progress.json
    ├── steering/
    └── <branchId>/<actionUid>/<invocation>/
```

The run directory remains the host control-plane root. Without PostgreSQL, `meta.json` and the append-only v2 journal `log.jsonl` are its fundamental durable files. With explicitly configured PostgreSQL storage, run identity lives in `hyperchart_run_meta`, journal facts live in `hyperchart_journal`, and operational runner status lives in `hyperchart_run_status`; none of the three local files is required. Status and the selected UI branch are operational/non-durable; named branch heads are reconstructed from journal mutations. Status is read and patched through the run log store (`readRunStatus`/`patchRunStatus`), so hosts and runners never choose a backend themselves; status writes are allowed from read-access handles because hosts publish `starting`/`stopping` while the live runner holds the journal writer claim. The runner control mailbox follows the same rule: `runner-control/user-responses/` under JSONL, `hyperchart_control` rows under PostgreSQL. Hosts and runners wait for status or control changes through the store (`watchRunChange`): PostgreSQL wakes waiters by `LISTEN/NOTIFY` with a one-second fallback, JSONL re-checks every 100 ms. Persisted `status.json` schema v2 contains the runner's current live `branchIds` array (empty at terminal status) (legacy v1 is read for host delivery compatibility and upgraded on the next write). `sessions/progress.json` records `branchId` and producing invocation `seqId`; session directories are branch-separated with no migration of the old layout. Steering requests also carry `branchId`. A user interaction's exact external identity is `(runId, branchId, seqId)`; older two-component identities are rejected.

Artifact paths keep their authored mutable-file semantics. Branching the durable machine log does not version artifact contents: sibling executions may overwrite the same path, and historical artifact restoration remains a separate artifact-versioning problem.

### Process states

```ts
type HyperchartRunState =
  | "starting"
  | "running"
  | "complete"
  | "failed"
  | "stopping"
  | "stopped";
```

These run status values (`status.json` or `hyperchart_run_status`) are different from canonical host run statuses and per-state inspector statuses. See [Pi API](api/pi.md#process-status-values) and [Host API](api/host.md).

## Current limitations

- Interactive presentation requires a supported owning host session (currently Pi or Claude Code); journal-open gates remain inspectable and may be answered while the runner is stopped.
- Rewind cannot reverse external effects.
- Shared/static external effects require application-specific idempotency and reconciliation.
- Missing agent definitions are execution errors.
- Loading a chart executes its top-level TypeScript.
- Important durable runs should pin exact package versions.
