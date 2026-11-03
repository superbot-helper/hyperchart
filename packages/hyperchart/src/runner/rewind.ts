import { basename } from "node:path";
import type { BranchId } from "../core/durable_events.js";
import { parseChartModuleSync } from "../core/inspect.js";
import { assertRunOwnership, assertStoppedRun } from "./branches.js";
import { BranchExecution } from "../execution/branch_execution.js";
import { findRewindMatch, semanticStatesForRecord, type RewindMatch } from "../execution/rewind.js";
export { findRewindMatch, semanticStatesForRecord } from "../execution/rewind.js";
import { openRunLogStore } from "../runtime/generic/log_store_factory.js";
import { loadRunMeta } from "../runtime/generic/run_dir.js";
import { requestLiveRunnerBranchMove, type RunnerMoveBranchCommit } from "../runtime/generic/runner_control.js";
import { isRunLive, patchRunStatus, readRunStatus } from "../runtime/generic/run_status.js";

export type RewindMode = "before" | "after";

export type RewindOptions = {
	runId: string;
	branchId: BranchId;
	state?: string;
	seqId?: number;
	to?: "compatible";
	mode: RewindMode;
	/** Working directory the run must belong to; rewinding a foreign run is refused. */
	cwd: string;
};

export type RewindResult = {
	runId: string;
	chartId: string;
	branchId: BranchId;
	targetLabel: string;
	previousHeadSeqId: number | null;
	headSeqId: number | null;
	/** Every machine record and downstream file remains in place. */
	preservedRecords: number;
};

/**
 * Move one durable named head. This operation is append-only: it never rewrites
 * log.jsonl and never moves/deletes sessions, gates, notifications, or artifacts.
 */
export async function rewindHyperchartRun(opts: RewindOptions): Promise<RewindResult> {
	const targetCount = [opts.state, opts.seqId, opts.to].filter((target) => target !== undefined).length;
	if (targetCount !== 1) {
		throw new Error("rewind requires exactly one of state, seqId, or to=compatible");
	}
	const status = await readRunStatus(opts.runId);
	const live = isRunLive(status);
	if (!live) {
		await assertStoppedRun(opts.runId, "rewinding");
	}
	await assertRunOwnership(opts.runId, opts.cwd);
	const meta = await loadRunMeta(opts.runId);
	const parsed = parseChartModuleSync(
		meta.chartPath,
		meta.exportName === undefined ? {} : { exportName: meta.exportName },
	);
	if (!parsed.ok) {
		throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
	}

	const store = await openRunLogStore(opts.runId, { branchId: opts.branchId, access: live ? "read" : "writer" });
	let match: RewindMatch;
	let moveCommit: RunnerMoveBranchCommit | undefined;
	try {
		const previous = await store.getBranch(opts.branchId);
		match = await findRewindMatch(store, opts, parsed.ast);
		if (match.targetHeadSeqId === previous.headSeqId) {
			throw new Error(`Rewind would not move branch '${opts.branchId}'; choose a different target`);
		}
		if (!live) {
			const semantic = await BranchExecution.restore({
				ast: parsed.ast,
				branchId: opts.branchId,
				store,
				saveCheckpoint: "never",
				snapshot: { branchId: opts.branchId, headSeqId: match.targetHeadSeqId },
			});
			const checkpoint = semantic.prepareExactCheckpoint(match.targetHeadSeqId);
			const moved = await store.moveBranch(
				opts.branchId,
				match.targetHeadSeqId,
				checkpoint === undefined ? undefined : { checkpoint },
			);
			moveCommit = {
				moveSeqId: moved.moveSeqId,
				previousHeadSeqId: moved.previousHeadSeqId,
				preservedRecords: moved.preservedRecords,
			};
		}
	} finally {
		await store.close();
	}
	if (live) {
		if (status?.attemptId === undefined) {
			throw new Error(`Live run '${opts.runId}' has no runner attempt identity`);
		}
		moveCommit = await requestLiveRunnerBranchMove(opts.runId, {
			attemptId: status.attemptId,
			branchId: opts.branchId,
			targetHeadSeqId: match.targetHeadSeqId,
		});
	} else {
		await patchRunStatus(opts.runId, {
			chartId: parsed.ast.id,
			branchIds: [opts.branchId],
			state: "stopped",
			pid: undefined,
			heartbeatAt: undefined,
			exitCode: 0,
			error: undefined,
		});
	}
	if (moveCommit === undefined) {
		throw new Error("Branch move completed without commit metadata");
	}
	return {
		runId: opts.runId,
		chartId: parsed.ast.id,
		branchId: opts.branchId,
		targetLabel: match.label,
		previousHeadSeqId: moveCommit.previousHeadSeqId,
		headSeqId: match.targetHeadSeqId,
		preservedRecords: moveCommit.preservedRecords,
	};
}
