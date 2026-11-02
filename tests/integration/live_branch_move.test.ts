import { dirname as fixtureRoot } from "node:path";
import { type RunStorage } from "../../packages/hyperchart/src/runtime/generic/run_paths.js";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEffect, AgentOutcome } from "../../packages/hyperchart/src/core/machine.js";
import type { ActionUID } from "../../packages/hyperchart/src/core/types.js";
import { JsonlLogStore } from "../../packages/hyperchart/src/runtime/generic/log_store.js";
import {
	BranchSealedError,
	createHyperchartRunnerController,
	type HyperchartRunnerController,
	type RunnerOutcome,
	type SteerableAgentExecutor,
} from "../../packages/hyperchart/src/runner/runner_main.js";
import type { StorageEntry } from "../../packages/hyperchart/src/core/durable_events.js";
import { collectHistoryRecords } from "../helpers/history.js";

const roots: string[] = [];
const originalCwd = process.cwd();
const originalExitCode = process.exitCode;

afterEach(() => {
	process.chdir(originalCwd);
	process.exitCode = originalExitCode;
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

type Deferred = { promise: Promise<void>; resolve(): void };
function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) {
			throw new Error("Timed out waiting for runner state");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function branchView(runDir: string, branchId: string) {
	const store = new JsonlLogStore(join(runDir, "log.jsonl"), branchId);
	try {
		const branch = await store.getBranch(branchId);
		return { branch, records: await collectHistoryRecords(store, branchId) };
	} finally {
		await store.close();
	}
}

function storageEntries(runDir: string): StorageEntry[] {
	return readFileSync(join(runDir, "log.jsonl"), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as StorageEntry);
}

class PausingExecutor implements SteerableAgentExecutor {
	emit?: (outcome: AgentOutcome) => void;
	readonly disposalStarted = deferred();
	constructor(
		readonly branchId: string,
		private readonly disposeGate?: Promise<void>,
	) {}
	start(_effect: AgentEffect, emit: (outcome: AgentOutcome) => void): void {
		this.emit = emit;
	}
	async cancel(_actionUid: ActionUID): Promise<void> {}
	async dispose(): Promise<void> {
		this.disposalStarted.resolve();
		await this.disposeGate;
	}
	async steer(): Promise<boolean> {
		return false;
	}
	complete(): void {
		this.emit?.({ kind: "completed", event: { type: "DONE" } });
	}
}

async function fixture(
	branchIds: readonly string[],
	disposeGates: ReadonlyMap<string, Promise<void>> = new Map(),
): Promise<{
	controller: HyperchartRunnerController;
	completion: Promise<RunnerOutcome>;
	executors: Map<string, PausingExecutor[]>;
	runDir: string;
}> {
	const root = mkdtempSync(join(tmpdir(), "hyperchart-live-move-"));
	roots.push(root);
	const workDir = join(root, "work");
	const runDir = join(root, "run");
	mkdirSync(workDir, { recursive: true });
	mkdirSync(runDir, { recursive: true });
	const chartPath = join(workDir, "chart.mjs");
	writeFileSync(
		chartPath,
		`export default {
  kind: "chart", id: "live-move", initial: "work",
  states: {
    work: { kind: "state", action: { kind: "agent", name: "worker" }, transitions: { DONE: "done" } },
    done: { kind: "final" }
  }
};\n`,
	);
	writeFileSync(
		join(runDir, "log.jsonl"),
		`${branchIds
			.map((branchId, index) =>
				JSON.stringify({
					kind: "branch",
					op: "create",
					seqId: index + 1,
					branchId,
					headSeqId: null,
					metadata: { name: branchId },
					committedAt: index + 1,
				}),
			)
			.join("\n")}\n`,
	);
	const executors = new Map<string, PausingExecutor[]>();
	const controller = await createHyperchartRunnerController(
		{
			runId: "run",
			storage: fixtureStorage(runDir),
			chartPath,
			chartId: "live-move",
			workDir,
			branchIds: [...branchIds],
		},
		({ config }) => {
			const executor = new PausingExecutor(config.branchId, disposeGates.get(config.branchId));
			const branchExecutors = executors.get(config.branchId) ?? [];
			branchExecutors.push(executor);
			executors.set(config.branchId, branchExecutors);
			return executor;
		},
	);
	controller.acquireHold();
	const completion = controller.start();
	await waitFor(() => branchIds.every((branchId) => executors.get(branchId)?.[0]?.emit !== undefined));
	return { controller, completion, executors, runDir };
}

describe("live branch sealing and move", () => {
	it("wakes ordinary admission after a rejected commit with no journal mutation, never reserving across the move fence", async () => {
		const f = await fixture(["main"]);
		const target = (await branchView(f.runDir, "main")).branch.headSeqId!;
		const before = storageEntries(f.runDir);
		const committing = deferred();
		const release = deferred();
		const store = (f.controller as unknown as { rootStore: JsonlLogStore }).rootStore;
		const failure = new Error("commit rejected after drain");
		vi.spyOn(store, "moveBranch").mockImplementationOnce(async () => {
			committing.resolve();
			await release.promise;
			throw failure;
		});
		const readiness: boolean[] = [];
		const unsubscribe = f.controller.onBranchChange(() => readiness.push(f.controller.canStartBranch("main")));
		try {
			const moving = f.controller.moveBranch("main", target);
			void moving.catch(() => {});
			await committing.promise;
			expect(f.controller.liveBranchIds).toEqual([]);
			expect(f.controller.canStartBranch("main")).toBe(false);
			await expect(f.controller.startBranch("main")).rejects.toBeInstanceOf(BranchSealedError);
			expect(f.controller.liveBranchIds).toEqual([]);
			expect(f.executors.get("main")).toHaveLength(1);
			expect(readiness).toEqual([false]);
			release.resolve();
			await expect(moving).rejects.toBe(failure);
			expect(readiness).toEqual([false, true]);
			expect(storageEntries(f.runDir)).toEqual(before);
			const resumed = f.controller.startBranch("main");
			await waitFor(() => f.executors.get("main")?.[1]?.emit !== undefined);
			expect(f.controller.canStartBranch("main")).toBe(false);
			await f.controller.stopAndDrain("main");
			await expect(resumed).resolves.toMatchObject({ outcome: "drained" });
		} finally {
			release.resolve();
			unsubscribe();
			await f.controller.stop();
			await f.completion;
		}
	});

	it("fails closed before the move commit point and releases temporary seals", async () => {
		const f = await fixture(["main"]);
		const beforeEntries = storageEntries(f.runDir);
		const before = await branchView(f.runDir, "main");
		const headSeqId = before.branch.headSeqId!;

		await expect(f.controller.moveBranch("main", 999_999)).rejects.toThrow(/No durable log record/);
		expect(storageEntries(f.runDir)).toEqual(beforeEntries);
		await expect(
			f.controller.forkBranch({
				branchId: "after-failed-move",
				sourceBranchId: "main",
				fromSeqId: headSeqId,
			}),
		).resolves.toMatchObject({ branchId: "after-failed-move", headSeqId });

		await f.controller.stop();
		await f.completion;
	});

	it("keeps a successfully drained branch sealed until replay-gated readmission from its current head", async () => {
		const releaseDispose = deferred();
		const f = await fixture(["main"], new Map([["main", releaseDispose.promise]]));
		const first = f.executors.get("main")?.[0];
		if (first === undefined) {
			throw new Error("missing main executor");
		}
		const before = await branchView(f.runDir, "main");
		const drainedHeadSeqId = before.branch.headSeqId!;

		const changes = vi.fn();
		const unsubscribe = f.controller.onBranchChange(changes);
		const draining = f.controller.stopAndDrain("main");
		await first.disposalStarted.promise;
		expect(f.controller.canStartBranch("main")).toBe(false);
		expect(await f.controller.activeBranchIds()).toEqual(["main"]);
		await expect(
			f.controller.forkBranch({
				branchId: "blocked-during-drain",
				sourceBranchId: "main",
				fromSeqId: drainedHeadSeqId,
			}),
		).rejects.toBeInstanceOf(BranchSealedError);
		releaseDispose.resolve();
		await expect(draining).resolves.toEqual({ branchId: "main", outcome: "drained" });
		expect(changes).toHaveBeenCalledTimes(1);
		expect(f.controller.canStartBranch("main")).toBe(true);
		unsubscribe();
		await expect(
			f.controller.forkBranch({
				branchId: "blocked-after-drain",
				sourceBranchId: "main",
				fromSeqId: drainedHeadSeqId,
			}),
		).rejects.toBeInstanceOf(BranchSealedError);
		await f.controller.moveBranch("main", drainedHeadSeqId);
		await expect(
			f.controller.forkBranch({
				branchId: "blocked-after-drained-move",
				sourceBranchId: "main",
				fromSeqId: drainedHeadSeqId,
			}),
		).rejects.toBeInstanceOf(BranchSealedError);

		const resumed = f.controller.startBranch("main");
		await waitFor(() => f.executors.get("main")?.length === 2 && f.executors.get("main")?.[1]?.emit !== undefined);
		expect((await branchView(f.runDir, "main")).branch.headSeqId).toBe(drainedHeadSeqId);
		f.executors.get("main")?.[1]?.complete();
		await expect(resumed).resolves.toMatchObject({ branchId: "main", outcome: "complete" });
		const ancestry = (await branchView(f.runDir, "main")).records;
		expect(ancestry.find((record) => record.seqId > drainedHeadSeqId)?.parentId).toBe(drainedHeadSeqId);

		await f.controller.stop();
		await f.completion;
	});

	it("seals a fork subtree, leaves an independent branch writable during drain, and resumes the moved branch from the new head", async () => {
		const releaseMain = deferred();
		const releaseChild = deferred();
		const f = await fixture(
			["main", "sibling"],
			new Map([
				["main", releaseMain.promise],
				["child", releaseChild.promise],
			]),
		);
		const initial = await branchView(f.runDir, "main");
		const siblingInitial = await branchView(f.runDir, "sibling");
		const mainTargetSeqId = initial.records[0]?.seqId;
		if (mainTargetSeqId === undefined) {
			throw new Error("missing main target record");
		}
		const mainHeadSeqId = initial.branch.headSeqId!;
		await expect(
			f.controller.forkBranch({
				branchId: "malformed-child",
				sourceBranchId: "main",
				fromSeqId: siblingInitial.branch.headSeqId!,
			}),
		).rejects.toThrow(/not in source branch 'main' ancestry/);
		await f.controller.forkBranch({ branchId: "child", sourceBranchId: "main", fromSeqId: mainHeadSeqId });
		const childOutcome = f.controller.startBranch("child");
		await waitFor(() => f.executors.get("child")?.[0]?.emit !== undefined);
		const oldMain = f.executors.get("main")?.[0];
		const oldChild = f.executors.get("child")?.[0];
		if (oldMain === undefined || oldChild === undefined) {
			throw new Error("missing executors before branch move");
		}

		let moved = false;
		const moving = f.controller.moveBranch("main", mainTargetSeqId).then((moveSeqId) => {
			moved = true;
			return moveSeqId;
		});
		await Promise.all([oldMain.disposalStarted.promise, oldChild.disposalStarted.promise]);
		await expect(
			f.controller.forkBranch({
				branchId: "blocked-child-fork",
				sourceBranchId: "child",
				fromSeqId: (await branchView(f.runDir, "child")).branch.headSeqId!,
			}),
		).rejects.toBeInstanceOf(BranchSealedError);

		const sibling = await branchView(f.runDir, "sibling");
		const independent = await f.controller.forkBranch({
			branchId: "sibling-child",
			sourceBranchId: "sibling",
			fromSeqId: sibling.branch.headSeqId!,
		});
		expect(independent.branchId).toBe("sibling-child");
		expect(moved).toBe(false);

		releaseMain.resolve();
		releaseChild.resolve();
		const moveSeqId = await moving;
		await expect(childOutcome).resolves.toEqual({ branchId: "child", outcome: "drained" });
		const movedSnapshot = await branchView(f.runDir, "main");
		const movedEntries = storageEntries(f.runDir);
		expect(movedSnapshot.branch.headSeqId).toBe(mainTargetSeqId);
		expect(
			movedEntries.find((entry) => "kind" in entry && entry.kind === "branch" && entry.branchId === "sibling-child")
				?.seqId,
		).toBeLessThan(moveSeqId);
		expect(movedEntries.at(-1)).toMatchObject({
			kind: "branch",
			op: "move",
			seqId: moveSeqId,
			branchId: "main",
			headSeqId: mainTargetSeqId,
		});

		const resumed = f.controller.startBranch("main");
		await waitFor(() => f.executors.get("main")?.length === 2 && f.executors.get("main")?.[1]?.emit !== undefined);
		f.executors.get("main")?.[1]?.complete();
		await expect(resumed).resolves.toMatchObject({ branchId: "main", outcome: "complete" });
		const resumedSnapshot = await branchView(f.runDir, "main");
		expect(resumedSnapshot.records.find((record) => record.seqId > moveSeqId)?.parentId).toBe(mainTargetSeqId);

		await f.controller.stop();
		await f.completion;
	});
});

/** Explicit storage configuration for this suite's generated literal-layout fixtures. */
function fixtureStorage(runDirectory: string): RunStorage {
	return { kind: "jsonl", rootDir: fixtureRoot(runDirectory), layout: "run-id" };
}
