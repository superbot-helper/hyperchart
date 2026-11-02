# Author charts

A Hyperchart module exports one chart definition. The definition is normalized into a frozen, serializable AST before a run starts.

Use this page for the authoring contract. For nested, parallel, and map behavior, continue with [Compose states](composition.md).

## Chart anatomy

```ts
import { agent, final, refs, t, z } from "@surprisal/hyperchart";

const Review = z.object({ verdict: z.enum(["pass", "fix"]), notes: z.string() });
type Review = z.infer<typeof Review>;

const { chart, arg } = refs<
  { task: string },
  { review: Review }
>();

export default chart({
  kind: "chart",
  id: "review",
  args: {
    task: { description: "Work item to review", schema: z.string(), default: "Review the current change" },
  },
  initial: "review",
  states: {
    review: {
      kind: "state",
      action: agent("reviewer", {
        task: t`Review this task: ${arg("task")}`,
        reply: Review,
      }),
      transitions: {
        PASS: "done",
        FIX: "done",
      },
    },
    done: final(),
  },
});
```

Every chart has:

- `kind: "chart"`;
- a stable `id`;
- an `initial` state name;
- a `states` record;
- optional typed run-argument metadata.

State names are local inside the authoring tree. Normalization assigns absolute paths such as `review` or `pipeline.verify`.

Chart-level `args` is optional launch-form metadata. Each entry may have a human-readable `description`, a Zod `schema`, and a JSON `default`. Normalization converts the schema to JSON Schema for the AST and inspect/host models, retaining `contract()` id/version metadata when present. If a default is declared with a schema, normalization validates it immediately. A fresh run journals its arguments with every declared default the launch omits; supplied values win. Hosts present this metadata and may let the user edit the defaults. A `refs<Args>()` chart checks every declared metadata key, schema output, and default type against `Args`, rejecting unknown keys even when they appear beside valid keys. Metadata may remain a subset of `Args` or be empty. `ArgsOf<typeof definition>` can infer argument types from declared schemas.

## Use typed refs

`refs()` creates a chart constructor and selectors checked against your registries:

```ts
const { chart, arg, input, result, artifactOf, joinArtifactOf, key, item, event, visit } = refs<
  Args,
  Results,
  Files,
  Maps,
  Inputs
>();
```

The registries mean:

| Registry | Keys | Values |
|---|---|---|
| `Args` | run argument names | argument types |
| `Results` | action state paths | accepted reply types |
| `Files` | artifact-producing state paths | artifact name → file content type |
| `Maps` | map template paths | one map item type |
| `Inputs` | target state paths | named transition-input types |

The `chart()` returned by `refs()` checks that declared replies, artifacts, maps, and inputs match those registries in both directions. Use the root `chart()` helper only when you deliberately do not need typed registries.

### Select values

```ts
arg("task")                         // run argument
result("review")                    // full accepted result
result("review", "notes")          // dot-path selection
input("notes")                     // transition input in the current visit
artifactOf("render")               // path to one declared artifact
artifactOf("render", { artifact: "html" })
joinArtifactOf("chapters.author")  // one artifact path per map instance
key("chapters")                    // current map key
item("chapters", "title")         // current map item selection
event("payload.id")                // current event payload selection
visit("review")                    // visit number
```

Refs are data. They are resolved immediately before an action is dispatched; they are not arbitrary JavaScript callbacks.

## Render templates

Use `t` when text contains refs:

```ts
t`Review ${arg("task")}`
```

Use `json()` when a value must be serialized as JSON rather than interpolated as a string:

```ts
t`Items: ${json(result("plan", "items"))}`
```

Hyperchart recognizes only DSL interpolation tokens. Text that happens to contain `${...}` is not evaluated as JavaScript.

## Terminal states and notifications

Use `final()` for a successful top-level terminal and `failed()` for an authored failed business terminal. Outcome is explicit metadata; a terminal's name does not classify it. Reserved executor `FAILED` never routes into either terminal—it records global failure intent and terminalizes immediately.

```ts
done: final({
  notify: {
    scope: "publish",
    prompt: t`Published ${result("publish", "title")}`,
    artifacts: [artifactOf("publish", { artifact: "report" })],
  },
}),
failed: failed(),
```

The optional prompt is appended to the standard host message. Artifact contents are not inlined; hosts receive authoritative absolute paths. `scope` lets the prompt resolve refs from an existing state scope and never adds input storage to the final itself. Result and artifact sources must dominate the terminal.

## Action states

An action state dispatches one action and waits for an event.

```ts
{
  kind: "state",
  action: agent("reviewer", { task: "Review the change." }),
  emit: [emit({
    event: "REVIEW_FINISHED",
    payload: result("review"),
    schema: z.object({ summary: z.string() }),
  })],
  transitions: { PASS: "done", FIX: "repair" },
}
```

The action may be an agent, script, user request, or host-resolved gate. Optional `emit` declarations publish ordered domain facts only when the completion is accepted. Their payloads use the ordinary value/ref expression language and must resolve to finite JSON. An optional `schema` declares the payload shape for downstream consumers, inferred `EmitsOf<C>` types, and the inspector; it is not runtime validation and is not stored in the journal. Hyperchart resolves every payload before atomically appending the accepted completion or positive validation verdict followed by the emit records. A rejected validation claim or `FAILED` outcome publishes nothing, and emitted facts never drive chart control flow.

### Agent actions

```ts
agent("reviewer", {
  task: t`Review ${arg("task")}`,
  reads: [artifactOf("prepare")],
  artifacts: {
    report: artifact("artifacts/review.json", Review),
  },
  reply: Review,
  model: "anthropic/claude-sonnet-4",
  thinking: "high",
  tools: ["read", "grep"],
})
```

The first argument is a Pi agent-definition name. Hyperchart resolves the concrete definition before execution. If it cannot load that definition, the state cannot run. Model, thinking level, tools, and system prompt are not inferred from an absent definition.

`model`, `thinking`, and `tools` in the chart override the resolved agent defaults for that invocation.

### Model roles

Instead of a concrete model, an agent definition can declare a symbolic `role` in its frontmatter:

```markdown
---
description: Reviews changes against the plan.
role: reviewer
model: anthropic/claude-sonnet-4
---
```

Roles are mapped to models once, in `settings.json` next to the charts — `<projectRoot>/<configDir>/hypercharts/settings.json` (project scope) and the user charts directory (user scope); project entries win per role key:

```json
{ "roles": { "reviewer": "anthropic/claude-opus-4-8", "fast": "anthropic/claude-haiku-4-5" } }
```

Model refs use the host's format, so charts stay portable between hosts. Resolution order per invocation: chart `model` override → configured role → definition `model` (the fallback when the role is not configured) → the host default model.

A declared role is a requirement, not a hint: if the role is not configured in settings and the definition declares no fallback `model` (and the chart does not override `model` for that invocation), the action fails with an error instead of silently running on the default model.

### Toolsets

Tool lists work the same way: a definition can declare a symbolic `toolset` instead of enumerating tools, with `tools` as the fallback when the toolset is not configured:

```markdown
---
description: Reviews changes against the plan.
toolset: reading
tools: read, grep
---
```

Toolsets live in the same `settings.json`, in the host's tool vocabulary (tool names differ between hosts, which is exactly why a symbolic name keeps the chart portable):

```json
{ "toolsets": { "reading": ["read", "grep"], "coding": ["read", "edit", "bash"] } }
```

Resolution order per invocation: chart `tools` override → configured toolset → definition `tools`. Same strictness as roles: an unconfigured toolset with no fallback `tools` (and no chart override) fails the action with an error.

Inspection preserves both layers: `role`/`toolset` are the declared symbolic names, while `resolvedModel`/`resolvedTools` are the effective host mapping. Static inspection uses current host settings. Concrete run inspection uses the mappings captured in that run's `runner.config.json`; live session progress records the actual model and explicit tool allowlist used at launch. If no tool list or toolset is declared, the host default tool configuration applies — this is not equivalent to allowing every installed tool.

### Script actions

```ts
script("python3", ["bin/build.py"], {
  env: {
    INPUT_JSON: t`${json(result("plan"))}`,
    OUTPUT_PATH: "artifacts/output.json",
  },
  artifacts: {
    output: artifact("artifacts/output.json", Output),
  },
  reply: Output,
})
```

Commands and arguments are static. Dynamic values enter through `env`; this avoids shell interpolation and keeps invocations inspectable.

A script completes as follows:

1. non-zero exit → `FAILED`;
2. otherwise, parse the last non-empty stdout line as `{ "type": "EVENT", "output": ... }`;
3. if there is exactly one allowed non-`FAILED` event, exit `0` may select it implicitly;
4. validate the event type, reply schema, and declared artifacts.

### Function actions

Use `tsAction()` for trusted, short in-process work when starting a subprocess is the measured bottleneck:

```ts
tsAction("./actions/score.mjs", "scoreCandidate", {
  env: {
    WEIGHTS: artifactOf("prepare", { artifact: "weights", select: "values" }),
    MODE: "simulation",
  },
  artifacts: { reward: artifact("artifacts/reward.json", Reward) },
  reply: z.object({ reward: z.number() }),
})
```

The chart stores only the serializable descriptor `{ kind: "tsImport", module, export, env?, artifacts?, reply? }`; closures are never embedded. Relative modules resolve from the chart directory, while bare specifiers use normal `import()` resolution. Module contents are cached by Node and are not part of replay identity, so restart the runner after editing an action module.

The named export is called as `fn(params, context)` and must return an explicit `ChartEvent` object:

```ts
export async function scoreCandidate(params, context) {
  await writeFile(context.artifacts.reward, JSON.stringify({ reward: 0.75 }));
  return { type: "SCORED", output: { reward: 0.75 } };
}
```

`params` contains rendered `env` declarations. Selected artifact refs are schema-checked and decoded; other entries remain strings. `context` contains the resolved visit `input`, allowed `events`, `actionUid`, absolute `chartDir`, branch `workDir`, owning `projectDir`, absolute declared artifact paths, an `AbortSignal`, and optional `{ n, reason }` retry metadata. It never exposes projection state or a runtime handle. The returned event, reply, and artifacts use the same completion validator as scripts, and accepted deliverables go through the same artifact pinning boundary.

Cancellation is cooperative. Hyperchart aborts the signal, suppresses late results, and lets runtime drain finish without waiting for a function that ignores the signal, but it cannot stop that function's CPU work or side effects. See [Recovery and safety](safety.md#in-process-function-actions).

### User actions

```ts
user({
  prompt: "Approve the release?",
  options: ["APPROVED", "BLOCK"],
  reply: z.object({ note: z.string().optional() }),
})
```

A user action is a durable host-neutral human interaction. Its allowed events come from reachable non-`FAILED` transitions; `options` supplies host-visible choices and normally uses those event names. The host shows the rendered prompt to the real user and commits the chosen event plus optional schema-validated output. The public interaction coordinate is `(runId, branchId, seqId)`.

An interaction suspends only its own branch: the detached runner stays alive and other `parallel` regions or admitted `map` instances continue. Across all owned runs in the same host session and canonical working directory, human presentation is serialized by lexical `runId`, then numeric `seqId`. Pi collects the next ordinary user prompt after presenting the interaction; Claude Code uses native `AskUserQuestion`. Identical response retries are safe, while divergent retries conflict.

### Host-resolved gates

Use `gate()` when an application, scheduler, or service—not a person—must supply the next chart event:

```ts
gate({
  event: "SELECT_CANDIDATE",
  payload: { candidates: result("search", "candidates") },
  reply: z.object({ candidateId: z.string() }),
})
```

`event` names the host-facing request, `payload` is a JSON value expression rendered when the phase opens, and `reply` validates the response event's optional `output`. A gate does not accept `prompt` or `options`, does not dispatch an executor, and is not published through human request/receipt scanning. It appends durable `gate/opened`, waits, and uses the same branch-aware controller and offline commit APIs as `user()` to append `gate/resolved`. Allowed-event, stale-head, rewind, idempotency, and conflict rules are the same for both interaction kinds.

## Events and transitions

A transition can be a target string:

```ts
transitions: { PASS: "done" }
```

or an object with target input selected from the firing event and/or durable refs:

```ts
transitions: {
  FIX: {
    target: "repair",
    input: {
      notes: event("notes"),
      priorNotes: result("review", "notes"),
    },
  },
}
```

Declare target input schemas on the destination state:

```ts
repair: {
  kind: "state",
  input: {
    notes: z.string(),
    priorNotes: z.string(),
  },
  action: agent("fixer", {
    task: t`Attempt ${visit("review")}: ${input("notes")}`,
  }),
  transitions: { FIXED: "review" },
}
```

Input is bound to a visit, not permanently to a state path. Re-entering the same state creates a new visit and a new input binding. `event()` reads the accepted event output; `result()` and the other ordinary refs use the same replay-derived resolver as templates, evaluated in the firing state's runtime scope. A missing result, missing selector, or otherwise unavailable ref throws before target entry, so no invoke is emitted with partial input.

For executor actions, the resolved input object is copied onto `state_action/invoke`, `state_action/complete`, and `state_action/validated` records. User and host-gate actions expose the same provenance on `user_interaction/opened` and `gate/opened`. These optional copies are durable, JSON-only informational provenance for downstream journal consumers; replay still derives input from the edge and excludes the copy from interaction contract identity.

Reserved system events include `FAILED`, validation outcomes, timer events, and scope cancellation. Do not invent application events that collide with reserved names.

## Replies and schemas

`reply` validates accepted event output:

```ts
const Decision = z.object({
  verdict: z.enum(["pass", "fix"]),
  notes: z.string(),
});

agent("reviewer", { task: "Review.", reply: Decision })
```

Hyperchart converts Zod schemas to JSON Schema for normalized source and inspection. Runtime validation still occurs before the result is accepted into the durable log.

The package re-exports `z` so charts can use the same Zod dependency:

```ts
import { z } from "@surprisal/hyperchart";
```

## Artifacts

Declare files that an action must produce:

```ts
artifacts: {
  report: artifact("artifacts/report.json", Report),
}
```

The path may be a template. A shape is optional; when present, Hyperchart validates file content before accepting completion.

Read artifacts through declared refs:

```ts
reads: [artifactOf("build", { artifact: "report" })]
```

Artifacts are files owned by the run or working directory. The durable log records the accepted declaration and invocation; it does not embed arbitrary file contents.

## Module loading and trust

Chart files are executable TypeScript modules loaded through Jiti. Importing, parsing, or inspecting a module may execute top-level JavaScript with the current user's permissions.

Keep chart modules declarative:

- no top-level network calls;
- no top-level writes;
- no timers or background processes;
- no environment-dependent mutation.

Review untrusted chart source before inspection. The word “static” in static inspection means “without runtime overlays,” not “safe evaluation without code execution.”

## Normalize before execution

`normalizeChartConfig()` validates structure and produces the AST used by the machine. It rejects unknown paths, invalid transition bindings, malformed composition, mismatched refs, and unsupported declarations.

The Pi runner normalizes automatically. Hosts embedding the core package should treat normalization errors as startup errors, not runtime branches.

## Next steps

- [Compose states](composition.md)
- [Runtime and durable facts](runtime-and-durability.md)
- [DSL reference](api/dsl.md)

## Explicit actors

Use [`actor()`, protocols, `receive()`, `send()`, `call()`, and `reply()`](./explicit-actors.md) for sequential side-effecting workflows. Actor templates are invoked with placement expressions and the resulting static declaration is placed directly in one owner's `actors` object; there is no dynamic actor API.

### Actor pools and batches

Use `actorPool({ concurrency, worker })` when one statically placed capability needs bounded parallelism. The endpoint keeps one durable FIFO mailbox and fixed persistent workers; use singleton `send`/`call` or explicit non-empty `sendBatch`/single-reply `callBatch`. Inside an actor template, `send({ to: self(), ... })` and `sendBatch({ to: self(), ... })` enqueue follow-up work on the current logical endpoint; pool self-sends return to the shared endpoint, not a concrete worker. Calls to `self()` are deliberately unsupported. `callBatch` publishes outputs only after all items settle and preserves input order. See [Explicit actors](explicit-actors.md).
