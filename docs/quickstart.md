# Run your first chart

This guide installs the Pi package, runs a chart with no agent definitions, and shows where Hyperchart stores the result.

## Prerequisites

- Node.js 22.19 or newer
- [Pi](https://pi.dev/docs/latest/quickstart) installed and able to start in the project
- a trusted project directory

The first chart uses only `node` and the filesystem. No model provider or custom agent is required.

## 1. Install the Pi package

From your shell, before starting Pi:

```sh
pi install npm:@surprisal/pi-hyperchart
```

Start Pi after the install, or restart an existing Pi process. The package contributes one extension and one `hyperchart` skill.

For repository development, the root `package.json` already declares the local extension and skill:

```sh
npm install
npm run build
pi
```

## 2. Create the chart

Create `.pi/hypercharts/hello.chart.ts`:

```ts
import { artifact, chart, final, script } from "@surprisal/hyperchart";

export default chart({
  kind: "chart",
  id: "hello",
  initial: "write",
  states: {
    write: {
      kind: "state",
      action: script("node", [
        "-e",
        `require("node:fs").writeFileSync("hello.txt", "Hello from Hyperchart\\n")`,
      ], {
        artifacts: { greeting: artifact("hello.txt") },
      }),
      transitions: { DONE: "done" },
    },
    done: final(),
  },
});
```

This chart has one action state and one final state. `script()` runs in the chart's working directory. Because the action declares one successful transition, exit code `0` selects `DONE` without requiring a JSON completion line.

The checked-in copy is [`examples/quickstart.chart.ts`](../examples/quickstart.chart.ts).

## 3. Inspect before running

Ask Pi:

```text
Use hyperchart action=inspect on .pi/hypercharts/hello.chart.ts
```

The tool call is equivalent to:

```json
{
  "action": "inspect",
  "chartPath": ".pi/hypercharts/hello.chart.ts"
}
```

Inspection should report:

- chart id `hello`;
- initial state `write`;
- transition `DONE → done`;
- artifact `greeting → hello.txt`;
- no structural errors.

> Inspection loads the TypeScript module through Jiti. It does not run the `script()` action, but top-level JavaScript in the module would run. Treat chart files as executable project code.

## 4. Start the run

```text
/hyperchart run .pi/hypercharts/hello.chart.ts
```

The command starts asynchronously and shows a compact progress widget. To block until completion instead, append `--wait`. The final status should be `complete`, and `hello.txt` should contain:

```text
Hello from Hyperchart
```

List recent runs at any time. Select with ↑/↓ and press Enter to open the full browser inspector:

```text
/hyperchart
```

Open a specific run directly in the browser inspector:

```text
/hyperchart view <run-id>
```

## 5. Inspect the durable result

A run directory lives under:

```text
${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/hypercharts/runs/<run-id>/
```

The files to know first are:

| File | Purpose |
|---|---|
| `meta.json` | Filesystem-backend chart path, working directory, and run identity. PostgreSQL uses `hyperchart_run_meta` instead. |
| `log.jsonl` | Filesystem-backend semantic journal. PostgreSQL uses `hyperchart_journal` instead. |
| `status.json` | Filesystem-backend operational process status and heartbeat information. PostgreSQL uses `hyperchart_run_status` instead. |
| `sessions/progress.json` | Optional progress from Pi agent sessions. |

`log.jsonl` is the semantic source of truth. Run status and progress are operational overlays.

## Run a chart with agents

Agent actions refer to Pi agent definitions by name:

```ts
import { agent } from "@surprisal/hyperchart";

agent("reviewer", {
  task: "Review the implementation and return a verdict.",
});
```

Define `reviewer` in one of Pi's agent-definition locations before running the chart. A missing concrete definition is a runtime error; Hyperchart does not treat it as an unrestricted default agent.

Agent execution also requires a configured Pi model/provider. Follow [Pi Providers](https://pi.dev/docs/latest/providers) for authentication, then read [Agent actions](core-authoring.md#agent-actions).

## Common problems

### `/hyperchart` is not available

Restart Pi after installation. `/reload` reloads auto-discovered resources, but an explicitly loaded extension may remain bound until process exit.

### The chart cannot import `@surprisal/hyperchart`

Install dependencies in the project or install the Pi package through `pi install`. A distributed Pi package is installed with production dependencies; a copied extension without its package dependencies is not equivalent.

### The run stops at `FAILED`

Open the run and inspect its runtime issues. For scripts, verify the exit code, final stdout line, declared artifacts, and reply schema. For agents, verify the concrete agent definition and model credentials.

## Next steps

- [Author charts](core-authoring.md)
- [Compose maps, parallel work, and validation](composition.md)
- [Use `/hyperchart` and the agent tools](pi.md)
- [Understand recovery before changing a run](safety.md)
