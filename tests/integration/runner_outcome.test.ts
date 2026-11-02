import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChartEvent } from "../../packages/hyperchart/src/core/types.js";
import { createHyperchartRunnerController } from "../../packages/hyperchart/src/runner/runner_main.js";
import { initializeRun } from "../../packages/hyperchart/src/runtime/generic/run_dir.js";
import { type RunStorage, withRunStorage } from "../../packages/hyperchart/src/runtime/generic/run_paths.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
	process.exitCode = 0;
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "hyperchart-runner-outcome-"));
	roots.push(root);
	const storage: RunStorage = { kind: "jsonl", rootDir: join(root, "runs"), layout: "sha256" };
	const chartPath = join(root, "chart.ts");
	writeFileSync(
		chartPath,
		`import { chart, agent, final } from "@surprisal/hyperchart";
 export default chart({ kind:"chart", id:"outcome", initial:"work", states:{
 work:{kind:"state", action:agent("worker"),transitions:{DONE:"done"}}, done:final() }});`,
	);
	return { root, storage, chartPath, runId: "outcome:run" };
}

/** Starts a controller of the fixture run whose agent answers with `answer`; counts agent starts. */
async function run(f: ReturnType<typeof fixture>, answer: () => ChartEvent | Error) {
	let starts = 0;
	const controller = await createHyperchartRunnerController(
		{
			runId: f.runId,
			storage: f.storage,
			chartId: "outcome",
			chartPath: f.chartPath,
			workDir: f.root,
			branchId: "main",
		},
		() => ({
			start(_effect, emit) {
				starts++;
				const event = answer();
				emit(
					event instanceof Error
						? { kind: "failed", failure: { kind: "runtime", retryable: false, message: event.message } }
						: { kind: "completed", event },
				);
			},
			async cancel() {},
			async dispose() {},
			async steer() {
				return false;
			},
		}),
	);
	const outcome = await controller.start();
	return { outcome, starts };
}

describe("runner controller outcome", () => {
	it("resolves start with the terminal state and the accepted results of each branch", async () => {
		const f = fixture();
		await withRunStorage(f.storage, () => initializeRun(f.runId));
		const { outcome, starts } = await run(f, () => ({ type: "DONE", output: { answer: 42 } }));
		expect(starts).toBe(1);
		expect(outcome).toEqual({
			state: "complete",
			branches: [{ branchId: "main", outcome: "complete", results: { work: { answer: 42 } } }],
		});
	});

	it("answers a finished run again from its journal without starting agents", async () => {
		const f = fixture();
		await withRunStorage(f.storage, () => initializeRun(f.runId));
		await run(f, () => ({ type: "DONE", output: { answer: 42 } }));
		const again = await run(f, () => new Error("not expected to run"));
		expect(again.starts).toBe(0);
		expect(again.outcome).toEqual({
			state: "complete",
			branches: [{ branchId: "main", outcome: "complete", results: { work: { answer: 42 } } }],
		});
	});

	it("resolves a failed run as failed, again without starting agents", async () => {
		const f = fixture();
		await withRunStorage(f.storage, () => initializeRun(f.runId));
		const failed = await run(f, () => new Error("provider unavailable"));
		expect(failed.outcome.state).toBe("failed");
		expect(failed.outcome.error).toContain("provider unavailable");
		const again = await run(f, () => ({ type: "DONE", output: {} }));
		expect(again.starts).toBe(0);
		expect(again.outcome.state).toBe("failed");
	});
});
