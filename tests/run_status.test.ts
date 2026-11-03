import {
	withRunStorage,
	resolveRunPaths,
	type RunStorage,
} from "../packages/hyperchart/src/runtime/generic/run_paths.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	isRunLive,
	markRunHeartbeat,
	patchRunStatus,
	readRunStatus,
} from "../packages/hyperchart/src/runtime/generic/run_status.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "hyperchart-status-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("run status", () => {
	it("persists v2 live branch transitions and clears them at terminal state", async () => {
		const root = await makeTempDir();
		const storage: RunStorage = { kind: "jsonl", rootDir: root, layout: "sha256" };
		const runId = "run";
		const dir = resolveRunPaths(runId, storage).runDir;
		await mkdir(dir);
		await withRunStorage(storage, () =>
			patchRunStatus(runId, {
				branchIds: ["main", "experiment"],
				chartId: "chart",
				state: "failed",
				attemptId: "attempt-a",
				error: "boom",
				exitCode: 1,
				heartbeatAt: 100,
			}),
		);
		await withRunStorage(storage, () =>
			patchRunStatus(runId, { state: "running", error: undefined, exitCode: undefined, heartbeatAt: Date.now() }),
		);

		const status = await withRunStorage(storage, () => readRunStatus(runId));
		expect(status).toMatchObject({
			version: 2,
			runId: "run",
			chartId: "chart",
			state: "running",
			branchIds: ["main", "experiment"],
			attemptId: "attempt-a",
		});
		expect(status?.error).toBeUndefined();
		expect(status?.exitCode).toBeUndefined();
		expect(isRunLive(status)).toBe(true);

		await withRunStorage(storage, () => patchRunStatus(runId, { branchIds: ["experiment"] }));
		expect((await withRunStorage(storage, () => readRunStatus(runId)))?.branchIds).toEqual(["experiment"]);
		await withRunStorage(storage, () =>
			patchRunStatus(runId, { state: "complete", branchIds: [], attemptId: "attempt-b" }),
		);
		expect(await withRunStorage(storage, () => readRunStatus(runId))).toMatchObject({
			state: "complete",
			branchIds: [],
			attemptId: "attempt-b",
		});
	});

	it("refreshes a starting heartbeat without promoting the runner state", async () => {
		const root = await makeTempDir();
		const storage: RunStorage = { kind: "jsonl", rootDir: root, layout: "sha256" };
		const runId = "run";
		const dir = resolveRunPaths(runId, storage).runDir;
		await mkdir(dir);
		await withRunStorage(storage, () =>
			patchRunStatus(runId, { branchIds: ["main"], chartId: "chart", state: "starting" }),
		);

		const heartbeat = await withRunStorage(storage, () => markRunHeartbeat(runId));

		expect(heartbeat).toMatchObject({ state: "starting", pid: process.pid, heartbeatAt: expect.any(Number) });
		expect((await withRunStorage(storage, () => readRunStatus(runId)))?.state).toBe("starting");
	});

	it("reads legacy singleton status for terminal-notification compatibility", async () => {
		const root = await makeTempDir();
		const storage: RunStorage = { kind: "jsonl", rootDir: root, layout: "sha256" };
		const runId = "run";
		const dir = resolveRunPaths(runId, storage).runDir;
		await mkdir(dir);
		await writeFile(
			join(dir, "status.json"),
			JSON.stringify({
				version: 1,
				runId,
				runDir: dir,
				chartId: "chart",
				state: "complete",
				branchId: "main",
				startedAt: 1,
				updatedAt: 2,
			}),
		);
		expect(await withRunStorage(storage, () => readRunStatus(runId))).toMatchObject({
			version: 2,
			branchIds: ["main"],
			state: "complete",
		});
	});
});
