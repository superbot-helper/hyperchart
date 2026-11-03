import {
	assertRunId,
	resolveRunPaths,
	listRunIds,
	withRunStorage,
	type RunStorage,
} from "@surprisal/hyperchart/runtime";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { z } from "zod";
import { inspectChartAst, parseChartModuleSync } from "@surprisal/hyperchart";
import {
	assertChartPreflight,
	claimTerminalNotificationReceipt,
	createRun,
	initializeRun,
	listHyperchartFiles,
	loadHostSettings,
	loadRunMeta,
	readDeliverableTerminalNotificationRequest,
	saveRunMeta,
	type RunMeta,
} from "@surprisal/hyperchart/runtime";
import {
	USER_INTERACTION_WAIT_LEASE_MS,
	acquireActiveUserInteraction,
	claimUserInteractionReceipt,
	forkHyperchartRun,
	listHyperchartBranchPage,
	rewindHyperchartRun,
	validateAndPersistUserInteractionResponse,
	type HyperchartRunnerConfig,
	type OwnedUserInteraction,
	type UserInteractionOwner,
} from "@surprisal/hyperchart/runner";
import {
	boundedModelEnvelope,
	hyperchartRunFromInspectResult,
	summarizeChartInspect,
	summarizeRunInspect,
	summarizeUserGate,
} from "@surprisal/hyperchart/host";
import {
	createRunInspectorDataSource,
	hyperchartRunFromRunId,
	openRunInspector,
	readNeutralSessionTranscript,
	type SessionTranscriptReader,
} from "@surprisal/hyperchart/inspect";
import {
	isPidAlive,
	isRunLive,
	patchRunStatus,
	queueLiveSessionSteering,
	readRunStatus,
	readSessionProgress,
	type HyperchartRunStatus,
} from "@surprisal/hyperchart/sessions";
import { claudeHostPaths, claudeRunsRoot, claudeUserChartsDir } from "../claude/paths.js";
import { createClaudeAgentDefaultsResolver } from "../claude/agent_definitions.js";
import { ownedClaudeUserInteractionSummary } from "../monitor.js";
import { spawnDetachedRunner, watchRun } from "./spawn_runner.js";

export type HyperchartMcpDeps = {
	/** Working directory of the Claude session the MCP server belongs to. */
	cwd: string;
	runsRoot?: string;
	storage?: RunStorage;
	/** Owning Claude Code session, captured once by the MCP server. */
	sessionId?: string;
	/** Test seam: replaces opening the system browser for hyperchart_view. */
	openBrowser?: (url: string) => void | Promise<void>;
};

export type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
};

export type HyperchartMcpTool = {
	name: string;
	description: string;
	inputSchema: z.ZodRawShape;
	handler(args: Record<string, unknown>): Promise<ToolResult>;
};

const cwdField = {
	cwd: z.string().optional().describe("Working directory override; defaults to the session working directory"),
};

function fileTranscriptReader(sessionsDir: string): SessionTranscriptReader {
	return async (binding) => {
		const session = Object.values(readSessionProgress(sessionsDir).sessions).find(
			(candidate) => candidate.sessionId === binding.sessionId,
		);
		return readNeutralSessionTranscript(sessionsDir, session?.sessionFile, { limit: false });
	};
}

export function createHyperchartMcpTools(deps: HyperchartMcpDeps): HyperchartMcpTool[] {
	const storage: RunStorage = deps.storage ?? {
		kind: "jsonl",
		rootDir: deps.runsRoot ?? claudeRunsRoot(),
		layout: "run-id",
	};
	const runsRoot = () => storage.rootDir;
	const cwdOf = (args: Record<string, unknown>) => (typeof args.cwd === "string" ? args.cwd : deps.cwd);
	const interactionOwner = (cwd: string): UserInteractionOwner | undefined =>
		deps.sessionId === undefined
			? undefined
			: { runsRoot: runsRoot(), host: "claude", sessionId: deps.sessionId, workDir: cwd };
	const resolveRunIdArg = (runId: string, _cwd: string) => {
		assertRunId(runId);
		return runId;
	};

	const tools: HyperchartMcpTool[] = [
		{
			name: "hyperchart_list",
			description:
				"List Hyperchart definitions (project .claude/hypercharts and user ~/.claude/hypercharts) and this directory's runs.",
			inputSchema: { ...cwdField },
			handler: async (args) => {
				const cwd = cwdOf(args);
				const paths = claudeHostPaths();
				const projectChartsDir = paths.getProjectHyperchartsDir(cwd);
				const sharedChartsDir = paths.getSharedHyperchartsDir(cwd);
				const userChartsDir = claudeUserChartsDir();
				// Weakest scope first so a stronger chart with the same name wins,
				// matching resolveChartPath's candidate order.
				const chartsByName = new Map<
					string,
					{ name: string; scope: "user" | "shared" | "project"; chartPath: string }
				>();
				for (const [scope, root] of [
					["user", userChartsDir],
					...(sharedChartsDir === undefined ? [] : ([["shared", sharedChartsDir]] as const)),
					["project", projectChartsDir],
				] as const) {
					for (const chartPath of listHyperchartFiles(root)) {
						const name = chartNameFor(chartPath, root);
						chartsByName.set(name, { name, scope, chartPath });
					}
				}
				const allRunIds = await runIdsFor(runsRoot(), cwd);
				const runs = await Promise.all(
					allRunIds.slice(0, 20).map(async (runId) => {
						const status = await readRunStatus(runId);
						const meta = await loadRunMeta(runId);
						return {
							runId: truncateToolText(runId),
							chartId: truncateToolText(status?.chartId ?? meta.chartId),
							state: status?.state ?? "unknown",
							updatedAt: status?.updatedAt,
						};
					}),
				);
				const charts = [...chartsByName.values()].slice(0, 20).map((chart) => ({
					name: truncateToolText(chart.name),
					scope: chart.scope,
					chartPath: truncateToolText(chart.chartPath, 1_000),
				}));
				return ok({
					projectChartsDir,
					userChartsDir,
					charts,
					runs,
					...(chartsByName.size === charts.length ? {} : { omittedChartCount: chartsByName.size - charts.length }),
					...(allRunIds.length === runs.length ? {} : { omittedRunCount: allRunIds.length - runs.length }),
				});
			},
		},
		{
			name: "hyperchart_inspect",
			description:
				"Statically validate a chart definition and return only a bounded digest. Full source, schemas, and states are available only through hyperchart_view.",
			inputSchema: {
				chartPath: z.string().describe("Chart name or path (resolved against project and user chart dirs)"),
				exportName: z.string().optional(),
				verbose: z.boolean().optional().describe("Deprecated and rejected; use hyperchart_view for full inspection"),
				...cwdField,
			},
			handler: async (args) => {
				if (args.verbose === true) {
					return fail(
						"verbose=true is no longer supported in tool responses; use hyperchart_view for full browser inspection",
					);
				}
				const cwd = cwdOf(args);
				const chartPath = claudeHostPaths().resolveChartPath(args.chartPath as string, cwd);
				await assertChartPreflight(chartPath);
				const parsed = parseChartModuleSync(
					chartPath,
					typeof args.exportName === "string" ? { exportName: args.exportName } : {},
				);
				if (!parsed.ok) {
					return fail(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
				}
				const inspected = inspectChartAst(parsed.ast, {
					chartPath,
					agentDefaults: createClaudeAgentDefaultsResolver(cwd, chartPath),
				});
				return ok(summarizeChartInspect(inspected));
			},
		},
		{
			name: "hyperchart_run",
			description:
				"Start a chart as a detached background run, or resume an existing run directory. Updates are delivered automatically by the Hyperchart plugin monitor; Claude must not start Bash/Monitor polling watchers. wait=true returns at either terminal status or the session arbiter's active user-input gate.",
			inputSchema: {
				chartPath: z.string().optional(),
				runId: z.string().optional().describe("Existing run identity to resume"),
				branchId: z.string().min(1).optional().describe("Singleton branch handle"),
				branchIds: z.array(z.string().min(1)).min(1).optional().describe("Initial branches to run concurrently"),
				args: z.record(z.string(), z.unknown()).optional(),
				exportName: z.string().optional(),
				ignoreReplayWarnings: z.boolean().optional(),
				defaultModel: z.string().optional(),
				wait: z
					.boolean()
					.optional()
					.describe(
						"Block only this current task until terminal status or an owned active user gate; do not start polling watchers",
					),
				...cwdField,
			},
			handler: async (args) => {
				const cwd = cwdOf(args);
				if ((typeof args.branchId === "string") === Array.isArray(args.branchIds)) {
					return fail("hyperchart_run requires exactly one of branchId or branchIds");
				}
				const branchIds = Array.isArray(args.branchIds) ? (args.branchIds as string[]) : [args.branchId as string];
				if (new Set(branchIds).size !== branchIds.length) {
					return fail("branchIds must be unique");
				}
				const branchId = branchIds[0]!;
				const requestedRunId = typeof args.runId === "string" ? resolveRunIdArg(args.runId, cwd) : undefined;
				let meta: RunMeta | undefined;
				let chartPath: string;
				let exportName = typeof args.exportName === "string" ? args.exportName : undefined;
				let workDir = cwd;
				if (requestedRunId !== undefined && typeof args.chartPath !== "string") {
					meta = await loadRunMeta(requestedRunId);
					if (resolve(meta.workDir) !== resolve(cwd)) {
						return fail(`Run '${requestedRunId}' belongs to ${meta.workDir}; run from that directory`);
					}
					chartPath = meta.chartPath;
					exportName = meta.exportName;
					workDir = meta.workDir;
				} else if (typeof args.chartPath === "string") {
					chartPath = claudeHostPaths().resolveChartPath(args.chartPath, cwd);
				} else {
					return fail("hyperchart_run requires chartPath unless runId points at an existing run");
				}
				if (meta === undefined && (branchIds.length !== 1 || branchIds[0] !== "main")) {
					return fail(
						"A fresh run must select exactly branch 'main'; start main, fork durable branches, then resume the existing run with branchId or branchIds",
					);
				}

				await assertChartPreflight(chartPath);
				const parsed = parseChartModuleSync(chartPath, exportName === undefined ? {} : { exportName });
				if (!parsed.ok) {
					return fail(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
				}

				const runId = requestedRunId ?? (await createRun(parsed.ast.id));
				if (meta === undefined) {
					if (requestedRunId !== undefined) {
						await initializeRun(runId);
					}
					await saveRunMeta(runId, {
						chartPath,
						...(exportName === undefined ? {} : { exportName }),
						workDir,
						chartId: parsed.ast.id,
						createdAt: new Date().toISOString(),
						...(deps.sessionId === undefined ? {} : { originSessionId: deps.sessionId }),
					});
				}
				assertRunId(runId);
				const existingStatus = await readRunStatus(runId);
				if (isRunLive(existingStatus)) {
					if (args.wait === true) {
						const boundary = await watchClaudeRunBoundary(runId, interactionOwner(cwd));
						if (boundary.kind === "user") {
							return waitedUserInteractionResult(boundary.interaction, { runId, chartId: parsed.ast.id });
						}
						return waitedRunResult(runId, meta ?? (await loadRunMeta(runId)), deps.sessionId, {
							runId,
							chartId: parsed.ast.id,
							status: compactRunStatus(boundary.status),
						});
					}
					return ok({ runId, chartId: parsed.ast.id, attached: true, status: compactRunStatus(existingStatus) });
				}

				const attemptId = randomUUID();
				await patchRunStatus(runId, {
					chartId: parsed.ast.id,
					state: "starting",
					branchIds,
					attemptId,
					heartbeatAt: Date.now(),
					error: undefined,
					exitCode: undefined,
				});
				const hostPaths = claudeHostPaths();
				const sharedChartsDir = hostPaths.getSharedHyperchartsDir(workDir);
				const { modelRoles, toolsets } = loadHostSettings(
					[
						claudeUserChartsDir(),
						...(sharedChartsDir === undefined ? [] : [sharedChartsDir]),
						hostPaths.getProjectHyperchartsDir(workDir),
					],
					"claude",
				);
				const config: HyperchartRunnerConfig = {
					storage,
					runId,
					chartPath,
					chartId: parsed.ast.id,
					workDir,
					...(Array.isArray(args.branchIds) ? { branchIds } : { branchId }),
					attemptId,
					...(exportName === undefined ? {} : { exportName }),
					...(isRecord(args.args) ? { args: args.args } : {}),
					...(args.ignoreReplayWarnings === true ? { ignoreReplayWarnings: true } : {}),
					...(typeof args.defaultModel === "string" ? { defaultModel: args.defaultModel } : {}),
					...(Object.keys(modelRoles).length === 0 ? {} : { modelRoles }),
					...(Object.keys(toolsets).length === 0 ? {} : { toolsets }),
				};
				const pid = spawnDetachedRunner(config);
				// The child runner alone promotes starting -> running after every replay gate passes.
				await patchRunStatus(runId, { chartId: parsed.ast.id, branchIds, pid, heartbeatAt: Date.now() });
				if (args.wait === true) {
					const boundary = await watchClaudeRunBoundary(runId, interactionOwner(cwd));
					if (boundary.kind === "user") {
						return waitedUserInteractionResult(boundary.interaction, { runId, chartId: parsed.ast.id });
					}
					return waitedRunResult(runId, await loadRunMeta(runId), deps.sessionId, {
						runId,
						chartId: parsed.ast.id,
						status: compactRunStatus(boundary.status),
					});
				}
				return ok({
					runId,
					chartId: parsed.ast.id,
					pid,
					updates: "Terminal updates are automatic; do not start Bash/Monitor polling watchers.",
					...(deps.sessionId === undefined
						? {
								limitation:
									"CLAUDE_CODE_SESSION_ID is unavailable, so automatic terminal notification ownership cannot be established.",
							}
						: {}),
				});
			},
		},
		{
			name: "hyperchart_respond",
			description:
				"Commit the real result of native AskUserQuestion to the exact active Hyperchart user gate. Never call this with an inferred or model-authored answer.",
			inputSchema: {
				runId: z.string().min(1),
				branchId: z.string().min(1),
				seqId: z.number().int().positive(),
				event: z.string().min(1),
				output: z.unknown().optional(),
				...cwdField,
			},
			handler: async (args) => {
				try {
					const cwd = cwdOf(args);
					const owner = interactionOwner(cwd);
					if (owner === undefined) {
						return fail("CLAUDE_CODE_SESSION_ID is unavailable; user interaction ownership cannot be established");
					}
					const runId = args.runId as string;
					const branchId = args.branchId as string;
					const seqId = args.seqId as number;
					if (args.event === "FAILED") {
						return fail("FAILED is reserved and cannot be returned by a user");
					}
					const event = {
						type: args.event as string,
						...(args.output === undefined ? {} : { output: args.output }),
					};
					assertRunId(runId);

					const meta = await loadRunMeta(runId);
					if (meta.originSessionId !== owner.sessionId) {
						return fail(`Run '${runId}' is not owned by this session`);
					}
					if (canonicalPath(meta.workDir) !== canonicalPath(cwd)) {
						return fail(`Run '${runId}' belongs to another working directory`);
					}

					const committed = await validateAndPersistUserInteractionResponse({
						runId,
						branchId,
						seqId,
						event,
						owner,
					});
					return ok({ runId, seqId, event: event.type, committed: true, idempotent: committed.idempotent });
				} catch (error) {
					return fail(error instanceof Error ? error.message : String(error));
				}
			},
		},
		{
			name: "hyperchart_run_inspect",
			description:
				"Inspect one run and return only a bounded status/activity digest. Full runtime state, visits, schemas, and transcripts are available only through hyperchart_view.",
			inputSchema: {
				runId: z.string().describe("Run identity"),
				branchId: z.string().min(1),
				verbose: z.boolean().optional().describe("Deprecated and rejected; use hyperchart_view for full inspection"),
				...cwdField,
			},
			handler: async (args) => {
				if (args.verbose === true) {
					return fail(
						"verbose=true is no longer supported in tool responses; use hyperchart_view for full browser inspection",
					);
				}
				const cwd = cwdOf(args);
				const runId = resolveRunIdArg(args.runId as string, cwd);
				const meta = await loadRunMeta(runId);
				const run = await hyperchartRunFromRunId(runId, {
					branchId: args.branchId as string,
					includeTranscripts: false,
					agentDefaults: createClaudeAgentDefaultsResolver(meta.workDir, meta.chartPath),
				});
				return ok({
					...summarizeRunInspect(run),
					userInteractions: boundedUserInteractions(
						await ownedClaudeUserInteractionSummary({
							storage,
							runsRoot: runsRoot(),
							cwd,
							...(deps.sessionId === undefined ? {} : { sessionId: deps.sessionId }),
						}),
					),
				});
			},
		},
		{
			name: "hyperchart_stop",
			description: "Stop one run (SIGTERM to its runner) or all active runs for this directory.",
			inputSchema: {
				runId: z.string().optional(),
				all: z.boolean().optional(),
				...cwdField,
			},
			handler: async (args) => {
				const cwd = cwdOf(args);
				if ((typeof args.runId === "string") === (args.all === true)) {
					return fail("hyperchart_stop requires exactly one of runId or all=true");
				}
				const targets =
					args.all === true
						? await activeRunIdsForWorkDir(runsRoot(), cwd)
						: [resolveRunIdArg(args.runId as string, cwd)];
				const stopped = await Promise.all(targets.map((runId) => stopRun(runId, cwd)));
				return ok({
					stoppedCount: stopped.length,
					stopped: stopped.slice(0, 20).map((run) => ({
						runId: truncateToolText(run.runId),
						...(run.pid === undefined ? {} : { pid: run.pid }),
					})),
					...(stopped.length <= 20 ? {} : { omittedStoppedCount: stopped.length - 20 }),
				});
			},
		},
		{
			name: "hyperchart_branches",
			description:
				"List one cursor-paged set of durable named branch heads for a run. This read-only operation does not select a branch or write the journal.",
			inputSchema: { runId: z.string(), cursor: z.string().optional(), ...cwdField },
			handler: async (args) => {
				const cwd = cwdOf(args);
				const runId = resolveRunIdArg(args.runId as string, cwd);
				const page = await listHyperchartBranchPage(runId, args.cursor as string | undefined);
				return ok({
					runId,
					branches: page.items.map(({ branchId, headSeqId, createdAt }) => ({ branchId, headSeqId, createdAt })),
					totalCount: page.totalCount,
					...(page.next === undefined ? {} : { next: page.next }),
				});
			},
		},
		{
			name: "hyperchart_fork",
			description: "Create a durable named branch at a historical record without selecting or starting it.",
			inputSchema: {
				runId: z.string(),
				fromSeqId: z.number().int().positive(),
				branchId: z.string().min(1),
				sourceBranchId: z.string().min(1).optional(),
				reason: z.string().optional(),
				...cwdField,
			},
			handler: async (args) => {
				const cwd = cwdOf(args);
				const runId = resolveRunIdArg(args.runId as string, cwd);
				return ok(
					await forkHyperchartRun({
						runId,
						fromSeqId: args.fromSeqId as number,
						branchId: args.branchId as string,
						...(typeof args.sourceBranchId === "string" ? { sourceBranchId: args.sourceBranchId } : {}),
						...(typeof args.reason === "string" ? { reason: args.reason } : {}),
						cwd,
					}),
				);
			},
		},
		{
			name: "hyperchart_rewind",
			description:
				"Append-only move of one stopped run branch head. All records, sessions, gates, notifications, and artifacts are preserved.",
			inputSchema: {
				runId: z.string().describe("Existing run identity to rewind"),
				branchId: z.string().min(1),
				state: z.string().optional().describe("State path to rewind to, e.g. plan.verify-beats#key.verify"),
				seqId: z.number().optional().describe("Durable log seqId to rewind to"),
				to: z.literal("compatible").optional().describe("Cut to the first prefix compatible with the current chart"),
				mode: z
					.enum(["before", "after"])
					.optional()
					.describe("Move the head before or after the matching record. Default: before"),
				...cwdField,
			},
			handler: async (args) => {
				const cwd = cwdOf(args);
				const runId = resolveRunIdArg(args.runId as string, cwd);
				const result = await rewindHyperchartRun({
					runId,
					branchId: args.branchId as string,
					...(typeof args.state === "string" ? { state: args.state } : {}),
					...(typeof args.seqId === "number" ? { seqId: args.seqId } : {}),
					...(args.to === "compatible" ? { to: "compatible" as const } : {}),
					mode: args.mode === "after" ? "after" : "before",
					cwd,
				});
				return ok(compactRewindResult(result));
			},
		},
		{
			name: "hyperchart_steer",
			description:
				"Queue a steering message for a live agent session of a run (delivered after its current tool call).",
			inputSchema: {
				runId: z.string(),
				branchId: z.string().min(1).describe("Branch owning the live session"),
				actionKey: z.string().describe("Action key of the live session, as shown by hyperchart_run_inspect"),
				message: z.string(),
				...cwdField,
			},
			handler: async (args) => {
				const cwd = cwdOf(args);
				const runId = resolveRunIdArg(args.runId as string, cwd);
				const sessionsDir = resolve(resolveRunPaths(runId).runDir, "sessions");
				try {
					const { request, session } = queueLiveSessionSteering(
						sessionsDir,
						args.branchId as string,
						args.actionKey as string,
						args.message as string,
					);
					return ok({
						queued: true,
						requestId: truncateToolText(request.id),
						actionName: truncateToolText(session.actionName),
					});
				} catch (error) {
					return fail(error instanceof Error ? error.message : String(error));
				}
			},
		},
		{
			name: "hyperchart_view",
			description:
				"Open the localhost browser inspector and return its URL. Pass runId for a live/finished run, or chartPath for a static view of a chart definition (reloads the chart on refresh).",
			inputSchema: {
				runId: z.string().optional(),
				branchId: z.string().min(1).optional().describe("Required with runId; non-durable view selection"),
				chartPath: z.string().optional().describe("Chart name or path to view statically (no run required)"),
				open: z.boolean().optional().describe("Set false to return the URL without opening a browser"),
				...cwdField,
			},
			handler: async (args) => {
				const cwd = cwdOf(args);
				if ((typeof args.runId === "string") === (typeof args.chartPath === "string")) {
					return fail("hyperchart_view requires exactly one of runId or chartPath");
				}
				if (typeof args.runId === "string" && typeof args.branchId !== "string") {
					return fail("hyperchart_view runId requires branchId");
				}
				const openBrowser =
					args.open === false
						? { openBrowser: () => undefined }
						: deps.openBrowser === undefined
							? {}
							: { openBrowser: deps.openBrowser };
				if (typeof args.chartPath === "string") {
					const chartPath = claudeHostPaths().resolveChartPath(args.chartPath, cwd);
					await assertChartPreflight(chartPath);
					const agentDefaults = createClaudeAgentDefaultsResolver(cwd, chartPath);
					const loadChart = () => {
						const parsed = parseChartModuleSync(chartPath);
						if (!parsed.ok) {
							throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
						}
						return hyperchartRunFromInspectResult(inspectChartAst(parsed.ast, { chartPath, agentDefaults }), { cwd });
					};
					const chartId = loadChart().chartName;
					const { url } = await openRunInspector({
						runId: `chart:${chartId}`,
						loadRun: async () => loadChart(),
						...openBrowser,
					});
					return ok({ url });
				}
				const runId = resolveRunIdArg(args.runId as string, cwd);
				const meta = await loadRunMeta(runId);
				const sessionsDir = resolve(resolveRunPaths(runId).runDir, "sessions");
				const agentDefaults = createClaudeAgentDefaultsResolver(meta.workDir, meta.chartPath);
				const readTranscript = fileTranscriptReader(sessionsDir);
				const { url } = await openRunInspector({
					runId: runId,
					historyDataSource: await createRunInspectorDataSource(runId, { readTranscript }),
					loadRun: (branchId) =>
						hyperchartRunFromRunId(runId, {
							branchId: branchId ?? (args.branchId as string),
							agentDefaults,
							includeTranscripts: false,
						}),
					steerSession: (branchId, actionKey, message) => {
						queueLiveSessionSteering(sessionsDir, branchId, actionKey, message);
					},
					...openBrowser,
				});
				return ok({ url });
			},
		},
	];
	return tools.map((tool) => ({
		...tool,
		handler: async (args) => {
			try {
				if ("runDir" in args) {
					throw new Error("runDir is not supported; pass runId");
				}
				return await withRunStorage(storage, () => tool.handler(args));
			} catch (error) {
				return fail(error instanceof Error ? error.message : String(error));
			}
		},
	}));
}

type ClaudeRunBoundary =
	| { kind: "terminal"; status: Awaited<ReturnType<typeof watchRun>> }
	| { kind: "user"; interaction: OwnedUserInteraction };

function watchClaudeRunBoundary(runId: string, owner: UserInteractionOwner | undefined): Promise<ClaudeRunBoundary> {
	if (owner === undefined) {
		return watchRun(runId).then((status) => ({ kind: "terminal" as const, status }));
	}
	return new Promise((resolveBoundary, rejectBoundary) => {
		let settled = false;
		const finish = (boundary: ClaudeRunBoundary) => {
			if (settled) {
				return;
			}
			settled = true;
			clearInterval(timer);
			resolveBoundary(boundary);
		};
		let inspecting = false;
		const inspectInteraction = async () => {
			if (inspecting || settled) {
				return;
			}
			inspecting = true;
			try {
				const active = await acquireActiveUserInteraction(owner);
				if (active === undefined) {
					return;
				}
				if (active.presentation === "pending") {
					// Pin only. The MCP tool result has not yet been delivered, so confirmation
					// here would make a crash in the return window suppress recovery.
					claimUserInteractionReceipt(
						active.runId,
						active.request.branchId,
						active.request.seqId,
						"claude",
						owner.sessionId,
						{
							source: "wait",
							leaseMs: USER_INTERACTION_WAIT_LEASE_MS,
						},
					);
				}
				const current = await acquireActiveUserInteraction(owner);
				if (current === undefined || interactionCoordinateKey(current) !== interactionCoordinateKey(active)) {
					return;
				}
				finish({ kind: "user", interaction: current });
			} catch {
				// Isolate malformed/concurrently-created journals and keep watching.
			} finally {
				inspecting = false;
			}
		};
		const timer = setInterval(() => void inspectInteraction(), 100);
		timer.unref();
		watchRun(runId).then(
			(status) => finish({ kind: "terminal", status }),
			(error) => {
				if (settled) {
					return;
				}
				settled = true;
				clearInterval(timer);
				rejectBoundary(error);
			},
		);
		void inspectInteraction();
	});
}

function interactionCoordinateKey(interaction: OwnedUserInteraction): string {
	return `${interaction.request.runId}\0${interaction.request.branchId}\0${interaction.request.seqId}`;
}

function waitedUserInteractionResult(
	interaction: OwnedUserInteraction,
	waitedRun: { runId: string; chartId: string },
): ToolResult {
	let summary: ReturnType<typeof compactUserInteraction>;
	try {
		summary = compactUserInteraction(interaction);
	} catch (error) {
		return fail(
			`Hyperchart cannot safely deliver this user gate through the model boundary. ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return ok({
		boundary: "user",
		final: false,
		runId: interaction.request.runId,
		branchId: interaction.request.branchId,
		chartId: interaction.request.actionUid.chart,
		interaction: summary,
		instruction:
			"Call AskUserQuestion once for this delivery attempt using the bounded preview and output hint, then call hyperchart_respond with this exact runId/branchId/seqId and an allowed event.",
		waitedRun,
		presentation: interaction.presentation === "confirmed" ? "confirmed-recovery" : "claimed-not-confirmed",
	});
}

async function waitedRunResult(
	runId: string,
	meta: RunMeta,
	sessionId: string | undefined,
	value: Record<string, unknown>,
): Promise<ToolResult> {
	if (sessionId === undefined) {
		return ok({
			...value,
			boundary: "terminal",
			final: true,
			limitation:
				"CLAUDE_CODE_SESSION_ID is unavailable; wait=true cannot claim a per-session receipt and automatic routing is disabled.",
		});
	}
	if (meta.originSessionId !== sessionId) {
		return ok({
			...value,
			boundary: "terminal",
			final: true,
			limitation:
				"This run is not owned by the current Claude session; its terminal notification was not receipted here.",
		});
	}
	const request = await readDeliverableTerminalNotificationRequest(runId);
	if (request === undefined) {
		return ok({ ...value, boundary: "terminal", final: true });
	}
	if (!claimTerminalNotificationReceipt(runId, request.requestId, "claude", sessionId)) {
		return ok({
			...value,
			boundary: "terminal",
			final: true,
			deliveryNotice: "Terminal notification delivery is already confirmed or in progress for this Claude session.",
		});
	}
	return ok({
		...value,
		boundary: "terminal",
		final: true,
		outcome: request.payload.outcome,
		deliveryNotice: "Run reached a terminal boundary. Open hyperchart_view for full results.",
	});
}

function compactRunStatus(status: HyperchartRunStatus | undefined) {
	if (status === undefined) {
		return { state: "unknown" as const };
	}
	return {
		state: status.state,
		branchIds: status.branchIds,
		...(status.pid === undefined ? {} : { pid: status.pid }),
		...(status.updatedAt === undefined ? {} : { updatedAt: status.updatedAt }),
		...(status.exitCode === undefined ? {} : { exitCode: status.exitCode }),
		...(status.error === undefined ? {} : { error: truncateToolText(status.error, 400) }),
		...(status.replayWarnings === undefined ? {} : { replayWarningCount: status.replayWarnings.length }),
	};
}

function compactUserInteraction(interaction: OwnedUserInteraction) {
	return summarizeUserGate(interaction.request);
}

/** Entries are already bounded gate summaries; only the queue length still needs a cap. */
function boundedUserInteractions(summary: Awaited<ReturnType<typeof ownedClaudeUserInteractionSummary>>) {
	return {
		...(summary.active === undefined ? {} : { active: summary.active }),
		queued: summary.queued.slice(0, 20),
		...(summary.queued.length <= 20 ? {} : { omittedQueuedCount: summary.queued.length - 20 }),
	};
}

function compactRewindResult(result: Awaited<ReturnType<typeof rewindHyperchartRun>>) {
	return {
		runId: result.runId,
		chartId: result.chartId,
		branchId: result.branchId,
		targetLabel: truncateToolText(result.targetLabel, 400),
		previousHeadSeqId: result.previousHeadSeqId,
		headSeqId: result.headSeqId,
		preservedRecords: result.preservedRecords,
	};
}

function truncateToolText(value: string, max = 160): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function ok(value: unknown): ToolResult {
	const boundedValue = boundedModelEnvelope(value, ({ digest, originalBytes, maxBytes }) => ({
		error: "model-envelope-too-large",
		digest,
		originalBytes,
		maxBytes,
	}));
	const result: ToolResult = { content: [{ type: "text", text: JSON.stringify(boundedValue) }] };
	return boundedToolResult(result);
}

function fail(message: string): ToolResult {
	const bounded = message.length <= 2_000 ? message : `${message.slice(0, 1_999)}…`;
	return boundedToolResult({ content: [{ type: "text", text: bounded }], isError: true });
}

function boundedToolResult(result: ToolResult): ToolResult {
	return boundedModelEnvelope(result, ({ digest, originalBytes, maxBytes }) => {
		const error = { error: "model-envelope-too-large", digest, originalBytes, maxBytes };
		return { content: [{ type: "text", text: JSON.stringify(error) }], isError: true };
	});
}

/** Derive the spec `resolveChartPath` accepts back: bundle dir for `<dir>/chart.ts`, else the filename without its chart extension. */
function chartNameFor(chartPath: string, root: string): string {
	const rel = relative(root, chartPath).replaceAll("\\", "/");
	if (rel !== "chart.ts" && rel.endsWith("/chart.ts")) {
		return rel.slice(0, -"/chart.ts".length);
	}
	return rel.replace(/(?:\.chart)?\.ts$/, "");
}

async function runIdsFor(root: string, cwd: string): Promise<string[]> {
	const candidates = await listRunIds();
	const owned = await Promise.all(
		candidates.map(async (path) => {
			try {
				return resolve((await loadRunMeta(path)).workDir) === resolve(cwd) ? path : undefined;
			} catch {
				return undefined;
			}
		}),
	);
	return owned.filter((path): path is string => path !== undefined).sort();
}

async function activeRunIdsForWorkDir(root: string, cwd: string): Promise<string[]> {
	const candidates = await Promise.all(
		(await runIdsFor(root, cwd)).map(async (runId) => ({ runId, status: await readRunStatus(runId) })),
	);
	return candidates
		.filter(
			({ status }) =>
				status !== undefined && (isRunLive(status) || ["starting", "running", "stopping"].includes(status.state)),
		)
		.map(({ runId }) => runId);
}

async function stopRun(runId: string, cwd: string): Promise<{ runId: string; pid?: number }> {
	const meta = await loadRunMeta(runId);
	if (resolve(meta.workDir) !== resolve(cwd)) {
		throw new Error(`Run '${runId}' belongs to ${meta.workDir}; run from that directory`);
	}
	const status = await readRunStatus(runId);
	await patchRunStatus(runId, { state: "stopping" });
	const pid = status?.pid !== undefined && isPidAlive(status.pid) ? status.pid : undefined;
	if (pid === undefined) {
		await patchRunStatus(runId, { state: "stopped", exitCode: 0, error: "runner was not live" });
	} else {
		process.kill(pid, "SIGTERM");
	}
	return { runId: runId, ...(pid === undefined ? {} : { pid }) };
}

function canonicalPath(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync.native(absolute);
	} catch {
		return absolute;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
