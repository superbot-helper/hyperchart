import type { BranchId } from "../../core/durable_events.js";
import { DEFAULT_BRANCH_ID, JsonlLogStore, type RunLogStore } from "./log_store.js";
import { PostgresLogStore, type PostgresLogAccess } from "./postgres_log_store.js";
import { currentRunStorage, resolveRunPaths, withRunStorage, type RunStorage } from "./run_paths.js";

export type RunLogStorage = RunStorage;
export const withRunLogStorage = withRunStorage;
export const currentRunLogStorage = currentRunStorage;

export type OpenRunLogStoreOptions = Readonly<{
	branchId?: BranchId;
	onWarn?: (message: string) => void;
	access?: PostgresLogAccess;
	storage?: RunLogStorage;
}>;

/** Open a known durable identity in exactly one configured storage namespace. */
export async function openRunLogStore(runId: string, options: OpenRunLogStoreOptions = {}): Promise<RunLogStore> {
	const { runDir, storage } = resolveRunPaths(runId, options.storage);
	const branchId = options.branchId ?? DEFAULT_BRANCH_ID;
	switch (storage.kind) {
		case "jsonl":
			return new JsonlLogStore(`${runDir}/log.jsonl`, branchId, runId);
		case "postgres":
			return PostgresLogStore.open({
				dsn: storage.dsn,
				runId,
				branchId,
				onWarn: options.onWarn ?? (() => {}),
				access: options.access ?? "read",
			});
	}
}

export function parseRunLogStorage(value: unknown): RunLogStorage | undefined {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	const candidate = value as Partial<RunLogStorage>;
	if (
		typeof candidate.rootDir !== "string" ||
		candidate.rootDir.length === 0 ||
		(candidate.layout !== "run-id" && candidate.layout !== "sha256")
	) {
		return undefined;
	}
	if (candidate.kind === "jsonl") {
		return { kind: "jsonl", rootDir: candidate.rootDir, layout: candidate.layout };
	}
	if (candidate.kind === "postgres" && typeof candidate.dsn === "string" && candidate.dsn.length > 0) {
		return { kind: "postgres", dsn: candidate.dsn, rootDir: candidate.rootDir, layout: candidate.layout };
	}
	return undefined;
}
