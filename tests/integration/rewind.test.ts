import {
	withRunStorage,
	resolveRunPaths,
	type RunStorage,
} from "../../packages/hyperchart/src/runtime/generic/run_paths.js";
import { collectHistoryRecords } from "../helpers/history.js";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DurableLogRecord } from "../../packages/hyperchart/src/core/durable_events.js";
import type { AgentEffect, AgentOutcome } from "../../packages/hyperchart/src/core/machine.js";
import type { ActionUID } from "../../packages/hyperchart/src/core/types.js";
import { forkHyperchartRun, listHyperchartBranchPage } from "../../packages/hyperchart/src/runner/branches.js";
import { JsonlLogStore } from "../../packages/hyperchart/src/runtime/generic/log_store.js";
import { saveRunMeta } from "../../packages/hyperchart/src/runtime/generic/run_dir.js";
import { patchRunStatus } from "../../packages/hyperchart/src/runtime/generic/run_status.js";
import { rewindHyperchartRun, semanticStatesForRecord } from "../../packages/hyperchart/src/runner/rewind.js";
import {
	createHyperchartRunnerController,
	type SteerableAgentExecutor,
} from "../../packages/hyperchart/src/runner/runner_main.js";

const tempDirs: string[] = [];
const originalCwd = process.cwd();
const originalExitCode = process.exitCode;
const stamp = (seqId: number) => ({
	seqId,
	parentId: seqId === 1 ? null : seqId - 1,
	branchId: "main",
	timestamp: seqId,
});

afterEach(async () => {
	vi.restoreAllMocks();
	process.chdir(originalCwd);
	process.exitCode = originalExitCode;
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class LiveExecutor implements SteerableAgentExecutor {
	emit?: (outcome: AgentOutcome) => void;
	start(_effect: AgentEffect, emit: (outcome: AgentOutcome) => void): void {
		this.emit = emit;
	}
	async cancel(_actionUid: ActionUID): Promise<void> {}
	async dispose(): Promise<void> {}
	async steer(): Promise<boolean> {
		return false;
	}
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) {
			throw new Error("Timed out waiting for live runner");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function createStoppedRun() {
	const root = await mkdtemp(join(tmpdir(), "hyperchart-rewind-"));
	tempDirs.push(root);
	const runId = "run";
	const storage: RunStorage = { kind: "jsonl", rootDir: root, layout: "sha256" };
	const runDir = resolveRunPaths(runId, storage).runDir;
	const chartPath = resolve("examples/quickstart.chart.ts");
	await withRunStorage(storage, () =>
		saveRunMeta(runId, {
			chartPath,
			workDir: root,
			chartId: "quickstart",
			createdAt: new Date().toISOString(),
		}),
	);
	await withRunStorage(storage, () =>
		patchRunStatus(runId, { branchIds: ["main"], chartId: "quickstart", state: "stopped" }),
	);
	const store = new JsonlLogStore(join(runDir, "log.jsonl"));
	await store.initializeRootBranch();
	return { root, runId, storage, runDir, store };
}

describe("append-only branch rewind", () => {
	it("forks without selecting/starting and moves a branch head without deleting the old tail", async () => {
		const { root, runId, storage, runDir, store } = await createStoppedRun();
		await store.appendDrafts([
			{ type: "args", args: {} },
			{ type: "session_ref", index: 1, file: "one.jsonl" },
			{ type: "session_ref", index: 2, file: "two.jsonl" },
		]);
		const fork = await withRunStorage(storage, () =>
			forkHyperchartRun({
				runId,
				fromSeqId: 3,
				branchId: "experiment",
				reason: "preserve B",
				cwd: root,
				sourceBranchId: "main",
			}),
		);
		expect(fork).toMatchObject({
			selectedBranchChanged: false,
			started: false,
			branch: { branchId: "experiment", headSeqId: 3 },
		});
		const bytesBeforeCheckout = await readFile(join(runDir, "log.jsonl"), "utf8");
		await store.listBranches();
		expect(await readFile(join(runDir, "log.jsonl"), "utf8")).toBe(bytesBeforeCheckout);

		const rewind = await withRunStorage(storage, () =>
			rewindHyperchartRun({ runId, branchId: "main", seqId: 3, mode: "after", cwd: root }),
		);
		expect(rewind).toMatchObject({ branchId: "main", previousHeadSeqId: 4, headSeqId: 3, preservedRecords: 3 });
		// Reopen after a separate host operation; an opened journal never rereads itself.
		const replacementStore = new JsonlLogStore(join(runDir, "log.jsonl"));
		const replacement = await replacementStore.appendDrafts([
			{ type: "session_ref", index: 3, file: "replacement.jsonl" },
		]);
		expect(replacement[0]).toMatchObject({ seqId: 7, parentId: 3, branchId: "main" });

		await withRunStorage(storage, () =>
			rewindHyperchartRun({ runId, branchId: "main", seqId: 4, mode: "after", cwd: root }),
		);
		const continuationStore = new JsonlLogStore(join(runDir, "log.jsonl"));
		const oldTailContinuation = await continuationStore.appendDrafts([
			{ type: "session_ref", index: 4, file: "old-tail.jsonl" },
		]);
		expect(oldTailContinuation[0]).toMatchObject({ seqId: 9, parentId: 4, branchId: "main" });
		const storedEntries = (await readFile(join(runDir, "log.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { kind?: string; seqId: number });
		expect(storedEntries.filter((entry) => entry.kind !== "branch").map((record) => record.seqId)).toEqual([
			2, 3, 4, 7, 9,
		]);
		expect((await collectHistoryRecords(continuationStore, "main")).map((record) => record.seqId)).toEqual([
			2, 3, 4, 9,
		]);
		expect((await collectHistoryRecords(continuationStore, "experiment")).map((record) => record.seqId)).toEqual([
			2, 3,
		]);
		expect(
			(await withRunStorage(storage, () => listHyperchartBranchPage(runId))).items.map((branch) => branch.branchId),
		).toEqual(["main", "experiment"]);
		expect(await readFile(join(runDir, "log.jsonl"), "utf8")).not.toContain("rewind-backups");
	});

	it("pages more than 100 run-directory branches without overlap", async () => {
		const { runId, storage, runDir, store } = await createStoppedRun();
		const [root] = await store.appendDrafts([{ type: "args", args: {} }]);
		for (let index = 0; index < 105; index++) {
			await store.createBranch(`branch-${index.toString().padStart(3, "0")}`, root!.seqId);
		}
		const first = await withRunStorage(storage, () => listHyperchartBranchPage(runId));
		expect(first.items).toHaveLength(100);
		expect(first.totalCount).toBe(106);
		expect(first.next).toBeTypeOf("string");
		const second = await withRunStorage(storage, () => listHyperchartBranchPage(runId, first.next));
		expect(second.items).toHaveLength(6);
		expect(second.totalCount).toBe(106);
		expect(second.next).toBeUndefined();
		const ids = [...first.items, ...second.items].map((branch) => branch.branchId);
		expect(new Set(ids).size).toBe(106);
		expect(ids).toEqual([
			"main",
			...Array.from({ length: 105 }, (_, index) => `branch-${index.toString().padStart(3, "0")}`),
		]);
	});

	it("reports live rewind metadata from the controller move boundary after a concurrent append", async () => {
		const root = await mkdtemp(join(tmpdir(), "hyperchart-live-rewind-race-"));
		tempDirs.push(root);
		const runId = "run";
		const storage: RunStorage = { kind: "jsonl", rootDir: root, layout: "sha256" };
		const runDir = resolveRunPaths(runId, storage).runDir;
		const chartPath = join(root, "chart.mjs");
		await mkdir(runDir, { recursive: true });
		await writeFile(
			chartPath,
			`export default {
  kind: "chart", id: "live-rewind-race", initial: "ask",
  states: {
    ask: { kind: "state", action: { kind: "user", prompt: "Select", options: ["SELECTED"] }, transitions: { SELECTED: "done" } },
    done: { kind: "final" }
  }
};\n`,
		);
		await withRunStorage(storage, () =>
			saveRunMeta(runId, {
				chartPath,
				workDir: root,
				chartId: "live-rewind-race",
				createdAt: new Date().toISOString(),
			}),
		);
		const seed = new JsonlLogStore(join(runDir, "log.jsonl"));
		await seed.initializeRootBranch();
		const controller = await createHyperchartRunnerController(
			{
				runId,
				storage,
				chartPath,
				chartId: "live-rewind-race",
				workDir: root,
				branchId: "main",
			},
			() => new LiveExecutor(),
		);
		controller.acquireHold();
		const aggregate = controller.start();
		let opened: Extract<DurableLogRecord, { type: "user_interaction"; kind: "opened" }> | undefined;
		let beforeRecords: readonly DurableLogRecord[] = [];
		for (let turn = 0; turn < 400 && opened === undefined; turn++) {
			const reader = new JsonlLogStore(join(runDir, "log.jsonl"));
			beforeRecords = await collectHistoryRecords(reader, "main");
			opened = beforeRecords.find(
				(record): record is Extract<DurableLogRecord, { type: "user_interaction"; kind: "opened" }> =>
					record.type === "user_interaction" && record.kind === "opened",
			);
			if (opened === undefined) {
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
		}
		if (opened === undefined) {
			throw new Error("live gate did not open");
		}
		const target = beforeRecords[0]!;

		let closeReached!: () => void;
		const atClose = new Promise<void>((resolve) => {
			closeReached = resolve;
		});
		let releaseClose!: () => void;
		const closeGate = new Promise<void>((resolve) => {
			releaseClose = resolve;
		});
		const originalClose = JsonlLogStore.prototype.close;
		let blockNextClose = true;
		vi.spyOn(JsonlLogStore.prototype, "close").mockImplementation(async function (this: JsonlLogStore) {
			if (blockNextClose) {
				blockNextClose = false;
				closeReached();
				await closeGate;
			}
			return originalClose.call(this);
		});

		const rewinding = withRunStorage(storage, () =>
			rewindHyperchartRun({ runId, branchId: "main", seqId: target.seqId, mode: "before", cwd: root }),
		);
		await atClose;
		const response = await controller.respondToUserInteraction("main", opened.seqId, { type: "SELECTED" });
		releaseClose();
		const result = await rewinding;
		expect(result).toMatchObject({
			previousHeadSeqId: response.record.seqId,
			headSeqId: target.parentId,
			preservedRecords: beforeRecords.length + 1,
		});
		await controller.stop();
		await aggregate;
	});

	it("routes a live rewind through the owning controller control channel", async () => {
		const root = await mkdtemp(join(tmpdir(), "hyperchart-live-rewind-"));
		tempDirs.push(root);
		const runId = "run";
		const storage: RunStorage = { kind: "jsonl", rootDir: root, layout: "sha256" };
		const runDir = resolveRunPaths(runId, storage).runDir;
		const chartPath = join(root, "chart.mjs");
		await mkdir(runDir, { recursive: true });
		await writeFile(
			chartPath,
			`export default {
  kind: "chart", id: "live-rewind", initial: "work",
  states: {
    work: { kind: "state", action: { kind: "agent", name: "worker" }, transitions: { DONE: "done" } },
    done: { kind: "final" }
  }
};\n`,
		);
		await withRunStorage(storage, () =>
			saveRunMeta(runId, { chartPath, workDir: root, chartId: "live-rewind", createdAt: new Date().toISOString() }),
		);
		const store = new JsonlLogStore(join(runDir, "log.jsonl"));
		await store.initializeRootBranch();
		const executor = new LiveExecutor();
		const controller = await createHyperchartRunnerController(
			{
				runId,
				storage,
				chartPath,
				chartId: "live-rewind",
				workDir: root,
				branchId: "main",
			},
			() => executor,
		);
		controller.acquireHold();
		const aggregate = controller.start();
		await waitFor(() => executor.emit !== undefined);
		const beforeStore = new JsonlLogStore(join(runDir, "log.jsonl"));
		const beforeBranch = await beforeStore.getBranch("main");
		const beforeRecords = await collectHistoryRecords(beforeStore, "main");
		const targetRecord = beforeRecords[0]!;

		const result = await withRunStorage(storage, () =>
			rewindHyperchartRun({ runId, branchId: "main", seqId: targetRecord.seqId, mode: "before", cwd: root }),
		);
		expect(result).toMatchObject({
			branchId: "main",
			previousHeadSeqId: beforeBranch.headSeqId,
			headSeqId: targetRecord.parentId,
			preservedRecords: beforeRecords.length,
		});
		const afterStore = new JsonlLogStore(join(runDir, "log.jsonl"));
		expect((await afterStore.getBranch("main")).headSeqId).toBe(targetRecord.parentId);
		expect(controller.liveBranchIds).toEqual([]);

		await controller.stop();
		await aggregate;
	});
});

describe("rewind actor-pool state matching", () => {
	it("attributes accepted, replied, and settled facts to the concrete worker receive visit", () => {
		const records: DurableLogRecord[] = [
			{
				type: "actor_message",
				kind: "accepted",
				occurrence: "projects#a.@pool~2",
				messageId: "message-1",
				receiveState: "projects#a.@pool~2.$worker-1.alternateIdle",
				workerIndex: 1,
				...stamp(1),
			},
			{
				type: "actor_message",
				kind: "replied",
				occurrence: "projects#a.@pool~2",
				messageId: "message-1",
				message: "WORK",
				workerIndex: 1,
				...stamp(2),
			},
			{
				type: "actor_message",
				kind: "settled",
				occurrence: "projects#a.@pool~2",
				messageId: "message-1",
				workerIndex: 1,
				...stamp(3),
			},
		];

		for (const [index, record] of records.entries()) {
			expect(semanticStatesForRecord(record, records, index)).toEqual([
				"projects#a.@pool~2",
				"projects#a.@pool~2.$worker-1",
				"projects#a.@pool~2.$worker-1.alternateIdle",
			]);
		}
	});
});
