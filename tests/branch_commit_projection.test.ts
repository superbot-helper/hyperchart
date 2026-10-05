import { afterEach, describe, expect, it, vi } from "vitest";
import { chart, final } from "../packages/hyperchart/src/core/dsl.js";
import type { DurableLogRecord } from "../packages/hyperchart/src/core/durable_events.js";
import { normalizeChartConfig } from "../packages/hyperchart/src/core/normalize.js";
import { BranchExecution } from "../packages/hyperchart/src/execution/branch_execution.js";
import { decodeCheckpoint, PROJECTION_CHECKPOINT_INTERVAL } from "../packages/hyperchart/src/execution/projection_restore.js";
import { MemoryLogStore } from "../packages/hyperchart/src/runtime/generic/memory_log_store.js";

afterEach(() => vi.restoreAllMocks());

function fixture() {
	const parsed = normalizeChartConfig(chart({ kind: "chart", id: "batch-projection", initial: "done", states: { done: final() } }));
	if (!parsed.ok) throw new Error("Invalid fixture chart");
	return { ast: parsed.ast, execution: BranchExecution.fresh(parsed.ast, "main", new MemoryLogStore()) };
}

function args(index: number): DurableLogRecord {
	return { type: "args", args: { value: index }, seqId: index + 1, parentId: index === 0 ? null : index, branchId: "main", timestamp: 1 };
}

describe("atomic commit projection working copy", () => {
	it("clones once per batch and preserves intermediate checkpoint snapshots", () => {
		const { ast, execution } = fixture();
		const records = Array.from({ length: PROJECTION_CHECKPOINT_INTERVAL + 1 }, (_, index) => args(index));
		const clone = vi.spyOn(globalThis, "structuredClone");
		const prepared = execution.prepareStampedCommit(records);
		expect(clone).toHaveBeenCalledTimes(1);
		clone.mockRestore();
		expect(execution.headSeqId()).toBeNull();
		expect(prepared.checkpoints).toHaveLength(1);
		const checkpoint = decodeCheckpoint(prepared.checkpoints[0]!, ast);
		expect(checkpoint?.headSeqId).toBe(PROJECTION_CHECKPOINT_INTERVAL);
		expect(checkpoint?.projection.args).toEqual({ value: PROJECTION_CHECKPOINT_INTERVAL - 1 });
		prepared.committed();
		expect(execution.headSeqId()).toBe(PROJECTION_CHECKPOINT_INTERVAL + 1);
		expect(execution.inspectionOverview().args).toEqual({ value: PROJECTION_CHECKPOINT_INTERVAL });
		expect(checkpoint?.projection.args).toEqual({ value: PROJECTION_CHECKPOINT_INTERVAL - 1 });
		expect(records[0]).toEqual(args(0));
		expect(() => prepared.committed()).toThrow("confirmed twice");
	});

	it("discards an unconfirmed working copy without leaking it into another preparation", () => {
		const { execution } = fixture();
		execution.prepareStampedCommit([args(0), args(1)]);
		expect(execution.headSeqId()).toBeNull();
		const accepted = execution.prepareStampedCommit([args(0)]);
		accepted.committed();
		expect(execution.headSeqId()).toBe(1);
		expect(execution.inspectionOverview().args).toEqual({ value: 0 });
	});

	it("does not publish a partially projected batch when a later record throws", () => {
		const { execution } = fixture();
		const failure: DurableLogRecord = { type: "failure_intent", error: "fixture failure", origin: "done", seqId: 2, parentId: 1, branchId: "main", timestamp: 1 };
		expect(() => execution.prepareStampedCommit([args(0), failure, { ...failure, seqId: 3, parentId: 2 }])).toThrow();
		expect(execution.headSeqId()).toBeNull();
		expect(execution.inspectionOverview().args).toBeUndefined();
		execution.prepareStampedCommit([args(0)]).committed();
		expect(execution.headSeqId()).toBe(1);
	});
});
