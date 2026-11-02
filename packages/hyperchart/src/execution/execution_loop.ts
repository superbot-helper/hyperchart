import type { Runtime } from "../runtime/runtime.js";
import { concatAsyncIterables } from "../utils/index.js";
import { stepMachine, type MachineState, type MachineEvent } from "../core/machine.js";
import type { ChartAst } from "../core/types.js";

export interface ExecutionSession {
	readonly ast: ChartAst;
	isFresh(): boolean;
	machineState(): MachineState;
}

// Runs a chart: execution owns the restored projection; runtime only performs effects and I/O.
export async function start(
	runtime: Runtime,
	execution: ExecutionSession,
	args?: Readonly<Record<string, unknown>>,
): Promise<MachineState> {
	const launchArgs = execution.isFresh() ? withDeclaredArgDefaults(execution.ast, args) : undefined;
	if (launchArgs !== undefined) {
		await runtime.runEffects([{ kind: "durable_records", id: "args", records: [{ type: "args", args: launchArgs }] }]);
	}
	return loop(runtime, execution);
}

// Every launch path funnels through start, so declared defaults are journaled with the args fact
// here: omitted args take their chart default, explicitly provided args win.
function withDeclaredArgDefaults(
	ast: ChartAst,
	args: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
	const defaults = Object.entries(ast.args ?? {}).flatMap(([name, declared]) =>
		declared.default === undefined ? [] : [[name, structuredClone(declared.default)] as const],
	);
	if (defaults.length === 0) {
		return args;
	}
	return { ...Object.fromEntries(defaults), ...args };
}

export async function loop(runtime: Runtime, execution: Pick<ExecutionSession, "machineState">): Promise<MachineState> {
	let state = execution.machineState();
	const queue: AsyncIterable<MachineEvent> = concatAsyncIterables([{ kind: "start" }], runtime.eventsQueue());
	for await (const event of queue) {
		const output = stepMachine(state, event);
		switch (output.kind) {
			case "effect":
				await runtime.runEffects(output.effects);
				break;
			case "final":
				if (output.effects.length > 0) {
					await runtime.runEffects(output.effects);
				}
				return output.state;
			case "error":
				throw new Error(output.error);
		}
	}
	throw new Error("Event queue closed before reaching a final state");
}
