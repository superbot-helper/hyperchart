# Development and release

This repository is an npm workspace with three publishable packages and shared tests, examples, Storybook, documentation, and formal models.

## Requirements

- Node.js 22.19 or newer
- npm
- Java, for TLA+ model checking
- Pi, for extension and TUI testing

Install dependencies:

```sh
npm install
```

## Repository layout

```text
packages/
├── hyperchart/
│   ├── src/core/
│   ├── src/runtime/
│   └── src/host/
├── claude-hyperchart/
│   ├── src/
│   │   ├── mcp/
│   │   └── claude/
│   ├── bin/
│   ├── hooks/
│   └── skills/
└── pi-hyperchart/
    ├── extensions/
    ├── skills/
    ├── docs/              generated bundled documentation mirror
    └── src/
        ├── runtime/pi/
        ├── tui/
        └── react/

docs/                 canonical user documentation
examples/             checked-in chart examples
tests/                cross-package tests
assets/readme/         README and documentation visuals
tla/
├── spec/              independent semantic models
├── tests/models/      bounded MC scenarios and TLC configurations
├── tests/trace/       executed chart fixtures, recorders, regression harness
├── tools/             trace exporter and TLC launch scripts
└── .cache/            downloaded tools and generated trace/log artifacts
scripts/               build and package validation
```

### Run-history boundaries

Durable history consumers use only snapshot-pinned cursor chunks from `RunHistoryStore`: public chunks are capped at 100 items and carry no reader handle. The oldest-first projection replay iterator is package-private, yields at most 500 facts per batch, and must not be imported by host, inspector, React, Pi, or Claude surfaces. Storage modules must remain AST/projector/host independent. `tests/run_history_boundary.test.ts` guards the package entrypoint, deleted materialized-log methods, caps, and import directions.

### Execution hot-path performance

Stamped-commit preparation uses one private projection copy per atomic batch. It
still applies diagnostics and retention after each record, snapshots checkpoints
at the same record boundaries, and publishes the new projection only after the
storage commit. Abandoned or failed preparations must not affect confirmed state.

Simultaneously admitted action starts are committed in bounded groups of at most
32 invocation facts. Group only fresh adjacent invocation appends after admission
and per-invocation deduplication; do not merge responses, completion/emit units,
actor admissions, or intervening effects. Preserve acknowledgement ordering and
verify restart both before commit and after commit but before acknowledgement.
Trace capture must exercise a real invocation group. TLA consumes its individual
facts: storage transaction grouping is outside the control-state abstraction.

Template-path memoization retains at most 4,096 immutable string results, never
ASTs or run state. Parallel/map join discovery visits shared ancestors once per
scan and checks leaf completion before inspecting actors. These optimizations
must preserve join ordering, actor drain requirements, replay output, and the
checkpoint/log contract. Compare captured production facts before and after a
change; distinguish pure projection timings from end-to-end runner throughput.

## Build and test

Build all three packages (needed for bundled browser assets, distribution, and package validation):

```sh
npm run build
```

Run source-level TypeScript checks without rebuilding packages (incremental on repeat runs):

```sh
npm run typecheck
```

Run fast in-memory and UI/contract tests:

```sh
npm test
```

External-I/O, real-runner, chart-loader, host, and end-to-end suites live in `tests/integration/` and are **not** part of `npm test` or `npm run check`. Run the relevant files when changing the corresponding subsystem, or the whole suite before release:

```sh
npm run test:integration
npx vitest run --config vitest.integration.config.ts tests/integration/user_interactions.test.ts
```

For changes to runtime/storage/rewind, run their integration suites; for Pi or Claude host changes, run that host's suites; for chart loading/build/typechecking changes, run parser and chart-typecheck suites; for Inspector history and browser-server changes, run the run-inspect/inspector suites. For cross-cutting changes, run all integration tests. PostgreSQL integration tests are opt-in via `HYPERCHART_PG_DSN`; without it, JSONL coverage still runs and PostgreSQL cases are reported as skipped. The Pi semantic-ID test additionally requires an isolated database named `autodiscovery_labnotes_test_<digits>` or `autodiscovery_msagl_labnotes_test_<digits>` and rejects an explicitly configured database outside that allowlist.

Boundary tests scan owned TypeScript sources, not generated `dist` declarations or linked `node_modules` trees. UI behavior tests should exercise reference navigation and production-projected graph/visit data rather than assert arbitrary CSS colors or implementation strings. The Inspector dialog's re-entry story uses a real captured actor run and checks that repeated action invocations remain separate execution nodes. A reply snapshot includes the entire atomic reply/settlement/call-resolution transaction; it must not claim a still-pending caller after that transaction.

Run the standard gate:

```sh
npm run check
```

`check` only typechecks sources and runs fast tests; it does not clean or rebuild `dist`, run integration tests, or pack/install packages. Each package has two TypeScript configs with distinct roles: `tsconfig.json` is the editor and typecheck view, with `paths` that map `@surprisal/hyperchart/*` to the sibling package's sources so a stale `dist` never shows phantom errors; `tsconfig.build.json` adds `rootDir`/`outDir` and clears `paths`, so emitted code resolves the sibling through its published `exports` exactly like a consumer. Keep `paths` patterns with an explicit `*.ts` candidate: under NodeNext ESM resolution an extensionless candidate is never probed. On repeat runs, TypeScript reuses `node_modules/.cache/hyperchart-check.tsbuildinfo`. On release, run `npm run check:release`: fast checks, a single full build, all integration tests, then package validation (including tarballs, clean-consumer imports, packed Pi extension and skill). Run `npm run build-storybook` separately when UI stories change or before release.

## Storybook

Start Storybook:

```sh
npm run storybook
```

Build the static site:

```sh
npm run build-storybook
```

React changes need a story that shows the affected state. Test both light and dark schemes, narrow layouts, long content, modal stacking, and keyboard behavior where relevant.

Organize Storybook by product surface: `Hyperchart/Inspector`, `Hyperchart/Launch`, and `Hyperchart/TUI`. A story is a deterministic named UI state; rendering, visual, interaction, and stress are verification properties, not top-level navigation categories. Do not add `Components`, `Features`, `Examples`, `Visual Tests`, `Internal`, or giant-object `Playground` sections. Actor cases belong under the Inspector surface they exercise (Dialog, Graph, or State Details). Graph Card Atlas uses one Storybook board per concrete state kind under Actions, Actors, and Flow; include each reachable runtime status and meaningful variant on that kind's board. All cards must remain production adapter projections of normalized charts and replay-valid execution-loop facts—never status-swapped or hand-authored view models. Controls are disabled by default; use fixed typed fixtures and `play` functions for meaningful interactions. Semantic Inspector Storybook scenarios must pass real normalized charts and typed durable facts through the production host adapters; do not hand-author `HyperchartRunInfo`, state status/topology, actor declarations/occurrences/mailboxes, completion colors, or failure issues. Build runtime cases with the replay-checking `storyScenario()` fixture boundary. Card/detail boards may focus an adapter-derived run, but must not clone or mutate it. Manual data is limited to presentation-only concerns such as viewport widths, long overflow strings, theme, modal interaction, and summary-transport omission cases.

TUI stories live under `Hyperchart/TUI`. They render the real compact `RunWidget` and selection-only `RunHistoryOverlay` through xterm.js; detailed run inspection belongs exclusively to the React browser inspector. The widget must use the shared path-aware percentage estimator rather than graph-node counts. Its stories include both a single active state and eight concurrent map instances at 60, 80, and 120 columns. The development server keeps a live Node-side component instance so keyboard input exercises the actual component state machine, while the static Storybook build contains deterministic initial/preset frames. The production picker materializes the real `deck-director` chart, durable JSONL records, and `sessions/progress.json` into a temporary run directory. Keep browser stories free of Node-only imports; fixture loading and TUI instances belong in the Storybook Vite plugin.

The core package build bundles the standalone inspector client into `packages/hyperchart/dist/inspector-web/`. If browser inspector behavior or React dependencies change, run the full package build and verify both `client.js` and `styles.css` are present.

The README inspector image must be captured from a deterministic Storybook fixture, not assembled as a mockup.

## Package boundaries

`@surprisal/hyperchart` must remain independent of Pi and React.

`@surprisal/pi-hyperchart` may depend on the core package and Pi/React peers. Browser code must not import Node-only modules.

Check boundaries with:

```sh
npm run validate:packages
```

The validator rejects cross-package relative imports and verifies packed export maps. Do not bypass it with development-only aliases that disappear from the tarball.

## Change execution semantics

A change to `machine.ts`, `projection.ts`, `execution_loop.ts`, durable records, or semantic normalization is not complete when TypeScript tests pass.

Keep three articulations in sync:

1. implementation and durable log/replay contract;
2. `tla/spec/Hyperchart.tla` and model-check configurations;
3. a real trace exported from the TypeScript engine and checked by `tla/spec/HyperchartTrace.tla`.

Run all 13 execution/actor models (and the storage models if storage semantics changed):

```sh
for M in MCReviewFix MCPipeline MCGate MCFanout MCMap MCNested \
  MCActorCall MCActorCompound MCActorDrain MCActorMailbox MCActorPool \
  MCActorScope MCUnsupportedHead; do
  tla/tools/check.sh "$M"
done
```

Record and validate fresh traces without overwriting checked-in/local samples:

```sh
OUT=$(mktemp -d)
node tla/tests/trace/record-sample.mjs "$OUT/sample.jsonl"
tla/tools/validate.sh tla/tests/trace/sample_chart.ts "$OUT/sample.jsonl" main Sample
node tla/tests/trace/record-removed-validator.mjs "$OUT/removed.jsonl"
tla/tools/validate.sh tla/tests/trace/removed-validator-chart.ts "$OUT/removed.jsonl" removed RemovedValidator
node tla/tests/trace/regression.mjs "$OUT/regressions"
npx vitest run tests/tla_trace_export.test.ts tests/actor_execution.test.ts tests/actor_pool.test.ts
```

The `tla/` tooling remains intentionally local and ignored. The focused `tla_trace_export.test.ts` suite explicitly skips when `tla/tests/trace/regression.mjs` is absent, so default tests in a clean checkout do not require these local files.

The local file map in `tla/README.md` separates reusable semantics (`spec/`), test cases (`tests/models/` and `tests/trace/`), and tooling (`tools/`). Chart/journal and explicit output arguments resolve relative to the caller's working directory. Named model checks load `tla/tests/models/<name>.tla/.cfg` together with `tla/spec/`. Default recorder/manual-export outputs live under `tla/.cache/trace/`, not beside source files. A branch ID is mandatory. Java and `tla/.cache/tla2tools.jar` are required. The validator generates models and TLC state directories in an isolated temporary directory, then removes them. Exit 0 means `TRACE ACCEPTED`, exit 1 means semantic `DIVERGENCE`, and exit 2 means an export/TLC tool error—not evidence of divergence. `check.sh` also isolates its TLC state directory.

### Formal coverage and limits

Read the entire header of `tla/spec/Hyperchart.tla` before editing either implementation or model. A divergence is a finding to investigate, not permission to change production behavior just to satisfy a model.

The regression harness normalizes real Chart DSL modules, captures durable records through `execution_loop`, `BranchExecution`, and `JsonlLogStore`, and asserts `explainReplay()` is clean against the original, fixed chart. Scripted effect responses control scheduling; no positive semantic records are hand-authored. Production-created branches select meaningful prefixes, including pool creation before any message, pending claims, negative verdicts, internal messaging, deadlines, and drain boundaries. Pass `--all-prefixes` to check every durable prefix instead. `--capture-only` performs replay/capture/export checks without claiming TLC acceptance. The output directory retains journals, generated models, TLC output, and `summary.json` for independent review; use a fresh directory per run.

Coverage includes terminal rejection before failure intent; guarded/retried pool actions; repeated callBatch occurrences; changing ordinary-actor receives; multi-event receive/action function serialization and escaped action events; worker FAILED and unsupported FIFO heads; direct-owner compound drain versus descendant drain; singleton and batch self-send; and ordinary/pool internal send, sendBatch, call, callBatch, and timeout progression. Negative mutations change exported facts while retaining their independent chart constants, and must be rejected by real TLC, not merely by production replay. Exported actor facts preserve concrete worker/source identity, declaration/validation provenance, receive state, call ID, ordered membership, and batch indices. Handler transitions are recomputed in TLA; neither exporter nor validator delegates step validation to the production projector. Additional ordinary/pool scenarios hold both endpoints busy through closing and then perform a non-self internal enqueue during drain; stopped targets remain inadmissible. Internal producers must address the compatible concrete map-owner context and cannot issue another call from the same concrete worker/state while its preceding call is unresolved. Re-exported negative journal prefixes redirect an internal enqueue to an existing sibling map endpoint or move a later singleton/batch call ahead of its first resolution; TLC must reject them even when export-time provenance checks pass.

`TRACE ACCEPTED` is **existential finite-trace acceptance**: TLC found some model micro-step interleaving consuming all exported entries. It does not certify termination, every provider invocation/data field, every runtime schedule, or every fixed chart. The bounded MC safety/liveness checks use the fairness doctrine in the model header; they are not a universal implementation-refinement proof. The core model abstracts handler workflows and pool receive choices; the trace companion refines authored ordinary/pool workflows independently. Worker capacity is an explicit model bound, not inferred from future messages. Concrete call occurrence correlation is separate from producer templates. Compound completion waits only for directly owned occurrences; parallel/map joins retain their subtree drain gate.

Arguments, artifact/payload values, rendering-only user-gate openings, provider/session internals, and full invocation identity are not modeled as control transitions. Export-time structural/provenance comparisons are additional gates, not a replacement for TLC. Generation sequencing and data-schema failures remain replay/runtime obligations. Reserved action failure and unsupported FIFO-head failure are modeled; arbitrary actor effect/schema or closing-admission failure paths and general in-flight effects after failure are not complete conformance guarantees. An already-dispatched owner-closing receipt may follow a failure in the same machine output batch; that narrow path is modeled without enabling normal post-failure progress. Passing these regressions does not establish universal inclusion.

## Documentation ownership

Documentation is part of the change.

| Change | Required documentation |
|---|---|
| DSL, schemas, refs, actions | `docs/core-authoring.md`, `docs/api/dsl.md`, core package README |
| compound/parallel/map/validation/re-entry | `docs/composition.md`, `docs/api/dsl.md`, semantic/replay notes where applicable |
| runtime, log, projection, replay | `docs/runtime-and-durability.md`, `docs/api/core.md`, `docs/api/runtime.md`, `docs/safety.md`, `docs/architecture.md` |
| Pi command, tool, lifecycle, discovery | `docs/pi.md`, `docs/api/pi.md`, bundled agent skill |
| rewind, delete, override behavior | `docs/safety.md`, `docs/api/pi.md`, skill safety rules |
| host models or adapters | `docs/integration.md`, `docs/api/host.md` |
| React components, CSS, themes, portals | `docs/integration.md`, `docs/api/react.md`, Storybook, package README |
| examples | `docs/examples.md`, runnable source/test |
| package exports/dependencies | root README, affected package README, matching page under `docs/api/` |
| visible product identity | README assets and their surrounding alt text/copy |

Do not rewrite or abbreviate the manual inside package READMEs or the skill. Package READMEs own installation and entry-point routing. The Pi skill uses the consolidated `hyperchart` tool with action parameters; the Claude skill uses individual `hyperchart_*` MCP tools. Both skills call tools directly rather than routing through slash commands.

The repository-root `docs/`, `examples/`, and referenced documentation assets are the only checked-in copies. Agent skills live canonically at `skills/pi/SKILL.md` and `skills/claude/SKILL.md`. Do not add generated mirrors under package directories.

Each package's `prepack` hook runs `scripts/stage-package-resources.mjs` after the build. It copies the canonical resources into the package directory just before npm builds the tarball; `postpack` removes them again. These transient paths are ignored by Git. `npm run validate:packages` verifies that the resulting tarballs contain the docs, examples, assets, and host-specific skill files.

Every command and code sample must match a checked-in implementation, test, or example. State prerequisites before the procedure, especially agent definitions, model credentials, external scripts, and unsupported user actions.

## Add or change a public export

1. update the source barrel;
2. update the package `exports` map if a new subpath is needed;
3. build declarations;
4. add a clean-consumer runtime and type import to `scripts/validate-packages.mjs`;
5. document every exported value and type on the matching page under `docs/api/`, then update the package README entry-point link;
6. run `npm run validate:packages`.

Avoid expanding `./internal/*` as an application API. Add a deliberate public subpath when third-party consumers need a supported contract.

## Validate tarballs

Run:

```sh
npm run validate:packages
npm publish --dry-run --workspace @surprisal/hyperchart
npm publish --dry-run --workspace @surprisal/pi-hyperchart
npm audit --omit=dev
```

Review the printed tarball contents. Source files included for Pi/Jiti loading are intentional; tests, Storybook, repository configuration, and unrelated assets are not.

## Prepare and publish a release

The packages publish independently, and the Pi package pins the exact matching core version. Prepare the version from a clean tracked working tree:

```sh
make release-prepare VERSION=0.2.0
```

This command:

1. rejects a version that already exists for any published package;
2. verifies that the corresponding `v<version>` tag is absent or already points at the current `HEAD`;
3. updates the workspace and package versions;
4. updates exact host → core dependencies and `package-lock.json` entries;
5. updates version labels in the root and package READMEs;
6. synchronizes the documentation bundled in the Pi package;
7. runs `npm run check:release` (including integration tests, one full build, and package validation), the Storybook build, the production dependency audit, and all publish dry-runs.

Review and commit the resulting version change. Publish only from that clean commit:

```sh
make release-publish \
  VERSION=0.2.0 \
  CONFIRM=publish-0.2.0
```

For a pre-release, provide a non-`latest` npm tag to both commands:

```sh
make release-prepare VERSION=0.2.0-rc.1 NPM_TAG=next
make release-publish VERSION=0.2.0-rc.1 NPM_TAG=next CONFIRM=publish-0.2.0-rc.1
```

`release-publish` repeats all gates and dry-runs, verifies npm authentication, then publishes core, Claude, and Pi packages in dependency order. After every npm publish succeeds, it creates the annotated git tag `v<version>` on the current release commit and pushes it to `origin`. Set `RELEASE_REMOTE=<remote>` to use another remote. It does not poll npm registry visibility.

If the process is interrupted after npm prints `+ @surprisal/hyperchart@<version>` but before Pi is published, do not rerun the core publish. Publish only the Pi package with:

```sh
make release-resume \
  VERSION=0.2.0 \
  CONFIRM=resume-0.2.0
```

The resume target repeats the release gate, skips packages already present in npm, publishes the missing packages, and then creates or pushes the same annotated tag. Tagging is idempotent: rerunning resume accepts an existing local or remote tag only when it resolves to the current release commit, and fails on a conflicting tag.

After publication, install the Pi package in a clean Pi environment and verify one extension, one `hyperchart` skill, `/hyperchart`, and every consolidated-tool action.

Do not publish from a workspace whose package manifests or lockfile still refer to a temporary local dependency.

## Pre-release checklist

- [ ] Node and npm versions match the supported range.
- [ ] `npm run check:release` passes (includes `check`, build, integration tests, package validation).
- [ ] `npm run build-storybook` passes.
- [ ] TLA+ models and trace validation pass for semantic changes.
- [ ] package and Markdown link validation passes.
- [ ] both tarballs install in a clean consumer.
- [ ] Pi discovers the packed extension and skill.
- [ ] production dependency audit is clean or findings are documented.
- [ ] package versions and core dependency are exact and matching.
- [ ] annotated tag `v<version>` exists on the release commit in the configured release remote.
- [ ] user docs, package READMEs, skill references, examples, and visuals reflect the release.

## Offline Inspector fixture capture

Migrated dialog, actor, State Details board, TUI, and replay-warning fixtures import synchronous captured JSON; browser builds do not execute their capture loops and retain the existing target. Regenerate with:

```bash
node scripts/record-story-fixtures.mjs --write
```

The generator temporarily transforms only the named fixture declarations in memory to execute their external-response schedules through the production execution loop. It seeds clock/UUID sources **before** execution in its isolated process, then persists emitted records directly. It never patches completed records or semantic UI models. The JSON includes capture context; `explainReplay()` validates each original-definition history. Running the command twice must produce byte-identical output. Missing registry keys fail explicitly.

Schedules are simulation inputs and snapshot selectors, not durable logs. A selector inside an atomic durable append rounds up to the entire committed batch; capture stops before acknowledgement or later effects, never between an actor reply, its settlement, and its call resolution. The pool out-of-order scenario releases worker 0 before acknowledging worker 1's second reply, because real FIFO admission immediately assigns the next message to the newly idle worker. The former hand-authored schedule incorrectly deferred that admission. Coverage still includes out-of-order replies, persistent worker reuse, and ordered batch results.

Replay-model verification additionally includes:

```bash
node tla/tests/trace/record-removed-validator.mjs
tla/tools/validate.sh tla/tests/trace/removed-validator-chart.ts tla/.cache/trace/removed-validator-run.jsonl removed RemovedValidator
```
