import { basename as fixtureRunId, dirname as fixtureRoot } from "node:path";
import { withRunStorage, type RunStorage } from "../../packages/hyperchart/src/runtime/generic/run_paths.js";
import { collectHistoryRecords } from "../helpers/history.js";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEffect, AgentOutcome } from "../../packages/hyperchart/src/core/machine.js";
import type { ActionUID } from "../../packages/hyperchart/src/core/types.js";
import type { DurableLogRecord } from "../../packages/hyperchart/src/core/durable_events.js";
import { JsonlLogStore } from "../../packages/hyperchart/src/runtime/generic/log_store.js";
import { readRunStatus } from "../../packages/hyperchart/src/runtime/generic/run_status.js";
import {
	createHyperchartRunnerController,
	runnerBranchIds,
	runHyperchartRunner,
	type SteerableAgentExecutor,
} from "../../packages/hyperchart/src/runner/runner_main.js";

const roots: string[] = [];
const originalCwd = process.cwd();
const originalExitCode = process.exitCode;

afterEach(() => {
	vi.restoreAllMocks();
	process.chdir(originalCwd);
	process.exitCode = originalExitCode;
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) {
			throw new Error("Timed out waiting for runner state");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function closeWithoutExiting(controller: unknown, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
	await (controller as { close(signal: NodeJS.Signals, exitProcess: boolean): Promise<void> }).close(signal, false);
}

function storedRecordSeqIds(runDir: string): number[] {
	return readFileSync(join(runDir, "log.jsonl"), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { kind?: string; seqId: number })
		.filter((entry) => entry.kind !== "branch")
		.map((entry) => entry.seqId);
}

function latestArtifactHash(records: readonly DurableLogRecord[], path: string): string | undefined {
	let hash: string | undefined;
	for (const record of records) {
		if (record.type === "state_action" && record.kind === "complete") {
			hash = record.artifacts?.[path]?.hash ?? hash;
		}
	}
	return hash;
}

class ControlledExecutor implements SteerableAgentExecutor {
	emit?: (outcome: AgentOutcome) => void;
	disposed = false;
	constructor(
		private readonly disposeGate?: Promise<void>,
		private readonly onDispose?: () => void,
		private readonly disposeError?: Error,
	) {}
	start(_effect: AgentEffect, emit: (outcome: AgentOutcome) => void): void {
		this.emit = emit;
	}
	async cancel(_actionUid: ActionUID): Promise<void> {}
	async dispose(): Promise<void> {
		this.disposed = true;
		this.onDispose?.();
		await this.disposeGate;
		if (this.disposeError !== undefined) {
			throw this.disposeError;
		}
	}
	async steer(): Promise<boolean> {
		return true;
	}
	complete(): void {
		this.emit?.({ kind: "completed", event: { type: "DONE" } });
	}
}

class CompletingExecutor implements SteerableAgentExecutor {
	constructor(
		readonly branchId: string,
		private readonly activity: { active: number; max: number },
		private readonly fail = false,
		private readonly disposeGate?: Promise<void>,
		private readonly onDispose?: () => void,
	) {}
	start(_effect: AgentEffect, emit: (outcome: AgentOutcome) => void): void {
		this.activity.active++;
		this.activity.max = Math.max(this.activity.max, this.activity.active);
		setTimeout(
			() => {
				this.activity.active--;
				emit(
					this.fail
						? { kind: "failed", failure: { kind: "runtime", retryable: false, message: `${this.branchId} failed` } }
						: { kind: "completed", event: { type: "DONE" } },
				);
			},
			this.branchId === "main" ? 20 : 10,
		);
	}
	async cancel(_actionUid: ActionUID): Promise<void> {}
	async dispose(): Promise<void> {
		this.onDispose?.();
		await this.disposeGate;
	}
	async steer(): Promise<boolean> {
		return true;
	}
}

describe("multi-branch process runner", () => {
	it("rejects an unrelated old FAILED fact for a failed terminal across restart", async () => {
		const root = mkdtempSync(join(tmpdir(), "hyperchart-final-provenance-"));
		roots.push(root);
		const workDir = join(root, "work");
		const runDir = join(root, "run");
		mkdirSync(workDir, { recursive: true });
		mkdirSync(runDir, { recursive: true });
		const chartPath = join(workDir, "chart.mjs");
		writeFileSync(
			chartPath,
			`export default { kind: "chart", id: "failure-provenance", initial: "failed", states: { failed: { kind: "final", outcome: "failed" } } };\n`,
		);
		const unrelated = {
			type: "state_action",
			kind: "complete",
			actionUid: { chart: "failure-provenance", state: "old", action: "agent" },
			event: { type: "FAILED", error: "unrelated old failure" },
			parentId: null,
			seqId: 2,
			branchId: "main",
			timestamp: 1,
		};
		writeFileSync(
			join(runDir, "log.jsonl"),
			`${[{ kind: "branch", op: "create", seqId: 1, branchId: "main", headSeqId: null, committedAt: 0 }, unrelated].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		);
		const config = {
			runId: "run",
			storage: fixtureStorage(runDir),
			chartPath,
			chartId: "failure-provenance",
			workDir,
			branchId: "main" as const,
			ignoreReplayWarnings: true,
		};
		for (let attempt = 0; attempt < 2; attempt++) {
			const controller = await createHyperchartRunnerController(config, () => new ControlledExecutor());
			await controller.start();
			expect(
				(await withRunStorage(fixtureStorage(runDir), () => readRunStatus(fixtureRunId(runDir))))?.error,
			).toContain("chart reached failed terminal state 'failed'");
			expect(
				(await withRunStorage(fixtureStorage(runDir), () => readRunStatus(fixtureRunId(runDir))))?.replayWarnings?.join(
					"\n",
				),
			).toContain("skipped");
		}
	});

	it("normalizes legacy singleton input and rejects ambiguous or duplicate sets", () => {
		expect(runnerBranchIds({ branchId: "main" })).toEqual(["main"]);
		expect(runnerBranchIds({ branchIds: ["main", "experiment"] })).toEqual(["main", "experiment"]);
		expect(() => runnerBranchIds({ branchId: "main", branchIds: ["experiment"] } as never)).toThrow(/not both/);
		expect(() => runnerBranchIds({ branchIds: ["main", "main"] })).toThrow(/Duplicate/);
	});

	it("closes reserved initial branches before start without waiting for readiness", async () => {
		const root = mkdtempSync(join(tmpdir(), "hyperchart-close-before-start-"));
		roots.push(root);
		const workDir = join(root, "work");
		const runDir = join(root, "run");
		mkdirSync(workDir, { recursive: true });
		mkdirSync(runDir, { recursive: true });
		const chartPath = join(workDir, "chart.mjs");
		writeFileSync(
			chartPath,
			`export default { kind: "chart", id: "close-before-start", initial: "done", states: { done: { kind: "final" } } };\n`,
		);
		writeFileSync(
			join(runDir, "log.jsonl"),
			`${JSON.stringify({ kind: "branch", op: "create", seqId: 1, branchId: "main", headSeqId: null, committedAt: 1 })}\n`,
		);
		let built = 0;
		const controller = await createHyperchartRunnerController(
			{
				runId: "run",
				storage: fixtureStorage(runDir),
				chartPath,
				chartId: "close-before-start",
				workDir,
				branchId: "main",
			},
			() => {
				built++;
				return new ControlledExecutor();
			},
		);

		await expect(controller.startBranch("main")).rejects.toThrow(/must be started.*controller\.start/);
		await closeWithoutExiting(controller);
		await controller.start();

		expect(built).toBe(0);
		expect(controller.liveBranchIds).toEqual([]);
		expect(await withRunStorage(fixtureStorage(runDir), () => readRunStatus(fixtureRunId(runDir)))).toMatchObject({
			state: "stopped",
			branchIds: [],
			exitCode: 143,
		});
	});

	it("does not publish running or construct executors after shutdown during initial replay gating", async () => {
		const root = mkdtempSync(join(tmpdir(), "hyperchart-close-initial-gate-"));
		roots.push(root);
		const workDir = join(root, "work");
		const runDir = join(root, "run");
		mkdirSync(workDir, { recursive: true });
		mkdirSync(runDir, { recursive: true });
		const chartPath = join(workDir, "chart.mjs");
		writeFileSync(
			chartPath,
			`export default { kind: "chart", id: "close-initial-gate", initial: "done", states: { done: { kind: "final" } } };\n`,
		);
		writeFileSync(
			join(runDir, "log.jsonl"),
			`${JSON.stringify({ kind: "branch", op: "create", seqId: 1, branchId: "main", headSeqId: null, committedAt: 1 })}\n`,
		);
		let releaseGate!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		let gateEntered!: () => void;
		const entered = new Promise<void>((resolve) => {
			gateEntered = resolve;
		});
		const originalCaptureSnapshot = JsonlLogStore.prototype.captureSnapshot;
		vi.spyOn(JsonlLogStore.prototype, "captureSnapshot").mockImplementation(async function (
			this: JsonlLogStore,
			branchId: string,
		) {
			if (this.branchId === "main") {
				gateEntered();
				await gate;
			}
			return originalCaptureSnapshot.call(this, branchId);
		});
		let built = 0;
		const controller = await createHyperchartRunnerController(
			{
				runId: "run",
				storage: fixtureStorage(runDir),
				chartPath,
				chartId: "close-initial-gate",
				workDir,
				branchId: "main",
			},
			() => {
				built++;
				return new ControlledExecutor();
			},
		);
		const completion = controller.start();
		await entered;

		let closeResolved = false;
		const closing = closeWithoutExiting(controller, "SIGINT").then(() => {
			closeResolved = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(closeResolved).toBe(false);
		expect((await withRunStorage(fixtureStorage(runDir), () => readRunStatus(fixtureRunId(runDir))))?.state).toBe(
			"starting",
		);
		releaseGate();
		await closing;
		await completion;

		expect(built).toBe(0);
		expect(await withRunStorage(fixtureStorage(runDir), () => readRunStatus(fixtureRunId(runDir)))).toMatchObject({
			state: "stopped",
			branchIds: [],
			exitCode: 130,
		});
	});

	it("records signal-shutdown disposal failures while preserving the signal exit code", async () => {
		const root = mkdtempSync(join(tmpdir(), "hyperchart-close-cleanup-failure-"));
		roots.push(root);
		const workDir = join(root, "work");
		const runDir = join(root, "run");
		mkdirSync(workDir, { recursive: true });
		mkdirSync(runDir, { recursive: true });
		const chartPath = join(workDir, "chart.mjs");
		writeFileSync(
			chartPath,
			`export default { kind: "chart", id: "close-cleanup-failure", initial: "work", states: { work: { kind: "state", action: { kind: "agent", name: "worker" }, transitions: { DONE: "done" } }, done: { kind: "final" } } };\n`,
		);
		writeFileSync(
			join(runDir, "log.jsonl"),
			`${JSON.stringify({ kind: "branch", op: "create", seqId: 1, branchId: "main", headSeqId: null, committedAt: 1 })}\n`,
		);
		const executor = new ControlledExecutor(undefined, undefined, new Error("dispose exploded"));
		const controller = await createHyperchartRunnerController(
			{
				runId: "run",
				storage: fixtureStorage(runDir),
				chartPath,
				chartId: "close-cleanup-failure",
				workDir,
				branchId: "main",
			},
			() => executor,
		);
		const completion = controller.start();
		await waitFor(() => executor.emit !== undefined);

		await closeWithoutExiting(controller, "SIGINT");
		await completion;

		expect(executor.disposed).toBe(true);
		expect(await withRunStorage(fixtureStorage(runDir), () => readRunStatus(fixtureRunId(runDir)))).toMatchObject({
			state: "stopped",
			branchIds: [],
			exitCode: 130,
			error: expect.stringMatching(/cleanup failed.*dispose exploded/),
		});
	});

	it("disposes an executor that finishes construction after shutdown without creating its runtime", async () => {
		const root = mkdtempSync(join(tmpdir(), "hyperchart-close-build-"));
		roots.push(root);
		const workDir = join(root, "work");
		const runDir = join(root, "run");
		mkdirSync(workDir, { recursive: true });
		mkdirSync(runDir, { recursive: true });
		const chartPath = join(workDir, "chart.mjs");
		writeFileSync(
			chartPath,
			`export default { kind: "chart", id: "close-build", initial: "work", states: { work: { kind: "state", action: { kind: "agent", name: "worker" }, transitions: { DONE: "done" } }, done: { kind: "final" } } };\n`,
		);
		writeFileSync(
			join(runDir, "log.jsonl"),
			`${JSON.stringify({ kind: "branch", op: "create", seqId: 1, branchId: "main", headSeqId: null, committedAt: 1 })}\n`,
		);
		let releaseBuild!: () => void;
		const buildGate = new Promise<void>((resolve) => {
			releaseBuild = resolve;
		});
		let buildEntered!: () => void;
		const entered = new Promise<void>((resolve) => {
			buildEntered = resolve;
		});
		const executor = new ControlledExecutor();
		const controller = await createHyperchartRunnerController(
			{
				runId: "run",
				storage: fixtureStorage(runDir),
				chartPath,
				chartId: "close-build",
				workDir,
				branchId: "main",
			},
			async () => {
				buildEntered();
				await buildGate;
				return executor;
			},
		);
		const completion = controller.start();
		await entered;

		let closeResolved = false;
		const closing = closeWithoutExiting(controller).then(() => {
			closeResolved = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(closeResolved).toBe(false);
		expect((await withRunStorage(fixtureStorage(runDir), () => readRunStatus(fixtureRunId(runDir))))?.state).toBe(
			"running",
		);
		releaseBuild();
		await closing;
		await completion;

		expect(executor.disposed).toBe(true);
		expect(executor.emit).toBeUndefined();
		expect(await withRunStorage(fixtureStorage(runDir), () => readRunStatus(fixtureRunId(runDir)))).toMatchObject({
			state: "stopped",
			branchIds: [],
		});
	});

	it("cancels a dynamically admitted branch while its replay gate is pending", async () => {
		const root = mkdtempSync(join(tmpdir(), "hyperchart-close-dynamic-gate-"));
		roots.push(root);
		const workDir = join(root, "work");
		const runDir = join(root, "run");
		mkdirSync(workDir, { recursive: true });
		mkdirSync(runDir, { recursive: true });
		const chartPath = join(workDir, "chart.mjs");
		writeFileSync(
			chartPath,
			`export default { kind: "chart", id: "close-dynamic-gate", initial: "work", states: { work: { kind: "state", action: { kind: "agent", name: "worker" }, transitions: { DONE: "done" } }, done: { kind: "final" } } };\n`,
		);
		writeFileSync(
			join(runDir, "log.jsonl"),
			`${JSON.stringify({ kind: "branch", op: "create", seqId: 1, branchId: "main", headSeqId: null, committedAt: 1 })}\n`,
		);
		const executors = new Map<string, ControlledExecutor>();
		const controller = await createHyperchartRunnerController(
			{
				runId: "run",
				storage: fixtureStorage(runDir),
				chartPath,
				chartId: "close-dynamic-gate",
				workDir,
				branchId: "main",
			},
			({ config }) => {
				const executor = new ControlledExecutor();
				executors.set(config.branchId, executor);
				return executor;
			},
		);
		const completion = controller.start();
		await waitFor(() => executors.get("main")?.emit !== undefined);
		const reader = new JsonlLogStore(join(runDir, "log.jsonl"), "main");
		await controller.forkBranch({ branchId: "experiment", fromSeqId: (await reader.getBranch("main")).headSeqId! });
		let releaseGate!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		let gateEntered!: () => void;
		const entered = new Promise<void>((resolve) => {
			gateEntered = resolve;
		});
		const originalCaptureSnapshot = JsonlLogStore.prototype.captureSnapshot;
		vi.spyOn(JsonlLogStore.prototype, "captureSnapshot").mockImplementation(async function (
			this: JsonlLogStore,
			branchId: string,
		) {
			if (this.branchId === "experiment") {
				gateEntered();
				await gate;
			}
			return originalCaptureSnapshot.call(this, branchId);
		});
		const experimentOutcome = controller.startBranch("experiment");
		await entered;

		let closeResolved = false;
		const closing = closeWithoutExiting(controller).then(() => {
			closeResolved = true;
		});
		expect(await experimentOutcome).toMatchObject({
			branchId: "experiment",
			outcome: "failed",
			error: "Runner stopped by SIGTERM",
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(closeResolved).toBe(false);
		releaseGate();
		await closing;
		await completion;

		expect(executors.has("experiment")).toBe(false);
		expect(executors.get("main")?.disposed).toBe(true);
		expect(await withRunStorage(fixtureStorage(runDir), () => readRunStatus(fixtureRunId(runDir)))).toMatchObject({
			state: "stopped",
			branchIds: [],
		});
	});

	it("holds dynamic replay and executor construction behind every initial replay gate", async () => {
		const root = mkdtempSync(join(tmpdir(), "hyperchart-dynamic-initial-barrier-"));
		roots.push(root);
		const workDir = join(root, "work");
		const runDir = join(root, "run");
		mkdirSync(workDir, { recursive: true });
		mkdirSync(runDir, { recursive: true });
		const chartPath = join(workDir, "chart.mjs");
		writeFileSync(
			chartPath,
			`export default { kind: "chart", id: "dynamic-initial-barrier", initial: "work", states: { work: { kind: "state", action: { kind: "agent", name: "worker" }, transitions: { DONE: "done" } }, done: { kind: "final" } } };\n`,
		);
		writeFileSync(
			join(runDir, "log.jsonl"),
			`${[
				{ kind: "branch", op: "create", seqId: 1, branchId: "main", headSeqId: null, committedAt: 1 },
				{ kind: "branch", op: "create", seqId: 2, branchId: "experiment", headSeqId: null, committedAt: 2 },
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		let releaseInitialGate!: () => void;
		const initialGate = new Promise<void>((resolve) => {
			releaseInitialGate = resolve;
		});
		let initialGateEntered!: () => void;
		const entered = new Promise<void>((resolve) => {
			initialGateEntered = resolve;
		});
		const originalCaptureSnapshot = JsonlLogStore.prototype.captureSnapshot;
		vi.spyOn(JsonlLogStore.prototype, "captureSnapshot").mockImplementation(async function (
			this: JsonlLogStore,
			branchId: string,
		) {
			if (this.branchId === "main") {
				initialGateEntered();
				await initialGate;
			}
			return originalCaptureSnapshot.call(this, branchId);
		});
		const built: string[] = [];
		const executors = new Map<string, ControlledExecutor>();
		const controller = await createHyperchartRunnerController(
			{
				runId: "run",
				storage: fixtureStorage(runDir),
				chartPath,
				chartId: "dynamic-initial-barrier",
				workDir,
				branchId: "main",
			},
			({ config }) => {
				built.push(config.branchId);
				const executor = new ControlledExecutor();
				executors.set(config.branchId, executor);
				return executor;
			},
		);

		const completion = controller.start();
		const experimentOutcome = controller.startBranch("experiment");
		await entered;
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(controller.liveBranchIds).toEqual(["main", "experiment"]);
		expect(built).toEqual([]);

		releaseInitialGate();
		await waitFor(() => executors.get("main")?.emit !== undefined && executors.get("experiment")?.emit !== undefined);
		expect(new Set(built)).toEqual(new Set(["main", "experiment"]));
		executors.get("experiment")?.complete();
		executors.get("main")?.complete();
		expect((await experimentOutcome).outcome).toBe("complete");
		await completion;
	});

	it("finishes every selected replay gate before constructing any executor", async () => {
		const root = mkdtempSync(join(tmpdir(), "hyperchart-multi-gate-"));
		roots.push(root);
		const workDir = join(root, "work");
		const runDir = join(root, "run");
		mkdirSync(workDir, { recursive: true });
		mkdirSync(runDir, { recursive: true });
		const chartPath = join(workDir, "chart.mjs");
		writeFileSync(
			chartPath,
			`export default { kind: "chart", id: "gate", initial: "done", states: { done: { kind: "final" } } };\n`,
		);
		writeFileSync(
			join(runDir, "log.jsonl"),
			`${JSON.stringify({ kind: "branch", op: "create", seqId: 1, branchId: "main", headSeqId: null, committedAt: 1 })}\n`,
		);
		let built = 0;
		await runHyperchartRunner(
			{
				runId: "run",
				storage: fixtureStorage(runDir),
				chartPath,
				chartId: "gate",
				workDir,
				branchIds: ["missing-a", "missing-b"],
			},
			({ config }) => {
				built++;
				return new CompletingExecutor(config.branchId, { active: 0, max: 0 });
			},
		);
		expect(built).toBe(0);
		expect(await withRunStorage(fixtureStorage(runDir), () => readRunStatus(fixtureRunId(runDir)))).toMatchObject({
			state: "failed",
			branchIds: [],
			error: expect.stringMatching(/missing-a[\s\S]*missing-b/),
		});
	});

	it("runs two branch-scoped runtimes concurrently over one incremental journal", async () => {
		const root = mkdtempSync(join(tmpdir(), "hyperchart-multi-runner-"));
		roots.push(root);
		const workDir = join(root, "work");
		const runDir = join(root, "run");
		mkdirSync(workDir, { recursive: true });
		mkdirSync(runDir, { recursive: true });
		const chartPath = join(workDir, "chart.mjs");
		writeFileSync(
			chartPath,
			`export default {
	kind: "chart", id: "parallel", initial: "work",
	states: {
		work: { kind: "state", action: { kind: "agent", name: "worker" }, transitions: { DONE: "done" } },
		done: { kind: "final" }
	}
};\n`,
		);
		writeFileSync(
			join(runDir, "log.jsonl"),
			`${[
				{ kind: "branch", op: "create", seqId: 1, branchId: "main", headSeqId: null, committedAt: 1 },
				{ kind: "branch", op: "create", seqId: 2, branchId: "experiment", headSeqId: null, committedAt: 2 },
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);

		const built: Array<{ branchId: string; executor: CompletingExecutor }> = [];
		const activity = { active: 0, max: 0 };
		await runHyperchartRunner(
			{
				runId: "run",
				storage: fixtureStorage(runDir),
				chartPath,
				chartId: "parallel",
				workDir,
				branchIds: ["main", "experiment"],
			},
			({ config }) => {
				const executor = new CompletingExecutor(config.branchId, activity);
				built.push({ branchId: config.branchId, executor });
				return executor;
			},
		);

		expect(built.map((entry) => entry.branchId)).toEqual(["main", "experiment"]);
		expect(new Set(built.map((entry) => entry.executor)).size).toBe(2);
		expect(activity.max).toBe(2);
		expect(await withRunStorage(fixtureStorage(runDir), () => readRunStatus(fixtureRunId(runDir)))).toMatchObject({
			version: 2,
			state: "complete",
			branchIds: [],
			exitCode: 0,
		});

		const main = new JsonlLogStore(join(runDir, "log.jsonl"), "main");
		expect(storedRecordSeqIds(runDir)).toEqual([3, 4, 5, 6]);
		for (const branchId of ["main", "experiment"]) {
			const ancestry = await collectHistoryRecords(main, branchId);
			expect(ancestry.length).toBeGreaterThan(0);
			expect(ancestry.every((record) => record.branchId === branchId)).toBe(true);
			for (let index = 1; index < ancestry.length; index++) {
				expect(ancestry[index]?.parentId).toBe(ancestry[index - 1]?.seqId);
			}
		}
		expect(main.fullReadCount()).toBe(1);
	});

	it("forks durably without starting and admits a dynamic branch into the live set", async () => {
		const root = mkdtempSync(join(tmpdir(), "hyperchart-dynamic-runner-"));
		roots.push(root);
		const workDir = join(root, "work");
		const runDir = join(root, "run");
		mkdirSync(workDir, { recursive: true });
		mkdirSync(runDir, { recursive: true });
		const chartPath = join(workDir, "chart.mjs");
		writeFileSync(
			chartPath,
			`export default {
	kind: "chart", id: "dynamic", initial: "work",
	states: {
		work: { kind: "state", action: { kind: "agent", name: "worker" }, transitions: { DONE: "done" } },
		done: { kind: "final" }
	}
};\n`,
		);
		writeFileSync(
			join(runDir, "log.jsonl"),
			`${JSON.stringify({ kind: "branch", op: "create", seqId: 1, branchId: "main", headSeqId: null, committedAt: 1 })}\n`,
		);
		const executors = new Map<string, ControlledExecutor>();
		const controller = await createHyperchartRunnerController(
			{
				runId: "run",
				storage: fixtureStorage(runDir),
				chartPath,
				chartId: "dynamic",
				workDir,
				branchId: "main",
			},
			({ config }) => {
				const executor = new ControlledExecutor();
				executors.set(config.branchId, executor);
				return executor;
			},
		);
		const completion = controller.start();
		await waitFor(() => executors.get("main")?.emit !== undefined);
		const store = new JsonlLogStore(join(runDir, "log.jsonl"), "main");
		const mainHead = (await store.getBranch("main")).headSeqId;
		expect(mainHead).not.toBeNull();

		const fork = await controller.forkBranch({ branchId: "experiment", fromSeqId: mainHead!, sourceBranchId: "main" });
		expect(fork.branchId).toBe("experiment");
		expect(executors.has("experiment")).toBe(false);
		expect(controller.liveBranchIds).toEqual(["main"]);
		expect(
			(await withRunStorage(fixtureStorage(runDir), () => readRunStatus(fixtureRunId(runDir))))?.branchIds,
		).toEqual(["main"]);

		const experimentOutcome = controller.startBranch("experiment");
		expect(controller.liveBranchIds).toEqual(["main", "experiment"]);
		expect(
			(await withRunStorage(fixtureStorage(runDir), () => readRunStatus(fixtureRunId(runDir))))?.branchIds,
		).toEqual(["main", "experiment"]);
		await expect(controller.startBranch("experiment")).rejects.toThrow(/already admitted/);
		await waitFor(() => executors.get("experiment")?.emit !== undefined);
		executors.get("experiment")?.complete();
		expect(await experimentOutcome).toMatchObject({ branchId: "experiment", outcome: "complete" });
		expect(
			(await withRunStorage(fixtureStorage(runDir), () => readRunStatus(fixtureRunId(runDir))))?.branchIds,
		).toEqual(["main"]);
		expect(executors.get("experiment")?.disposed).toBe(true);

		executors.get("main")?.complete();
		await completion;
		expect(await withRunStorage(fixtureStorage(runDir), () => readRunStatus(fixtureRunId(runDir)))).toMatchObject({
			state: "complete",
			branchIds: [],
		});
		await expect(controller.forkBranch({ branchId: "late", fromSeqId: mainHead! })).rejects.toThrow(/closed/);
		await expect(controller.startBranch("main")).rejects.toThrow(/closed/);
		const finalReader = new JsonlLogStore(join(runDir, "log.jsonl"), "main");
		expect(storedRecordSeqIds(runDir)).toEqual([2, 4, 5]);
		expect(
			(await collectHistoryRecords(finalReader, "experiment")).every(
				(record) => record.branchId === "main" || record.branchId === "experiment",
			),
		).toBe(true);
	});

	it("stops and drains one live branch while its sibling keeps running", async () => {
		const root = mkdtempSync(join(tmpdir(), "hyperchart-branch-drain-"));
		roots.push(root);
		const workDir = join(root, "work");
		const runDir = join(root, "run");
		mkdirSync(workDir, { recursive: true });
		mkdirSync(runDir, { recursive: true });
		const chartPath = join(workDir, "chart.mjs");
		writeFileSync(
			chartPath,
			`export default { kind: "chart", id: "branch-drain", initial: "work", states: { work: { kind: "state", action: { kind: "agent", name: "worker" }, transitions: { DONE: "done" } }, done: { kind: "final" } } };\n`,
		);
		writeFileSync(
			join(runDir, "log.jsonl"),
			`${JSON.stringify({ kind: "branch", op: "create", seqId: 1, branchId: "main", headSeqId: null, committedAt: 1 })}\n`,
		);
		let releaseExperimentDispose!: () => void;
		const experimentDisposeGate = new Promise<void>((resolve) => {
			releaseExperimentDispose = resolve;
		});
		const executors = new Map<string, ControlledExecutor>();
		const controller = await createHyperchartRunnerController(
			{ runId: "run", storage: fixtureStorage(runDir), chartPath, chartId: "branch-drain", workDir, branchId: "main" },
			({ config }) => {
				const executor = new ControlledExecutor(config.branchId === "experiment" ? experimentDisposeGate : undefined);
				executors.set(config.branchId, executor);
				return executor;
			},
		);
		const completion = controller.start();
		await waitFor(() => executors.get("main")?.emit !== undefined);
		const store = new JsonlLogStore(join(runDir, "log.jsonl"), "main");
		await controller.forkBranch({
			branchId: "experiment",
			fromSeqId: (await store.getBranch("main")).headSeqId!,
			sourceBranchId: "main",
		});
		const experimentOutcome = controller.startBranch("experiment");
		await waitFor(() => executors.get("experiment")?.emit !== undefined);
		const journalSize = () => readFileSync(join(runDir, "log.jsonl"), "utf8").trim().split("\n").length;
		const beforeDrain = journalSize();

		const drain = controller.stopAndDrain("experiment");
		expect(controller.stopAndDrain("experiment")).toBe(drain);
		expect(controller.liveBranchIds).toEqual(["main", "experiment"]);
		executors.get("experiment")?.complete();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(journalSize()).toBe(beforeDrain);

		releaseExperimentDispose();
		expect(await drain).toEqual({ branchId: "experiment", outcome: "drained" });
		expect(await experimentOutcome).toEqual({ branchId: "experiment", outcome: "drained" });
		expect(controller.liveBranchIds).toEqual(["main"]);
		expect(await controller.activeBranchIds()).toEqual(["main"]);
		expect(await withRunStorage(fixtureStorage(runDir), () => readRunStatus(fixtureRunId(runDir)))).toMatchObject({
			state: "running",
			branchIds: ["main"],
		});
		expect(executors.get("experiment")?.disposed).toBe(true);
		expect(() => controller.stopAndDrain("experiment")).toThrow(/not live/);

		executors.get("main")?.complete();
		await completion;
		expect(await withRunStorage(fixtureStorage(runDir), () => readRunStatus(fixtureRunId(runDir)))).toMatchObject({
			state: "complete",
			branchIds: [],
		});
	});

	it("a durable dynamic branch keeps the runner alive during async executor construction", async () => {
		const root = mkdtempSync(join(tmpdir(), "hyperchart-dynamic-reservation-"));
		roots.push(root);
		const workDir = join(root, "work");
		const runDir = join(root, "run");
		mkdirSync(workDir, { recursive: true });
		mkdirSync(runDir, { recursive: true });
		const chartPath = join(workDir, "chart.mjs");
		writeFileSync(
			chartPath,
			`export default { kind: "chart", id: "reserve", initial: "work", states: { work: { kind: "state", action: { kind: "agent", name: "worker" }, transitions: { DONE: "done" } }, done: { kind: "final" } } };\n`,
		);
		writeFileSync(
			join(runDir, "log.jsonl"),
			`${JSON.stringify({ kind: "branch", op: "create", seqId: 1, branchId: "main", headSeqId: null, committedAt: 1 })}\n`,
		);
		const executors = new Map<string, ControlledExecutor>();
		let releaseExperiment!: () => void;
		const experimentBuild = new Promise<void>((resolve) => {
			releaseExperiment = resolve;
		});
		const controller = await createHyperchartRunnerController(
			{ runId: "run", storage: fixtureStorage(runDir), chartPath, chartId: "reserve", workDir, branchId: "main" },
			async ({ config }) => {
				if (config.branchId === "experiment") {
					await experimentBuild;
				}
				const executor = new ControlledExecutor();
				executors.set(config.branchId, executor);
				return executor;
			},
		);
		const completion = controller.start();
		await waitFor(() => executors.get("main")?.emit !== undefined);
		const store = new JsonlLogStore(join(runDir, "log.jsonl"), "main");
		const head = (await store.getBranch("main")).headSeqId!;
		await controller.forkBranch({ branchId: "experiment", fromSeqId: head });
		const experimentOutcome = controller.startBranch("experiment");
		executors.get("main")?.complete();
		await waitFor(
			async () =>
				(await withRunStorage(fixtureStorage(runDir), () => readRunStatus(fixtureRunId(runDir))))?.branchIds.length ===
				1,
		);
		expect(await withRunStorage(fixtureStorage(runDir), () => readRunStatus(fixtureRunId(runDir)))).toMatchObject({
			state: "running",
			branchIds: ["experiment"],
		});
		releaseExperiment();
		await waitFor(() => executors.get("experiment")?.emit !== undefined);
		executors.get("experiment")?.complete();
		expect((await experimentOutcome).outcome).toBe("complete");
		await completion;
		expect(await withRunStorage(fixtureStorage(runDir), () => readRunStatus(fixtureRunId(runDir)))).toMatchObject({
			state: "complete",
			branchIds: [],
		});
	});

	it("admits a branch during delayed last-branch disposal and prevents closure", async () => {
		const root = mkdtempSync(join(tmpdir(), "hyperchart-disposal-admission-"));
		roots.push(root);
		const workDir = join(root, "work");
		const runDir = join(root, "run");
		mkdirSync(workDir, { recursive: true });
		mkdirSync(runDir, { recursive: true });
		const chartPath = join(workDir, "chart.mjs");
		writeFileSync(
			chartPath,
			`export default { kind: "chart", id: "disposal-admission", initial: "work", states: { work: { kind: "state", action: { kind: "agent", name: "worker" }, transitions: { DONE: "done" } }, done: { kind: "final" } } };\n`,
		);
		writeFileSync(
			join(runDir, "log.jsonl"),
			`${JSON.stringify({ kind: "branch", op: "create", seqId: 1, branchId: "main", headSeqId: null, committedAt: 1 })}\n`,
		);
		let releaseDispose!: () => void;
		const disposeGate = new Promise<void>((resolve) => {
			releaseDispose = resolve;
		});
		let disposalStarted!: () => void;
		const startedDisposal = new Promise<void>((resolve) => {
			disposalStarted = resolve;
		});
		const executors = new Map<string, ControlledExecutor>();
		const controller = await createHyperchartRunnerController(
			{
				runId: "run",
				storage: fixtureStorage(runDir),
				chartPath,
				chartId: "disposal-admission",
				workDir,
				branchId: "main",
			},
			({ config }) => {
				const executor =
					config.branchId === "main" ? new ControlledExecutor(disposeGate, disposalStarted) : new ControlledExecutor();
				executors.set(config.branchId, executor);
				return executor;
			},
		);
		const completion = controller.start();
		await waitFor(() => executors.get("main")?.emit !== undefined);
		const reader = new JsonlLogStore(join(runDir, "log.jsonl"), "main");
		await controller.forkBranch({ branchId: "experiment", fromSeqId: (await reader.getBranch("main")).headSeqId! });
		executors.get("main")?.complete();
		await startedDisposal;
		const outcome = controller.startBranch("experiment");
		expect(controller.liveBranchIds).toEqual(["main", "experiment"]);
		releaseDispose();
		await waitFor(() => executors.get("experiment")?.emit !== undefined);
		executors.get("experiment")?.complete();
		expect((await outcome).outcome).toBe("complete");
		await completion;
		expect(await withRunStorage(fixtureStorage(runDir), () => readRunStatus(fixtureRunId(runDir)))).toMatchObject({
			state: "complete",
			branchIds: [],
		});
	});

	it("fails a dynamic replay gate without constructing that branch executor", async () => {
		const root = mkdtempSync(join(tmpdir(), "hyperchart-dynamic-gate-"));
		roots.push(root);
		const workDir = join(root, "work");
		const runDir = join(root, "run");
		mkdirSync(workDir, { recursive: true });
		mkdirSync(runDir, { recursive: true });
		const chartPath = join(workDir, "chart.mjs");
		writeFileSync(
			chartPath,
			`export default { kind: "chart", id: "dynamic-gate", initial: "work", states: { work: { kind: "state", action: { kind: "agent", name: "worker" }, transitions: { DONE: "done" } }, done: { kind: "final" } } };\n`,
		);
		writeFileSync(
			join(runDir, "log.jsonl"),
			`${JSON.stringify({ kind: "branch", op: "create", seqId: 1, branchId: "main", headSeqId: null, committedAt: 1 })}\n`,
		);
		const executors = new Map<string, ControlledExecutor>();
		const controller = await createHyperchartRunnerController(
			{ runId: "run", storage: fixtureStorage(runDir), chartPath, chartId: "dynamic-gate", workDir, branchId: "main" },
			({ config }) => {
				const executor = new ControlledExecutor();
				executors.set(config.branchId, executor);
				return executor;
			},
		);
		const completion = controller.start();
		await waitFor(() => executors.get("main")?.emit !== undefined);
		const reader = new JsonlLogStore(join(runDir, "log.jsonl"), "main");
		await controller.forkBranch({ branchId: "broken", fromSeqId: (await reader.getBranch("main")).headSeqId! });
		const originalCaptureSnapshot = JsonlLogStore.prototype.captureSnapshot;
		const captureSnapshot = vi.spyOn(JsonlLogStore.prototype, "captureSnapshot").mockImplementation(function (
			this: JsonlLogStore,
			branchId: string,
		) {
			return this.branchId === "broken"
				? Promise.reject(new Error("incompatible ancestry"))
				: originalCaptureSnapshot.call(this, branchId);
		});
		const outcome = await controller.startBranch("broken");
		captureSnapshot.mockRestore();
		expect(outcome).toMatchObject({
			branchId: "broken",
			outcome: "failed",
			error: expect.stringMatching(/Replay|replay|stale/),
		});
		expect(executors.has("broken")).toBe(false);
		executors.get("main")?.complete();
		await completion;
		expect(await withRunStorage(fixtureStorage(runDir), () => readRunStatus(fixtureRunId(runDir)))).toMatchObject({
			state: "failed",
			branchIds: [],
		});
	});

	it("keeps status non-terminal until delayed executor disposal finishes", async () => {
		const root = mkdtempSync(join(tmpdir(), "hyperchart-dispose-order-"));
		roots.push(root);
		const workDir = join(root, "work");
		const runDir = join(root, "run");
		mkdirSync(workDir, { recursive: true });
		mkdirSync(runDir, { recursive: true });
		const chartPath = join(workDir, "chart.mjs");
		writeFileSync(
			chartPath,
			`export default {
	kind: "chart", id: "dispose-order", initial: "work",
	states: {
		work: { kind: "state", action: { kind: "agent", name: "worker" }, transitions: { DONE: "done" } },
		done: { kind: "final" }
	}
};\n`,
		);
		writeFileSync(
			join(runDir, "log.jsonl"),
			`${JSON.stringify({ kind: "branch", op: "create", seqId: 1, branchId: "main", headSeqId: null, committedAt: 1 })}\n`,
		);
		let releaseDispose!: () => void;
		const disposeGate = new Promise<void>((resolve) => {
			releaseDispose = resolve;
		});
		let disposalStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			disposalStarted = resolve;
		});
		const running = runHyperchartRunner(
			{
				runId: "run",
				storage: fixtureStorage(runDir),
				chartPath,
				chartId: "dispose-order",
				workDir,
				branchId: "main",
			},
			({ config }) =>
				new CompletingExecutor(config.branchId, { active: 0, max: 0 }, false, disposeGate, disposalStarted),
		);
		await started;
		expect((await withRunStorage(fixtureStorage(runDir), () => readRunStatus(fixtureRunId(runDir))))?.state).toBe(
			"running",
		);
		releaseDispose();
		await running;
		expect((await withRunStorage(fixtureStorage(runDir), () => readRunStatus(fixtureRunId(runDir))))?.state).toBe(
			"complete",
		);
	});

	it("isolates sibling authored paths and materializes each workspace before its first action", async () => {
		const root = mkdtempSync(join(tmpdir(), "hyperchart-branch-workspaces-"));
		roots.push(root);
		const workDir = join(root, "work");
		const runDir = join(root, "run");
		mkdirSync(workDir, { recursive: true });
		mkdirSync(runDir, { recursive: true });
		const chartPath = join(workDir, "chart.ts");
		writeFileSync(
			chartPath,
			`import { agent, artifact, artifactOf, chart, final, t } from "@surprisal/hyperchart";
export default chart({ kind: "chart", id: "workspace-isolation", initial: "write", states: {
  write: { kind: "state", action: agent("writer", { artifacts: { output: artifact(t\`shared.txt\`) } }), transitions: { DONE: "read" } },
  read: { kind: "state", action: agent("reader", { reads: [artifactOf("write")] }), transitions: { DONE: "done" } },
  done: final()
} });\n`,
		);
		writeFileSync(
			join(runDir, "log.jsonl"),
			`${[
				{ kind: "branch", op: "create", seqId: 1, branchId: "left", headSeqId: null, committedAt: 1 },
				{ kind: "branch", op: "create", seqId: 2, branchId: "right", headSeqId: null, committedAt: 2 },
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const writerEmits: Array<() => void> = [];
		const observedReads = new Map<string, string>();
		const workspaceByBranch = new Map<string, string>();

		await runHyperchartRunner(
			{
				runId: "run",
				storage: fixtureStorage(runDir),
				chartPath,
				chartId: "workspace-isolation",
				workDir,
				branchIds: ["left", "right"],
			},
			({ config }) => {
				workspaceByBranch.set(config.branchId, config.workDir);
				expect(config.projectDir).toBe(workDir);
				expect(config.workDir).toBe(join(runDir, "workspaces", config.branchId));
				expect(existsSync(config.workDir)).toBe(true);
				return new (class extends ControlledExecutor {
					override start(effect: AgentEffect, emit: (outcome: AgentOutcome) => void): void {
						if (effect.action.name === "writer") {
							writeFileSync(join(config.workDir, "shared.txt"), `${config.branchId} bytes`);
							writerEmits.push(() => emit({ kind: "completed", event: { type: "DONE" } }));
							if (writerEmits.length === 2) {
								for (const done of writerEmits) {
									done();
								}
							}
							return;
						}
						observedReads.set(config.branchId, readFileSync(join(config.workDir, "shared.txt"), "utf8"));
						emit({ kind: "completed", event: { type: "DONE" } });
					}
				})();
			},
		);

		expect(workspaceByBranch.get("left")).not.toBe(workspaceByBranch.get("right"));
		expect(observedReads).toEqual(
			new Map([
				["left", "left bytes"],
				["right", "right bytes"],
			]),
		);
		const finalReader = new JsonlLogStore(join(runDir, "log.jsonl"), "left");
		const pins = await Promise.all(
			["left", "right"].map(async (branchId) =>
				latestArtifactHash(await collectHistoryRecords(finalReader, branchId), "shared.txt"),
			),
		);
		expect(pins.every((pin) => pin !== undefined)).toBe(true);
		expect(new Set(pins).size).toBe(2);
	});

	it("stays accepting while held across an idle gap, then terminates when released", async () => {
		const root = mkdtempSync(join(tmpdir(), "hyperchart-held-idle-"));
		roots.push(root);
		const workDir = join(root, "work");
		const runDir = join(root, "run");
		mkdirSync(workDir, { recursive: true });
		mkdirSync(runDir, { recursive: true });
		const chartPath = join(workDir, "chart.mjs");
		writeFileSync(
			chartPath,
			`export default { kind: "chart", id: "held-idle", initial: "work", states: { work: { kind: "state", action: { kind: "agent", name: "worker" }, transitions: { DONE: "done" } }, done: { kind: "final" } } };\n`,
		);
		writeFileSync(
			join(runDir, "log.jsonl"),
			`${JSON.stringify({ kind: "branch", op: "create", seqId: 1, branchId: "main", headSeqId: null, committedAt: 1 })}\n`,
		);
		const executors = new Map<string, ControlledExecutor>();
		const controller = await createHyperchartRunnerController(
			{ runId: "run", storage: fixtureStorage(runDir), chartPath, chartId: "held-idle", workDir, branchId: "main" },
			({ config }) => {
				const executor = new ControlledExecutor();
				executors.set(config.branchId, executor);
				return executor;
			},
		);
		const hold = controller.acquireHold();
		const completion = controller.start();
		await waitFor(() => executors.get("main")?.emit !== undefined);
		executors.get("main")?.complete();
		await waitFor(() => controller.liveBranchIds.length === 0);
		expect(await withRunStorage(fixtureStorage(runDir), () => readRunStatus(fixtureRunId(runDir)))).toMatchObject({
			state: "running",
			branchIds: [],
		});
		let completed = false;
		void completion.then(() => {
			completed = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(completed).toBe(false);

		const head = (await new JsonlLogStore(join(runDir, "log.jsonl"), "main").getBranch("main")).headSeqId!;
		await controller.forkBranch({ branchId: "wave-two", fromSeqId: head - 1, sourceBranchId: "main" });
		const outcome = controller.startBranch("wave-two");
		await waitFor(() => executors.get("wave-two")?.emit !== undefined);
		executors.get("wave-two")?.complete();
		expect((await outcome).outcome).toBe("complete");
		await waitFor(() => controller.liveBranchIds.length === 0);
		hold.release();
		await completion;
		expect(await withRunStorage(fixtureStorage(runDir), () => readRunStatus(fixtureRunId(runDir)))).toMatchObject({
			state: "complete",
			branchIds: [],
			exitCode: 0,
		});
	});

	it("readmits a settled failed branch through startBranch and journal replay", async () => {
		const root = mkdtempSync(join(tmpdir(), "hyperchart-retry-admission-"));
		roots.push(root);
		const workDir = join(root, "work");
		const runDir = join(root, "run");
		mkdirSync(workDir, { recursive: true });
		mkdirSync(runDir, { recursive: true });
		const chartPath = join(workDir, "chart.mjs");
		writeFileSync(
			chartPath,
			`export default { kind: "chart", id: "retry-admission", initial: "work", states: { work: { kind: "state", action: { kind: "agent", name: "worker" }, transitions: { DONE: "done" } }, done: { kind: "final" } } };\n`,
		);
		writeFileSync(
			join(runDir, "log.jsonl"),
			`${JSON.stringify({ kind: "branch", op: "create", seqId: 1, branchId: "main", headSeqId: null, committedAt: 1 })}\n`,
		);
		let failOnce = true;
		const executors = new Map<string, ControlledExecutor>();
		const controller = await createHyperchartRunnerController(
			{
				runId: "run",
				storage: fixtureStorage(runDir),
				chartPath,
				chartId: "retry-admission",
				workDir,
				branchId: "main",
			},
			({ config }) => {
				if (config.branchId === "retry" && failOnce) {
					failOnce = false;
					throw new Error("temporary artifact unavailable");
				}
				const executor = new ControlledExecutor();
				executors.set(config.branchId, executor);
				return executor;
			},
		);
		const hold = controller.acquireHold();
		const completion = controller.start();
		await waitFor(() => executors.get("main")?.emit !== undefined);
		executors.get("main")?.complete();
		await waitFor(() => controller.liveBranchIds.length === 0);
		const head = (await new JsonlLogStore(join(runDir, "log.jsonl"), "main").getBranch("main")).headSeqId!;
		await controller.forkBranch({ branchId: "retry", fromSeqId: head - 1, sourceBranchId: "main" });
		const failed = await controller.startBranch("retry");
		expect(failed).toMatchObject({ outcome: "failed", error: "temporary artifact unavailable" });
		expect(controller.canStartBranch("retry")).toBe(true);
		const resumed = controller.startBranch("retry");
		await waitFor(() => executors.get("retry")?.emit !== undefined);
		executors.get("retry")?.complete();
		expect((await resumed).outcome).toBe("complete");
		hold.release();
		await completion;
	});

	it("signal shutdown closes a held controller", async () => {
		const root = mkdtempSync(join(tmpdir(), "hyperchart-held-signal-"));
		roots.push(root);
		const workDir = join(root, "work");
		const runDir = join(root, "run");
		mkdirSync(workDir, { recursive: true });
		mkdirSync(runDir, { recursive: true });
		const chartPath = join(workDir, "chart.mjs");
		writeFileSync(
			chartPath,
			`export default { kind: "chart", id: "held-signal", initial: "work", states: { work: { kind: "state", action: { kind: "agent", name: "worker" }, transitions: { DONE: "done" } }, done: { kind: "final" } } };\n`,
		);
		writeFileSync(
			join(runDir, "log.jsonl"),
			`${JSON.stringify({ kind: "branch", op: "create", seqId: 1, branchId: "main", headSeqId: null, committedAt: 1 })}\n`,
		);
		const executor = new ControlledExecutor();
		const controller = await createHyperchartRunnerController(
			{ runId: "run", storage: fixtureStorage(runDir), chartPath, chartId: "held-signal", workDir, branchId: "main" },
			() => executor,
		);
		controller.acquireHold();
		const completion = controller.start();
		await waitFor(() => executor.emit !== undefined);

		await closeWithoutExiting(controller, "SIGINT");
		await completion;

		expect(executor.disposed).toBe(true);
		expect(await withRunStorage(fixtureStorage(runDir), () => readRunStatus(fixtureRunId(runDir)))).toMatchObject({
			state: "stopped",
			branchIds: [],
			exitCode: 130,
		});
	});

	it("waits for every branch and fails the aggregate status when one branch fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "hyperchart-multi-failure-"));
		roots.push(root);
		const workDir = join(root, "work");
		const runDir = join(root, "run");
		mkdirSync(workDir, { recursive: true });
		mkdirSync(runDir, { recursive: true });
		const chartPath = join(workDir, "chart.mjs");
		writeFileSync(
			chartPath,
			`export default {
	kind: "chart", id: "aggregate", initial: "work",
	states: {
		work: { kind: "state", action: { kind: "agent", name: "worker" }, transitions: { DONE: "done" } },
		done: { kind: "final" }
	}
};\n`,
		);
		writeFileSync(
			join(runDir, "log.jsonl"),
			`${[
				{ kind: "branch", op: "create", seqId: 1, branchId: "main", headSeqId: null, committedAt: 1 },
				{ kind: "branch", op: "create", seqId: 2, branchId: "experiment", headSeqId: null, committedAt: 2 },
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const activity = { active: 0, max: 0 };
		await runHyperchartRunner(
			{
				runId: "run",
				storage: fixtureStorage(runDir),
				chartPath,
				chartId: "aggregate",
				workDir,
				branchIds: ["main", "experiment"],
			},
			({ config }) => new CompletingExecutor(config.branchId, activity, config.branchId === "experiment"),
		);
		expect(activity).toMatchObject({ active: 0, max: 2 });
		expect(await withRunStorage(fixtureStorage(runDir), () => readRunStatus(fixtureRunId(runDir)))).toMatchObject({
			state: "failed",
			branchIds: [],
			exitCode: 1,
			error: expect.any(String),
		});
	});
});

/** Explicit storage configuration for this suite's generated literal-layout fixtures. */
function fixtureStorage(runDirectory: string): RunStorage {
	return { kind: "jsonl", rootDir: fixtureRoot(runDirectory), layout: "run-id" };
}
