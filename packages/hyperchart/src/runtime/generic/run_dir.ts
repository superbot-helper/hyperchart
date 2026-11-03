import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { sanitizeSegment } from "../../core/action_uid.js";
import type { RunMeta } from "./log_store.js";
import { openRunLogStore } from "./log_store_factory.js";
import { assertRunId, currentRunStorage, resolveRunPaths, type RunStorage } from "./run_paths.js";

export type { RunMeta } from "./log_store.js";

export async function createRun(chartId: string): Promise<string> {
	const runId = `${sanitizeSegment(chartId)}-${randomUUID()}`;
	await initializeRun(runId);
	return runId;
}

export async function initializeRun(runId: string): Promise<void> {
	const store = await openRunLogStore(runId, { access: "writer" });
	try {
		await store.initializeRootBranch();
	} finally {
		await store.close();
	}
}

export async function loadRunMeta(runId: string): Promise<RunMeta> {
	const store = await openRunLogStore(runId, { access: "read" });
	try {
		const meta = await store.readRunMeta();
		if (meta === undefined) {
			const error = new Error(`No Hyperchart run metadata for '${runId}'`) as NodeJS.ErrnoException;
			error.code = "ENOENT";
			throw error;
		}
		if (meta.runId !== undefined && meta.runId !== runId) {
			throw new Error(`Hyperchart run identity mismatch for '${runId}'`);
		}
		return { ...normalizeRunMeta(meta), runId };
	} finally {
		await store.close();
	}
}

export async function saveRunMeta(runId: string, meta: RunMeta): Promise<void> {
	if (meta.runId !== undefined && meta.runId !== runId) {
		throw new Error(`Hyperchart run identity mismatch for '${runId}'`);
	}
	const store = await openRunLogStore(runId, { access: "writer" });
	try {
		await store.writeRunMeta({ ...normalizeRunMeta(meta), runId });
	} finally {
		await store.close();
	}
}

export async function deleteRunStorage(runId: string): Promise<void> {
	const store = await openRunLogStore(runId, { access: "writer" });
	try {
		await store.deleteRunData();
	} finally {
		await store.close();
	}
}

/** Enumerate authoritative storage keys, never infer identity from a caller's path. */
export async function listRunIds(storage: RunStorage | undefined = currentRunStorage()): Promise<string[]> {
	if (storage === undefined) {
		throw new Error("Hyperchart run storage scope is required");
	}
	if (storage.kind === "postgres") {
		const { default: pg } = await import("pg");
		const client = new pg.Client({ connectionString: storage.dsn });
		await client.connect();
		try {
			const result = await client.query<{ run_id: string }>(
				"select run_id from hyperchart_run_meta where chart_path is not null order by run_id",
			);
			return result.rows.map(({ run_id }) => {
				assertRunId(run_id, storage.layout);
				return run_id;
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "42P01") {
				return [];
			}
			throw error;
		} finally {
			await client.end();
		}
	}
	if (!existsSync(storage.rootDir)) {
		return [];
	}
	const result: string[] = [];
	for (const entry of readdirSync(storage.rootDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}
		if (storage.layout === "run-id") {
			assertRunId(entry.name);
			result.push(entry.name);
			continue;
		}
		const path = join(storage.rootDir, entry.name, "meta.json");
		if (!existsSync(path)) {
			continue;
		}
		const meta = JSON.parse(readFileSync(path, "utf8")) as RunMeta;
		if (meta.runId === undefined) {
			throw new Error(`Hashed JSONL run metadata lacks runId: ${path}`);
		}
		if (resolveRunPaths(meta.runId, storage).runDir !== resolve(storage.rootDir, entry.name)) {
			throw new Error(`Hashed JSONL run identity mismatch: ${path}`);
		}
		result.push(meta.runId);
	}
	return result.sort();
}

function normalizeRunMeta(meta: RunMeta): RunMeta {
	return { ...meta, chartPath: resolve(meta.chartPath), workDir: resolve(meta.workDir) };
}
