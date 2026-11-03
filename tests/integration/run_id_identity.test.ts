import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	initializeRun,
	listRunIds,
	loadRunMeta,
	saveRunMeta,
} from "../../packages/hyperchart/src/runtime/generic/run_dir.js";
import { openRunLogStore } from "../../packages/hyperchart/src/runtime/generic/log_store_factory.js";
import {
	resolveRunPaths,
	withRunStorage,
	type RunStorage,
} from "../../packages/hyperchart/src/runtime/generic/run_paths.js";
import { createRunInspectorDataSource } from "../../packages/hyperchart/src/inspect/run_history.js";
import { hyperchartRunFromRunId } from "../../packages/hyperchart/src/inspect/run_inspect.js";
import { forkHyperchartRun } from "../../packages/hyperchart/src/runner/branches.js";
import { rewindHyperchartRun } from "../../packages/hyperchart/src/runner/rewind.js";
import { createHyperchartRunnerController } from "../../packages/hyperchart/src/runner/runner_main.js";
import {
	requestLiveRunnerBranchMove,
	requestLiveRunnerUserResponse,
} from "../../packages/hyperchart/src/runtime/generic/runner_control.js";
import { readRunStatus } from "../../packages/hyperchart/src/runtime/generic/run_status.js";
import { scanOpenUserInteractions } from "../../packages/hyperchart/src/runner/user_interactions.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
	process.exitCode = 0;
});
function fixture(layout: RunStorage["layout"] = "sha256") {
	const root = mkdtempSync(join(tmpdir(), "hyperchart-run-id-"));
	roots.push(root);
	const storage: RunStorage = { kind: "jsonl", rootDir: join(root, "runs"), layout };
	const chartPath = join(root, "chart.ts");
	writeFileSync(
		chartPath,
		`import { chart, agent, user, final } from "@surprisal/hyperchart";
 export default chart({ kind:"chart", id:"identity", initial:"ask", states:{
 ask:{kind:"state", action:user({prompt:"Choose",options:["GO"]}),transitions:{GO:"work"}},
 work:{kind:"state", action:agent("waiting"),transitions:{DONE:"done"}}, done:final() }});`,
	);
	const runId = "autodiscovery:semantic-id";
	return { root, storage, chartPath, runId };
}
async function seed(f: ReturnType<typeof fixture>) {
	await initializeRun(f.runId);
	await saveRunMeta(f.runId, {
		chartId: "identity",
		chartPath: f.chartPath,
		workDir: f.root,
		createdAt: new Date().toISOString(),
	});
}

describe("runId storage identity", () => {
	it.each([
		"run-id",
		"sha256",
	] as const)("addresses metadata and deferred history in declared %s layout", async (layout) => {
		const f = fixture(layout);
		const source = await withRunStorage(f.storage, async () => {
			await seed(f);
			expect((await loadRunMeta(f.runId)).runId).toBe(f.runId);
			expect(await listRunIds()).toEqual([f.runId]);
			expect((await hyperchartRunFromRunId(f.runId)).runId).toBe(f.runId);
			return createRunInspectorDataSource(f.runId);
		});
		const foreign = fixture(layout);
		await withRunStorage(foreign.storage, async () => {
			expect((await source.listBranches({ runId: f.runId })).items[0]?.branchId).toBe("main");
			await expect(loadRunMeta(f.runId)).rejects.toMatchObject({ code: "ENOENT" });
		});
		await expect(source.listBranches({ runId: "wrong-id" })).rejects.toThrow("bound to run");
		expect(basename(resolveRunPaths(f.runId, f.storage).runDir)).toEqual(
			layout === "run-id" ? f.runId : expect.stringMatching(/^[a-f0-9]{64}$/),
		);
	});
	it("preserves old literal metadata bytes without adding a required serialized identity", async () => {
		const f = fixture("run-id");
		const { runDir } = resolveRunPaths(f.runId, f.storage);
		mkdirSync(runDir, { recursive: true });
		const bytes = JSON.stringify({
			chartId: "identity",
			chartPath: f.chartPath,
			workDir: f.root,
			createdAt: "2026-01-01",
		});
		writeFileSync(join(runDir, "meta.json"), bytes);
		await withRunStorage(f.storage, async () => {
			expect((await loadRunMeta(f.runId)).runId).toBe(f.runId);
			expect(await listRunIds()).toEqual([f.runId]);
		});
		expect(readFileSync(join(runDir, "meta.json"), "utf8")).toBe(bytes);
	});
	it("rejects literal path selectors and symlink escapes rather than inferring an ID", () => {
		const f = fixture("run-id");
		for (const id of ["../outside", "/tmp/run", "a/b", "a\\b", "..", ""]) {
			expect(() => resolveRunPaths(id, f.storage)).toThrow();
		}
		mkdirSync(f.storage.rootDir);
		symlinkSync(f.root, join(f.storage.rootDir, "escape"));
		expect(() => resolveRunPaths("escape", f.storage)).toThrow("escapes");
	});
	it("uses semantic ID through live control, drain/readmission, fork, rewind and ownership", async () => {
		const f = fixture();
		let starts = 0;
		await withRunStorage(f.storage, async () => {
			await seed(f);
			const controller = await createHyperchartRunnerController(
				{
					runId: f.runId,
					storage: f.storage,
					chartId: "identity",
					chartPath: f.chartPath,
					workDir: f.root,
					branchId: "main",
					attemptId: "identity-attempt",
				},
				() => ({
					start() {
						starts++;
					},
					async cancel() {},
					async dispose() {},
					async steer() {
						return false;
					},
				}),
			);

			const hold = controller.acquireHold();
			const running = controller.start();
			try {
				await vi.waitFor(async () => expect((await scanOpenUserInteractions(f.runId)).length).toBe(1));
				const gate = (await scanOpenUserInteractions(f.runId))[0]!;
				const response = await requestLiveRunnerUserResponse(f.runId, {
					attemptId: "identity-attempt",
					branchId: "main",
					gateSeqId: gate.seqId,
					event: { type: "GO" },
				});
				await vi.waitFor(() => expect(starts).toBe(1));
				const move = await requestLiveRunnerBranchMove(f.runId, {
					attemptId: "identity-attempt",
					branchId: "main",
					targetHeadSeqId: response.record.seqId,
				});
				expect(move.moveSeqId).toBeGreaterThan(response.record.seqId);
				expect(controller.liveBranchIds).not.toContain("main");
				expect(controller.canStartBranch("main")).toBe(true);
				const restart = controller.startBranch("main");
				await vi.waitFor(() => expect(starts).toBe(2));
				expect((await readRunStatus(f.runId))?.runId).toBe(f.runId);
				await controller.stop();
				await restart;
				await expect(
					forkHyperchartRun({ runId: f.runId, branchId: "foreign", fromSeqId: response.record.seqId, cwd: tmpdir() }),
				).rejects.toThrow("belongs to");
				const fork = await forkHyperchartRun({
					runId: f.runId,
					branchId: "fork",
					fromSeqId: response.record.seqId,
					cwd: f.root,
				});
				expect(fork.runId).toBe(f.runId);
				expect(fork).not.toHaveProperty("runDir");
				const rewound = await rewindHyperchartRun({
					runId: f.runId,
					branchId: "fork",
					seqId: gate.seqId,
					mode: "after",
					cwd: f.root,
				});
				expect(rewound.runId).toBe(f.runId);
				expect(rewound).not.toHaveProperty("runDir");
			} finally {
				await controller.stop();
				hold.release();
				await running;
			}
		});
	});
});
