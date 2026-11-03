import {
	withRunStorage,
	resolveRunPaths,
	type RunStorage,
} from "../../packages/hyperchart/src/runtime/generic/run_paths.js";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPackageDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import register from "../../packages/pi-hyperchart/extensions/hyperchart.js";
import {
	HYPERCHART_COMMAND_EVENT,
	requestHyperchartCommand,
	type HyperchartCommandRequest,
} from "../../packages/pi-hyperchart/src/command.js";
import { actionUidDirName, actionUidKey, sanitizeSegment } from "../../packages/hyperchart/src/core/action_uid.js";
import { parseChartModuleSync } from "../../packages/hyperchart/src/core/inspect.js";
import { branchSessionSegment } from "../../packages/hyperchart/src/runtime/generic/executor_helpers.js";
import { JsonlLogStore } from "../../packages/hyperchart/src/runtime/generic/log_store.js";
import { loadRunMeta, saveRunMeta } from "../../packages/hyperchart/src/runtime/generic/run_dir.js";
import {
	hasTerminalNotificationReceipt,
	persistTerminalNotificationRequest,
	removeTerminalNotificationOutbox,
} from "../../packages/hyperchart/src/runtime/generic/terminal_notifications.js";
import { hasUserInteractionReceipt } from "../../packages/hyperchart/src/runner/user_interactions.js";
import { patchRunStatus, readRunStatus } from "../../packages/hyperchart/src/runtime/generic/run_status.js";
import {
	readSessionProgress,
	updateSessionProgress,
} from "../../packages/hyperchart/src/runtime/generic/session_progress.js";
import { closeRunInspectorServer, openRunInspector } from "../../packages/hyperchart/src/inspect/inspector_server.js";

type HyperchartCommand = {
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	getArgumentCompletions: (prefix: string) => AutocompleteItem[] | null;
};
type HyperchartTool = {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: (update: unknown) => void,
		ctx: ExtensionCommandContext,
	) => Promise<{ details?: unknown }>;
};
type Notification = { message: string; type: "info" | "warning" | "error" | undefined };

let previousAgentDir: string | undefined;
let previousHyperchartPgDsn: string | undefined;
let previousCwd = process.cwd();
let tempDir = "";
let agentDir = "";
let projectDir = "";
let otherProjectDir = "";

function testStorage(): RunStorage {
	return { kind: "jsonl", rootDir: join(agentDir, "hypercharts", "runs"), layout: "run-id" };
}

function writeV2Log(runDir: string, records: readonly Record<string, unknown>[]): void {
	writeFileSync(
		join(runDir, "log.jsonl"),
		`${[{ kind: "branch", op: "create", seqId: 1, branchId: "main", headSeqId: null, committedAt: 0 }, ...records]
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`,
	);
}

function writeTwoBranchV2Log(runDir: string): void {
	const uid = { chart: "demo", state: "work", action: "agent" };
	writeFileSync(
		join(runDir, "log.jsonl"),
		`${[
			{ kind: "branch", op: "create", seqId: 1, branchId: "main", headSeqId: null, committedAt: 0 },
			{ type: "args", args: {}, parentId: null, seqId: 2, branchId: "main", timestamp: 1 },
			{
				kind: "branch",
				op: "create",
				seqId: 3,
				branchId: "experiment",
				headSeqId: 2,
				committedAt: 2,
				metadata: { name: "experiment", sourceBranchId: "main", sourceSeqId: 2 },
			},
			{
				type: "state_action",
				kind: "invoke",
				sessionId: "session-id",
				actionUid: uid,
				definition: { kind: "agent", uid, name: "worker" },
				parentId: 2,
				seqId: 4,
				branchId: "experiment",
				timestamp: 2,
			},
			{
				type: "state_action",
				kind: "complete",
				actionUid: uid,
				event: { type: "DONE" },
				parentId: 4,
				seqId: 5,
				branchId: "experiment",
				timestamp: 3,
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`,
	);
}

function writeTwoBranchFinalLog(runDir: string): void {
	writeFileSync(
		join(runDir, "log.jsonl"),
		`${[
			{ kind: "branch", op: "create", seqId: 1, branchId: "main", headSeqId: null, committedAt: 0 },
			{ type: "args", args: {}, parentId: null, seqId: 2, branchId: "main", timestamp: 1 },
			{
				kind: "branch",
				op: "create",
				seqId: 3,
				branchId: "experiment",
				headSeqId: 2,
				committedAt: 2,
				metadata: { name: "experiment", sourceBranchId: "main", sourceSeqId: 2 },
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`,
	);
}

beforeEach(() => {
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	previousHyperchartPgDsn = process.env.HYPERCHART_PG_DSN;
	delete process.env.HYPERCHART_PG_DSN;
	previousCwd = process.cwd();
	tempDir = mkdtempSync(join(tmpdir(), "hyperchart-extension-"));
	agentDir = join(tempDir, "agent");
	projectDir = join(tempDir, "project");
	otherProjectDir = join(tempDir, "other-project");
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(otherProjectDir, { recursive: true });
	projectDir = realpathSync(projectDir);
	otherProjectDir = realpathSync(otherProjectDir);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.chdir(projectDir);
});

afterEach(async () => {
	vi.useRealTimers();
	await closeRunInspectorServer();
	process.chdir(previousCwd);
	if (previousAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
	if (previousHyperchartPgDsn === undefined) {
		delete process.env.HYPERCHART_PG_DSN;
	} else {
		process.env.HYPERCHART_PG_DSN = previousHyperchartPgDsn;
	}
	rmSync(tempDir, { recursive: true, force: true });
});

it("preserves ambient storage while capturing project options", () => {
	process.env.HYPERCHART_PG_DSN = "postgres://inherited.invalid/example";

	registeredToolNames();

	expect(process.env.HYPERCHART_PG_DSN).toBe("postgres://inherited.invalid/example");
});

it("preserves ambient storage when project config loading fails", () => {
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	writeFileSync(join(projectDir, ".pi", "hyperchart.config.ts"), "export default {};\n");
	process.env.HYPERCHART_PG_DSN = "postgres://inherited.invalid/example";

	expect(() => registeredToolNames()).toThrow(/must export transcriptReaderForRun/);
	expect(process.env.HYPERCHART_PG_DSN).toBe("postgres://inherited.invalid/example");
});

it("loads Pi imports in project config from the host extension runtime", () => {
	const fakePackageDir = join(projectDir, "node_modules", "@earendil-works", "pi-coding-agent");
	mkdirSync(fakePackageDir, { recursive: true });
	writeFileSync(
		join(fakePackageDir, "package.json"),
		JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "commonjs", main: "index.cjs" }),
	);
	writeFileSync(join(fakePackageDir, "index.cjs"), 'throw new Error("loaded fake project Pi package");\n');
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	writeFileSync(
		join(projectDir, ".pi", "hyperchart.config.ts"),
		`import { SessionManager } from "@earendil-works/pi-coding-agent";
if (typeof SessionManager !== "function") throw new Error("host SessionManager unavailable");
export default { transcriptReaderForRun: async () => [] };
`,
	);

	expect(() => registeredCommand()).not.toThrow();
});

describe("hyperchart extension", () => {
	it("registers one consolidated hyperchart tool", () => {
		expect(registeredToolNames()).toEqual(["hyperchart"]);
	});

	it("records the originating pi session on a new run", async () => {
		const chartPath = join(tempDir, "session-owned.mjs");
		writeFileSync(
			chartPath,
			`export default { kind: "chart", id: "owned", initial: "done", states: { done: { kind: "final" } } };\n`,
		);
		const result = await registeredTool("hyperchart").execute(
			"tool-call",
			{ action: "run", branchId: "main", chartPath, wait: true },
			new AbortController().signal,
			() => undefined,
			commandContext(projectDir).ctx,
		);
		const details = result.details as { runId: string; inspector?: unknown; notification?: unknown };
		const runId = details.runId;

		expect(details).not.toHaveProperty("runDir");
		expect(details.inspector).toBeUndefined();
		expect(details.notification).toBeUndefined();
		expect((await withRunStorage(testStorage(), () => loadRunMeta(runId))).originSessionId).toBe("session-a");
	});

	it("returns only bounded startup coordinates for wait=false and rejects verbose static inspection", async () => {
		const chartPath = join(tempDir, "bounded-start.mjs");
		writeFileSync(
			chartPath,
			`export default { kind: "chart", id: "bounded-start", initial: "done", states: { done: { kind: "final" } } };\n`,
		);
		const tool = registeredTool("hyperchart");
		const ctx = commandContext(projectDir).ctx;
		const started = await tool.execute(
			"start-bounded",
			{ action: "run", branchId: "main", chartPath, wait: false },
			new AbortController().signal,
			() => undefined,
			ctx,
		);
		const details = started.details as Record<string, unknown> & { runId: string };
		expect(details).toMatchObject({ chartId: "bounded-start", runId: expect.any(String), final: false });
		expect(details).not.toHaveProperty("runDir");
		expect(details).not.toHaveProperty("inspector");
		expect(details).not.toHaveProperty("states");
		await tool.execute(
			"finish-bounded",
			{ action: "run", branchId: "main", runId: details.runId, wait: true },
			new AbortController().signal,
			() => undefined,
			ctx,
		);
		await expect(
			tool.execute(
				"verbose-static",
				{ action: "inspect", chartPath, verbose: true },
				new AbortController().signal,
				() => undefined,
				ctx,
			),
		).rejects.toThrow(/hyperchart view/);
	}, 30_000);

	it("runs the same source preflight for inspect as for run", async () => {
		const chartPath = join(tempDir, "inspect-preflight.chart.ts");
		writeFileSync(
			chartPath,
			`// @ts-ignore\nexport default { kind: "chart", id: "inspect-preflight", initial: "done", states: { done: { kind: "final" } } };\n`,
		);
		await expect(
			registeredTool("hyperchart").execute(
				"inspect-preflight",
				{ action: "inspect", chartPath },
				new AbortController().signal,
				() => undefined,
				commandContext(projectDir).ctx,
			),
		).rejects.toThrow(/Hyperchart preflight failed.*TS_SUPPRESSION/s);
	});

	it("rejects TypeScript-only failures during inspect preflight", async () => {
		const chartPath = join(tempDir, "inspect-typecheck.chart.ts");
		writeFileSync(
			chartPath,
			`const invalid: string = 42;\nvoid invalid;\nexport default { kind: "chart", id: "inspect-typecheck", initial: "done", states: { done: { kind: "final" } } };\n`,
		);
		await expect(
			registeredTool("hyperchart").execute(
				"inspect-typecheck",
				{ action: "inspect", chartPath },
				new AbortController().signal,
				() => undefined,
				commandContext(projectDir).ctx,
			),
		).rejects.toThrow(/Hyperchart preflight failed.*Type 'number' is not assignable to type 'string'/s);
	});

	it("defaults a fresh run to main and validates explicit branch selectors", async () => {
		const chartPath = join(tempDir, "branch-admission.mjs");
		writeFileSync(
			chartPath,
			`export default { kind: "chart", id: "branch-admission", initial: "done", states: { done: { kind: "final" } } };\n`,
		);
		const tool = registeredTool("hyperchart");
		const ctx = commandContext(projectDir).ctx;
		const fresh = await tool.execute(
			"default-main",
			{ action: "run", chartPath, wait: true },
			new AbortController().signal,
			() => undefined,
			ctx,
		);
		expect(fresh.details).toMatchObject({ boundary: "terminal", status: { state: "complete" } });
		const freshConfig = JSON.parse(
			readFileSync(
				join(resolveRunPaths((fresh.details as { runId: string }).runId, testStorage()).runDir, "runner.config.json"),
				"utf8",
			),
		);
		expect(freshConfig.branchId).toBe("main");
		expect(freshConfig.storage).toEqual(testStorage());
		const resumed = await tool.execute(
			"resume-single-branch-id",
			{ action: "run", runId: (fresh.details as { runId: string }).runId, wait: true },
			new AbortController().signal,
			() => undefined,
			ctx,
		);
		expect(resumed.details).toMatchObject({ boundary: "terminal", status: { state: "complete" } });
		await expect(
			tool.execute(
				"both",
				{ action: "run", chartPath, branchId: "main", branchIds: ["main"] },
				new AbortController().signal,
				() => undefined,
				ctx,
			),
		).rejects.toThrow(/accepts branchId or branchIds, not both/);
		await expect(
			tool.execute(
				"empty",
				{ action: "run", chartPath, branchIds: [] },
				new AbortController().signal,
				() => undefined,
				ctx,
			),
		).rejects.toThrow(/branchIds must be non-empty and unique/);
		await expect(
			tool.execute(
				"duplicate",
				{ action: "run", chartPath, branchIds: ["main", "main"] },
				new AbortController().signal,
				() => undefined,
				ctx,
			),
		).rejects.toThrow(/branchIds must be non-empty and unique/);
		await expect(
			tool.execute(
				"fresh-non-main",
				{ action: "run", chartPath, branchId: "experiment" },
				new AbortController().signal,
				() => undefined,
				ctx,
			),
		).rejects.toThrow(/fresh run must select exactly branch 'main'.*fork durable branches.*resume/i);
		await expect(
			tool.execute(
				"fresh-many",
				{ action: "run", chartPath, branchIds: ["main", "experiment"] },
				new AbortController().signal,
				() => undefined,
				ctx,
			),
		).rejects.toThrow(/fresh run must select exactly branch 'main'.*fork durable branches.*resume/i);
	}, 30_000);

	it("fails closed when a resumed run has multiple branches and no selector", async () => {
		const runId = "ambiguous-resume";
		const { runDir } = createRun(runId, projectDir, writeChart("ambiguous-resume"));
		writeTwoBranchV2Log(runDir);
		await withRunStorage(testStorage(), () => patchRunStatus(runId, { branchIds: [], chartId: "demo", state: "stopped" }));
		await expect(
			registeredTool("hyperchart").execute(
				"ambiguous-resume",
				{ action: "run", runId },
				new AbortController().signal,
				() => undefined,
				commandContext(projectDir).ctx,
			),
		).rejects.toThrow(/action=run requires branchId.*2 durable branches.*main, experiment/);
	});

	it("fails closed when slash-command resume omits a multi-branch selector", async () => {
		const runId = "ambiguous-command-resume";
		const { runDir } = createRun(runId, projectDir, writeChart("ambiguous-command-resume"));
		writeTwoBranchV2Log(runDir);
		await withRunStorage(testStorage(), () => patchRunStatus(runId, { branchIds: [], chartId: "demo", state: "stopped" }));
		const { ctx, notifications } = commandContext(projectDir);

		await registeredCommand().handler(`resume ${runId}`, ctx);

		expect(notifications).toContainEqual({
			message: expect.stringMatching(/action=run requires branchId.*2 durable branches.*main, experiment/),
			type: "error",
		});
		expect(await withRunStorage(testStorage(), () => readRunStatus(runId))).toMatchObject({ state: "stopped" });
	});

	it("resumes the selected branch through the slash command and advertises the option", async () => {
		const runId = "selected-command-resume";
		const chartPath = join(tempDir, "selected-command-resume.mjs");
		writeFileSync(
			chartPath,
			`export default { kind: "chart", id: "demo", initial: "done", states: { done: { kind: "final" } } };\n`,
		);
		const { runDir } = createRun(runId, projectDir, chartPath);
		writeTwoBranchFinalLog(runDir);
		await withRunStorage(testStorage(), () => patchRunStatus(runId, { branchIds: [], chartId: "demo", state: "stopped" }));
		const command = registeredCommand();
		const { ctx, notifications } = commandContext(projectDir);

		const completions = command.getArgumentCompletions(`resume ${runId} --`)?.map((item) => item.value);
		expect(completions).toContain(`resume ${runId} --branch`);
		expect(command.getArgumentCompletions(`resume ${runId} --branch `)).toBeNull();

		await command.handler(`resume ${runId} --branch experiment`, ctx);

		expect(notifications.filter((notification) => notification.type === "error")).toEqual([]);
		expect(JSON.parse(readFileSync(join(runDir, "runner.config.json"), "utf8"))).toMatchObject({
			branchIds: ["experiment"],
		});
		await vi.waitFor(
			async () => expect(await withRunStorage(testStorage(), () => readRunStatus(runId))).toMatchObject({ state: "complete" }),
			{ timeout: 60_000 },
		);
		await registeredTool("hyperchart").execute(
			"stop-selected-command-resume",
			{ action: "stop", runId },
			new AbortController().signal,
			() => undefined,
			ctx,
		);
	}, 90_000);

	it("passes merged model roles and toolsets from settings into the runner config", async () => {
		mkdirSync(join(agentDir, "hypercharts"), { recursive: true });
		writeFileSync(
			join(agentDir, "hypercharts", "settings.json"),
			JSON.stringify({
				roles: { reviewer: "user/model", scout: "user/scout" },
				toolsets: { reading: ["read", "grep"] },
			}),
		);
		mkdirSync(join(projectDir, ".pi", "hypercharts"), { recursive: true });
		writeFileSync(
			join(projectDir, ".pi", "hypercharts", "settings.json"),
			JSON.stringify({ roles: { reviewer: "project/model" }, toolsets: { reading: ["read"] } }),
		);
		const chartPath = join(tempDir, "roles-config.mjs");
		writeFileSync(
			chartPath,
			`export default { kind: "chart", id: "roles", initial: "done", states: { done: { kind: "final" } } };\n`,
		);

		const result = await registeredTool("hyperchart").execute(
			"tool-call",
			{ action: "run", branchId: "main", chartPath, wait: true },
			new AbortController().signal,
			() => undefined,
			commandContext(projectDir).ctx,
		);
		const runId = (result.details as { runId: string }).runId;
		const runDir = resolveRunPaths(runId, testStorage()).runDir;
		const config = JSON.parse(readFileSync(join(runDir, "runner.config.json"), "utf8"));

		expect(config.modelRoles).toEqual({ reviewer: "project/model", scout: "user/scout" });
		expect(config.toolsets).toEqual({ reading: ["read"] });
		expect(config.piModules.codingAgent.startsWith(getPackageDir())).toBe(true);
		expect(existsSync(config.piModules.codingAgent)).toBe(true);
		expect(existsSync(config.piModules.typebox)).toBe(true);
	});

	it("restores widgets only for non-terminal runs owned by the current pi session", async () => {
		const chartPath = writeChart("session-restore");
		createRun("owned-running", projectDir, chartPath, "session-a");
		createRun("foreign-session", projectDir, chartPath, "session-b");
		createRun("legacy-unowned", projectDir, chartPath);
		createRun("foreign-project", otherProjectDir, chartPath, "session-a");
		const { runId: failedRunId, runDir: failedRunDir } = createRun("owned-failed", projectDir, chartPath, "session-a");
		await withRunStorage(testStorage(), () =>
			patchRunStatus(failedRunId, { branchIds: ["main"], chartId: "demo", state: "failed", exitCode: 1 }),
		);
		const { runId: completedRunId, runDir: completedRunDir } = createRun(
			"owned-complete",
			projectDir,
			chartPath,
			"session-a",
		);
		await withRunStorage(testStorage(), () =>
			patchRunStatus(completedRunId, { branchIds: ["main"], chartId: "demo", state: "complete", exitCode: 0 }),
		);

		let sessionStart: ((event: { reason: string }, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
		const pi = {
			registerCommand: () => {},
			registerTool: () => {},
			on: (event: string, handler: (event: { reason: string }, ctx: ExtensionCommandContext) => Promise<void>) => {
				if (event === "session_start") {
					sessionStart = handler;
				}
			},
			events: { on: () => {}, emit: () => {} },
		} as unknown as ExtensionAPI;
		register(pi);
		const { ctx, widgetKeys } = commandContext(projectDir);

		await sessionStart?.({ reason: "startup" }, ctx);

		expect(widgetKeys).toEqual(["hyperchart:owned-running"]);
	});

	it("triggers an observable Pi turn when presenting an idle user gate", async () => {
		const chartPath = join(tempDir, "observable-user-gate.chart.ts");
		writeFileSync(
			chartPath,
			`
			import { chart, final, user } from "@surprisal/hyperchart";
			export default chart({ id: "observable-user-gate", initial: "ask", states: {
				ask: { kind: "state", action: user({ prompt: "Approve?", options: ["APPROVED"] }), transitions: { APPROVED: "done" } },
				done: final(),
			} });
		`,
		);
		const parsed = parseChartModuleSync(chartPath);
		if (!parsed.ok) {
			throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
		}
		const state = parsed.ast.states.ask;
		if (state?.kind !== "state" || state.action.kind !== "user") {
			throw new Error("invalid user gate fixture");
		}
		const { runId, runDir } = createRun("observable-user-gate", projectDir, chartPath, "session-a");
		const store = new JsonlLogStore(join(runDir, "log.jsonl"));
		await store.initializeRootBranch();
		await store.appendDrafts([{ type: "args", args: {} }]);
		const [invoke] = await store.appendDrafts([
			{
				type: "state_action",
				kind: "invoke",
				sessionId: "session-id",
				actionUid: state.action.uid,
				definition: state.action,
			},
		]);
		if (invoke === undefined) {
			throw new Error("missing invocation record");
		}
		const [opened] = await store.appendDrafts([
			{
				type: "user_interaction",
				kind: "opened",
				actionUid: state.action.uid,
				phaseSeqId: invoke.seqId,
				prompt: "Approve?",
				options: ["APPROVED"],
				events: ["APPROVED"],
			},
		]);

		const harness = lifecycleHarness(projectDir, true);
		await harness.sessionStart();
		await harness.shutdown();

		expect(harness.sent).toEqual([
			expect.objectContaining({
				message: expect.objectContaining({ customType: "hyperchart-user-request", display: true }),
				options: { deliverAs: "followUp", triggerTurn: true },
			}),
		]);
		if (opened === undefined) {
			throw new Error("missing opened interaction");
		}
		expect(
			withRunStorage(testStorage(), () => hasUserInteractionReceipt(runId, "main", opened.seqId, "pi", "session-a")),
		).toBe(true);
	});

	it("recovers terminal notifications only into the exact owning session and workDir", async () => {
		const chartPath = writeChart("terminal-routing");
		const owned = createRun("owned-terminal", projectDir, chartPath, "session-a");
		const foreignSession = createRun("foreign-terminal", projectDir, chartPath, "session-b");
		const foreignWorkDir = createRun("foreign-workdir-terminal", otherProjectDir, chartPath, "session-a");
		for (const { runId, runDir } of [owned, foreignSession, foreignWorkDir]) {
			await withRunStorage(testStorage(), () =>
				persistTerminalNotificationRequest(runId, {
					runId,
					branchId: "main",
					chartId: "demo",
					outcome: "complete",
					prompt: `terminal ${runDir}`,
					artifacts: [],
				}),
			);
			await withRunStorage(testStorage(), () =>
				patchRunStatus(runId, { branchIds: ["main"], chartId: "demo", state: "complete" }),
			);
		}
		// Created last so it is scanned first: its malformed outbox must not prevent the
		// valid owned run from being recovered.
		const malformed = createRun("malformed-terminal", projectDir, chartPath, "session-a");
		mkdirSync(join(malformed.runDir, "terminal-notification"), { recursive: true });
		writeFileSync(join(malformed.runDir, "terminal-notification", "request.json"), "{not-json\n");
		await withRunStorage(testStorage(), () =>
			patchRunStatus(malformed.runId, { branchIds: ["main"], chartId: "demo", state: "complete" }),
		);
		let sessionStart: ((event: { reason: string }, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
		const sent: Array<{ customType: string; details: { requestId: string } }> = [];
		const pi = {
			registerCommand: () => {},
			registerTool: () => {},
			on: (event: string, handler: (event: { reason: string }, ctx: ExtensionCommandContext) => Promise<void>) => {
				if (event === "session_start") {
					sessionStart = handler;
				}
			},
			sendMessage: (message: { customType: string; details: { requestId: string } }) => sent.push(message),
			events: { on: () => {}, emit: () => {} },
		} as unknown as ExtensionAPI;
		register(pi);
		const context = commandContext(projectDir).ctx as ExtensionCommandContext & {
			sessionManager: { getEntries(): unknown[] };
		};
		context.sessionManager.getEntries = () => [];

		await sessionStart?.({ reason: "startup" }, context);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.customType).toBe("hyperchart-terminal");
		expect(withRunStorage(testStorage(), () => hasTerminalNotificationReceipt(owned.runId, "pi", "session-a"))).toBe(
			true,
		);
		expect(
			withRunStorage(testStorage(), () => hasTerminalNotificationReceipt(foreignSession.runId, "pi", "session-a")),
		).toBe(false);
		expect(
			withRunStorage(testStorage(), () => hasTerminalNotificationReceipt(foreignWorkDir.runId, "pi", "session-a")),
		).toBe(false);
	});

	it("confirms only after Pi accepts the message and retries a pre-delivery failure", async () => {
		const chartPath = writeChart("terminal-send-order");
		const { runId, runDir } = createRun("terminal-send-order", projectDir, chartPath, "session-a");
		await withRunStorage(testStorage(), () =>
			persistTerminalNotificationRequest(runId, {
				runId: "terminal-send-order",
				branchId: "main",
				chartId: "demo",
				outcome: "complete",
				prompt: "done",
				artifacts: [],
			}),
		);
		await withRunStorage(testStorage(), () =>
			patchRunStatus(runId, { branchIds: ["main"], chartId: "demo", state: "complete" }),
		);
		let sessionStart: ((event: { reason: string }, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
		let attempts = 0;
		const pi = {
			registerCommand: () => {},
			registerTool: () => {},
			on: (event: string, handler: (event: { reason: string }, ctx: ExtensionCommandContext) => Promise<void>) => {
				if (event === "session_start") {
					sessionStart = handler;
				}
			},
			sendMessage: () => {
				attempts++;
				expect(withRunStorage(testStorage(), () => hasTerminalNotificationReceipt(runId, "pi", "session-a"))).toBe(
					false,
				);
				if (attempts === 1) {
					throw new Error("send failed");
				}
			},
			events: { on: () => {}, emit: () => {} },
		} as unknown as ExtensionAPI;
		register(pi);
		const context = commandContext(projectDir).ctx as ExtensionCommandContext & {
			sessionManager: { getEntries(): unknown[] };
		};
		context.sessionManager.getEntries = () => [];

		await sessionStart?.({ reason: "startup" }, context);
		expect(attempts).toBe(1);
		expect(withRunStorage(testStorage(), () => hasTerminalNotificationReceipt(runId, "pi", "session-a"))).toBe(false);
		await sessionStart?.({ reason: "resume" }, context);
		expect(attempts).toBe(2);
		expect(withRunStorage(testStorage(), () => hasTerminalNotificationReceipt(runId, "pi", "session-a"))).toBe(true);
	});

	it("does not resend a terminal request already persisted in the Pi session", async () => {
		const chartPath = writeChart("terminal-persisted");
		const { runId, runDir } = createRun("persisted-terminal", projectDir, chartPath, "session-a");
		const request = await withRunStorage(testStorage(), () =>
			persistTerminalNotificationRequest(runId, {
				runId: "persisted-terminal",
				branchId: "main",
				chartId: "demo",
				outcome: "failed",
				prompt: "failed terminal",
				artifacts: [],
				error: "boom",
			}),
		);
		await withRunStorage(testStorage(), () =>
			patchRunStatus(runId, { branchIds: ["main"], chartId: "demo", state: "failed", error: "boom" }),
		);
		let sessionStart: ((event: { reason: string }, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
		let sends = 0;
		const pi = {
			registerCommand: () => {},
			registerTool: () => {},
			on: (event: string, handler: (event: { reason: string }, ctx: ExtensionCommandContext) => Promise<void>) => {
				if (event === "session_start") {
					sessionStart = handler;
				}
			},
			sendMessage: () => {
				sends++;
			},
			events: { on: () => {}, emit: () => {} },
		} as unknown as ExtensionAPI;
		register(pi);
		const context = commandContext(projectDir).ctx as ExtensionCommandContext & {
			sessionManager: { getEntries(): unknown[] };
		};
		context.sessionManager.getEntries = () => [
			{
				type: "custom_message",
				id: "entry",
				parentId: null,
				timestamp: new Date().toISOString(),
				customType: "hyperchart-terminal",
				content: "failed terminal",
				display: true,
				details: { requestId: request.requestId },
			},
		];

		await sessionStart?.({ reason: "resume" }, context);

		expect(sends).toBe(0);
		expect(withRunStorage(testStorage(), () => hasTerminalNotificationReceipt(runId, "pi", "session-a"))).toBe(true);
	});

	it("delivers an identical post-rewind notification because it has a new request identity", async () => {
		const chartPath = writeChart("terminal-rewind-generation");
		const { runId, runDir } = createRun("terminal-rewind-generation", projectDir, chartPath, "session-a");
		const payload = {
			runId: "terminal-rewind-generation",
			branchId: "main",
			chartId: "demo",
			outcome: "complete" as const,
			prompt: "identical terminal",
			artifacts: [],
		};
		const oldRequest = await withRunStorage(testStorage(), () => persistTerminalNotificationRequest(runId, payload));
		withRunStorage(testStorage(), () => removeTerminalNotificationOutbox(runId));
		const newRequest = await withRunStorage(testStorage(), () => persistTerminalNotificationRequest(runId, payload));
		await withRunStorage(testStorage(), () =>
			patchRunStatus(runId, { branchIds: ["main"], chartId: "demo", state: "complete" }),
		);
		expect(newRequest.requestId).not.toBe(oldRequest.requestId);
		let sessionStart: ((event: { reason: string }, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
		const sent: Array<{ details: { requestId: string } }> = [];
		const pi = {
			registerCommand: () => {},
			registerTool: () => {},
			on: (event: string, handler: (event: { reason: string }, ctx: ExtensionCommandContext) => Promise<void>) => {
				if (event === "session_start") {
					sessionStart = handler;
				}
			},
			sendMessage: (message: { details: { requestId: string } }) => sent.push(message),
			events: { on: () => {}, emit: () => {} },
		} as unknown as ExtensionAPI;
		register(pi);
		const context = commandContext(projectDir).ctx as ExtensionCommandContext & {
			sessionManager: { getEntries(): unknown[] };
		};
		context.sessionManager.getEntries = () => [
			{
				type: "custom_message",
				id: "old-terminal",
				parentId: null,
				timestamp: new Date().toISOString(),
				customType: "hyperchart-terminal",
				content: "identical terminal",
				display: true,
				details: { requestId: oldRequest.requestId },
			},
		];

		await sessionStart?.({ reason: "resume" }, context);
		expect(sent.map((message) => message.details.requestId)).toEqual([newRequest.requestId]);
	});

	it("lists project and user charts with project precedence", async () => {
		const projectCharts = join(projectDir, ".pi", "hypercharts");
		const userCharts = join(agentDir, "hypercharts");
		mkdirSync(projectCharts, { recursive: true });
		mkdirSync(userCharts, { recursive: true });
		writeFileSync(join(userCharts, "shared.chart.ts"), "export default {};\n");
		writeFileSync(join(userCharts, "user-only.chart.ts"), "export default {};\n");
		writeFileSync(join(projectCharts, "shared.chart.ts"), "export default {};\n");
		const tool = registeredTool("hyperchart");
		const { ctx } = commandContext(projectDir);

		const result = await tool.execute(
			"tool-call",
			{ action: "list" },
			new AbortController().signal,
			() => undefined,
			ctx,
		);
		const charts = (result.details as { charts: Array<{ name: string; scope: string }> }).charts;
		const text = (result as { content: Array<{ type: string; text: string }> }).content[0]?.text;

		expect(text).toBe(["Found 2 Hyperchart definitions:", "- shared [project]", "- user-only [user]"].join("\n"));
		expect(charts).toEqual([
			expect.objectContaining({ name: "shared", scope: "project" }),
			expect.objectContaining({ name: "user-only", scope: "user" }),
		]);
	});

	it("lists a user chart bundle installed as a directory symlink", async () => {
		const userCharts = join(agentDir, "hypercharts");
		const externalBundle = join(tempDir, "odyssey-source");
		mkdirSync(userCharts, { recursive: true });
		mkdirSync(externalBundle, { recursive: true });
		writeFileSync(join(externalBundle, "chart.ts"), "export default {};\n");
		symlinkSync(externalBundle, join(userCharts, "odyssey"), "dir");

		const result = await registeredTool("hyperchart").execute(
			"tool-call",
			{ action: "list" },
			new AbortController().signal,
			() => undefined,
			commandContext(projectDir).ctx,
		);
		const charts = (result.details as { charts: Array<{ name: string; path: string }> }).charts;
		expect(charts).toEqual([
			expect.objectContaining({ name: "odyssey", path: join(userCharts, "odyssey", "chart.ts") }),
		]);
	});

	it("registers tools from a self-contained chart bundle extension without listing its implementation files", async () => {
		const bundleDir = join(projectDir, ".pi", "hypercharts", "bundled");
		mkdirSync(join(bundleDir, "extensions", "custom"), { recursive: true });
		writeFileSync(join(bundleDir, "chart.ts"), "export default {};\n");
		writeFileSync(
			join(bundleDir, "extensions", "custom", "index.ts"),
			[
				"export default function register(pi: any) {",
				"  pi.registerTool({ name: 'bundle_tool', parameters: {}, execute() {} });",
				"}",
			].join("\n"),
		);

		expect(registeredToolNames()).toEqual(["bundle_tool", "hyperchart"]);
		const list = await registeredTool("hyperchart").execute(
			"tool-call",
			{ action: "list" },
			new AbortController().signal,
			() => undefined,
			commandContext(projectDir).ctx,
		);
		const charts = (list.details as { charts: Array<{ name: string }> }).charts;
		expect(charts.map((chart) => chart.name)).toEqual(["bundled"]);
	});

	it("accepts runId and rejects legacy runDir coordinates", async () => {
		const runId = "coordinate-alias";
		const { runDir } = createRun(runId, projectDir, writeChart("coordinate-alias"));
		writeV2Log(runDir, [
			{ type: "args", args: {}, parentId: null, seqId: 2, branchId: "main", timestamp: 1 },
			{ type: "session_ref", index: 1, file: "missing.jsonl", parentId: 2, seqId: 3, branchId: "main", timestamp: 2 },
		]);
		const tool = registeredTool("hyperchart");
		const ctx = commandContext(projectDir).ctx;
		const listed = await tool.execute(
			"branches-id",
			{ action: "branches", runId },
			new AbortController().signal,
			() => undefined,
			ctx,
		);
		expect(listed.details).not.toHaveProperty("runDir");
		expect(listed.details).toMatchObject({
			runId,
			branches: [expect.objectContaining({ branchId: "main" })],
			totalCount: 1,
		});
		const viewed = await tool.execute(
			"view-id",
			{ action: "view", runId, branchId: "main", open: false },
			new AbortController().signal,
			() => undefined,
			ctx,
		);
		expect(viewed.details).toMatchObject({ url: expect.stringMatching(/^http:\/\//) });
		const forked = await tool.execute(
			"fork-id",
			{ action: "fork", runId, branchId: "experiment", fromSeqId: 2 },
			new AbortController().signal,
			() => undefined,
			ctx,
		);
		expect(forked.details).toMatchObject({
			branchId: "experiment",
			headSeqId: 2,
			selectedBranchChanged: false,
			started: false,
		});
		const rewound = await tool.execute(
			"rewind-id",
			{ action: "rewind", runId, branchId: "main", seqId: 2, mode: "after" },
			new AbortController().signal,
			() => undefined,
			ctx,
		);
		expect(rewound.details).toMatchObject({ branchId: "main", headSeqId: 2 });
		await expect(
			tool.execute(
				"coordinate-conflict",
				{ action: "branches", runId, runDir: "different-run" },
				new AbortController().signal,
				() => undefined,
				ctx,
			),
		).rejects.toThrow(/runDir is not supported; pass runId/);
		await expect(
			tool.execute(
				"respond-run-dir",
				{ action: "respond", runDir, runId, branchId: "main", seqId: 1, event: "APPROVED" },
				new AbortController().signal,
				() => undefined,
				ctx,
			),
		).rejects.toThrow(/runDir is not supported; pass runId/);
	});

	it("returns cursor-paged branch tool results capped at 100", async () => {
		const runId = "paged-branches";
		const { runDir } = createRun(runId, projectDir, writeChart("paged-branches"));
		const store = new JsonlLogStore(join(runDir, "log.jsonl"));
		await store.initializeRootBranch();
		const [root] = await store.appendDrafts([{ type: "args", args: {} }]);
		if (root === undefined) {
			throw new Error("missing root record");
		}
		for (let index = 0; index < 105; index++) {
			await store.createBranch(`branch-${index.toString().padStart(3, "0")}`, root.seqId);
		}
		const tool = registeredTool("hyperchart");
		const ctx = commandContext(projectDir).ctx;
		const first = await tool.execute(
			"branches-first",
			{ action: "branches", runId },
			new AbortController().signal,
			() => undefined,
			ctx,
		);
		const firstDetails = first.details as { branches: Array<{ branchId: string }>; totalCount: number; next?: string };
		expect(firstDetails.branches).toHaveLength(100);
		expect(firstDetails.totalCount).toBe(106);
		expect(firstDetails.next).toBeTypeOf("string");
		const second = await tool.execute(
			"branches-second",
			{ action: "branches", runId, cursor: firstDetails.next },
			new AbortController().signal,
			() => undefined,
			ctx,
		);
		const secondDetails = second.details as {
			branches: Array<{ branchId: string }>;
			totalCount: number;
			next?: string;
		};
		expect(secondDetails.branches).toHaveLength(6);
		expect(secondDetails.totalCount).toBe(106);
		expect(secondDetails.next).toBeUndefined();
		expect(new Set([...firstDetails.branches, ...secondDetails.branches].map((branch) => branch.branchId)).size).toBe(
			106,
		);
	});

	it("reports action-specific requirements for incomplete calls", async () => {
		const tool = registeredTool("hyperchart");
		const ctx = commandContext(projectDir).ctx;
		const signal = new AbortController().signal;
		await expect(tool.execute("missing-run", { action: "run" }, signal, () => undefined, ctx)).rejects.toThrow(
			/action=run requires chartPath.*runId/,
		);
		await expect(
			tool.execute("missing-inspect-run", { action: "run_inspect" }, signal, () => undefined, ctx),
		).rejects.toThrow(/action=run_inspect requires runId/);
		await expect(
			tool.execute("missing-branches-run", { action: "branches" }, signal, () => undefined, ctx),
		).rejects.toThrow(/action=branches requires runId/);
		await expect(tool.execute("missing-view-target", { action: "view" }, signal, () => undefined, ctx)).rejects.toThrow(
			/action=view requires exactly one of chartPath or runId/,
		);
	});

	it("stops one run through the consolidated tool", async () => {
		const chartPath = writeChart("stoppable");
		const { runId, runDir } = createRun("stoppable-run", projectDir, chartPath);
		await withRunStorage(testStorage(), () =>
			patchRunStatus(runId, {
				branchIds: ["main"],
				chartId: "demo",
				state: "running",
				pid: 999_999_999,
				heartbeatAt: Date.now(),
			}),
		);
		const result = await registeredTool("hyperchart").execute(
			"tool-call",
			{ action: "stop", runId: "stoppable-run" },
			new AbortController().signal,
			() => undefined,
			commandContext(projectDir).ctx,
		);

		expect(await withRunStorage(testStorage(), () => readRunStatus(runId))).toMatchObject({ state: "stopped", exitCode: 0 });
		expect((result as { content: Array<{ text: string }> }).content[0]?.text).toContain(
			"stoppable-run (marked stopped)",
		);
	});

	it("accepts commands from another pi extension over the shared event bus", async () => {
		let sessionStart: ((event: { reason: string }, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
		let commandRequest: ((request: HyperchartCommandRequest) => void) | undefined;
		const pi = {
			registerCommand: () => {},
			registerTool: () => {},
			on: (event: string, handler: (event: { reason: string }, ctx: ExtensionCommandContext) => Promise<void>) => {
				if (event === "session_start") {
					sessionStart = handler;
				}
			},
			events: {
				on: (event: string, handler: (request: HyperchartCommandRequest) => void) => {
					if (event === HYPERCHART_COMMAND_EVENT) {
						commandRequest = handler;
					}
				},
				emit: () => {},
			},
		} as unknown as ExtensionAPI;
		register(pi);
		const { ctx, notifications } = commandContext(projectDir);
		await sessionStart?.({ reason: "startup" }, ctx);

		const handled = await requestHyperchartCommand(
			{
				emit(event, payload) {
					if (event === HYPERCHART_COMMAND_EVENT) {
						commandRequest?.(payload as HyperchartCommandRequest);
					}
				},
			},
			"status",
		);

		expect(handled).toBe(true);
		expect(notifications).toContainEqual({ message: "No hyperchart runs", type: "info" });
		await expect(
			requestHyperchartCommand(
				{
					emit(event, payload) {
						if (event === HYPERCHART_COMMAND_EVENT) {
							commandRequest?.(payload as HyperchartCommandRequest);
						}
					},
				},
				"resume",
			),
		).rejects.toThrow("resume requires a runId");
	});

	it("closes the browser inspector server on session shutdown", async () => {
		let sessionShutdown: (() => Promise<void>) | undefined;
		const pi = {
			registerCommand: () => {},
			registerTool: () => {},
			on: (event: string, handler: () => Promise<void>) => {
				if (event === "session_shutdown") {
					sessionShutdown = handler;
				}
			},
			events: { on: () => {}, emit: () => {} },
		} as unknown as ExtensionAPI;
		register(pi);
		const { url } = await withRunStorage(testStorage(), () =>
			openRunInspector({
				runId: "lifecycle-run",
				branchId: "main",
				loadRun: async () => ({ runId: "lifecycle-run" }) as never,
				openBrowser: () => undefined,
			}),
		);
		expect((await fetch(url)).status).toBe(200);

		await sessionShutdown?.();

		await expect(fetch(url)).rejects.toThrow();
	});

	it("queues steering for a live agent session", async () => {
		const runId = "steerable-run";
		const { runDir } = createRun(runId, projectDir, writeChart("steerable"));
		const actionUid = { chart: "demo", state: "work", action: "agent" };
		const actionKey = actionUidKey(actionUid);
		updateSessionProgress(
			join(runDir, "sessions"),
			actionUid,
			{
				actionName: "worker",
				status: "running",
			},
			`${actionKey}:1:7`,
			"main",
		);
		const { ctx, notifications } = commandContext(projectDir);

		await registeredCommand().handler(`steer '${runId}' 'main' '${actionKey}' 'Prioritize the narrow layout'`, ctx);

		const files = readdirSync(join(runDir, "sessions", "steering"));
		expect(files).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(runDir, "sessions", "steering", files[0]!), "utf8"))).toMatchObject({
			branchId: "main",
			actionKey: "demo:work:agent",
			invokeSeqId: 7,
			message: "Prioritize the narrow layout",
		});
		expect(notifications).toContainEqual({ message: "Steering queued for @worker on branch main", type: "info" });
	});

	it("offers documented top-level commands and run ids with an empty prefix", async () => {
		const runId = "demo-run";
		const chartPath = writeChart("demo");
		const { runDir } = createRun(runId, projectDir, chartPath);
		writeFileSync(
			join(runDir, "runner.config.json"),
			JSON.stringify({
				runId,
				storage: testStorage(),
				chartPath,
				chartId: "demo",
				workDir: projectDir,
				branchId: "main",
			}),
		);

		const command = registeredCommand();
		await command.handler("list", commandContext(projectDir).ctx);
		const values = command.getArgumentCompletions("")?.map((item) => item.value);

		expect(values).toContain("view");
		expect(values).toContain("steer");
		expect(values).toContain(runId);
	});

	it("enriches inspected agents with defaults from subagent definitions", async () => {
		mkdirSync(join(agentDir, "agents"), { recursive: true });
		writeFileSync(
			join(agentDir, "agents", "worker.md"),
			"---\ndescription: Reviews implementation details\nmodel: anthropic/claude-sonnet\nthinking: high\ntools:\n  - read\n  - grep\n---\nWorker prompt\n",
			"utf8",
		);
		const chartPath = writeChart("inspect-defaults");
		const tool = registeredTool("hyperchart");
		const { ctx } = commandContext(projectDir);

		const result = await tool.execute(
			"tool-call",
			{ action: "inspect", chartPath },
			new AbortController().signal,
			() => undefined,
			ctx,
		);
		const details = result.details as { stateDigests: Array<Record<string, unknown>> };

		expect(details.stateDigests.find((state) => state.id === "work")).toMatchObject({
			description: "Reviews implementation details",
			model: "anthropic/claude-sonnet",
			thinking: "high",
			tools: ["read", "grep"],
		});
	});

	it("loads agent descriptions from the selected chart bundle", async () => {
		const bundleDir = join(agentDir, "hypercharts", "described-bundle");
		mkdirSync(join(bundleDir, "agents"), { recursive: true });
		copyFileSync(writeChart("described-source"), join(bundleDir, "chart.ts"));
		writeFileSync(
			join(bundleDir, "agents", "worker.md"),
			"---\ndescription: Bundle-local analyzer\n---\nAnalyze locally\n",
			"utf8",
		);
		const result = await registeredTool("hyperchart").execute(
			"tool-call",
			{ action: "inspect", chartPath: join(bundleDir, "chart.ts") },
			new AbortController().signal,
			() => undefined,
			commandContext(projectDir).ctx,
		);
		const details = result.details as { stateDigests: Array<Record<string, unknown>> };

		expect(details.stateDigests.find((state) => state.id === "work")).toMatchObject({
			agent: "worker",
			description: "Bundle-local analyzer",
		});
	});

	it("marks unavailable agent definitions in static inspect results", async () => {
		const chartPath = writeChart("inspect-missing-agent");
		const tool = registeredTool("hyperchart");
		const { ctx } = commandContext(projectDir);

		const result = await tool.execute(
			"tool-call",
			{ action: "inspect", chartPath },
			new AbortController().signal,
			() => undefined,
			ctx,
		);
		const details = result.details as { stateDigests: Array<Record<string, unknown>> };

		expect(details.stateDigests.find((state) => state.id === "work")).toMatchObject({
			agent: "worker",
			agentDefinitionUnavailable: true,
		});
	});

	it("keeps view as the shortcut for opening the latest run", async () => {
		const runId = "current-run";
		const { runDir } = createRun(runId, projectDir, writeChart("current"));
		const { ctx, notifications } = commandContext(projectDir);

		await registeredCommand().handler("view", ctx);

		expect(notifications).toContainEqual({ message: `Run ${runId}: ${runId}`, type: "info" });
	});

	it("opens the browser inspector with overview data and on-demand transcripts", async () => {
		const runId = "tool-view-run";
		const { runDir } = createRun(runId, projectDir, writeChart("tool-view"));
		const actionUid = { chart: "demo", state: "work", action: "agent" };
		writeV2Log(runDir, [
			{ type: "args", args: {}, parentId: null, seqId: 2, branchId: "main", timestamp: 1 },
			{
				type: "state_action",
				kind: "invoke",
				sessionId: "session-id",
				actionUid,
				definition: { kind: "agent", uid: actionUid, name: "worker", onFail: { nudge: 2, restart: 1 } },
				parentId: 2,
				seqId: 3,
				branchId: "main",
				timestamp: 2,
			},
		]);
		const transcriptFile = join(runDir, "sessions", "tool-view.jsonl");
		writeFileSync(
			transcriptFile,
			`${JSON.stringify({ id: "assistant-1", timestamp: new Date(3).toISOString(), type: "message", message: { role: "assistant", content: "inspector transcript" } })}\n`,
		);
		updateSessionProgress(
			join(runDir, "sessions"),
			actionUid,
			{
				actionName: "worker",
				status: "running",
				sessionId: "session-id",
				sessionFile: transcriptFile,
			},
			"demo:work:agent:1:3",
		);
		updateSessionProgress(
			join(runDir, "sessions"),
			actionUid,
			{
				actionName: "worker",
				status: "running",
				sessionId: "experiment-session",
			},
			"demo:work:agent:1:3",
			"experiment",
		);
		const tool = registeredTool("hyperchart");
		const { ctx } = commandContext(projectDir);

		const result = await tool.execute(
			"tool-call",
			{ action: "view", branchId: "main", runId, open: false },
			new AbortController().signal,
			() => undefined,
			ctx,
		);
		const details = result.details as { url: string };

		expect(details).toEqual({ url: expect.any(String) });
		const inspectorUrl = new URL(details.url);
		expect(inspectorUrl.protocol).toBe("http:");
		expect(inspectorUrl.pathname).toMatch(/^\/runs\/[A-Za-z0-9_-]+$/);
		const response = await fetch(inspectorUrl);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("<title>Hyperchart Inspector</title>");

		const token = inspectorUrl.pathname.slice("/runs/".length);
		const runResponse = await fetch(new URL(`/api/runs/${token}`, inspectorUrl));
		expect(runResponse.status).toBe(200);
		const runPayload = (await runResponse.json()) as {
			run: {
				runId: string;
				historySnapshot: { branchId: string; headSeqId: number | null };
				states: Array<{ id: string; session?: { messages?: unknown[] } }>;
			};
		};
		expect(runPayload).toMatchObject({ run: { runId } });
		expect(runPayload.run.states.find((state) => state.id === "work")?.session?.messages).toBeUndefined();
		const sessionResponse = await fetch(new URL(`/api/runs/${token}/history`, inspectorUrl), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				operation: "readVisitSession",
				input: { snapshot: runPayload.run.historySnapshot, invokeSeqId: 3 },
			}),
		});
		expect(sessionResponse.status).toBe(200);
		const sessionPayload = (await sessionResponse.json()) as { result: { messages?: unknown[] } };
		expect(sessionPayload.result.messages).toEqual([
			{ id: "assistant-1", role: "assistant", text: "inspector transcript", timestamp: 3 },
		]);

		const steerResponse = await fetch(new URL(`/api/runs/${token}/steer`, inspectorUrl), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				branchId: "experiment",
				actionKey: actionUidKey(actionUid),
				message: "Focus on primary sources",
			}),
		});
		expect(steerResponse.status).toBe(202);
		const steeringFiles = readdirSync(join(runDir, "sessions", "steering"));
		expect(steeringFiles).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(runDir, "sessions", "steering", steeringFiles[0]!), "utf8"))).toMatchObject({
			branchId: "experiment",
			actionKey: actionUidKey(actionUid),
			message: "Focus on primary sources",
		});
	});

	it("rejects a foreign-workdir run through the view agent action", async () => {
		const { runId, runDir } = createRun("foreign-tool-view", otherProjectDir, writeChart("foreign-tool-view"));
		const tool = registeredTool("hyperchart");
		const { ctx } = commandContext(projectDir);

		await expect(
			tool.execute(
				"tool-call",
				{ action: "view", runId, branchId: "main", open: false },
				new AbortController().signal,
				() => undefined,
				ctx,
			),
		).rejects.toThrow("belongs to another working directory");
	});

	it("inspects the requested durable branch and rejects ambiguous omission", async () => {
		const runId = "branch-aware-inspect";
		const { runDir } = createRun(runId, projectDir, writeChart("branch-aware-inspect"));
		writeTwoBranchV2Log(runDir);
		await withRunStorage(testStorage(), () => patchRunStatus(runId, { branchIds: [], chartId: "demo", state: "stopped" }));
		const tool = registeredTool("hyperchart");
		const ctx = commandContext(projectDir).ctx;

		const result = await tool.execute(
			"inspect-experiment",
			{ action: "run_inspect", runId, branchId: "experiment" },
			new AbortController().signal,
			() => undefined,
			ctx,
		);
		expect(result.details).toMatchObject({
			branchId: "experiment",
			stateDigests: expect.arrayContaining([expect.objectContaining({ id: "work", status: "done" })]),
		});
		await expect(
			tool.execute(
				"inspect-ambiguous",
				{ action: "run_inspect", runId },
				new AbortController().signal,
				() => undefined,
				ctx,
			),
		).rejects.toThrow(/action=run_inspect requires branchId.*2 durable branches/);
	});

	it("returns a runtime-enriched inspector model for concrete run dirs", async () => {
		const runId = "runtime-inspect-run";
		const { runDir } = createRun(runId, projectDir, writeChart("runtime-inspect"));
		const uid = { chart: "demo", state: "work", action: "agent" };
		writeV2Log(runDir, [
			{ type: "args", args: { topic: "wire runtime" }, parentId: null, seqId: 2, branchId: "main", timestamp: 1 },
			{
				type: "state_action",
				kind: "invoke",
				sessionId: "session-id",
				actionUid: uid,
				definition: { kind: "agent", uid, name: "worker" },
				parentId: 2,
				seqId: 3,
				branchId: "main",
				timestamp: 2,
			},
			{
				type: "failure_intent",
				origin: "work",
				error: { code: 2, stderr: "nope" },
				parentId: 3,
				seqId: 4,
				branchId: "main",
				timestamp: 3,
			},
		]);
		await withRunStorage(testStorage(), () =>
			patchRunStatus(runId, {
				chartId: "demo",
				state: "failed",
				exitCode: 1,
				error: "runner failed",
				replayWarnings: ["Replay warning: stale provenance"],
			}),
		);
		const transcriptFile = join(runDir, "sessions", "runtime-inspect.jsonl");
		writeFileSync(
			transcriptFile,
			`${JSON.stringify({ id: "assistant-1", timestamp: new Date(3).toISOString(), type: "message", message: { role: "assistant", content: "verbose Pi transcript" } })}\n`,
		);
		updateSessionProgress(
			join(runDir, "sessions"),
			uid,
			{
				actionName: "worker",
				status: "failed",
				error: "session failed",
				lastActivityAt: 4,
				sessionId: "session-id",
				sessionFile: transcriptFile,
			},
			"demo:work:agent:1:3",
		);
		const tool = registeredTool("hyperchart");
		const { ctx } = commandContext(projectDir);

		const result = await tool.execute(
			"tool-call",
			{ action: "run_inspect", branchId: "main", runId },
			new AbortController().signal,
			() => undefined,
			ctx,
		);
		const inferred = await tool.execute(
			"tool-call-inferred",
			{ action: "run_inspect", runId },
			new AbortController().signal,
			() => undefined,
			ctx,
		);
		expect(inferred.details).toMatchObject({ branchId: "main" });
		await expect(
			tool.execute(
				"tool-call-full",
				{ action: "run_inspect", branchId: "main", runId, verbose: true },
				new AbortController().signal,
				() => undefined,
				ctx,
			),
		).rejects.toThrow(/hyperchart view/);
		const details = result.details as {
			mode?: string;
			args?: Record<string, unknown>;
			issues?: Array<{ kind: string }>;
			stateDigests: Array<{ id: string; issues?: Array<{ kind: string; message: string }> }>;
		};

		expect(JSON.stringify(details)).not.toContain("verbose Pi transcript");
		expect(details.mode).toBe("run");
		expect(details.args).toBeUndefined();
		expect(details.issues?.map((issue) => issue.kind)).toEqual(["run_failed", "replay_warning", "replay_warning"]);
		expect(details.stateDigests.find((state) => state.id === "work")?.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "action_failed", message: "Script exited with code 2: nope" }),
				expect.objectContaining({ kind: "session_failed", message: "session failed" }),
			]),
		);
	});

	it("does not import path-like or foreign run specs through the top-level fallback", async () => {
		const importedFlag = join(tempDir, "imported.txt");
		const maliciousChart = writeChart("malicious", importedFlag);
		const pathRunDir = join(tempDir, "crafted-run");
		await withRunStorage({ kind: "jsonl", rootDir: tempDir, layout: "run-id" }, () =>
			saveRunMeta("crafted-run", {
				chartPath: maliciousChart,
				workDir: projectDir,
				chartId: "malicious",
				createdAt: new Date().toISOString(),
			}),
		);
		createRun("foreign-run", otherProjectDir, maliciousChart);
		const command = registeredCommand();
		const { ctx } = commandContext(projectDir);

		await command.handler(pathRunDir, ctx);
		await command.handler("foreign-run", ctx);

		expect(existsSync(importedFlag)).toBe(false);
	});

	it("rejects resume of a foreign run before importing its chart", async () => {
		const importedFlag = join(tempDir, "resume-imported.txt");
		const maliciousChart = writeChart("resume-malicious", importedFlag);
		createRun("foreign-resume", otherProjectDir, maliciousChart);
		const command = registeredCommand();
		const { ctx, notifications } = commandContext(projectDir);

		await command.handler("resume foreign-resume", ctx);

		expect(existsSync(importedFlag)).toBe(false);
		expect(notifications).toContainEqual({
			message: `Run 'foreign-resume' belongs to ${otherProjectDir}; open that directory first`,
			type: "error",
		});
	});

	it("rewinds an incompatible modified-chart run to the compatible prefix", async () => {
		const chartPath = writeIncompatibleReplayChart();
		const { runId, runDir } = createRun("rewind-compatible", projectDir, chartPath);
		mkdirSync(runDir, { recursive: true });
		writeV2Log(runDir, [
			{ type: "args", args: {}, parentId: null, seqId: 2, branchId: "main", timestamp: 1 },
			{
				type: "state_action",
				kind: "invoke",
				sessionId: "session-id",
				actionUid: { chart: "demo", state: "first", action: "agent" },
				definition: {
					kind: "agent",
					uid: { chart: "demo", state: "first", action: "agent" },
					name: "old-worker",
					onFail: { nudge: 2, restart: 1 },
				},
				parentId: 2,
				seqId: 3,
				branchId: "main",
				timestamp: 2,
			},
			{
				type: "state_action",
				kind: "complete",
				actionUid: { chart: "demo", state: "first", action: "agent" },
				event: { type: "FIRST_DONE" },
				parentId: 3,
				seqId: 4,
				branchId: "main",
				timestamp: 3,
			},
		]);
		const tool = registeredTool("hyperchart");
		const { ctx } = commandContext(projectDir);

		const result = await tool.execute(
			"tool-call",
			{ action: "rewind", runId, branchId: "main", to: "compatible" },
			new AbortController().signal,
			() => undefined,
			ctx,
		);

		const logText = readFileSync(join(runDir, "log.jsonl"), "utf8");
		expect(logText).toContain('"seqId":3');
		expect(result.details).toMatchObject({ branchId: "main", previousHeadSeqId: 4, headSeqId: 2, preservedRecords: 3 });
		expect(existsSync(join(runDir, "rewind-backups"))).toBe(false);
	});

	it("append-only rewind preserves every session visit of the same action", async () => {
		const chartPath = join(tempDir, "repeated-visits.mjs");
		writeFileSync(
			chartPath,
			`export default {
	kind: "chart", id: "demo", initial: "work",
	states: {
		work: { kind: "state", action: { kind: "agent", name: "worker" }, transitions: { AGAIN: "work", DONE: "done" } },
		done: { kind: "final" }
	}
};\n`,
		);
		const { runId, runDir } = createRun("rewind-visits", projectDir, chartPath);
		mkdirSync(runDir, { recursive: true });
		const actionUid = { chart: "demo", state: "work", action: "agent" };
		const definition = { kind: "agent", uid: actionUid, name: "worker", onFail: { nudge: 2, restart: 1 } };
		writeV2Log(runDir, [
			{ type: "args", args: {}, parentId: null, seqId: 2, branchId: "main", timestamp: 1 },
			{
				type: "state_action",
				kind: "invoke",
				sessionId: "session-id",
				actionUid,
				definition,
				parentId: 2,
				seqId: 3,
				branchId: "main",
				timestamp: 2,
			},
			{
				type: "state_action",
				kind: "complete",
				actionUid,
				event: { type: "AGAIN" },
				parentId: 3,
				seqId: 4,
				branchId: "main",
				timestamp: 3,
			},
			{
				type: "state_action",
				kind: "invoke",
				sessionId: "session-id",
				actionUid,
				definition,
				parentId: 4,
				seqId: 5,
				branchId: "main",
				timestamp: 4,
			},
			{
				type: "state_action",
				kind: "complete",
				actionUid,
				event: { type: "AGAIN" },
				parentId: 5,
				seqId: 6,
				branchId: "main",
				timestamp: 5,
			},
			{
				type: "state_action",
				kind: "invoke",
				sessionId: "session-id",
				actionUid,
				definition,
				parentId: 6,
				seqId: 7,
				branchId: "main",
				timestamp: 6,
			},
			{
				type: "state_action",
				kind: "complete",
				actionUid,
				event: { type: "DONE" },
				parentId: 7,
				seqId: 8,
				branchId: "main",
				timestamp: 7,
			},
		]);
		const sessionsDir = join(runDir, "sessions");
		const actionDir = join(sessionsDir, branchSessionSegment("main"), actionUidDirName(actionUid));
		const firstVisitDir = join(actionDir, sanitizeSegment(`${actionUidKey(actionUid)}:1`));
		const secondVisitDir = join(actionDir, sanitizeSegment(`${actionUidKey(actionUid)}:2`));
		const thirdVisitDir = join(actionDir, sanitizeSegment(`${actionUidKey(actionUid)}:3`));
		const sharedSessionFile = join(firstVisitDir, "shared.jsonl");
		mkdirSync(firstVisitDir, { recursive: true });
		mkdirSync(secondVisitDir, { recursive: true });
		mkdirSync(thirdVisitDir, { recursive: true });
		writeFileSync(
			sharedSessionFile,
			`${[
				{ type: "session", id: "shared", timestamp: "1970-01-01T00:00:00.001Z" },
				{
					type: "message",
					timestamp: "1970-01-01T00:00:00.002Z",
					message: { role: "assistant", content: "retained visit" },
				},
				{
					type: "message",
					timestamp: "1970-01-01T00:00:00.004Z",
					message: { role: "assistant", content: "removed visit two" },
				},
				{
					type: "message",
					timestamp: "1970-01-01T00:00:00.006Z",
					message: { role: "assistant", content: "removed visit three" },
				},
			]
				.map((record) => JSON.stringify(record))
				.join("\n")}\n`,
		);
		writeFileSync(join(secondVisitDir, "visit.marker"), "removed");
		writeFileSync(join(thirdVisitDir, "visit.marker"), "removed");
		updateSessionProgress(
			sessionsDir,
			actionUid,
			{ actionName: "worker", status: "completed", sessionFile: sharedSessionFile },
			"demo:work:agent:1:3",
			"main",
		);
		updateSessionProgress(
			sessionsDir,
			actionUid,
			{ actionName: "worker", status: "completed", sessionFile: sharedSessionFile },
			"demo:work:agent:3:6",
			"main",
		);

		const tool = registeredTool("hyperchart");
		const { ctx } = commandContext(projectDir);
		const result = await tool.execute(
			"tool-call",
			{ action: "rewind", runId, branchId: "main", seqId: 4, mode: "before" },
			new AbortController().signal,
			() => undefined,
			ctx,
		);

		const progress = readSessionProgress(sessionsDir);
		expect(Object.keys(progress.sessions)).toHaveLength(2);
		expect(existsSync(firstVisitDir)).toBe(true);
		expect(existsSync(secondVisitDir)).toBe(true);
		expect(existsSync(thirdVisitDir)).toBe(true);
		expect(readFileSync(sharedSessionFile, "utf8")).toContain("retained visit");
		expect(readFileSync(sharedSessionFile, "utf8")).toContain("removed visit two");
		expect(readFileSync(sharedSessionFile, "utf8")).toContain("removed visit three");
		expect(result.details).toMatchObject({ branchId: "main", previousHeadSeqId: 8, headSeqId: 3, preservedRecords: 7 });
	});
});

type LifecycleHarness = {
	ctx: ExtensionCommandContext;
	tool: HyperchartTool;
	sent: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }>;
	setIdle: (idle: boolean) => void;
	setEntries: (entries: unknown[]) => void;
	sessionStart: (reason?: string) => Promise<void>;
	agentSettled: () => Promise<void>;
	beforeAgentStart: (prompt: string) => Promise<unknown>;
	shutdown: () => Promise<void>;
};

function lifecycleHarness(cwd: string, initiallyIdle: boolean): LifecycleHarness {
	const handlers = new Map<string, (...args: any[]) => any>();
	const tools: HyperchartTool[] = [];
	const sent: LifecycleHarness["sent"] = [];
	let idle = initiallyIdle;
	let entries: unknown[] = [];
	const base = commandContext(cwd).ctx;
	const ctx = {
		...base,
		isIdle: () => idle,
		sessionManager: {
			getSessionId: () => "session-a",
			getEntries: () => entries,
		},
	} as unknown as ExtensionCommandContext;
	const pi = {
		registerCommand: () => {},
		registerTool: (tool: HyperchartTool) => tools.push(tool),
		on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
		sendMessage: (message: Record<string, unknown>, options?: Record<string, unknown>) => {
			sent.push({ message, ...(options === undefined ? {} : { options }) });
		},
		events: { on: () => {}, emit: () => {} },
	} as unknown as ExtensionAPI;
	register(pi);
	const tool = tools.find((candidate) => candidate.name === "hyperchart");
	if (tool === undefined) {
		throw new Error("hyperchart tool was not registered");
	}
	return {
		ctx,
		tool,
		sent,
		setIdle: (value) => {
			idle = value;
		},
		setEntries: (value) => {
			entries = value;
		},
		sessionStart: async (reason = "startup") => {
			await handlers.get("session_start")?.({ reason }, ctx);
		},
		agentSettled: async () => {
			await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
		},
		beforeAgentStart: async (prompt) =>
			handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt }, ctx),
		shutdown: async () => {
			await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
		},
	};
}

function registeredCommand(): HyperchartCommand {
	let command: HyperchartCommand | undefined;
	const pi = {
		registerCommand: (name: string, config: HyperchartCommand) => {
			if (name === "hyperchart") {
				command = config;
			}
		},
		registerTool: () => {},
		on: () => {},
		events: { on: () => {}, emit: () => {} },
	} as unknown as ExtensionAPI;
	register(pi);
	if (command === undefined) {
		throw new Error("hyperchart command was not registered");
	}
	return command;
}

function registeredToolNames(): string[] {
	const tools: HyperchartTool[] = [];
	const pi = {
		registerCommand: () => {},
		registerTool: (tool: HyperchartTool) => tools.push(tool),
		on: () => {},
		events: { on: () => {}, emit: () => {} },
	} as unknown as ExtensionAPI;
	register(pi);
	return tools.map((tool) => tool.name);
}

function registeredTool(name: string): HyperchartTool {
	const tools: HyperchartTool[] = [];
	const pi = {
		registerCommand: () => {},
		registerTool: (tool: HyperchartTool) => tools.push(tool),
		on: () => {},
		events: { on: () => {}, emit: () => {} },
	} as unknown as ExtensionAPI;
	register(pi);
	const tool = tools.find((entry) => entry.name === name);
	if (tool === undefined) {
		throw new Error(`hyperchart tool ${name} was not registered`);
	}
	return tool;
}

function commandContext(cwd: string): {
	ctx: ExtensionCommandContext;
	notifications: Notification[];
	widgetKeys: string[];
} {
	const notifications: Notification[] = [];
	const widgetKeys: string[] = [];
	return {
		notifications,
		widgetKeys,
		ctx: {
			cwd,
			mode: "print",
			model: undefined,
			sessionManager: { getSessionId: () => "session-a" },
			ui: {
				notify: (message: string, type: "info" | "warning" | "error" | undefined) => {
					notifications.push({ message, type });
				},
				setStatus: () => {},
				setWidget: (key: string, widget: unknown) => {
					if (widget !== undefined) {
						widgetKeys.push(key);
					}
				},
				confirm: async () => false,
				custom: async () => undefined,
			},
		} as unknown as ExtensionCommandContext,
	};
}

function createRun(
	runId: string,
	workDir: string,
	chartPath: string,
	originSessionId?: string,
): { runId: string; runDir: string } {
	const runDir = resolveRunPaths(runId, testStorage()).runDir;
	mkdirSync(join(runDir, "sessions"), { recursive: true });
	void new JsonlLogStore(join(runDir, "log.jsonl")).writeRunMeta({
		chartPath,
		workDir,
		chartId: "demo",
		createdAt: new Date().toISOString(),
		...(originSessionId === undefined ? {} : { originSessionId }),
	});
	return { runId, runDir };
}

function writeIncompatibleReplayChart(): string {
	const chartPath = join(tempDir, "incompatible-replay.mjs");
	writeFileSync(
		chartPath,
		`export default {
	kind: "chart",
	id: "demo",
	initial: "first",
	states: {
		first: { kind: "state", action: { kind: "agent", name: "first-worker" }, transitions: { OTHER: "done" } },
		done: { kind: "final" }
	}
};
`,
		"utf8",
	);
	return chartPath;
}

function writeChart(name: string, sideEffectPath?: string): string {
	const chartPath = join(tempDir, `${name}.mjs`);
	const sideEffect =
		sideEffectPath === undefined
			? ""
			: `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sideEffectPath)}, "imported");\n`;
	writeFileSync(
		chartPath,
		`${sideEffect}export default {
	kind: "chart",
	id: "demo",
	initial: "work",
	states: {
		work: { kind: "state", action: { kind: "agent", name: "worker" }, transitions: { DONE: "done" } },
		done: { kind: "final" },
		failed: { kind: "final" }
	}
};
`,
		"utf8",
	);
	return chartPath;
}
