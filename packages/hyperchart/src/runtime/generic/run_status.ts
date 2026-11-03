import { openRunLogStore } from "./log_store_factory.js";
import { resolveRunPaths, type RunStorage } from "./run_paths.js";
import { runStatusFilePath, type HyperchartRunStatus, type RunStatusPatch } from "./run_status_model.js";

export {
	applyRunStatusPatch,
	isPidAlive,
	isRunLive,
	isTerminalRunState,
	normalizeRunStatus,
	RUN_STATUS_FILE,
} from "./run_status_model.js";
export type { HyperchartRunState, HyperchartRunStatus, RunStatusPatch } from "./run_status_model.js";

/** JSONL-backend file location. PostgreSQL-backed runs keep status in hyperchart_run_status instead. */
export function runStatusPath(runId: string): string {
	return runStatusFilePath(resolveRunPaths(runId).runDir);
}

/** Read the operational status through the configured storage backend. */
export async function readRunStatus(runId: string, storage?: RunStorage): Promise<HyperchartRunStatus | undefined> {
	const store = await openRunLogStore(runId, { access: "read", ...(storage === undefined ? {} : { storage }) });
	try {
		return await store.readRunStatus();
	} finally {
		await store.close();
	}
}

/** Merge a patch into the operational status through the configured storage backend. */
export async function patchRunStatus(
	runId: string,
	patch: RunStatusPatch,
	storage?: RunStorage,
): Promise<HyperchartRunStatus> {
	const store = await openRunLogStore(runId, { access: "read", ...(storage === undefined ? {} : { storage }) });
	try {
		return await store.patchRunStatus(patch);
	} finally {
		await store.close();
	}
}

export function markRunHeartbeat(runId: string): Promise<HyperchartRunStatus> {
	return patchRunStatus(runId, { pid: process.pid, heartbeatAt: Date.now() });
}
