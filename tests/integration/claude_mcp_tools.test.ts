import {
	withRunStorage,
	resolveRunPaths,
	type RunStorage,
} from "../../packages/hyperchart/src/runtime/generic/run_paths.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { JsonlLogStore } from "../../packages/hyperchart/src/runtime/generic/log_store.js";
import { loadRunMeta, saveRunMeta } from "../../packages/hyperchart/src/runtime/generic/run_dir.js";
import {
	hasTerminalNotificationReceipt,
	readTerminalNotificationRequest,
} from "../../packages/hyperchart/src/runtime/generic/terminal_notifications.js";
import { patchRunStatus } from "../../packages/hyperchart/src/runtime/generic/run_status.js";
import {
	hasUserInteractionReceipt,
	markUserInteractionReceipt,
	readUserInteractionResponse,
} from "../../packages/hyperchart/src/runner/user_interactions.js";
import { actionUidKey, updateSessionProgress } from "../../packages/hyperchart/src/runtime/generic/session_progress.js";
import { closeRunInspectorServer } from "../../packages/hyperchart/src/inspect/inspector_server.js";
import { createHyperchartMcpTools, type HyperchartMcpTool } from "../../packages/claude-hyperchart/src/mcp/tools.js";
import type { ReplySchemaSummary } from "../../packages/hyperchart/src/host/summarize.js";
import { answerFromReplySummary } from "../reply_summary_helpers.js";

const roots: string[] = [];
let previousClaudeConfigDir: string | undefined;

beforeEach(() => {
	// Inspector overrides exported by the developer's shell must not leak into tests.
	delete process.env.HYPERCHART_INSPECTOR_PORT;
	delete process.env.HYPERCHART_INSPECTOR_HOST;
	delete process.env.SSH_CONNECTION;
	previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
});

afterEach(async () => {
	if (previousClaudeConfigDir === undefined) {
		delete process.env.CLAUDE_CONFIG_DIR;
	} else {
		process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
	}
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
	await closeRunInspectorServer();
});

function makeWorld(sessionId?: string): {
	cwd: string;
	runsRoot: string;
	storage: RunStorage;
	tools: Map<string, HyperchartMcpTool>;
	chartPath: string;
	chartsDir: string;
	userChartsDir: string;
} {
	const root = mkdtempSync(join(tmpdir(), "claude-mcp-"));
	roots.push(root);
	// User-scope settings must come from the test world, not the developer's ~/.claude.
	process.env.CLAUDE_CONFIG_DIR = join(root, "claude-config");
	const userChartsDir = join(root, "claude-config", "hypercharts");
	const cwd = join(root, "project");
	const chartsDir = join(cwd, ".claude", "hypercharts");
	mkdirSync(chartsDir, { recursive: true });
	const runsRoot = join(root, "runs-root");
	const storage: RunStorage = { kind: "jsonl", rootDir: runsRoot, layout: "run-id" };
	const chartPath = join(chartsDir, "simple.chart.ts");
	writeFileSync(
		chartPath,
		`import { chart, final } from "@surprisal/hyperchart";
export default chart({ kind: "chart", id: "simple", initial: "done", states: { done: final() } });
`,
	);
	const tools = new Map(
		createHyperchartMcpTools({
			cwd,
			runsRoot,
			storage,
			...(sessionId === undefined ? {} : { sessionId }),
			openBrowser: () => undefined,
		}).map((tool) => [tool.name, tool]),
	);
	return { cwd, runsRoot, storage, tools, chartPath, chartsDir, userChartsDir };
}

function text(result: { content: Array<{ text: string }> }): string {
	return result.content[0]?.text ?? "";
}

function largeRepresentableGateSchema(): Record<string, unknown> {
	return {
		type: "object",
		properties: Object.fromEntries(
			Array.from({ length: 20 }, (_, index) => [`field${index}`, { type: "string", pattern: "a".repeat(250) }]),
		),
		required: Array.from({ length: 20 }, (_, index) => `field${index}`),
		additionalProperties: false,
	};
}

function complexGateSchema(): Record<string, unknown> {
	return z.toJSONSchema(
		z.object({
			decision: z.enum(["approve", "reject"]),
			review: z.object({
				note: z
					.string()
					.min(3)
					.max(12)
					.regex(/^[a-z]+$/),
				priority: z.number().int().min(1).max(5).default(2),
				optionalNote: z.string().optional(),
			}),
			findings: z
				.array(
					z.object({
						kind: z.literal("finding"),
						value: z.union([z.literal("ok"), z.number().int().min(1)]),
					}),
				)
				.min(1)
				.max(2),
		}),
	);
}

describe("hyperchart MCP tools", () => {
	it("pages more than 100 branches through the MCP cursor contract", async () => {
		const { storage, cwd, runsRoot, tools, chartPath } = makeWorld();
		const runId = "paged-branches";
		const runDir = resolveRunPaths(runId, storage).runDir;
		await withRunStorage(storage, () =>
			saveRunMeta(runId, { chartPath, workDir: cwd, chartId: "simple", createdAt: new Date().toISOString() }),
		);
		const store = new JsonlLogStore(join(runDir, "log.jsonl"));
		await store.initializeRootBranch();
		const [root] = await store.appendDrafts([{ type: "args", args: {} }]);
		for (let index = 0; index < 105; index++) {
			await store.createBranch(`branch-${index.toString().padStart(3, "0")}`, root!.seqId);
		}
		const firstResult = await tools.get("hyperchart_branches")!.handler({ runId, cwd });
		const first = JSON.parse(text(firstResult)) as {
			branches: Array<{ branchId: string }>;
			totalCount: number;
			next?: string;
		};
		expect(first.branches).toHaveLength(100);
		expect(first.totalCount).toBe(106);
		expect(first.next).toBeTypeOf("string");
		const secondResult = await tools.get("hyperchart_branches")!.handler({ runId, cwd, cursor: first.next });
		const second = JSON.parse(text(secondResult)) as {
			branches: Array<{ branchId: string }>;
			totalCount: number;
			next?: string;
		};
		expect(second.branches).toHaveLength(6);
		expect(second.totalCount).toBe(106);
		expect(second.next).toBeUndefined();
		expect(new Set([...first.branches, ...second.branches].map((branch) => branch.branchId)).size).toBe(106);
	});

	it("registers the full tool surface", () => {
		const { storage, tools } = makeWorld();
		expect([...tools.keys()].sort()).toEqual([
			"hyperchart_branches",
			"hyperchart_fork",
			"hyperchart_inspect",
			"hyperchart_list",
			"hyperchart_respond",
			"hyperchart_rewind",
			"hyperchart_run",
			"hyperchart_run_inspect",
			"hyperchart_steer",
			"hyperchart_stop",
			"hyperchart_view",
		]);
	});

	it("always returns compact inspect digests and rejects the former verbose escape hatch", async () => {
		const { storage, tools } = makeWorld();
		const digest = JSON.parse(text(await tools.get("hyperchart_inspect")!.handler({ chartPath: "simple" })));
		expect(digest.chartId).toBe("simple");
		expect(digest.definitionSource).toBeUndefined();
		expect(digest.stateDigests.every((state: object) => !("definitionSource" in state))).toBe(true);

		const verbose = await tools.get("hyperchart_inspect")!.handler({ chartPath: "simple", verbose: true });
		expect(verbose.isError).toBe(true);
		expect(text(verbose)).toContain("hyperchart_view");

		const run = JSON.parse(
			text(await tools.get("hyperchart_run")!.handler({ branchId: "main", chartPath: "simple", wait: true })),
		);
		expect(run).not.toHaveProperty("inspector");
		expect(run).not.toHaveProperty("notification");
		const runDigest = JSON.parse(
			text(await tools.get("hyperchart_run_inspect")!.handler({ branchId: "main", runId: run.runId })),
		);
		expect(runDigest.runId).toBe(run.runId);
		expect(runDigest.status).toBe("completed");
		expect(runDigest.stateDigests.every((state: object) => !("definitionSource" in state))).toBe(true);
	}, 30_000);

	it("requires fresh runs to select exactly main", async () => {
		const { storage, tools } = makeWorld();
		for (const selector of [{ branchId: "experiment" }, { branchIds: ["main", "experiment"] }]) {
			const result = await tools.get("hyperchart_run")!.handler({ chartPath: "simple", ...selector });
			expect(result.isError).toBe(true);
			expect(text(result)).toMatch(/fresh run must select exactly branch 'main'.*fork durable branches.*resume/i);
		}
	});

	it("returns only bounded startup coordinates for wait=false", async () => {
		const { storage, tools } = makeWorld();
		const started = JSON.parse(
			text(await tools.get("hyperchart_run")!.handler({ branchId: "main", chartPath: "simple", wait: false })),
		);
		expect(started).toMatchObject({ chartId: "simple", runId: expect.any(String) });
		expect(started).not.toHaveProperty("runDir");
		expect(started).not.toHaveProperty("inspector");
		expect(started).not.toHaveProperty("states");
		expect(started).not.toHaveProperty("messages");
		await tools.get("hyperchart_run")!.handler({ branchId: "main", runId: started.runId, wait: true });
	}, 30_000);

	it("never loads transcripts into run inspection tool responses", async () => {
		const { storage, tools, runsRoot, cwd, chartPath } = makeWorld();
		const runId = "verbose-run";
		const runDir = resolveRunPaths(runId, storage).runDir;
		const sessionsDir = join(runDir, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		await withRunStorage(storage, () =>
			saveRunMeta(runId, { chartPath, workDir: cwd, chartId: "simple", createdAt: new Date().toISOString() }),
		);
		const actionUid = { chart: "simple", state: "done", action: "agent" };
		const transcriptFile = join(sessionsDir, "verbose.jsonl");
		writeFileSync(
			transcriptFile,
			[
				JSON.stringify({ hyperchartTranscript: 1, sessionId: "verbose-session", createdAt: 1 }),
				JSON.stringify({ id: "assistant-1", role: "assistant", text: "verbose transcript" }),
			].join("\n") + "\n",
		);
		updateSessionProgress(
			sessionsDir,
			actionUid,
			{
				actionName: "worker",
				status: "completed",
				sessionId: "session-id",
				sessionFile: transcriptFile,
			},
			"simple:done:agent:1:2",
		);

		const compact = JSON.parse(
			text(await tools.get("hyperchart_run_inspect")!.handler({ branchId: "main", runId: "verbose-run" })),
		);
		const rejected = await tools
			.get("hyperchart_run_inspect")!
			.handler({ branchId: "main", runId: "verbose-run", verbose: true });
		expect(JSON.stringify(compact)).not.toContain("verbose transcript");
		expect(rejected.isError).toBe(true);
		expect(text(rejected)).toContain("hyperchart_view");
	});

	it("owns runs by the injected session and leases wait delivery without pre-confirming", async () => {
		const { storage, tools, runsRoot, cwd } = makeWorld("session-a");
		const first = await tools.get("hyperchart_run")!.handler({ branchId: "main", chartPath: "simple", wait: true });
		expect(JSON.parse(text(first))).toMatchObject({ boundary: "terminal", final: true, status: { state: "complete" } });
		const [runId] = readdirSync(runsRoot);
		if (runId === undefined) {
			throw new Error("expected run");
		}
		const runDir = resolveRunPaths(runId, storage).runDir;
		expect((await withRunStorage(storage, () => loadRunMeta(runId))).originSessionId).toBe("session-a");
		expect(withRunStorage(storage, () => hasTerminalNotificationReceipt(runId, "claude", "session-a"))).toBe(false);
		const firstRequestId = withRunStorage(storage, () => readTerminalNotificationRequest(runId))!.requestId;

		const second = JSON.parse(
			text(await tools.get("hyperchart_run")!.handler({ branchId: "main", runId: runId, wait: true })),
		);
		expect(second.deliveryNotice).toContain("terminal boundary");
		expect(withRunStorage(storage, () => readTerminalNotificationRequest(runId))!.requestId).not.toBe(firstRequestId);

		const foreignTools = new Map(
			createHyperchartMcpTools({ cwd, runsRoot, storage, sessionId: "session-b" }).map((tool) => [tool.name, tool]),
		);
		const foreign = JSON.parse(
			text(await foreignTools.get("hyperchart_run")!.handler({ branchId: "main", runId: runId, wait: true })),
		);
		expect(foreign.limitation).toContain("not owned");
		expect(withRunStorage(storage, () => hasTerminalNotificationReceipt(runId, "claude", "session-b"))).toBe(false);
	}, 30_000);

	it("publishes the actual FAILED error before matching failed status", async () => {
		const { storage, tools, chartsDir } = makeWorld();
		writeFileSync(
			join(chartsDir, "failure.chart.ts"),
			`import { chart, failed, script } from "@surprisal/hyperchart";
export default chart({ kind: "chart", id: "failure", initial: "work", states: {
	work: { kind: "state", action: script("node", ["-e", "console.error('specific boom'); process.exit(9)"]), transitions: { ERROR: "failed" } },
	failed: failed(),
} });
`,
		);
		const run = JSON.parse(
			text(await tools.get("hyperchart_run")!.handler({ branchId: "main", chartPath: "failure", wait: true })),
		);
		expect(run.status).toMatchObject({ state: "failed", error: expect.stringContaining("specific boom") });
		const request = withRunStorage(storage, () => readTerminalNotificationRequest(run.runId));
		expect(request?.payload).toMatchObject({ outcome: "failed", error: expect.stringContaining("specific boom") });
		expect(request?.payload.prompt).toContain("specific boom");
	}, 30_000);

	it("marks finals entered through a container's onDone as done", async () => {
		const { storage, tools, chartsDir } = makeWorld();
		writeFileSync(
			join(chartsDir, "pardone.chart.ts"),
			`import { chart, compound, final, parallel, script } from "@surprisal/hyperchart";
const worker = () =>
	compound({
		initial: "step",
		states: {
			step: { kind: "state", action: script("node", ["-e", "process.exit(0)"]), transitions: { DONE: "done" } },
			done: final(),
		},
	});
export default chart({
	kind: "chart",
	id: "pardone",
	initial: "wrap",
	states: {
		wrap: compound({
			initial: "fan",
			states: {
				fan: parallel({ states: { left: worker(), right: worker() }, onDone: "done" }),
				done: final(),
			},
			onDone: "end",
		}),
		end: final(),
	},
});
`,
		);
		const run = JSON.parse(
			text(await tools.get("hyperchart_run")!.handler({ branchId: "main", chartPath: "pardone", wait: true })),
		);
		expect(run.status.state).toBe("complete");
		const digest = JSON.parse(
			text(await tools.get("hyperchart_run_inspect")!.handler({ branchId: "main", runId: run.runId })),
		);
		const statusOf = (id: string) =>
			digest.stateDigests.find((state: { id: string }) => state.id === id)?.status ??
			(digest.pendingStateIds.includes(id) ? "pending" : undefined);
		expect(statusOf("wrap.done")).toBe("done");
		expect(statusOf("wrap")).toBe("done");
		expect(statusOf("wrap.fan")).toBe("done");
	}, 30_000);

	it("discovers charts and host-sectioned settings from the shared .hypercharts dir", async () => {
		const { storage, tools, cwd } = makeWorld();
		const sharedDir = join(cwd, ".hypercharts");
		mkdirSync(sharedDir, { recursive: true });
		writeFileSync(
			join(sharedDir, "common.chart.ts"),
			`import { chart, final } from "@surprisal/hyperchart";
export default chart({ kind: "chart", id: "common", initial: "done", states: { done: final() } });
`,
		);
		writeFileSync(
			join(sharedDir, "settings.json"),
			JSON.stringify({
				pi: { roles: { reviewer: "pi/model" } },
				claude: { roles: { reviewer: "claude-haiku-4-5" }, toolsets: { reading: ["Read"] } },
			}),
		);

		const listed = JSON.parse(text(await tools.get("hyperchart_list")!.handler({})));
		expect(listed.charts).toEqual(
			expect.arrayContaining([
				{ name: "common", scope: "shared", chartPath: join(sharedDir, "common.chart.ts") },
				expect.objectContaining({ name: "simple", scope: "project" }),
			]),
		);

		const run = JSON.parse(
			text(await tools.get("hyperchart_run")!.handler({ branchId: "main", chartPath: "common", wait: true })),
		);
		expect(run.status.state).toBe("complete");
		const config = JSON.parse(
			readFileSync(join(resolveRunPaths(run.runId, storage).runDir, "runner.config.json"), "utf8"),
		);
		expect(config.modelRoles).toEqual({ reviewer: "claude-haiku-4-5" });
		expect(config.toolsets).toEqual({ reading: ["Read"] });
	}, 30_000);

	it("opens a static chart view without a run", async () => {
		const { storage, tools } = makeWorld();
		const viewed = JSON.parse(text(await tools.get("hyperchart_view")!.handler({ chartPath: "simple", open: false })));
		expect(viewed).toEqual({ url: expect.stringContaining("/runs/") });
		const both = await tools.get("hyperchart_view")!.handler({});
		expect(both.isError).toBe(true);
	});

	it("rewinds a completed run and replays it to completion", async () => {
		const { storage, tools, chartsDir } = makeWorld();
		writeFileSync(
			join(chartsDir, "steps.chart.ts"),
			`import { chart, final, script } from "@surprisal/hyperchart";
export default chart({
	kind: "chart",
	id: "steps",
	initial: "work",
	states: {
		work: { kind: "state", action: script("node", ["-e", "process.exit(0)"]), transitions: { DONE: "done" } },
		done: final(),
	},
});
`,
		);
		const run = JSON.parse(
			text(await tools.get("hyperchart_run")!.handler({ branchId: "main", chartPath: "steps", wait: true })),
		);
		expect(run.status.state).toBe("complete");
		const originalRequestId = withRunStorage(storage, () => readTerminalNotificationRequest(run.runId))?.requestId;

		const terminalBefore = readFileSync(
			join(resolveRunPaths(run.runId, storage).runDir, "terminal-notification", "request.json"),
			"utf8",
		);
		const rewindResult = await tools
			.get("hyperchart_rewind")!
			.handler({ branchId: "main", runId: run.runId, state: "work" });
		expect(rewindResult.isError, text(rewindResult)).toBeUndefined();
		const rewound = JSON.parse(text(rewindResult));
		expect(rewound).toMatchObject({ branchId: "main", preservedRecords: expect.any(Number) });
		expect(rewound.previousHeadSeqId).toBeGreaterThan(0);
		expect(rewound.headSeqId).toBeNull();
		expect(
			readFileSync(join(resolveRunPaths(run.runId, storage).runDir, "terminal-notification", "request.json"), "utf8"),
		).toBe(terminalBefore);

		const resumed = JSON.parse(
			text(await tools.get("hyperchart_run")!.handler({ branchId: "main", runId: run.runId, wait: true })),
		);
		expect(resumed.status.state).toBe("complete");
		expect(withRunStorage(storage, () => readTerminalNotificationRequest(run.runId))?.requestId).not.toBe(
			originalRequestId,
		);
	}, 30_000);

	it("lists charts, runs a chart to completion, and inspects the run", async () => {
		const { storage, tools, runsRoot } = makeWorld();
		const listed = JSON.parse(text(await tools.get("hyperchart_list")!.handler({})));
		expect(listed.charts).toEqual([
			{ name: "simple", scope: "project", chartPath: join(listed.projectChartsDir, "simple.chart.ts") },
		]);
		expect(listed.runs).toEqual([]);

		const inspected = JSON.parse(text(await tools.get("hyperchart_inspect")!.handler({ chartPath: "simple" })));
		expect(inspected.chartId).toBe("simple");

		const run = JSON.parse(
			text(await tools.get("hyperchart_run")!.handler({ branchId: "main", chartPath: "simple", wait: true })),
		);
		expect(run.status.state).toBe("complete");
		expect(resolveRunPaths(run.runId, storage).runDir.startsWith(runsRoot)).toBe(true);

		const runInfo = JSON.parse(
			text(await tools.get("hyperchart_run_inspect")!.handler({ branchId: "main", runId: run.runId })),
		);
		expect(runInfo.runId).toBe(run.runId);
		expect(runInfo.stateDigests.some((state: { id: string }) => state.id === "done")).toBe(true);

		const relisted = JSON.parse(text(await tools.get("hyperchart_list")!.handler({})));
		expect(relisted.runs).toHaveLength(1);
	}, 30_000);

	it("lists user-scope charts and lets a same-named project chart win", async () => {
		const { storage, tools, chartsDir, userChartsDir } = makeWorld();
		mkdirSync(join(userChartsDir, "bundle"), { recursive: true });
		writeFileSync(join(userChartsDir, "bundle", "chart.ts"), "export default {};\n");
		writeFileSync(join(userChartsDir, "simple.chart.ts"), "export default {};\n");
		writeFileSync(join(userChartsDir, "settings.json"), "{}");

		const listed = JSON.parse(text(await tools.get("hyperchart_list")!.handler({})));
		expect(listed.userChartsDir).toBe(userChartsDir);
		expect(listed.charts).toEqual([
			{ name: "bundle", scope: "user", chartPath: join(userChartsDir, "bundle", "chart.ts") },
			{ name: "simple", scope: "project", chartPath: join(chartsDir, "simple.chart.ts") },
		]);
	});

	it("rejects multi-branch selection for a fresh chart with fork/resume guidance", async () => {
		const { storage, tools } = makeWorld();
		const result = await tools.get("hyperchart_run")!.handler({
			chartPath: "simple",
			branchIds: ["main", "experiment"],
		});
		expect(result).toMatchObject({ isError: true });
		expect(text(result)).toMatch(/start main, fork durable branches, then resume/);
	});

	it("passes merged model roles and toolsets from settings into the runner config", async () => {
		const { storage, tools, chartsDir, userChartsDir } = makeWorld();
		mkdirSync(userChartsDir, { recursive: true });
		writeFileSync(
			join(userChartsDir, "settings.json"),
			JSON.stringify({ roles: { reviewer: "haiku", scout: "haiku" }, toolsets: { reading: ["Read", "Grep"] } }),
		);
		writeFileSync(
			join(chartsDir, "settings.json"),
			JSON.stringify({ roles: { reviewer: "opus" }, toolsets: { coding: ["Read", "Edit", "Bash"] } }),
		);

		const run = JSON.parse(
			text(await tools.get("hyperchart_run")!.handler({ branchId: "main", chartPath: "simple", wait: true })),
		);
		const config = JSON.parse(
			readFileSync(join(resolveRunPaths(run.runId, storage).runDir, "runner.config.json"), "utf8"),
		);

		expect(config.modelRoles).toEqual({ reviewer: "opus", scout: "haiku" });
		expect(config.toolsets).toEqual({ reading: ["Read", "Grep"], coding: ["Read", "Edit", "Bash"] });
	}, 30_000);

	it("queues steering for a live session and rejects dead sessions", async () => {
		const { storage, tools, runsRoot, cwd, chartPath } = makeWorld();
		const runId = "steer-run";
		const runDir = resolveRunPaths(runId, storage).runDir;
		mkdirSync(join(runDir, "sessions"), { recursive: true });
		await withRunStorage(storage, () =>
			saveRunMeta(runId, { chartPath, workDir: cwd, chartId: "simple", createdAt: new Date().toISOString() }),
		);
		const actionUid = { chart: "simple", state: "work", action: "agent" };
		const actionKey = actionUidKey(actionUid);
		updateSessionProgress(
			join(runDir, "sessions"),
			actionUid,
			{ actionName: "worker", status: "running" },
			`${actionKey}:1:7`,
		);

		const queued = await tools.get("hyperchart_steer")!.handler({
			runId: "steer-run",
			branchId: "main",
			actionKey,
			message: "focus",
		});
		expect(queued.isError).toBeUndefined();
		const queuedFiles = readdirSync(join(runDir, "sessions", "steering"));
		expect(queuedFiles).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(runDir, "sessions", "steering", queuedFiles[0]!), "utf8"))).toMatchObject({
			branchId: "main",
			actionKey,
			invokeSeqId: 7,
			message: "focus",
		});

		updateSessionProgress(join(runDir, "sessions"), actionUid, { status: "completed" }, `${actionKey}:1:7`);
		const rejected = await tools.get("hyperchart_steer")!.handler({
			runId: "steer-run",
			branchId: "main",
			actionKey,
			message: "late",
		});
		expect(rejected.isError).toBe(true);

		updateSessionProgress(join(runDir, "sessions"), actionUid, { status: "running" }, `${actionKey}:2:8`);
		updateSessionProgress(join(runDir, "sessions"), actionUid, { status: "running" }, `${actionKey}:3:9`);
		const ambiguous = await tools.get("hyperchart_steer")!.handler({
			runId: "steer-run",
			branchId: "main",
			actionKey,
			message: "which one",
		});
		expect(ambiguous).toMatchObject({ isError: true });
		expect(text(ambiguous)).toMatch(/ambiguous/);
	});

	it("stops a run that is not live by marking it stopped", async () => {
		const { storage, tools, runsRoot, cwd, chartPath } = makeWorld();
		const runId = "stop-run";
		const runDir = resolveRunPaths(runId, storage).runDir;
		mkdirSync(join(runDir, "sessions"), { recursive: true });
		await withRunStorage(storage, () =>
			saveRunMeta(runId, { chartPath, workDir: cwd, chartId: "simple", createdAt: new Date().toISOString() }),
		);
		await withRunStorage(storage, () => patchRunStatus(runId, { branchIds: ["main"], chartId: "simple", state: "running" }));

		const stopped = JSON.parse(text(await tools.get("hyperchart_stop")!.handler({ runId: "stop-run" })));
		expect(stopped.stopped).toHaveLength(1);
		const status = JSON.parse(readFileSync(join(runDir, "status.json"), "utf8"));
		expect(status.state).toBe("stopped");
	});

	it("opens the browser inspector with overview-only data and loads transcripts on demand", async () => {
		const { storage, tools, runsRoot, cwd, chartPath } = makeWorld();
		const runId = "view-run";
		const runDir = resolveRunPaths(runId, storage).runDir;
		const sessionsDir = join(runDir, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		await withRunStorage(storage, () =>
			saveRunMeta(runId, { chartPath, workDir: cwd, chartId: "simple", createdAt: new Date().toISOString() }),
		);
		writeFileSync(
			chartPath,
			`export default { kind: "chart", id: "simple", initial: "work", states: { work: { kind: "state", action: { kind: "agent", name: "worker" }, transitions: { DONE: "done" } }, done: { kind: "final" } } };`,
		);
		const actionUid = { chart: "simple", state: "work", action: "agent" };
		const store = new JsonlLogStore(join(runDir, "log.jsonl"));
		await store.initializeRootBranch();
		const [invoke] = await store.appendDrafts([
			{
				type: "state_action",
				kind: "invoke",
				sessionId: "session-id",
				actionUid,
				definition: { kind: "agent", uid: actionUid, name: "worker", onFail: { nudge: 2, restart: 1 } },
			},
		]);
		const timestamp = invoke!.timestamp;
		const transcriptFile = join(sessionsDir, "view-run.jsonl");
		writeFileSync(
			transcriptFile,
			[
				JSON.stringify({ hyperchartTranscript: 1, sessionId: "view-session", createdAt: 1 }),
				JSON.stringify({ id: "assistant-1", role: "assistant", text: "inspector transcript", timestamp }),
			].join("\n") + "\n",
		);
		updateSessionProgress(
			sessionsDir,
			actionUid,
			{
				actionName: "worker",
				status: "running",
				sessionId: "session-id",
				sessionFile: transcriptFile,
			},
			`${actionUidKey(actionUid)}:1:${invoke!.seqId}`,
			"main",
		);
		updateSessionProgress(
			sessionsDir,
			actionUid,
			{
				actionName: "worker",
				status: "running",
				sessionId: "experiment-session",
			},
			`${actionUidKey(actionUid)}:1:${invoke!.seqId}`,
			"experiment",
		);

		const viewed = JSON.parse(
			text(await tools.get("hyperchart_view")!.handler({ runId: "view-run", branchId: "main", open: false })),
		);
		expect(viewed.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/runs\/[A-Za-z0-9_-]+$/);
		const response = await fetch(viewed.url.replace("/runs/", "/api/runs/"));
		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			run: {
				runId: string;
				historySnapshot: { branchId: string; headSeqId: number | null };
				states: Array<{ id: string; session?: { messages?: unknown[] } }>;
			};
		};
		expect(payload.run.runId).toBe("view-run");
		expect(payload.run.states.find((state) => state.id === "done")?.session?.messages).toBeUndefined();
		const sessionResponse = await fetch(`${viewed.url.replace("/runs/", "/api/runs/")}/history`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				operation: "readVisitSession",
				input: { snapshot: payload.run.historySnapshot, invokeSeqId: invoke!.seqId },
			}),
		});
		expect(sessionResponse.status).toBe(200);
		const sessionPayload = (await sessionResponse.json()) as { result: { messages?: unknown[] } };
		expect(sessionPayload.result.messages).toEqual([
			{ id: "assistant-1", role: "assistant", text: "inspector transcript", timestamp },
		]);

		// The inspector's steering endpoint must land in the run's file queue.
		const steer = await fetch(`${viewed.url.replace("/runs/", "/api/runs/")}/steer`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ branchId: "experiment", actionKey: actionUidKey(actionUid), message: "from inspector" }),
		});
		expect(steer.status).toBe(202);
		const steeringFiles = readdirSync(join(runDir, "sessions", "steering"));
		expect(steeringFiles).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(runDir, "sessions", "steering", steeringFiles[0]!), "utf8"))).toMatchObject({
			branchId: "experiment",
		});
	});
});

describe("session start hook", () => {
	it("lists only live runs for the hook cwd", () => {
		const root = mkdtempSync(join(tmpdir(), "claude-hook-"));
		roots.push(root);
		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		const runsRoot = join(root, "runs");
		const liveDir = join(runsRoot, "live-run");
		const deadDir = join(runsRoot, "dead-run");
		const foreignDir = join(runsRoot, "foreign-run");
		for (const dir of [liveDir, deadDir, foreignDir]) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(
			join(liveDir, "meta.json"),
			JSON.stringify({
				chartPath: join(cwd, "one.chart.ts"),
				workDir: cwd,
				chartId: "one",
				createdAt: new Date().toISOString(),
				originSessionId: "s1",
			}),
		);
		writeFileSync(
			join(liveDir, "status.json"),
			JSON.stringify({
				version: 2,
				runId: "live-run",
				branchIds: ["main"],
				chartId: "one",
				state: "running",
				pid: process.pid,
				heartbeatAt: Date.now(),
			}),
		);
		writeFileSync(
			join(deadDir, "meta.json"),
			JSON.stringify({
				chartPath: join(cwd, "two.chart.ts"),
				workDir: cwd,
				chartId: "two",
				createdAt: new Date().toISOString(),
				originSessionId: "s1",
			}),
		);
		writeFileSync(
			join(deadDir, "status.json"),
			JSON.stringify({ version: 2, runId: "dead-run", branchIds: [], chartId: "two", state: "complete" }),
		);
		writeFileSync(
			join(foreignDir, "meta.json"),
			JSON.stringify({
				chartPath: join(root, "three.chart.ts"),
				workDir: root,
				chartId: "three",
				createdAt: new Date().toISOString(),
				originSessionId: "s1",
			}),
		);
		writeFileSync(
			join(foreignDir, "status.json"),
			JSON.stringify({
				version: 2,
				runId: "foreign-run",
				branchIds: ["main"],
				chartId: "three",
				state: "running",
				pid: process.pid,
				heartbeatAt: Date.now(),
			}),
		);

		const output = execFileSync(process.execPath, [resolve("packages/claude-hyperchart/hooks/session_start.mjs")], {
			input: JSON.stringify({ cwd, session_id: "s1" }),
			env: { ...process.env, HYPERCHART_RUNS_ROOT: runsRoot },
			encoding: "utf8",
		});
		const parsed = JSON.parse(output) as { hookSpecificOutput: { additionalContext: string } };
		expect(parsed.hookSpecificOutput.additionalContext).toContain("live-run");
		expect(parsed.hookSpecificOutput.additionalContext).not.toContain("dead-run");
		expect(parsed.hookSpecificOutput.additionalContext).not.toContain("foreign-run");
	});
});
