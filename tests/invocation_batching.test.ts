import { describe, expect, it } from "vitest";
import { agent, chart, compound, final, parallel } from "../packages/hyperchart/src/core/dsl.js";
import { batchInvocationAppends } from "../packages/hyperchart/src/core/invocation_batch.js";
import {
	createMachineOutput,
	stepMachine,
	type DurableRecordsEffect,
	type MachineOutput,
	type RecordAppend,
} from "../packages/hyperchart/src/core/machine.js";
import { normalizeChartConfig } from "../packages/hyperchart/src/core/normalize.js";
import { createBranchProjection, projectBranch } from "../packages/hyperchart/src/core/projection.js";
import { explainReplay } from "../packages/hyperchart/src/core/replay_check.js";
import { BranchExecution } from "../packages/hyperchart/src/execution/branch_execution.js";
import { MemoryLogStore } from "../packages/hyperchart/src/runtime/generic/memory_log_store.js";
import type { DurableLogRecord } from "../packages/hyperchart/src/core/durable_events.js";

function fixture(count: number) {
	const parsed = normalizeChartConfig(
		chart({
			kind: "chart",
			id: "invocation-batching",
			initial: "work",
			states: {
				work: parallel({
					states: Object.fromEntries(
						Array.from({ length: count }, (_, index) => [
							`region${index}`,
							compound({
								initial: "run",
								states: {
									run: { kind: "state", action: agent("worker"), transitions: { OK: "done" } },
									done: final(),
								},
							}),
						]),
					),
					onDone: "done",
				}),
				done: final(),
			},
		}),
	);
	if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
	const store = new MemoryLogStore();
	const execution = BranchExecution.fresh(parsed.ast, "main", store);
	return { ast: parsed.ast, store, execution, machine: execution.machineState() };
}

function effects(output: MachineOutput) {
	if (output.kind !== "effect") throw new Error(`Expected effects, got ${output.kind}`);
	return output.effects;
}

function appends(output: MachineOutput): DurableRecordsEffect[] {
	return effects(output).filter((effect) => effect.kind === "durable_records");
}

describe("bounded simultaneous invocation commits", () => {
	it("preserves invocation order while reducing 65 commits to 32 + 32 + 1", () => {
		const { machine } = fixture(65);
		const batches = appends(createMachineOutput(machine, []));
		expect(batches.map((batch) => batch.records.length)).toEqual([32, 32, 1]);
		const records = batches.flatMap((batch) => batch.records);
		expect(records.map((record) => record.type === "state_action" && record.actionUid.state)).toEqual(
			machine.projection.activeLeaves,
		);
		expect(new Set(batches.map((batch) => batch.id)).size).toBe(3);
		expect(batches[2]!.id.startsWith("invoke:")).toBe(true);
		expect(effects(createMachineOutput(machine, []))).toEqual([]);
	});

	it("starts each action only after its group commits and keeps unacknowledged reservations", async () => {
		const { ast, machine, execution, store } = fixture(40);
		const batches = appends(createMachineOutput(machine, []));
		const records: DurableLogRecord[] = [];
		for (const batch of batches) {
			const committed = await store.appendDrafts(batch.records, execution.prepareStampedCommit);
			records.push(...committed);
			const output = stepMachine(machine, { kind: "durable_records_added", effectId: batch.id, records: committed });
			const started = effects(output).filter((effect) => effect.kind === "agent");
			expect(started).toHaveLength(batch.records.length);
			expect(appends(output)).toEqual([]);
			expect(started.map((effect) => effect.sessionId)).toEqual(
				committed.map((record) => record.type === "state_action" && record.kind === "invoke" && record.sessionId),
			);
			expect(effects(createMachineOutput(machine, []))).toEqual([]);
		}
		expect(machine.projection.pendingActions).toHaveLength(40);
		expect(machine.projection).toEqual(projectBranch(createBranchProjection(ast), ast, records));
		for (let length = 1; length <= records.length; length++) {
			expect(explainReplay(ast, records.slice(0, length))).toMatchObject({
				prefixEnd: length,
				skipped: [],
				stale: [],
				unpinned: [],
			});
		}
	});

	it("recovers committed starts after losing their acknowledgement without invoking them twice", async () => {
		const { ast, machine, execution, store } = fixture(40);
		const [first] = appends(createMachineOutput(machine, []));
		await store.appendDrafts(first!.records, execution.prepareStampedCommit);
		const restored = await BranchExecution.restore({ ast, branchId: "main", store });
		const output = createMachineOutput(restored.machineState(), []);
		expect(effects(output).filter((effect) => effect.kind === "agent")).toHaveLength(32);
		expect(appends(output).flatMap((batch) => batch.records)).toHaveLength(8);
	});

	it("does not publish any start when group preparation fails", async () => {
		const { ast, machine, execution, store } = fixture(8);
		const [batch] = appends(createMachineOutput(machine, []));
		await expect(
			store.appendDrafts(batch!.records, (records) => {
				execution.prepareStampedCommit(records);
				throw new Error("fixture preparation failure");
			}),
		).rejects.toThrow("fixture preparation failure");
		expect(execution.headSeqId()).toBeNull();
		expect((await store.captureSnapshot("main")).headSeqId).toBeNull();
		const restored = await BranchExecution.restore({ ast, branchId: "main", store });
		expect(appends(createMachineOutput(restored.machineState(), [])).map((entry) => entry.records.length)).toEqual([8]);
	});

	it("never merges across another effect or into an existing multi-record append", () => {
		const { machine } = fixture(4);
		const records = appends(createMachineOutput(machine, []))[0]!.records;
		const single = (index: number): RecordAppend => ({
			kind: "append",
			id: `individual-${index}`,
			records: [records[index]!],
		});
		const existing: RecordAppend = { kind: "append", id: "existing-atomic-unit", records: records.slice(1, 3) };
		const separator: RecordAppend = { kind: "append", id: "non-invocation", records: [{ type: "args", args: {} }] };
		const entries = [single(0), existing, single(3), separator, single(1)];
		expect(batchInvocationAppends(entries)).toEqual(entries);
	});

	it("does not merge response commit boundaries with freshly admitted starts", () => {
		const { machine } = fixture(4);
		const response: RecordAppend = { kind: "append", id: "response", records: [{ type: "args", args: {} }] };
		const batches = appends(createMachineOutput(machine, [response]));
		expect(batches.map((entry) => entry.records.length)).toEqual([1, 4]);
		expect(batches[0]!.id).toBe("response");
	});
});
