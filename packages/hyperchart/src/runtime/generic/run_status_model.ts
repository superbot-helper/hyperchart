import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BranchId } from "../../core/durable_events.js";

/**
 * Operational runner status. It is not durable history: the journal never
 * depends on it and replay never reads it. Hosts and runners share it to learn
 * which attempt owns a run, whether that attempt is alive, and how it ended.
 * Each storage backend persists it beside its own run identity (status.json for
 * JSONL, hyperchart_run_status for PostgreSQL); the model and merge rules here
 * are backend-independent.
 */
export type HyperchartRunState = "starting" | "running" | "complete" | "failed" | "stopping" | "stopped";

export type HyperchartRunStatus = {
	version: 2;
	runId: string;
	chartId: string;
	state: HyperchartRunState;
	/** Current live runner reservations; operational ownership, never durable selection. Terminal states use []. */
	branchIds: BranchId[];
	/** Opaque identity of the runner launch that owns this process status. */
	attemptId?: string;
	pid?: number;
	startedAt: number;
	updatedAt: number;
	heartbeatAt?: number;
	exitCode?: number;
	error?: string;
	replayWarnings?: string[];
};

export type RunStatusPatch = {
	[K in keyof Omit<HyperchartRunStatus, "version" | "runId" | "startedAt">]?:
		| Omit<HyperchartRunStatus, "version" | "runId" | "startedAt">[K]
		| undefined;
};

/** Merge one patch over the previous status. A key present in the patch wins even when undefined. */
export function applyRunStatusPatch(
	runId: string,
	previous: HyperchartRunStatus | undefined,
	patch: RunStatusPatch,
	now = Date.now(),
): HyperchartRunStatus {
	const pid = valueFor("pid", patch, previous);
	const heartbeatAt = valueFor("heartbeatAt", patch, previous);
	const exitCode = valueFor("exitCode", patch, previous);
	const error = valueFor("error", patch, previous);
	const replayWarnings = valueFor("replayWarnings", patch, previous);
	const attemptId = valueFor("attemptId", patch, previous);
	const branchIds = valueFor("branchIds", patch, previous) ?? ["main"];
	assertBranchIds(branchIds);
	return {
		version: 2,
		runId,
		chartId: valueFor("chartId", patch, previous) ?? "unknown",
		state: valueFor("state", patch, previous) ?? "starting",
		branchIds: [...branchIds],
		...(attemptId === undefined ? {} : { attemptId }),
		startedAt: previous?.startedAt ?? now,
		updatedAt: now,
		...(pid === undefined ? {} : { pid }),
		...(heartbeatAt === undefined ? {} : { heartbeatAt }),
		...(exitCode === undefined ? {} : { exitCode }),
		...(error === undefined ? {} : { error }),
		...(replayWarnings === undefined ? {} : { replayWarnings }),
	};
}

export function isTerminalRunState(state: HyperchartRunState): boolean {
	return state === "complete" || state === "failed" || state === "stopped";
}

export function isRunLive(status: HyperchartRunStatus | undefined, now = Date.now()): boolean {
	if (status === undefined || isTerminalRunState(status.state) || status.state === "stopping") {
		return false;
	}
	if (status.pid !== undefined && isPidAlive(status.pid)) {
		return true;
	}
	return status.heartbeatAt !== undefined && now - status.heartbeatAt < 15_000;
}

export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Validate an untrusted persisted value. Legacy v1 singleton status is upgraded on read. */
export function normalizeRunStatus(value: unknown, expectedRunId: string): HyperchartRunStatus | undefined {
	if (!isRecord(value) || value.runId !== expectedRunId || typeof value.chartId !== "string") {
		return undefined;
	}
	const state = normalizeState(value.state);
	if (state === undefined) {
		return undefined;
	}
	// v1 is read-only compatibility for terminal delivery and existing run discovery;
	// every subsequent write upgrades it to v2.
	const branchIds =
		value.version === 1 && typeof value.branchId === "string"
			? [value.branchId]
			: value.version === 2 &&
					Array.isArray(value.branchIds) &&
					value.branchIds.every((entry) => typeof entry === "string")
				? value.branchIds
				: undefined;
	if (branchIds === undefined) {
		return undefined;
	}
	try {
		assertBranchIds(branchIds);
	} catch {
		return undefined;
	}
	return {
		version: 2,
		runId: value.runId,
		chartId: value.chartId,
		state,
		branchIds: [...branchIds],
		...(typeof value.attemptId === "string" ? { attemptId: value.attemptId } : {}),
		startedAt: typeof value.startedAt === "number" ? value.startedAt : 0,
		updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
		...(typeof value.pid === "number" ? { pid: value.pid } : {}),
		...(typeof value.heartbeatAt === "number" ? { heartbeatAt: value.heartbeatAt } : {}),
		...(typeof value.exitCode === "number" ? { exitCode: value.exitCode } : {}),
		...(typeof value.error === "string" ? { error: value.error } : {}),
		...(Array.isArray(value.replayWarnings) && value.replayWarnings.every((entry) => typeof entry === "string")
			? { replayWarnings: value.replayWarnings }
			: {}),
	};
}

/** JSONL backend file name beside log.jsonl. */
export const RUN_STATUS_FILE = "status.json";

export function runStatusFilePath(runDir: string): string {
	return join(runDir, RUN_STATUS_FILE);
}

export function readRunStatusFile(path: string, runId: string): HyperchartRunStatus | undefined {
	if (!existsSync(path)) {
		return undefined;
	}
	try {
		return normalizeRunStatus(JSON.parse(readFileSync(path, "utf8")) as unknown, runId);
	} catch {
		return undefined;
	}
}

export function writeRunStatusFile(path: string, status: HyperchartRunStatus): void {
	const temp = join(dirname(path), `.status.${process.pid}.${Date.now()}.tmp`);
	writeFileSync(temp, `${JSON.stringify(status, null, 2)}\n`, "utf8");
	renameSync(temp, path);
}

function valueFor<K extends keyof RunStatusPatch>(
	key: K,
	patch: RunStatusPatch,
	previous: HyperchartRunStatus | undefined,
): HyperchartRunStatus[K] | undefined {
	return Object.hasOwn(patch, key) ? patch[key] : previous?.[key];
}

function assertBranchIds(value: readonly string[]): void {
	const seen = new Set<string>();
	for (const branchId of value) {
		if (branchId.trim().length === 0 || branchId.length > 128 || /[\0/\\]/.test(branchId)) {
			throw new Error("Invalid Hyperchart runner branchId");
		}
		if (seen.has(branchId)) {
			throw new Error(`Duplicate Hyperchart runner branchId '${branchId}'`);
		}
		seen.add(branchId);
	}
}

function normalizeState(value: unknown): HyperchartRunState | undefined {
	return value === "starting" ||
		value === "running" ||
		value === "complete" ||
		value === "failed" ||
		value === "stopping" ||
		value === "stopped"
		? value
		: undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
