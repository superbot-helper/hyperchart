import { basename, resolve } from "node:path";
import type { BranchHead, BranchId, BranchMetadata } from "../core/durable_events.js";
import { parseChartModuleSync } from "../core/inspect.js";
import { loadRunMeta } from "../runtime/generic/run_dir.js";
import { isRunLive, readRunStatus } from "../runtime/generic/run_status.js";
import { openRunLogStore } from "../runtime/generic/log_store_factory.js";
import { collectBranches, type BranchListChunk, type BranchListCursor } from "../runtime/generic/log_store.js";
import { BranchExecution } from "../execution/branch_execution.js";

export type ForkBranchOptions = Readonly<{
	runId: string;
	fromSeqId: number;
	branchId: BranchId;
	reason?: string;
	/** Optional ownership boundary used by host tools. */
	cwd?: string;
	sourceBranchId?: BranchId;
}>;

export type ForkBranchResult = Readonly<{
	runId: string;
	branch: BranchHead;
	/** Fork never changes a caller/UI selection. */
	selectedBranchChanged: false;
	started: false;
}>;

export async function listHyperchartBranchPage(runId: string, cursor?: BranchListCursor): Promise<BranchListChunk> {
	const store = await openRunLogStore(runId);
	try {
		return await store.listBranches(cursor);
	} finally {
		await store.close();
	}
}

export async function getHyperchartBranch(runId: string, branchId: BranchId): Promise<BranchHead> {
	const store = await openRunLogStore(runId);
	try {
		return await store.getBranch(branchId);
	} finally {
		await store.close();
	}
}

/** Create a durable named pointer without selecting it and without starting a runner. */
export async function forkHyperchartRun(options: ForkBranchOptions): Promise<ForkBranchResult> {
	await assertStoppedRun(options.runId, "forking");
	await assertRunOwnership(options.runId, options.cwd);
	const meta = await loadRunMeta(options.runId);
	const parsed = parseChartModuleSync(
		meta.chartPath,
		meta.exportName === undefined ? {} : { exportName: meta.exportName },
	);
	if (!parsed.ok) {
		throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
	}
	const store = await openRunLogStore(options.runId, { access: "writer" });
	let branch: BranchHead;
	try {
		if ((await store.getRecord(options.fromSeqId)) === undefined) {
			throw new Error(`No durable log record with seqId ${options.fromSeqId}`);
		}
		if ((await collectBranches(store)).some((candidate) => candidate.branchId === options.branchId)) {
			throw new Error(`Hyperchart branch '${options.branchId}' already exists`);
		}
		if (options.sourceBranchId !== undefined) {
			const source = await store.captureSnapshot(options.sourceBranchId);
			if (!(await store.containsInHistory({ headSeqId: source.headSeqId, seqId: options.fromSeqId }))) {
				throw new Error(`Fork point ${options.fromSeqId} is not in source branch '${options.sourceBranchId}' history`);
			}
		}
		const metadata: BranchMetadata = {
			name: options.branchId,
			...(options.reason === undefined ? {} : { reason: options.reason }),
			...(options.sourceBranchId === undefined ? {} : { sourceBranchId: options.sourceBranchId }),
			sourceSeqId: options.fromSeqId,
		};
		const semantic = await BranchExecution.restore({
			ast: parsed.ast,
			branchId: options.branchId,
			store,
			saveCheckpoint: "never",
			snapshot: { branchId: options.branchId, headSeqId: options.fromSeqId },
		});
		const checkpoint = semantic.prepareExactCheckpoint(options.fromSeqId);
		branch = await store.createBranch(
			options.branchId,
			options.fromSeqId,
			metadata,
			checkpoint === undefined ? undefined : { checkpoint },
		);
	} finally {
		await store.close();
	}
	return {
		runId: options.runId,
		branch,
		selectedBranchChanged: false,
		started: false,
	};
}

export async function assertStoppedRun(runId: string, operation: string): Promise<void> {
	const status = await readRunStatus(runId);
	if (isRunLive(status)) {
		throw new Error(`Run '${runId}' is live; stop it before ${operation}`);
	}
}

export async function assertRunOwnership(runId: string, cwd: string | undefined): Promise<void> {
	if (cwd === undefined) {
		return;
	}
	const meta = await loadRunMeta(runId);
	if (resolve(meta.workDir) !== resolve(cwd)) {
		throw new Error(`Run '${runId}' belongs to ${meta.workDir}; open that directory first`);
	}
}
