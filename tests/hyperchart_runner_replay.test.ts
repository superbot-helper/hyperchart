import {
	withRunStorage,
	resolveRunPaths,
	type RunStorage,
} from "../packages/hyperchart/src/runtime/generic/run_paths.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, type HyperchartRunnerConfig } from "../packages/pi-hyperchart/src/runtime/pi/hyperchart_runner.js";
import { readRunStatus } from "../packages/hyperchart/src/runtime/generic/run_status.js";

let previousCwd = process.cwd();
let previousExitCode: string | number | null | undefined;
let tempDir = "";

beforeEach(() => {
	previousCwd = process.cwd();
	previousExitCode = process.exitCode;
	process.exitCode = undefined;
	tempDir = mkdtempSync(join(tmpdir(), "hyperchart-runner-replay-"));
});

afterEach(() => {
	process.chdir(previousCwd);
	process.exitCode = previousExitCode;
	rmSync(tempDir, { recursive: true, force: true });
});

describe("hyperchart runner replay warning policy", () => {
	it("fails resume on stale/skipped replay warnings by default", async () => {
		const paths = writeRunFixture({ ignoreReplayWarnings: false });

		await main([paths.configPath]);

		const status = await withRunStorage(paths.storage, () => readRunStatus(paths.runId));
		expect(status).toMatchObject({ state: "failed", exitCode: 1 });
		expect(status?.error).toContain("Replay over the current chart produced warning-level compatibility issues");
		expect(status?.error).toContain("stale provenance");
		expect(process.exitCode).toBe(1);
	});

	it("continues when replay warnings are explicitly ignored", async () => {
		const paths = writeRunFixture({ ignoreReplayWarnings: true });

		await main([paths.configPath]);

		const status = await withRunStorage(paths.storage, () => readRunStatus(paths.runId));
		expect(status).toMatchObject({ state: "complete", exitCode: 0 });
		expect(status?.replayWarnings?.join("\n")).toContain("stale provenance");
		expect(process.exitCode).toBeUndefined();
	});
});

function writeRunFixture(opts: { ignoreReplayWarnings: boolean }): {
	runId: string;
	storage: RunStorage;
	configPath: string;
} {
	const workDir = join(tempDir, "work");
	const agentDir = join(tempDir, "agent");
	const runId = "run";
	const storage: RunStorage = { kind: "jsonl", rootDir: tempDir, layout: "sha256" };
	const runDir = resolveRunPaths(runId, storage).runDir;
	mkdirSync(workDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(runDir, { recursive: true });
	const chartPath = join(workDir, "chart.mjs");
	writeFileSync(
		chartPath,
		`export default {
	kind: "chart",
	id: "demo",
	initial: "work",
	states: {
		work: { kind: "state", action: { kind: "agent", name: "new-worker" }, transitions: { DONE: "done" } },
		done: { kind: "final" }
	}
};
`,
		"utf8",
	);
	const uid = { chart: "demo", state: "work", action: "agent" };
	const records = [
		{ type: "args", args: {}, parentId: null, seqId: 2, branchId: "main", timestamp: 1 },
		{
			type: "state_action",
			kind: "invoke",
			sessionId: "session-id",
			actionUid: uid,
			definition: { kind: "agent", uid, name: "old-worker" },
			parentId: 2,
			seqId: 3,
			branchId: "main",
			timestamp: 2,
		},
		{
			type: "state_action",
			kind: "complete",
			actionUid: uid,
			event: { type: "DONE" },
			parentId: 3,
			seqId: 4,
			branchId: "main",
			timestamp: 3,
		},
	];
	writeFileSync(
		join(runDir, "log.jsonl"),
		[{ kind: "branch", op: "create", seqId: 1, branchId: "main", headSeqId: null, committedAt: 0 }, ...records]
			.map((entry) => JSON.stringify(entry))
			.join("\n") + "\n",
		"utf8",
	);
	const config: HyperchartRunnerConfig = {
		runId: "run",
		branchId: "main",
		storage,
		chartPath,
		chartId: "demo",
		workDir,
		agentDir,
		piModules: { codingAgent: "/unused", typebox: "/unused" },
		...(opts.ignoreReplayWarnings ? { ignoreReplayWarnings: true } : {}),
	};
	const configPath = join(runDir, "runner.config.json");
	writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	// Sanity guard: the config should be readable in failure assertions if a test breaks.
	JSON.parse(readFileSync(configPath, "utf8"));
	return { runId, storage, configPath };
}
