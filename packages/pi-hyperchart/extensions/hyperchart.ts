import { AsyncLocalStorage } from "node:async_hooks";
import { assertRunId, resolveRunPaths, listRunIds, parseRunLogStorage } from "@surprisal/hyperchart/runtime";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as hostPiCodingAgent from "@earendil-works/pi-coding-agent";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getPackageDir,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createJiti } from "jiti";
import {
	inspectChartModuleSync,
	parseChartModuleSync,
	type ChartAst,
	type DurableLogRecord,
} from "@surprisal/hyperchart";
import {
	assertChartPreflight,
	claimTerminalNotificationReceipt,
	currentRunLogStorage,
	createRun,
	deleteRunStorage,
	initializeRun,
	hasTerminalNotificationReceipt,
	loadHostSettings,
	loadRunMeta,
	markTerminalNotificationReceipt,
	openRunLogStore,
	readDeliverableTerminalNotificationRequest,
	removeTerminalNotificationReceipt,
	recoverStaleRunTerminalNotification,
	saveRunMeta,
	withRunLogStorage,
	type RunLogStorage,
	type RunMeta,
} from "@surprisal/hyperchart/runtime";
import {
	USER_INTERACTION_WAIT_LEASE_MS,
	acquireActiveUserInteraction,
	claimUserInteractionReceipt,
	forkHyperchartRun,
	listHyperchartBranchPage,
	markUserInteractionReceipt,
	rewindHyperchartRun,
	scanOwnedOpenUserInteractions,
	validateAndPersistUserInteractionResponse,
	type OwnedUserInteraction,
	type RunTerminalState,
	type UserInteractionOwner,
} from "@surprisal/hyperchart/runner";
import { readBranchExecutionOverview } from "@surprisal/hyperchart/inspect";
import {
	getHyperchartRunsRoot,
	getProjectHyperchartsDir,
	getSharedHyperchartsDir,
	listHyperchartFiles,
	listProjectHypercharts,
	resolveHyperchartPath,
} from "../src/runtime/pi/paths.js";
import {
	isPidAlive,
	isRunLive,
	isTerminalRunState,
	patchRunStatus,
	queueLiveSessionSteering,
	readRunStatus,
	type HyperchartRunStatus,
} from "@surprisal/hyperchart/sessions";
import type { HyperchartRunnerConfig } from "../src/runtime/pi/hyperchart_runner.js";
import { createAgentDefaultsResolver } from "../src/runtime/pi/agent_definitions.js";
import { RunHistoryOverlay, RunWidget, type RunHistoryAction, type RunHistoryItem } from "../src/tui/components.js";
import { buildRunView, type RunView } from "../src/tui/run_view.js";
import {
	boundedModelEnvelope,
	hyperchartRunFromInspectResult,
	summarizeChartInspect,
	summarizeRunInspect,
	summarizeUserGate,
} from "@surprisal/hyperchart/host";
import {
	createPiFileTranscriptReader,
	hyperchartRunFromRunId,
	type SessionTranscriptReader,
} from "../src/runtime/pi/run_inspect.js";
import { closeRunInspectorServer, createRunInspectorDataSource, openRunInspector } from "@surprisal/hyperchart/inspect";

const require = createRequire(import.meta.url);
import { HYPERCHART_COMMAND_EVENT, type HyperchartCommandRequest } from "../src/command.js";

type RunSnapshot = {
	runId: string;
	ast: ChartAst;
	status?: HyperchartRunStatus;
	live: boolean;
};
type RunHistoryEntry = {
	runId: string;
	meta: RunMeta;
	status?: HyperchartRunStatus;
	live: boolean;
	final: boolean;
	terminalState?: RunTerminalState;
	sessionCount: number;
	updatedAt: number;
};
type ActiveRun = RunSnapshot & { done: Promise<HyperchartRunStatus> };
type HyperchartContext = Pick<ExtensionContext, "cwd" | "mode" | "model" | "sessionManager" | "ui" | "isIdle">;
export type HyperchartExtensionOptions = {
	transcriptReaderForRun(runId: string): SessionTranscriptReader;
	storage: RunLogStorage;
	close?(): void | Promise<void>;
};

type PiTerminalDelivery = {
	api: ExtensionAPI;
	currentContext: () => HyperchartContext | undefined;
	transcriptReaderForRun(runId: string): SessionTranscriptReader;
	interactions?: PiUserInteractionCoordinator;
};
type RunStartOptions = {
	chartPath?: string;
	branchId?: string;
	branchIds?: string[];
	args?: Record<string, unknown>;
	runId?: string;
	exportName?: string;
	ignoreReplayWarnings?: boolean;
	/** Synchronous tool/command waits return and receipt the prompt instead of injecting it. */
	wait?: boolean;
	/** Per-registration delivery channel; never retain a stale session context globally. */
	delivery?: PiTerminalDelivery;
};
type RunStartResult = { runId: string; chartId: string; done: Promise<HyperchartRunStatus> };

class RunManager {
	readonly active = new Map<string, ActiveRun>();
	completions = new Map<string, RunMeta>();
	completionRefresh = 0;
	lastRunId: string | undefined;

	add(run: ActiveRun): void {
		this.active.set(run.runId, run);
		this.lastRunId = run.runId;
	}

	remove(runId: string, expected?: ActiveRun): boolean {
		if (expected !== undefined && this.active.get(runId) !== expected) {
			return false;
		}
		return this.active.delete(runId);
	}

	get(runId: string | undefined): ActiveRun | undefined {
		return this.active.get(runId ?? this.lastRunId ?? "");
	}
}

const runManagerScope = new AsyncLocalStorage<RunManager>();
function currentRuns(): RunManager {
	const manager = runManagerScope.getStore();
	if (manager === undefined) {
		throw new Error("Hyperchart registration scope is unavailable");
	}
	return manager;
}

const runnerEntry = fileURLToPath(new URL("../src/runtime/pi/hyperchart_runner.mjs", import.meta.url));
const SUBCOMMAND_COMPLETIONS: AutocompleteItem[] = [
	{ value: "run", label: "run", description: "start chart" },
	{ value: "resume", label: "resume", description: "resume run id" },
	{ value: "steer", label: "steer", description: "steer a live agent session" },
	{ value: "restart", label: "restart", description: "restart run as new run" },
	{ value: "stop", label: "stop", description: "stop run id" },
	{ value: "delete", label: "delete", description: "delete old run dir" },
	{ value: "rm", label: "rm", description: "delete old run dir" },
	{ value: "view", label: "view", description: "open run view" },
	{ value: "status", label: "status", description: "show active runs" },
	{ value: "--limit", label: "--limit", description: "limit default run list" },
];
const RUN_OPTION_COMPLETIONS: AutocompleteItem[] = [
	{ value: "--args", label: "--args", description: "JSON args" },
	{ value: "--run-id", label: "--run-id", description: "durable run identity" },
	{ value: "--export", label: "--export", description: "named chart export" },
	{ value: "--wait", label: "--wait", description: "wait synchronously for completion" },
	{
		value: "--ignore-replay-warnings",
		label: "--ignore-replay-warnings",
		description: "explicitly continue despite stale/skipped replay warnings",
	},
];
const HYPERCHART_USAGE =
	"Usage: /hyperchart [runId|--limit N] | run <name|chart.ts> [--args JSON] [--run-id RUN_ID] [--export NAME] [--wait] [--ignore-replay-warnings] | resume <runId> [--branch BRANCH_ID]... [--ignore-replay-warnings] | steer <runId> <branchId> <actionKey> <message> | restart <runId> | status | stop <runId> | delete <runId> | view [runId]";

function completeHyperchartArgs(argumentPrefix: string, cwd: string): AutocompleteItem[] | null {
	const parsed = parseCompletionPrefix(argumentPrefix);
	if (parsed.previous.length === 0) {
		return completeTopLevelArgs(parsed.current, cwd);
	}
	const command = parsed.previous[0];
	const previous = parsed.previous.slice(1);
	if (command === "run") {
		return prependCompletionPrefix(completeRunArgs(previous, parsed.current, cwd), parsed.previous);
	}
	if (command === "resume") {
		return prependCompletionPrefix(completeResumeArgs(previous, parsed.current, cwd), parsed.previous);
	}
	if (command === "steer" && previous.length === 0) {
		return prependCompletionPrefix(filterCompletions(runIdCompletions(cwd), parsed.current), parsed.previous);
	}
	if (command === "restart" || command === "stop" || command === "view" || command === "delete" || command === "rm") {
		return prependCompletionPrefix(filterCompletions(runIdCompletions(cwd), parsed.current), parsed.previous);
	}
	if (command === "--limit") {
		return null;
	}
	return null;
}

function completeTopLevelArgs(current: string, cwd: string): AutocompleteItem[] | null {
	const commands = filterCompletions(SUBCOMMAND_COMPLETIONS, current) ?? [];
	const runs = filterCompletions(runIdCompletions(cwd), current) ?? [];
	const items = [...commands, ...runs];
	return items.length === 0 ? null : items;
}

function completeResumeArgs(previous: string[], current: string, cwd: string): AutocompleteItem[] | null {
	if (previous.at(-1) === "--branch") {
		return null;
	}
	if (current.startsWith("--")) {
		return filterCompletions(
			[
				{ value: "--branch", label: "--branch", description: "durable branch to resume; repeat for multiple branches" },
				{
					value: "--ignore-replay-warnings",
					label: "--ignore-replay-warnings",
					description: "explicitly continue despite stale/skipped replay warnings",
				},
			],
			current,
		);
	}
	const hasRunId = previous.some((token, index) => !token.startsWith("--") && previous[index - 1] !== "--branch");
	if (hasRunId) {
		return current.length === 0 ? completeResumeArgs([], "--", cwd) : null;
	}
	return filterCompletions(runIdCompletions(cwd), current);
}

function completeRunArgs(previous: string[], current: string, cwd: string): AutocompleteItem[] | null {
	const last = previous.at(-1);
	if (last === "--run-id") {
		return filterCompletions(runIdCompletions(cwd), current);
	}
	if (last === "--args" || last === "--export") {
		return null;
	}
	if (current.startsWith("--")) {
		return filterCompletions(RUN_OPTION_COMPLETIONS, current);
	}
	const hasChart = previous.some(
		(token, index) =>
			!token.startsWith("--") &&
			previous[index - 1] !== "--run-id" &&
			previous[index - 1] !== "--args" &&
			previous[index - 1] !== "--export",
	);
	if (hasChart) {
		return current.length === 0 ? filterCompletions(RUN_OPTION_COMPLETIONS, current) : null;
	}
	return filterCompletions(chartCompletions(cwd), current);
}

function prependCompletionPrefix(
	items: AutocompleteItem[] | null,
	previous: readonly string[],
): AutocompleteItem[] | null {
	if (items === null) {
		return null;
	}
	const prefix = previous.length === 0 ? "" : `${previous.join(" ")} `;
	return items.map((item) => ({ ...item, value: `${prefix}${item.value}` }));
}

function parseCompletionPrefix(prefix: string): { previous: string[]; current: string } {
	const trailingSpace = /\s$/.test(prefix);
	const tokens = safeTokenize(prefix);
	if (trailingSpace) {
		return { previous: tokens, current: "" };
	}
	return { previous: tokens.slice(0, -1), current: tokens.at(-1) ?? "" };
}

function safeTokenize(input: string): string[] {
	try {
		return tokenize(input);
	} catch {
		return input.trim().split(/\s+/).filter(Boolean);
	}
}

function chartCompletions(cwd: string): AutocompleteItem[] {
	return listProjectHypercharts(cwd).map((file) => {
		const name = file.replace(/\.chart\.ts$/, "").replace(/\.ts$/, "");
		return { value: name, label: name, description: file };
	});
}

function runIdCompletions(cwd: string): AutocompleteItem[] {
	return [...currentRuns().completions]
		.filter(([, meta]) => resolve(meta.workDir) === resolve(cwd))
		.map(([runId, meta]) => ({ value: runId, label: runId, description: meta.chartId }));
}

async function refreshRunCompletions(): Promise<void> {
	const manager = currentRuns();
	const generation = ++manager.completionRefresh;
	const entries = new Map<string, RunMeta>();
	try {
		for (const runId of await listRunIds()) {
			const meta = await loadRunMetaIfPresent(runId).catch(() => undefined);
			if (meta !== undefined) {
				entries.set(runId, meta);
			}
		}
	} catch {
		// Completion is auxiliary; unavailable metadata yields no stale suggestions.
		entries.clear();
	}
	if (manager.completionRefresh === generation) {
		manager.completions = entries;
	}
}

function filterCompletions(items: readonly AutocompleteItem[], current: string): AutocompleteItem[] | null {
	const needle = current.toLowerCase();
	const filtered = items.filter(
		(item) => item.value.toLowerCase().includes(needle) || item.label.toLowerCase().includes(needle),
	);
	return filtered.length === 0 ? null : filtered;
}

function loadHyperchartExtensionOptions(cwd: string): HyperchartExtensionOptions {
	const configPath = join(cwd, ".pi", "hyperchart.config.ts");
	if (!existsSync(configPath)) {
		return {
			transcriptReaderForRun: createPiFileTranscriptReader,
			storage: { kind: "jsonl", rootDir: getHyperchartRunsRoot(), layout: "run-id" },
		};
	}
	const module = createJiti(pathToFileURL(configPath).href, {
		interopDefault: true,
		moduleCache: false,
		virtualModules: { "@earendil-works/pi-coding-agent": hostPiCodingAgent },
	})(configPath) as unknown;
	const loaded = (
		typeof module === "object" && module !== null && "default" in module ? module.default : module
	) as Partial<HyperchartExtensionOptions>;
	if (typeof loaded.transcriptReaderForRun !== "function") {
		throw new Error(`${configPath} must export transcriptReaderForRun(runId)`);
	}
	return {
		transcriptReaderForRun: loaded.transcriptReaderForRun,
		storage: parseExtensionStorage(loaded.storage, configPath),
		...(typeof loaded.close === "function" ? { close: loaded.close } : {}),
	};
}

function parseExtensionStorage(value: unknown, configPath: string): RunLogStorage {
	if (value === undefined) {
		return { kind: "jsonl", rootDir: getHyperchartRunsRoot(), layout: "run-id" };
	}
	const storage = parseRunLogStorage(value);
	if (storage === undefined) {
		throw new Error(`${configPath} requires storage kind, rootDir and layout`);
	}
	return storage;
}

export default function registerDefault(pi: ExtensionAPI) {
	register(pi, loadHyperchartExtensionOptions(process.cwd()));
}

export function register(pi: ExtensionAPI, options: HyperchartExtensionOptions) {
	registerBundleExtensions(pi, process.cwd());
	const manager = new RunManager();
	const storage = Object.freeze({ ...options.storage, rootDir: resolve(options.storage.rootDir) });
	const inStorageScope = <T>(operation: () => T): T =>
		runManagerScope.run(manager, () => withRunLogStorage(storage, operation));
	let completionCwd = process.cwd();
	const invoke = <T>(cwd: string, operation: () => Promise<T>): Promise<T> =>
		inStorageScope(async () => {
			completionCwd = cwd;
			try {
				return await operation();
			} finally {
				await refreshRunCompletions();
			}
		});
	let currentCtx: HyperchartContext | undefined;
	const interactions = new PiUserInteractionCoordinator(pi, () => currentCtx);
	const delivery: PiTerminalDelivery = {
		api: pi,
		currentContext: () => currentCtx,
		transcriptReaderForRun: options.transcriptReaderForRun,
		interactions,
	};
	pi.registerCommand("hyperchart", {
		description: "Run and inspect hyperchart workflows",
		handler: async (args, ctx) => invoke(ctx.cwd, () => dispatch(args, ctx, true, delivery)),
		getArgumentCompletions: (prefix) => inStorageScope(() => completeHyperchartArgs(prefix, completionCwd)),
	});
	const hyperchartTool = createHyperchartTool(delivery);
	const executeHyperchartTool = hyperchartTool.execute.bind(hyperchartTool);
	pi.registerTool({
		...hyperchartTool,
		execute: (...args: Parameters<typeof executeHyperchartTool>) =>
			invoke(args[4].cwd, () => executeHyperchartTool(...args)),
	});
	pi.events.on(HYPERCHART_COMMAND_EVENT, (payload) => {
		const request = payload as HyperchartCommandRequest;
		request.claim(async () =>
			inStorageScope(async () => {
				const ctx = currentCtx;
				if (ctx === undefined) {
					throw new Error("Hyperchart session context is not ready");
				}
				await invoke(ctx.cwd, () => dispatch(request.args, ctx, false, delivery));
			}),
		);
	});
	pi.on("session_start", async (event, ctx) =>
		inStorageScope(async () => {
			currentCtx = ctx;
			completionCwd = ctx.cwd;
			await refreshRunCompletions();
			if (event.reason === "reload" || event.reason === "startup" || event.reason === "resume") {
				await restoreRunWidgets(ctx);
			}
			interactions.start();
			// One arbitration scan presents an owned gate first, or recovers terminals when
			// no gate is active. Do not run a separate terminal pass ahead of the gate.
			await interactions.scan();
		}),
	);
	pi.on("agent_settled", async () => inStorageScope(() => interactions.scan()));
	pi.on("before_agent_start", async (event) => inStorageScope(() => interactions.beforeAgentStart(event.prompt)));
	pi.on("session_shutdown", async () => {
		interactions.stop();
		currentCtx = undefined;
		await closeRunInspectorServer();
		await options.close?.();
	});
}

type PiInteractionPhase = "pending" | "yielding" | "awaiting-user";
type PiInteractionState = { key?: string; phase: PiInteractionPhase };

class PiUserInteractionCoordinator {
	private state: PiInteractionState = { phase: "pending" };
	private timer: NodeJS.Timeout | undefined;
	private scanning: Promise<void> | undefined;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly currentContext: () => HyperchartContext | undefined,
	) {}

	start(): void {
		this.stopTimer();
		const ctx = this.currentContext();
		if (currentRunLogStorage()?.kind !== "jsonl") {
			return;
		}
		// Real Pi contexts always expose isIdle. Minimal extension-test contexts may not;
		// those still receive the immediate scan without leaking a process-wide timer.
		if (ctx === undefined || typeof ctx.isIdle !== "function") {
			return;
		}
		// Journal scans load and project every owned run. A short polling cadence is
		// responsive without continuously occupying the Pi host while it is idle.
		this.timer = setInterval(() => void this.scan(), 5_000);
		this.timer.unref();
	}

	stop(): void {
		this.stopTimer();
		this.state = { phase: "pending" };
	}

	async scan(): Promise<void> {
		if (this.scanning !== undefined) {
			return this.scanning;
		}
		this.scanning = this.scanOnce()
			.catch(() => {
				// A resolution/close can land between arbitration and a receipt write. The loser
				// must not crash the host; the next periodic scan converges on the new mailbox state.
			})
			.finally(() => {
				this.scanning = undefined;
			});
		return this.scanning;
	}

	async beforeAgentStart(_userPrompt: string) {
		const ctx = this.currentContext();
		if (ctx === undefined || currentRunLogStorage()?.kind !== "jsonl") {
			return undefined;
		}
		const active = await acquireActiveUserInteraction(interactionOwner(ctx));
		if (active === undefined || active.presentation !== "confirmed") {
			return undefined;
		}
		this.state = { key: interactionKey(active), phase: "awaiting-user" };
		let details: ReturnType<typeof compactPiUserInteraction>;
		try {
			details = compactPiUserInteraction(active);
		} catch (error) {
			return { message: undeliverablePiGateMessage(active, error) };
		}
		return {
			message: boundedPiMessage({
				customType: "hyperchart-user-response-context",
				content: [
					`Hyperchart interaction (${details.runId}, ${details.branchId}, ${details.seqId}) is awaiting the user's answer.`,
					`Question preview: ${details.promptPreview.text}`,
					`Allowed events: ${details.allowedEvents.join(", ")}`,
					details.outputRequired
						? `Structured output is required. Bounded shape hint: ${JSON.stringify(details.outputHint)}.`
						: undefined,
					'The extension does not answer automatically; the model calls hyperchart action="respond" only when the user\'s just-submitted prompt actually answers the displayed gate.',
					'If the prompt is unrelated, continue that request and leave the gate open; do not call action="respond".',
					`If it answers the gate, translate it into one allowed event and optional output, then call hyperchart with action="respond", runId=${JSON.stringify(details.runId)}, branchId=${JSON.stringify(details.branchId)}, seqId=${details.seqId}, event, and output when required.`,
					"Do not answer the gate yourself or infer consent without real user input.",
				]
					.filter((line): line is string => line !== undefined)
					.join("\n"),
				display: false,
				details: safeToolDetails(details),
			}),
		};
	}

	private async scanOnce(): Promise<void> {
		const ctx = this.currentContext();
		if (ctx === undefined) {
			return;
		}
		const active = await activePiUserInteraction(ctx);
		if (active === undefined) {
			this.state = { phase: "pending" };
			const idle = typeof ctx.isIdle !== "function" || ctx.isIdle();
			if (idle) {
				await recoverPiTerminalNotifications(this.pi, ctx);
			}
			return;
		}
		const key = interactionKey(active);
		if (this.state.key !== key) {
			this.state = { key, phase: "pending" };
		}

		try {
			compactPiUserInteraction(active);
		} catch (error) {
			this.pi.sendMessage(undeliverablePiGateMessage(active, error), { deliverAs: "followUp" });
			markUserInteractionReceipt(
				active.runId,
				active.request.branchId,
				active.request.seqId,
				"pi",
				ctx.sessionManager.getSessionId(),
			);
			this.state = { key, phase: "awaiting-user" };
			return;
		}

		if (piSessionContainsUserInteraction(ctx, "hyperchart-user-request", active)) {
			markUserInteractionReceipt(
				active.runId,
				active.request.branchId,
				active.request.seqId,
				"pi",
				ctx.sessionManager.getSessionId(),
			);
			this.state = { key, phase: "awaiting-user" };
			return;
		}
		if (active.presentation === "confirmed") {
			this.state = { key, phase: "awaiting-user" };
			return;
		}

		const idle = typeof ctx.isIdle !== "function" || ctx.isIdle();
		if (!idle) {
			if (this.state.phase === "yielding" || piSessionContainsUserInteraction(ctx, "hyperchart-yield", active)) {
				this.state = { key, phase: "yielding" };
				return;
			}
			if (
				active.presentation === "pending" &&
				!claimUserInteractionReceipt(
					active.runId,
					active.request.branchId,
					active.request.seqId,
					"pi",
					ctx.sessionManager.getSessionId(),
				)
			) {
				return;
			}
			if (!(await this.isStillActive(ctx, key))) {
				return;
			}
			this.pi.sendMessage(
				boundedPiMessage({
					customType: "hyperchart-yield",
					content: `Hyperchart reached user interaction (${active.request.runId}, ${active.request.seqId}). Finish the current safe action/tool batch, do not answer it yourself, and yield so the real user can respond.`,
					display: false,
					details: safeToolDetails(compactPiUserInteraction(active)),
				}),
				{ deliverAs: "steer" },
			);
			this.state = { key, phase: "yielding" };
			return;
		}

		if (
			active.presentation === "pending" &&
			!claimUserInteractionReceipt(
				active.runId,
				active.request.branchId,
				active.request.seqId,
				"pi",
				ctx.sessionManager.getSessionId(),
			)
		) {
			return;
		}
		if (!(await this.isStillActive(ctx, key))) {
			return;
		}
		this.pi.sendMessage(
			boundedPiMessage({
				customType: "hyperchart-user-request",
				content: formatCompactUserInteraction(active),
				display: true,
				details: safeToolDetails(compactPiUserInteraction(active)),
			}),
			{ deliverAs: "followUp", triggerTurn: true },
		);
		markUserInteractionReceipt(
			active.runId,
			active.request.branchId,
			active.request.seqId,
			"pi",
			ctx.sessionManager.getSessionId(),
		);
		this.state = { key, phase: "awaiting-user" };
	}

	private async isStillActive(ctx: HyperchartContext, expectedKey: string): Promise<boolean> {
		const current = await acquireActiveUserInteraction(interactionOwner(ctx));
		if (current !== undefined && interactionKey(current) === expectedKey) {
			return true;
		}
		this.state = current === undefined ? { phase: "pending" } : { key: interactionKey(current), phase: "pending" };
		return false;
	}

	private stopTimer(): void {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
		}
		this.timer = undefined;
	}
}

function canonicalHostPath(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync.native(absolute);
	} catch {
		return absolute;
	}
}

function interactionOwner(ctx: HyperchartContext): UserInteractionOwner {
	const storage = currentRunLogStorage();
	if (storage?.kind !== "jsonl") {
		throw new Error("User interaction ownership requires JSONL run storage");
	}
	return {
		runsRoot: storage.rootDir,
		host: "pi",
		sessionId: ctx.sessionManager.getSessionId(),
		workDir: ctx.cwd,
	};
}

// Pi's user-gate presentation is currently JSONL-only. Terminal notifications
// and their receipts work with either backend and must not enter that adapter.
async function activePiUserInteraction(ctx: HyperchartContext): Promise<OwnedUserInteraction | undefined> {
	return currentRunLogStorage()?.kind === "jsonl" ? acquireActiveUserInteraction(interactionOwner(ctx)) : undefined;
}

function interactionKey(active: OwnedUserInteraction): string {
	return `${active.request.runId}\0${active.request.branchId}\0${active.request.seqId}`;
}

async function inspectOwnedUserInteractions(ctx: HyperchartContext) {
	if (currentRunLogStorage()?.kind !== "jsonl") {
		return { active: undefined, queued: [] };
	}
	const interactions = await scanOwnedOpenUserInteractions(interactionOwner(ctx));
	const active = await acquireActiveUserInteraction(interactionOwner(ctx));
	const activeKey = active === undefined ? undefined : interactionKey(active);
	return {
		active: active === undefined ? undefined : { ...interactionDetails(active), presentation: active.presentation },
		queued: interactions
			.filter((interaction) => interactionKey(interaction) !== activeKey)
			.map((interaction) => ({ ...interactionDetails(interaction), presentation: interaction.presentation })),
	};
}

function interactionDetails(active: OwnedUserInteraction) {
	return {
		version: 1 as const,
		runId: active.request.runId,
		branchId: active.request.branchId,
		seqId: active.request.seqId,
		prompt: active.request.prompt,
		options: active.request.options,
		allowedEvents: active.request.events.filter((event) => event !== "FAILED"),
		...(active.request.reply === undefined ? {} : { reply: active.request.reply }),
	};
}

function compactPiUserInteraction(active: OwnedUserInteraction) {
	return summarizeUserGate(active.request);
}

function undeliverablePiGateMessage(active: OwnedUserInteraction, error: unknown) {
	const reason = truncateToolText(error instanceof Error ? error.message : String(error), 1_000);
	return boundedPiMessage({
		customType: "hyperchart-boundary-error",
		content: `Hyperchart cannot safely deliver this user interaction through the Pi model boundary. ${reason}`,
		display: true,
		details: { error: "user-gate-summary-unavailable", seqId: active.request.seqId },
	});
}

function compactPiUserInteractions(summary: Awaited<ReturnType<typeof inspectOwnedUserInteractions>>) {
	const compact = (entry: NonNullable<typeof summary.active>) => ({
		...summarizeUserGate({
			runId: entry.runId,
			branchId: entry.branchId,
			seqId: entry.seqId,
			prompt: entry.prompt,
			options: entry.options,
			events: entry.allowedEvents,
			...(entry.reply === undefined ? {} : { reply: entry.reply }),
		}),
		presentation: entry.presentation,
	});
	return {
		...(summary.active === undefined ? {} : { active: compact(summary.active) }),
		queued: summary.queued.slice(0, 20).map(compact),
		...(summary.queued.length <= 20 ? {} : { omittedQueuedCount: summary.queued.length - 20 }),
	};
}

function formatCompactUserInteraction(active: OwnedUserInteraction): string {
	const details = compactPiUserInteraction(active);
	return [
		`Hyperchart needs your input for (${details.runId}, ${details.branchId}, ${details.seqId}).`,
		`Question preview: ${details.promptPreview.text}`,
		details.options.length === 0
			? undefined
			: `Options (label => exact value): ${details.options.map((option) => `${JSON.stringify(option.label.text)} => ${JSON.stringify(option.value)}`).join(", ")}`,
		`Allowed events: ${details.allowedEvents.join(", ")}`,
		details.outputRequired
			? `Structured output is required. Shape hint: ${JSON.stringify(details.outputHint)}.`
			: undefined,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

function formatUserInteraction(active: OwnedUserInteraction): string {
	const details = interactionDetails(active);
	return [
		`Hyperchart needs your input for (${details.runId}, ${details.branchId}, ${details.seqId}).`,
		details.prompt,
		details.options.length === 0 ? undefined : `Options: ${details.options.join(", ")}`,
		`Allowed events: ${details.allowedEvents.join(", ")}`,
		details.reply === undefined ? undefined : `Reply contract: ${JSON.stringify(details.reply)}`,
		"Reply normally in your next message. Hyperchart will commit that real input explicitly before continuing.",
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

function piSessionContainsUserInteraction(
	ctx: HyperchartContext,
	customType: "hyperchart-yield" | "hyperchart-user-request",
	active: OwnedUserInteraction,
): boolean {
	return ctx.sessionManager.getEntries().some((entry) => {
		if (
			entry.type !== "custom_message" ||
			entry.customType !== customType ||
			typeof entry.details !== "object" ||
			entry.details === null ||
			!("runId" in entry.details) ||
			!("branchId" in entry.details) ||
			!("seqId" in entry.details) ||
			(entry.details as { runId?: unknown }).runId !== active.request.runId ||
			(entry.details as { branchId?: unknown }).branchId !== active.request.branchId ||
			(entry.details as { seqId?: unknown }).seqId !== active.request.seqId
		) {
			return false;
		}
		// A newly created request must not be acknowledged by an older session message.
		const entryTime = Date.parse(entry.timestamp);
		const requestTime = Date.parse(active.request.createdAt);
		return !Number.isFinite(entryTime) || !Number.isFinite(requestTime) || entryTime >= requestTime;
	});
}

function registerBundleExtensions(pi: ExtensionAPI, cwd: string): void {
	for (const bundleDir of discoverBundleDirs(cwd)) {
		const extensionsDir = join(bundleDir, "extensions");
		for (const entryPath of bundleExtensionEntries(extensionsDir)) {
			try {
				const jiti = createJiti(pathToFileURL(entryPath).href, {
					interopDefault: true,
					moduleCache: false,
					alias: { typebox: require.resolve("typebox") },
				});
				const loaded = jiti(entryPath) as unknown;
				const register =
					typeof loaded === "function"
						? loaded
						: typeof (loaded as { default?: unknown })?.default === "function"
							? (loaded as { default: (api: ExtensionAPI) => void }).default
							: undefined;
				if (register === undefined) {
					throw new Error("default export must be an extension registration function");
				}
				register(pi);
			} catch (error) {
				console.warn(`[pi-hyperchart] Failed to load bundle extension ${entryPath}:`, error);
			}
		}
	}
}

function discoverBundleDirs(cwd: string): string[] {
	const projectRoot = getProjectHyperchartsDir(cwd);
	const sharedRoot = getSharedHyperchartsDir(cwd);
	const userRoot = resolve(getAgentDir(), "hypercharts");
	const byName = new Map<string, string>();
	for (const root of [userRoot, ...(sharedRoot === undefined ? [] : [sharedRoot]), projectRoot]) {
		if (!existsSync(root)) {
			continue;
		}
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || entry.name === "runs" || entry.name === "node_modules") {
				continue;
			}
			const bundleDir = join(root, entry.name);
			if (
				!(entry.isDirectory() || (entry.isSymbolicLink() && existsSync(bundleDir) && statSync(bundleDir).isDirectory()))
			) {
				continue;
			}
			if (existsSync(join(bundleDir, "chart.ts"))) {
				byName.set(entry.name, bundleDir);
			}
		}
	}
	return [...byName.values()];
}

function bundleExtensionEntries(extensionsDir: string): string[] {
	if (!existsSync(extensionsDir)) {
		return [];
	}
	const entries: string[] = [];
	if (existsSync(join(extensionsDir, "index.ts"))) {
		entries.push(join(extensionsDir, "index.ts"));
	}
	for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
		if (entry.isDirectory() && !entry.name.startsWith(".") && existsSync(join(extensionsDir, entry.name, "index.ts"))) {
			entries.push(join(extensionsDir, entry.name, "index.ts"));
		}
	}
	return entries.sort();
}

function createHyperchartTool(delivery: PiTerminalDelivery) {
	return defineTool({
		name: "hyperchart",
		label: "Hyperchart",
		description:
			"List, inspect, run, and manage Hyperchart workflows. Fresh runs default to branch main. Run-target actions accept runId only; respond requires its exact runId, branchId, and seqId.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("list"),
				Type.Literal("inspect"),
				Type.Literal("run"),
				Type.Literal("run_inspect"),
				Type.Literal("view"),
				Type.Literal("branches"),
				Type.Literal("fork"),
				Type.Literal("rewind"),
				Type.Literal("stop"),
				Type.Literal("respond"),
			]),
			chartPath: Type.Optional(
				Type.String({ description: "Chart name or module path for inspect, fresh run, or static view" }),
			),
			args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Fresh/resumed run arguments" })),
			runId: Type.Optional(
				Type.String({
					description:
						"Run identity for run-target actions; respond requires this exact identity together with branchId and seqId",
				}),
			),
			branchId: Type.Optional(
				Type.String({ description: "Durable branch; inferred only when a run has exactly one branch" }),
			),
			cursor: Type.Optional(Type.String({ description: "Opaque continuation cursor for action=branches" })),
			branchIds: Type.Optional(
				Type.Array(Type.String(), { description: "Non-empty unique branches to run concurrently" }),
			),
			fromSeqId: Type.Optional(Type.Number({ description: "Existing durable record at which fork creates a branch" })),
			sourceBranchId: Type.Optional(Type.String({ description: "Optional source branch asserted by fork" })),
			reason: Type.Optional(Type.String({ description: "Optional durable fork reason" })),
			exportName: Type.Optional(Type.String({ description: "Named chart export; defaults to default" })),
			wait: Type.Optional(Type.Boolean({ description: "For run, wait for terminal status or an owned user boundary" })),
			open: Type.Optional(
				Type.Boolean({ description: "For view, set false to return the URL without opening a browser" }),
			),
			ignoreReplayWarnings: Type.Optional(
				Type.Boolean({ description: "Explicitly continue despite stale/skipped replay warnings" }),
			),
			state: Type.Optional(Type.String({ description: "State selector for rewind" })),
			seqId: Type.Optional(Type.Number({ description: "Exact positive user-interaction sequence id for respond" })),
			event: Type.Optional(Type.String({ description: "Exact allowed non-FAILED user-interaction event for respond" })),
			output: Type.Optional(Type.Unknown({ description: "Schema-valid structured gate output for respond" })),
			to: Type.Optional(Type.Literal("compatible", { description: "Rewind to the compatible replay prefix" })),
			mode: Type.Optional(
				Type.Union([Type.Literal("before"), Type.Literal("after")], {
					description: "Rewind before or after the selected record",
				}),
			),
			start: Type.Optional(Type.Boolean({ description: "Start the selected branch after rewind" })),
			all: Type.Optional(
				Type.Boolean({ description: "For stop, stop every active run owned by this working directory" }),
			),
			verbose: Type.Optional(
				Type.Boolean({ description: "Deprecated and rejected; use action=view for full browser inspection" }),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			try {
				if ("runDir" in params) {
					throw new Error("runDir is not supported; pass runId");
				}
				return boundedPiToolResult(
					await (async () => {
						if (params.action === "list") {
							return listHypercharts(ctx.cwd);
						}
						if (params.action === "inspect") {
							if (params.verbose === true) {
								throw new Error(
									"verbose=true is no longer supported in tool responses; use hyperchart view for full browser inspection",
								);
							}
							if (params.chartPath === undefined) {
								throw new Error("hyperchart action=inspect requires chartPath");
							}
							return hyperchartInspectTool.execute(
								toolCallId,
								{ chartPath: params.chartPath, exportName: params.exportName, verbose: params.verbose },
								signal,
								onUpdate,
								ctx,
							);
						}
						if (params.action === "run") {
							const runId = actionRunCoordinate(params, "run", false);
							if (params.chartPath === undefined && runId === undefined) {
								throw new Error("hyperchart action=run requires chartPath for a fresh run, or runId to resume");
							}
							if (params.branchId !== undefined && params.branchIds !== undefined) {
								throw new Error(
									"hyperchart action=run accepts branchId or branchIds, not both; omit both only for fresh main or an existing single-branch run",
								);
							}
							return createHyperchartRunTool(delivery).execute(toolCallId, { ...params, runId }, signal, onUpdate, ctx);
						}
						if (params.action === "run_inspect") {
							if (params.verbose === true) {
								throw new Error(
									"verbose=true is no longer supported in tool responses; use hyperchart view for full browser inspection",
								);
							}
							const runId = actionRunCoordinate(params, "run_inspect");
							const branchId = params.branchId ?? (await unambiguousRunBranch("run_inspect", runId, ctx));
							return hyperchartRunInspectTool.execute(
								toolCallId,
								{ runId, branchId, verbose: params.verbose },
								signal,
								onUpdate,
								ctx,
							);
						}
						if (params.action === "view") {
							const runId = actionRunCoordinate(params, "view", false);
							if ((runId === undefined) === (params.chartPath === undefined)) {
								throw new Error("hyperchart action=view requires exactly one of chartPath or runId");
							}
							const branchId =
								runId === undefined ? undefined : (params.branchId ?? (await unambiguousRunBranch("view", runId, ctx)));
							return createHyperchartViewTool(delivery).execute(
								toolCallId,
								{ runId, branchId, chartPath: params.chartPath, open: params.open },
								signal,
								onUpdate,
								ctx,
							);
						}
						if (params.action === "stop") {
							const runId =
								params.all === true ? actionRunCoordinate(params, "stop", false) : actionRunCoordinate(params, "stop");
							return stopHyperchartRuns(
								{
									...(runId === undefined ? {} : { runId }),
									...(params.all === undefined ? {} : { all: params.all }),
								},
								ctx,
							);
						}
						if (params.action === "respond") {
							return respondToUserInteraction(params, ctx, delivery.interactions);
						}
						if (params.action === "branches") {
							const runSpec = actionRunCoordinate(params, "branches");
							const runId = await ownedRunId("branches", runSpec, ctx);
							const page = await listHyperchartBranchPage(runId, params.cursor);
							return {
								content: [{ type: "text" as const, text: `Branches for ${runId}` }],
								details: safeToolDetails({
									runId,
									branches: page.items.map(({ branchId, headSeqId, createdAt }) => ({
										branchId,
										headSeqId,
										createdAt,
									})),
									totalCount: page.totalCount,
									...(page.next === undefined ? {} : { next: page.next }),
								}),
							};
						}
						if (params.action === "fork") {
							const runSpec = actionRunCoordinate(params, "fork");
							if (params.branchId === undefined || !Number.isSafeInteger(params.fromSeqId)) {
								throw new Error("hyperchart action=fork requires branchId and integer fromSeqId, plus runId");
							}
							const runId = checkedRunId(runSpec);
							const result = await forkHyperchartRun({
								runId,
								branchId: params.branchId,
								fromSeqId: params.fromSeqId as number,
								...(params.sourceBranchId === undefined ? {} : { sourceBranchId: params.sourceBranchId }),
								...(params.reason === undefined ? {} : { reason: params.reason }),
								cwd: ctx.cwd,
							});
							return {
								content: [
									{
										type: "text" as const,
										text: `Created branch ${result.branch.branchId} at seqId ${result.branch.headSeqId}; selection unchanged.`,
									},
								],
								details: safeToolDetails({
									runId: result.runId,
									branchId: result.branch.branchId,
									headSeqId: result.branch.headSeqId,
									selectedBranchChanged: result.selectedBranchChanged,
									started: result.started,
								}),
							};
						}
						const runId = actionRunCoordinate(params, "rewind");
						if (params.branchId === undefined) {
							throw new Error("hyperchart action=rewind requires branchId, plus runId");
						}
						return hyperchartRewindTool.execute(toolCallId, { ...params, runId }, signal, onUpdate, ctx);
					})(),
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(truncateToolText(message, 2_000));
			}
		},
	});
}

type RunCoordinateParams = { runId?: string };

function actionRunCoordinate(params: RunCoordinateParams, action: string): string;
function actionRunCoordinate(params: RunCoordinateParams, action: string, required: false): string | undefined;
function actionRunCoordinate(params: RunCoordinateParams, action: string, required = true): string | undefined {
	if ("runDir" in params) {
		throw new Error("runDir is not supported; pass runId");
	}
	if (params.runId === undefined) {
		if (required) {
			throw new Error(`hyperchart action=${action} requires runId`);
		}
		return undefined;
	}
	return checkedRunId(params.runId);
}
function checkedRunId(runId: string): string {
	assertRunId(runId);
	return runId;
}

async function ownedRunId(action: string, runSpec: string, ctx: HyperchartContext): Promise<string> {
	const runId = checkedRunId(runSpec);
	const meta = await loadRunMeta(runId);
	if (canonicalHostPath(meta.workDir) !== canonicalHostPath(ctx.cwd)) {
		throw new Error(`hyperchart action=${action}: run '${runId}' belongs to another working directory`);
	}
	return runId;
}

async function unambiguousRunBranch(action: string, runSpec: string, ctx: HyperchartContext): Promise<string> {
	const runId = await ownedRunId(action, runSpec, ctx);
	const page = await listHyperchartBranchPage(runId);
	if (page.totalCount === 1 && page.items[0] !== undefined) {
		return page.items[0].branchId;
	}
	const available = page.items.map((branch) => branch.branchId).join(", ") || "none";
	const suffix = page.next === undefined ? "" : ", …";
	throw new Error(
		`hyperchart action=${action} requires branchId because run '${runId}' has ${page.totalCount} durable branches (${available}${suffix})`,
	);
}

async function respondToUserInteraction(
	params: { runId?: string; branchId?: string; seqId?: number; event?: string; output?: unknown },
	ctx: HyperchartContext,
	coordinator?: PiUserInteractionCoordinator,
) {
	if (params.runId === undefined) {
		throw new Error("hyperchart action=respond requires runId");
	}
	if (params.branchId === undefined) {
		throw new Error("hyperchart action=respond requires branchId");
	}
	if (!Number.isSafeInteger(params.seqId) || (params.seqId as number) <= 0) {
		throw new Error("hyperchart action=respond requires a positive integer seqId");
	}
	if (params.event === undefined || params.event.length === 0) {
		throw new Error("hyperchart action=respond requires event");
	}
	const seqId = params.seqId as number;
	const runId = checkedRunId(params.runId);
	const meta = await loadRunMeta(runId);
	if (meta.originSessionId !== ctx.sessionManager.getSessionId()) {
		throw new Error(`Run '${params.runId}' is not owned by this session`);
	}
	if (canonicalHostPath(meta.workDir) !== canonicalHostPath(ctx.cwd)) {
		throw new Error(`Run '${params.runId}' belongs to another working directory`);
	}
	const event = {
		type: params.event,
		...(params.output === undefined ? {} : { output: params.output }),
	};
	const committed = await validateAndPersistUserInteractionResponse({
		runId,
		branchId: params.branchId,
		seqId,
		event,
		owner: interactionOwner(ctx),
	});
	await coordinator?.scan();
	return userInteractionRespondResult(params.runId, seqId, event, committed.idempotent);
}

function userInteractionRespondResult(
	runId: string,
	seqId: number,
	event: { type: string; output?: unknown },
	idempotent: boolean,
) {
	return {
		content: [
			{
				type: "text" as const,
				text: idempotent
					? `Hyperchart interaction (${runId}, ${seqId}) was already committed with the identical response.`
					: `Committed Hyperchart interaction (${runId}, ${seqId}) as ${event.type}.`,
			},
		],
		details: safeToolDetails({ runId, seqId, event: event.type, committed: true, idempotent }),
	};
}

function compactPiRewindResult(result: Awaited<ReturnType<typeof rewindHyperchartRun>>) {
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

function safeToolDetails<T>(details: T): T {
	return boundedModelEnvelope(
		details,
		({ digest, originalBytes, maxBytes }) =>
			({
				error: "model-envelope-too-large",
				digest,
				originalBytes,
				maxBytes,
			}) as T,
	);
}

function boundedPiToolResult<T>(result: T): T {
	return boundedModelEnvelope(
		result,
		({ digest, originalBytes, maxBytes }) =>
			({
				content: [
					{ type: "text", text: `Hyperchart response exceeded the model boundary (${digest}). Open hyperchart view.` },
				],
				details: { error: "model-envelope-too-large", digest, originalBytes, maxBytes },
			}) as T,
	);
}

function boundedPiMessage<T extends { customType: string; content: string; display: boolean; details: unknown }>(
	message: T,
): T {
	return boundedModelEnvelope(
		message,
		({ digest, originalBytes, maxBytes }) =>
			({
				customType: "hyperchart-boundary-error",
				content: `Hyperchart notification exceeded the model boundary (${digest}). Open hyperchart view.`,
				display: false,
				details: { error: "model-envelope-too-large", digest, originalBytes, maxBytes },
			}) as T,
	);
}

function truncateToolText(value: string, max = 160): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function compactPiRunStatus(status: HyperchartRunStatus) {
	return {
		state: status.state,
		branchIds: status.branchIds,
		...(status.pid === undefined ? {} : { pid: status.pid }),
		...(status.updatedAt === undefined ? {} : { updatedAt: status.updatedAt }),
		...(status.exitCode === undefined ? {} : { exitCode: status.exitCode }),
		...(status.error === undefined ? {} : { errorPreview: truncateToolText(status.error, 400) }),
		...(status.replayWarnings === undefined ? {} : { replayWarningCount: status.replayWarnings.length }),
	};
}

function listHypercharts(cwd: string) {
	const projectRoot = getProjectHyperchartsDir(cwd);
	const sharedRoot = getSharedHyperchartsDir(cwd);
	const userRoot = resolve(getAgentDir(), "hypercharts");
	const byName = new Map<string, { name: string; scope: "user" | "shared" | "project"; path: string }>();
	for (const [scope, root, files] of [
		["user", userRoot, listHyperchartFiles(userRoot)],
		...(sharedRoot === undefined ? [] : ([["shared", sharedRoot, listHyperchartFiles(sharedRoot)]] as const)),
		["project", projectRoot, listProjectHypercharts(cwd).map((file) => resolve(projectRoot, file))],
	] as const) {
		for (const path of files) {
			const rel = relative(root, path).replaceAll("\\", "/");
			const name = rel.endsWith("/chart.ts")
				? rel.slice(0, -"/chart.ts".length)
				: rel.replace(/\.chart\.ts$/, "").replace(/\.ts$/, "");
			byName.set(name, { name, scope, path: resolve(path) });
		}
	}
	const allCharts = [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
	const charts = allCharts.slice(0, 40).map((chart) => ({
		name: truncateToolText(chart.name),
		scope: chart.scope,
		path: truncateToolText(chart.path, 1_000),
	}));
	const omittedChartCount = allCharts.length - charts.length;
	const text =
		charts.length === 0
			? "No Hyperchart definitions found"
			: [
					`Found ${allCharts.length} Hyperchart definition${allCharts.length === 1 ? "" : "s"}${omittedChartCount === 0 ? "" : ` (showing ${charts.length})`}:`,
					...charts.map((chart) => `- ${chart.name} [${chart.scope}]`),
				].join("\n");
	return {
		content: [{ type: "text" as const, text }],
		details: safeToolDetails({ charts, ...(omittedChartCount === 0 ? {} : { omittedChartCount }) }),
	};
}

function createHyperchartRunTool(delivery: PiTerminalDelivery) {
	return defineTool({
		name: "hyperchart_run",
		label: "Run Hyperchart",
		description: "Start or resume a pi-hyperchart workflow run from a chart module.",
		parameters: Type.Object({
			chartPath: Type.Optional(
				Type.String({ description: "Hyperchart name in .pi/hypercharts, or a chart module path" }),
			),
			args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Run arguments JSON object" })),
			runId: Type.Optional(
				Type.String({ description: "Existing run directory to resume, or destination run directory" }),
			),
			branchId: Type.Optional(Type.String({ description: "Singleton branch to run; fresh omission defaults to main" })),
			branchIds: Type.Optional(
				Type.Array(Type.String(), { description: "Non-empty unique initial branches to run concurrently" }),
			),
			exportName: Type.Optional(Type.String({ description: "Named export to load from the chart module" })),
			wait: Type.Optional(
				Type.Boolean({ description: "Wait for terminal status or an owned user boundary before returning" }),
			),
			ignoreReplayWarnings: Type.Optional(
				Type.Boolean({ description: "Explicitly continue despite stale/skipped replay warnings. Default: false" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await startHyperchartRun(
				{
					...(params.chartPath === undefined ? {} : { chartPath: params.chartPath }),
					...(params.args === undefined ? {} : { args: params.args as Record<string, unknown> }),
					...(params.runId === undefined ? {} : { runId: params.runId }),
					...(params.branchId === undefined ? {} : { branchId: params.branchId }),
					...(params.branchIds === undefined ? {} : { branchIds: params.branchIds }),
					...(params.exportName === undefined ? {} : { exportName: params.exportName }),
					...(params.ignoreReplayWarnings === true ? { ignoreReplayWarnings: true } : {}),
					...(params.wait === true ? { wait: true } : {}),
					delivery,
				},
				ctx,
			);
			if (params.wait === true) {
				const boundary = await waitForPiRunBoundary(result, ctx);
				if (boundary.kind === "user") {
					const details = safeToolDetails({
						runId: boundary.interaction.request.runId,
						chartId: boundary.interaction.request.actionUid.chart,
						boundary: "user",
						final: false,
						interaction: compactPiUserInteraction(boundary.interaction),
						waitedRun: { runId: result.runId, chartId: result.chartId },
					});
					return {
						content: [
							{
								type: "text",
								text: `Hyperchart is waiting for user input at (${details.runId}, ${details.interaction.seqId}); use the bounded preview and output hint to respond.`,
							},
						],
						details,
					};
				}
				await receiptWaitedPiTerminalNotification(result.runId, ctx);
				const details = safeToolDetails({
					runId: result.runId,
					chartId: result.chartId,
					boundary: "terminal",
					final: true,
					status: compactPiRunStatus(boundary.status),
				});
				return {
					content: [
						{
							type: "text",
							text: `Hyperchart run ${result.runId} reached ${boundary.status.state} (${result.runId}). Open hyperchart view for full results.`,
						},
					],
					details,
				};
			}
			const details = safeToolDetails({
				runId: result.runId,
				chartId: result.chartId,
				final: false,
				status: "started",
			});
			return {
				content: [{ type: "text", text: `Started hyperchart run ${result.runId} (${result.runId})` }],
				details,
			};
		},
	});
}

type InspectRunOptions = { ast?: ChartAst; branchId?: string } & (
	| { includeTranscripts?: false }
	| { includeTranscripts: true; readTranscript: SessionTranscriptReader }
);

function transcriptReaderForRun(delivery: PiTerminalDelivery, runId: string): SessionTranscriptReader {
	return delivery.transcriptReaderForRun(runId);
}

async function inspectRunForCurrentWorkDir(runId: string, ctx: HyperchartContext, options: InspectRunOptions = {}) {
	const meta = await loadRunMeta(runId);
	if (canonicalHostPath(meta.workDir) !== canonicalHostPath(ctx.cwd)) {
		throw new Error(`Run '${runId}' belongs to another working directory`);
	}
	const base = {
		meta,
		...(options.ast === undefined ? {} : { ast: options.ast }),
		...(options.branchId === undefined ? {} : { branchId: options.branchId }),
		agentDefaults: createAgentDefaultsResolver(ctx.cwd, getAgentDir(), meta.chartPath),
	};
	return options.includeTranscripts === true
		? hyperchartRunFromRunId(runId, {
				...base,
				includeTranscripts: true,
				readTranscript: options.readTranscript,
			})
		: hyperchartRunFromRunId(runId, { ...base, includeTranscripts: false });
}

const hyperchartInspectTool = defineTool({
	name: "hyperchart_inspect",
	label: "Inspect Hyperchart",
	description:
		"Validate a Hyperchart chart module and return only a bounded digest; use hyperchart view for full inspection.",
	parameters: Type.Object({
		chartPath: Type.String({ description: "Hyperchart name in .pi/hypercharts, or a chart module path" }),
		exportName: Type.Optional(Type.String({ description: "Named export to inspect" })),
		verbose: Type.Optional(Type.Boolean({ description: "Deprecated and rejected; use hyperchart view" })),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const chartPath = resolveHyperchartPath(params.chartPath, ctx.cwd);
		await assertChartPreflight(chartPath);
		const agentDefaults = createAgentDefaultsResolver(
			ctx.cwd,
			getAgentDir(),
			chartPath,
			ctx.model === undefined ? {} : { defaultModel: `${ctx.model.provider}/${ctx.model.id}` },
		);
		const result = inspectChartModuleSync(chartPath, {
			...(params.exportName === undefined ? {} : { exportName: params.exportName }),
			agentDefaults,
		});
		if (params.verbose === true) {
			throw new Error(
				"verbose=true is no longer supported in tool responses; use hyperchart view for full browser inspection",
			);
		}
		const payload = safeToolDetails(summarizeChartInspect(result));
		return {
			content: [
				{
					type: "text",
					text: `Inspected hyperchart ${result.chartId}: ${result.states.length} states (${result.chartPath}). Returned a bounded digest; no run was started.`,
				},
			],
			details: payload,
		};
	},
});

const hyperchartRunInspectTool = defineTool({
	name: "hyperchart_run_inspect",
	label: "Inspect Hyperchart Run",
	description:
		"Load a concrete Hyperchart run and return only a bounded status/activity digest; use hyperchart view for full inspection.",
	parameters: Type.Object({
		runId: Type.String({ description: "Run identity to inspect" }),
		branchId: Type.String({ description: "Durable branch to inspect" }),
		verbose: Type.Optional(Type.Boolean({ description: "Deprecated and rejected; use hyperchart view" })),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		if (params.verbose === true) {
			throw new Error(
				"verbose=true is no longer supported in tool responses; use hyperchart view for full browser inspection",
			);
		}
		const runId = checkedRunId(params.runId);
		const inspector = await inspectRunForCurrentWorkDir(runId, ctx, {
			branchId: params.branchId,
			includeTranscripts: false,
		});
		const issueCount =
			(inspector.issues?.length ?? 0) +
			inspector.states.reduce((count, state) => count + (state.issues?.length ?? 0), 0);
		const payload = safeToolDetails({
			...summarizeRunInspect(inspector),
			userInteractions: compactPiUserInteractions(await inspectOwnedUserInteractions(ctx)),
		});
		return {
			content: [
				{
					type: "text",
					text: `Inspected hyperchart run ${inspector.runId}: ${inspector.stateCount} states, ${issueCount} issue${issueCount === 1 ? "" : "s"} (${runId}). Returned a bounded digest; use hyperchart view for full details.`,
				},
			],
			details: payload,
		};
	},
});

function createHyperchartViewTool(delivery: PiTerminalDelivery) {
	return defineTool({
		name: "hyperchart_view",
		label: "View Hyperchart Run",
		description:
			"Open the localhost browser inspector and return its URL. Pass runId for a run, or chartPath for a static view of a chart definition (reloads the chart on refresh).",
		parameters: Type.Object({
			runId: Type.Optional(Type.String({ description: "Run identity to view" })),
			chartPath: Type.Optional(Type.String({ description: "Chart name or path to view statically (no run required)" })),
			branchId: Type.Optional(Type.String({ description: "Branch selected for a run view" })),
			open: Type.Optional(Type.Boolean({ description: "Set false to return the URL without opening a browser" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if ((params.runId === undefined) === (params.chartPath === undefined)) {
				throw new Error("hyperchart_view requires exactly one of runId or chartPath");
			}
			if (params.chartPath !== undefined) {
				const chartPath = resolveHyperchartPath(params.chartPath, ctx.cwd);
				const agentDefaults = createAgentDefaultsResolver(ctx.cwd, getAgentDir(), chartPath);
				const loadChart = () =>
					hyperchartRunFromInspectResult(inspectChartModuleSync(chartPath, { agentDefaults }), { cwd: ctx.cwd });
				const chartId = loadChart().chartName;
				const { url } = await openRunInspector({
					runId: `chart:${chartId}`,
					loadRun: async () => loadChart(),
					...(params.open === false ? { openBrowser: () => undefined } : {}),
				});
				return {
					content: [{ type: "text", text: `Opened Hyperchart inspector for chart ${chartId}: ${url}` }],
					details: safeToolDetails({ url }),
				};
			}
			if (params.runId === undefined) {
				throw new Error("hyperchart_view requires runId when chartPath is omitted");
			}
			const runId = checkedRunId(params.runId);
			const inspector = await inspectRunForCurrentWorkDir(
				runId,
				ctx,
				params.branchId === undefined ? {} : { branchId: params.branchId },
			);
			const readTranscript = transcriptReaderForRun(delivery, runId);
			const { url } = await openRunInspector({
				runId: inspector.runId,
				historyDataSource: await createRunInspectorDataSource(runId, { readTranscript }),
				loadRun: (branchId) =>
					inspectRunForCurrentWorkDir(runId, ctx, {
						...((branchId ?? inspector.branchId) === undefined ? {} : { branchId: branchId ?? inspector.branchId }),
						includeTranscripts: false,
					}),
				steerSession: (branchId, actionKey, message) => {
					queueLiveSessionSteering(join(resolveRunPaths(runId).runDir, "sessions"), branchId, actionKey, message);
				},
				...(params.open === false ? { openBrowser: () => undefined } : {}),
			});
			return {
				content: [{ type: "text", text: `Opened Hyperchart inspector for ${inspector.runId}: ${url}` }],
				details: safeToolDetails({ url }),
			};
		},
	});
}

const hyperchartRewindTool = defineTool({
	name: "hyperchart_rewind",
	label: "Rewind Hyperchart Run",
	description: "Append-only move of a stopped Hyperchart branch head; all history and downstream files are preserved.",
	parameters: Type.Object({
		runId: Type.String({ description: "Existing run identity to rewind" }),
		branchId: Type.String({ description: "Durable named branch whose head will move" }),
		state: Type.Optional(
			Type.String({
				description: "State path to rewind to, e.g. chapter-production or chapter-production#key.write-copy",
			}),
		),
		seqId: Type.Optional(Type.Number({ description: "Durable log seqId to rewind to" })),
		to: Type.Optional(
			Type.Literal("compatible", { description: "Cut to the first prefix compatible with the current chart" }),
		),
		mode: Type.Optional(
			Type.Union([Type.Literal("before"), Type.Literal("after")], {
				description: "Move before or after the matching record. Default: before",
			}),
		),
		start: Type.Optional(
			Type.Boolean({ description: "Start exactly this branch after the head move. Default: false" }),
		),
		ignoreReplayWarnings: Type.Optional(
			Type.Boolean({
				description: "When start=true, explicitly continue despite stale/skipped replay warnings. Default: false",
			}),
		),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const runId = checkedRunId(params.runId);
		const result = await rewindHyperchartRun({
			runId,
			branchId: params.branchId,
			...(params.state === undefined ? {} : { state: params.state }),
			...(params.seqId === undefined ? {} : { seqId: params.seqId }),
			...(params.to === undefined ? {} : { to: params.to }),
			mode: params.mode === "after" ? "after" : "before",
			cwd: ctx.cwd,
		});
		if (params.start === true) {
			const started = await startHyperchartRun(
				{
					runId,
					branchId: params.branchId,
					...(params.ignoreReplayWarnings === true ? { ignoreReplayWarnings: true } : {}),
				},
				ctx,
			);
			return {
				content: [
					{
						type: "text",
						text: `Moved ${result.branchId} to ${result.targetLabel} and started that branch (${started.runId})`,
					},
				],
				details: safeToolDetails({
					...compactPiRewindResult(result),
					started: { runId: started.runId, chartId: started.chartId },
				}),
			};
		}
		return {
			content: [
				{
					type: "text",
					text: `Moved ${result.branchId} to ${result.targetLabel}. Resume with hyperchart action=run runId=${result.runId} branchId=${result.branchId}`,
				},
			],
			details: safeToolDetails(compactPiRewindResult(result)),
		};
	},
});

async function dispatch(
	args: string,
	ctx: HyperchartContext,
	notifyErrors: boolean,
	delivery: PiTerminalDelivery,
): Promise<void> {
	const tokens = tokenize(args);
	const command = tokens.shift();
	try {
		if (command === undefined || command.startsWith("-")) {
			if (command !== undefined) {
				tokens.unshift(command);
			}
			await runsCommand(tokens, ctx, delivery);
			return;
		}
		switch (command) {
			case "run":
				await runCommand(tokens, ctx, delivery);
				break;
			case "restart":
				await restartCommand(tokens, ctx, delivery);
				break;
			case "resume":
				await resumeCommand(tokens, ctx, delivery);
				break;
			case "steer":
				await steerCommand(tokens, ctx);
				break;
			case "status":
				await statusCommand(ctx);
				break;
			case "stop":
				await stopCommand(tokens, ctx);
				break;
			case "delete":
			case "rm":
				await deleteCommand(tokens, ctx);
				break;
			case "view":
				await viewCommand(tokens, ctx, delivery);
				break;
			default:
				if (isBareRunIdSpec(command)) {
					const run = await lookupBareRunIdForView(command, ctx.cwd);
					if (run.kind === "match") {
						await viewCommand([command], ctx, delivery);
						break;
					}
					if (run.kind === "foreign") {
						ctx.ui.notify(`Run '${command}' belongs to ${run.workDir}; open that directory first`, "warning");
						break;
					}
				}
				ctx.ui.notify(`Unknown hyperchart command '${command}'. ${HYPERCHART_USAGE}`, "info");
		}
	} catch (error) {
		if (!notifyErrors) {
			throw error;
		}
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

async function runCommand(tokens: string[], ctx: HyperchartContext, delivery: PiTerminalDelivery): Promise<void> {
	const { wait, ...options } = parseRunOptions(tokens);
	const result = await startHyperchartRun(
		{ ...options, ...(wait === true ? { wait: true } : {}), ...(delivery === undefined ? {} : { delivery }) },
		ctx,
	);
	if (wait === true) {
		const boundary = await waitForPiRunBoundary(result, ctx);
		if (boundary.kind === "user") {
			ctx.ui.notify(formatUserInteraction(boundary.interaction), "info");
			return;
		}
		const notification = await receiptWaitedPiTerminalNotification(result.runId, ctx);
		if (notification !== undefined) {
			ctx.ui.notify(notification.payload.prompt, notification.payload.outcome === "failed" ? "error" : "info");
		}
	}
}

async function runsCommand(tokens: string[], ctx: HyperchartContext, delivery: PiTerminalDelivery): Promise<void> {
	const options = parseRunsOptions(tokens);
	const entries = await loadRunHistory({ cwd: ctx.cwd, limit: options.limit });
	if (entries.length === 0) {
		ctx.ui.notify(`No hyperchart runs for ${ctx.cwd}`, "info");
		return;
	}
	if (ctx.mode !== "tui") {
		ctx.ui.notify(formatRunHistory(entries, ctx.cwd), "info");
		return;
	}
	const action = await ctx.ui.custom<RunHistoryAction>(
		(tui, theme, _keybindings, done) =>
			new RunHistoryOverlay(tui, theme, {
				cwd: ctx.cwd,
				items: entries.map(runHistoryItem),
				done,
			}),
		{ overlay: true },
	);
	await executeRunHistoryAction(action, ctx, delivery);
}

async function resumeCommand(tokens: string[], ctx: HyperchartContext, delivery: PiTerminalDelivery): Promise<void> {
	const options = parseResumeOptions(tokens);
	await resumeRun(options.runId, ctx, {
		...(options.branchIds === undefined ? {} : { branchIds: options.branchIds }),
		...(options.ignoreReplayWarnings === true ? { ignoreReplayWarnings: true } : {}),
		delivery,
	});
}

async function steerCommand(tokens: string[], ctx: HyperchartContext): Promise<void> {
	const runId = tokens.shift();
	const branchId = tokens.shift();
	const actionKey = tokens.shift();
	const message = tokens.join(" ").trim();
	if (runId === undefined || branchId === undefined || actionKey === undefined || message.length === 0) {
		throw new Error("Usage: /hyperchart steer <runId> <branchId> <actionKey> <message>");
	}
	assertRunId(runId);
	const meta = await loadRunMeta(runId);
	if (resolve(meta.workDir) !== resolve(ctx.cwd)) {
		throw new Error(`Run '${runId}' belongs to ${meta.workDir}; open that directory first`);
	}
	const sessionsDir = resolve(resolveRunPaths(runId).runDir, "sessions");
	const { session } = queueLiveSessionSteering(sessionsDir, branchId, actionKey, message);
	ctx.ui.notify(`Steering queued for @${session.actionName} on branch ${branchId}`, "info");
}

async function restartCommand(tokens: string[], ctx: HyperchartContext, delivery: PiTerminalDelivery): Promise<void> {
	const runId = tokens[0];
	if (runId === undefined) {
		throw new Error("restart requires a runId");
	}
	await restartRun(runId, ctx, delivery);
}

async function deleteCommand(tokens: string[], ctx: HyperchartContext): Promise<void> {
	const runId = tokens[0];
	if (runId === undefined) {
		throw new Error("delete requires a runId");
	}
	await deleteRun(runId, ctx);
}

async function resumeRun(
	runId: string,
	ctx: HyperchartContext,
	opts: { branchIds?: string[]; ignoreReplayWarnings?: boolean; delivery: PiTerminalDelivery },
): Promise<RunStartResult> {
	return startHyperchartRun(
		{
			runId: runId,
			...(opts.branchIds === undefined ? {} : { branchIds: opts.branchIds }),
			...(opts.ignoreReplayWarnings === true ? { ignoreReplayWarnings: true } : {}),
			...(opts.delivery === undefined ? {} : { delivery: opts.delivery }),
		},
		ctx,
	);
}

async function restartRun(
	runId: string,
	ctx: HyperchartContext,
	delivery: PiTerminalDelivery,
): Promise<RunStartResult> {
	assertRunId(runId);
	const meta = await loadRunMeta(runId);
	if (resolve(meta.workDir) !== resolve(ctx.cwd)) {
		throw new Error(`Run '${runId}' belongs to ${meta.workDir}; open that directory first`);
	}
	const args = await loadRunArgs(runId);
	const result = await startHyperchartRun(
		{
			chartPath: meta.chartPath,
			...(meta.exportName === undefined ? {} : { exportName: meta.exportName }),
			...(args === undefined ? {} : { args }),
			...(delivery === undefined ? {} : { delivery }),
		},
		ctx,
	);
	ctx.ui.notify(`Restarted hyperchart run ${runId} as ${result.runId}`, "info");
	return result;
}

async function executeRunHistoryAction(
	action: RunHistoryAction,
	ctx: HyperchartContext,
	delivery: PiTerminalDelivery,
): Promise<void> {
	if (action.kind === "view") {
		await viewCommand([action.runId], ctx, delivery);
	}
}

async function startHyperchartRun(opts: RunStartOptions, ctx: HyperchartContext): Promise<RunStartResult> {
	if (opts.branchId !== undefined && opts.branchIds !== undefined) {
		throw new Error("run accepts branchId or branchIds, not both");
	}
	let branchIds = opts.branchIds ?? (opts.branchId === undefined ? undefined : [opts.branchId]);
	const requestedRunId = opts.runId === undefined ? undefined : checkedRunId(opts.runId);
	let meta: RunMeta | undefined;
	let chartPath: string;
	let exportName = opts.exportName;
	let workDir = ctx.cwd;
	if (requestedRunId !== undefined && opts.chartPath === undefined) {
		meta = await loadRunMeta(requestedRunId);
		if (resolve(meta.workDir) !== resolve(ctx.cwd)) {
			throw new Error(`Run '${opts.runId ?? requestedRunId}' belongs to ${meta.workDir}; open that directory first`);
		}
		chartPath = meta.chartPath;
		exportName = meta.exportName;
		workDir = meta.workDir;
	} else if (opts.chartPath !== undefined) {
		chartPath = resolveHyperchartPath(opts.chartPath, ctx.cwd);
	} else {
		throw new Error("hyperchart action=run requires chartPath unless runId points at an existing run");
	}
	if (branchIds === undefined) {
		if (meta === undefined) {
			branchIds = ["main"];
		} else {
			if (requestedRunId === undefined) {
				throw new Error("Existing run metadata requires a run directory");
			}
			branchIds = [await unambiguousRunBranch("run", requestedRunId, ctx)];
		}
	}
	const [branchId] = branchIds;
	if (
		branchId === undefined ||
		new Set(branchIds).size !== branchIds.length ||
		branchIds.some((entry) => entry.trim().length === 0)
	) {
		throw new Error("branchIds must be non-empty and unique");
	}
	if (meta === undefined && (branchIds.length !== 1 || branchId !== "main")) {
		throw new Error(
			"A fresh run must select exactly branch 'main'; start main, fork durable branches, then resume the existing run with branchId or branchIds",
		);
	}

	await assertChartPreflight(chartPath);
	const parsed = parseChartModuleSync(chartPath, exportName === undefined ? {} : { exportName });
	if (!parsed.ok) {
		throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
	}

	const actualRunId = requestedRunId ?? (await createRun(parsed.ast.id));
	if (meta === undefined) {
		if (requestedRunId !== undefined) {
			await initializeRun(actualRunId);
		}
		await saveRunMeta(actualRunId, {
			chartPath,
			...(exportName === undefined ? {} : { exportName }),
			workDir,
			chartId: parsed.ast.id,
			createdAt: new Date().toISOString(),
			originSessionId: ctx.sessionManager.getSessionId(),
		});
	}
	mkdirSync(resolve(resolveRunPaths(actualRunId).runDir, "sessions"), { recursive: true });
	const runId = actualRunId;
	const existingStatus = readRunStatus(actualRunId);
	if (isRunLive(existingStatus)) {
		const done = watchRun(actualRunId);
		const active: ActiveRun = {
			runId,
			ast: parsed.ast,
			...(existingStatus === undefined ? {} : { status: existingStatus }),
			live: true,
			done,
		};
		currentRuns().add(active);
		setRunWidget(ctx, active);
		ctx.ui.notify(`Attached to live hyperchart run ${runId}`, "info");
		void done
			.then(async () => {
				if (currentRuns().get(runId) !== active) {
					return;
				}
				if (opts.wait !== true && opts.delivery !== undefined) {
					await deliverToCurrentPiSession(opts.delivery, actualRunId);
				}
			})
			.finally(() => {
				if (!currentRuns().remove(runId, active)) {
					return;
				}
				ctx.ui.setWidget(`hyperchart:${runId}`, undefined);
				ctx.ui.setStatus(
					"hyperchart",
					currentRuns().active.size === 0 ? undefined : `▶ ${currentRuns().active.size} runs`,
				);
			})
			.catch((error) => {
				console.error(`Hyperchart background completion failed for ${runId}:`, error);
			});
		return { runId, chartId: parsed.ast.id, done };
	}

	const attemptId = randomUUID();
	patchRunStatus(actualRunId, {
		chartId: parsed.ast.id,
		state: "starting",
		branchIds,
		attemptId,
		heartbeatAt: Date.now(),
		error: undefined,
		exitCode: undefined,
	});
	const sharedChartsDir = getSharedHyperchartsDir(workDir);
	const { modelRoles, toolsets } = loadHostSettings(
		[
			resolve(getAgentDir(), "hypercharts"),
			...(sharedChartsDir === undefined ? [] : [sharedChartsDir]),
			getProjectHyperchartsDir(workDir),
		],
		"pi",
	);
	const storage = currentRunLogStorage();
	if (storage === undefined) {
		throw new Error("Hyperchart run storage scope is unavailable");
	}
	const config: HyperchartRunnerConfig = {
		runId,
		chartPath,
		chartId: parsed.ast.id,
		workDir,
		...(opts.branchIds === undefined ? { branchId } : { branchIds }),
		attemptId,
		agentDir: getAgentDir(),
		piModules: resolvePiRunnerModules(),
		storage,
		...(exportName === undefined ? {} : { exportName }),
		...(opts.args === undefined ? {} : { args: opts.args }),
		...(opts.ignoreReplayWarnings === true ? { ignoreReplayWarnings: true } : {}),
		...(ctx.model === undefined ? {} : { defaultModel: `${ctx.model.provider}/${ctx.model.id}` }),
		...(Object.keys(modelRoles).length === 0 ? {} : { modelRoles }),
		...(Object.keys(toolsets).length === 0 ? {} : { toolsets }),
	};
	const pid = spawnRunner(config);
	// The child runner alone promotes starting -> running after every replay gate passes.
	patchRunStatus(actualRunId, { chartId: parsed.ast.id, branchIds, pid, heartbeatAt: Date.now() });
	const done = watchRun(actualRunId);
	const status = readRunStatus(actualRunId);
	const active: ActiveRun = {
		runId,
		ast: parsed.ast,
		...(status === undefined ? {} : { status }),
		live: true,
		done,
	};
	currentRuns().add(active);
	setRunWidget(ctx, active);
	ctx.ui.setStatus("hyperchart", `▶ ${currentRuns().active.size} run${currentRuns().active.size === 1 ? "" : "s"}`);
	ctx.ui.notify(`Started hyperchart run ${runId} (pid ${pid})`, "info");
	void done
		.then(async (status) => {
			if (currentRuns().get(runId) !== active) {
				return;
			}
			if (status.state === "complete") {
				ctx.ui.notify(`Hyperchart run ${runId} finished`, "info");
			} else if (status.state === "failed") {
				ctx.ui.notify(`Hyperchart run ${runId} failed: ${status.error ?? "unknown"}`, "error");
			}
			if (opts.wait !== true && opts.delivery !== undefined) {
				await deliverToCurrentPiSession(opts.delivery, actualRunId);
			}
		})
		.finally(() => {
			if (!currentRuns().remove(runId, active)) {
				return;
			}
			ctx.ui.setWidget(`hyperchart:${runId}`, undefined);
			ctx.ui.setStatus(
				"hyperchart",
				currentRuns().active.size === 0 ? undefined : `▶ ${currentRuns().active.size} runs`,
			);
		})
		.catch((error) => {
			console.error(`Hyperchart background completion failed for ${runId}:`, error);
		});
	return { runId, chartId: parsed.ast.id, done };
}

async function deliverToCurrentPiSession(delivery: PiTerminalDelivery, runId: string): Promise<boolean> {
	const ctx = delivery.currentContext();
	return ctx === undefined ? false : deliverPendingPiTerminalNotification(delivery.api, ctx, runId);
}

async function deliverPendingPiTerminalNotification(
	pi: ExtensionAPI,
	ctx: HyperchartContext,
	runId: string,
): Promise<boolean> {
	const meta = await loadRunMetaIfPresent(runId);
	const sessionId = ctx.sessionManager.getSessionId();
	if (meta === undefined || meta.originSessionId !== sessionId || resolve(meta.workDir) !== resolve(ctx.cwd)) {
		return false;
	}
	// A visible or queued owned gate is the current conversational boundary. Leave the
	// terminal outbox unclaimed so it remains recoverable after the gate is resolved.
	if ((await activePiUserInteraction(ctx)) !== undefined) {
		return false;
	}
	recoverStaleRunTerminalNotification(runId);
	const request = readDeliverableTerminalNotificationRequest(runId);
	if (request === undefined) {
		return false;
	}
	if (hasTerminalNotificationReceipt(runId, "pi", sessionId)) {
		return false;
	}
	// The Pi session log is the host acknowledgement. It must be checked even when
	// the filesystem confirmation is missing (for example, a crash after sendMessage).
	if (piSessionContainsTerminalRequest(ctx, request.requestId)) {
		markTerminalNotificationReceipt(runId, request.requestId, "pi", sessionId);
		return false;
	}
	if (!claimTerminalNotificationReceipt(runId, request.requestId, "pi", sessionId)) {
		return false;
	}
	if (readDeliverableTerminalNotificationRequest(runId)?.requestId !== request.requestId) {
		return false;
	}
	try {
		pi.sendMessage(
			boundedPiMessage({
				customType: "hyperchart-terminal",
				content: `Hyperchart run ${request.payload.runId} (${request.payload.chartId}) reached ${request.payload.outcome}. Open hyperchart view for full results.`,
				display: true,
				details: safeToolDetails({
					requestId: request.requestId,
					runId: request.payload.runId,
					chartId: request.payload.chartId,
					outcome: request.payload.outcome,
				}),
			}),
			{ deliverAs: "followUp", triggerTurn: true },
		);
	} catch (error) {
		removeTerminalNotificationReceipt(runId, request.requestId, "pi", sessionId);
		throw error;
	}
	// Never confirm before Pi accepts/persists the custom message: a crash before
	// send remains recoverable, while a crash here is deduplicated by the session log.
	markTerminalNotificationReceipt(runId, request.requestId, "pi", sessionId);
	return true;
}

function piSessionContainsTerminalRequest(ctx: HyperchartContext, requestId: string): boolean {
	return ctx.sessionManager
		.getEntries()
		.some(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "hyperchart-terminal" &&
				typeof entry.details === "object" &&
				entry.details !== null &&
				"requestId" in entry.details &&
				(entry.details as { requestId?: unknown }).requestId === requestId,
		);
}

type PiRunBoundary =
	| { kind: "terminal"; status: HyperchartRunStatus }
	| { kind: "user"; interaction: OwnedUserInteraction };

function waitForPiRunBoundary(result: RunStartResult, ctx: HyperchartContext): Promise<PiRunBoundary> {
	return new Promise((resolveBoundary, rejectBoundary) => {
		let settled = false;
		const finish = (boundary: PiRunBoundary) => {
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
				const active = await activePiUserInteraction(ctx);
				if (active === undefined) {
					return;
				}
				if (active.presentation === "pending") {
					// Claim pins this coordinate, but do not confirm it here: the tool result has not
					// yet been persisted/delivered. The settled scanner performs the visible send
					// and confirmation, so a crash in this wait-return window remains recoverable.
					claimUserInteractionReceipt(
						active.runId,
						active.request.branchId,
						active.request.seqId,
						"pi",
						ctx.sessionManager.getSessionId(),
						{ source: "wait", leaseMs: USER_INTERACTION_WAIT_LEASE_MS },
					);
				}
				const current = await activePiUserInteraction(ctx);
				if (current === undefined || interactionKey(current) !== interactionKey(active)) {
					return;
				}
				finish({ kind: "user", interaction: current });
			} catch {
				// A concurrently-created/malformed journal is isolated; retry until another
				// valid gate or terminal run status becomes observable.
			} finally {
				inspecting = false;
			}
		};
		const timer = setInterval(() => void inspectInteraction(), 100);
		timer.unref();
		result.done.then(
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

async function receiptWaitedPiTerminalNotification(runId: string, ctx: HyperchartContext) {
	const meta = await loadRunMetaIfPresent(runId);
	const sessionId = ctx.sessionManager.getSessionId();
	if (meta === undefined || meta.originSessionId !== sessionId || resolve(meta.workDir) !== resolve(ctx.cwd)) {
		return undefined;
	}
	if ((await activePiUserInteraction(ctx)) !== undefined) {
		return undefined;
	}
	const request = readDeliverableTerminalNotificationRequest(runId);
	if (request === undefined || !claimTerminalNotificationReceipt(runId, request.requestId, "pi", sessionId)) {
		return undefined;
	}
	return request;
}

async function recoverPiTerminalNotifications(pi: ExtensionAPI, ctx: HyperchartContext): Promise<void> {
	const root = currentRunLogStorage()?.rootDir;
	if (root === undefined || !existsSync(root)) {
		return;
	}
	for (const runId of await listRunIds()) {
		try {
			await deliverPendingPiTerminalNotification(pi, ctx, runId);
		} catch {
			// One concurrently-created, malformed, or temporarily unavailable run must not
			// prevent recovery of other runs owned by this session.
		}
	}
}

function resolvePiRunnerModules(): HyperchartRunnerConfig["piModules"] {
	const packageDir = getPackageDir();
	const packageJsonPath = join(packageDir, "package.json");
	const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
		main?: unknown;
		exports?: { "."?: string | { import?: unknown } };
	};
	const rootExport =
		typeof manifest.exports?.["."] === "string"
			? manifest.exports["."]
			: typeof manifest.exports?.["."]?.import === "string"
				? manifest.exports["."].import
				: typeof manifest.main === "string"
					? manifest.main
					: undefined;
	if (rootExport === undefined) {
		throw new Error(`Active Pi package has no importable root export: ${packageJsonPath}`);
	}
	const codingAgent = resolve(packageDir, rootExport);
	const hostRequire = createRequire(pathToFileURL(packageJsonPath));
	const typebox = hostRequire.resolve("typebox");
	for (const [name, path] of Object.entries({ codingAgent, typebox })) {
		if (!isAbsolute(path) || !existsSync(path)) {
			throw new Error(`Active Pi ${name} module is not available to detached runners: ${path}`);
		}
	}
	return { codingAgent, typebox };
}

function spawnRunner(config: HyperchartRunnerConfig): number {
	const configPath = resolve(resolveRunPaths(config.runId).runDir, "runner.config.json");
	writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	chmodSync(configPath, 0o600);
	const stdoutFd = openSync(resolve(resolveRunPaths(config.runId).runDir, "runner.stdout.log"), "a");
	const stderrFd = openSync(resolve(resolveRunPaths(config.runId).runDir, "runner.stderr.log"), "a");
	try {
		const env = { ...process.env };
		delete env.HYPERCHART_PG_DSN;
		const child = spawn(process.execPath, [runnerEntry, configPath], {
			cwd: config.workDir,
			detached: true,
			stdio: ["ignore", stdoutFd, stderrFd],
			env,
		});
		child.unref();
		if (child.pid === undefined) {
			throw new Error("hyperchart runner did not produce a pid");
		}
		return child.pid;
	} finally {
		closeSync(stdoutFd);
		closeSync(stderrFd);
	}
}

function watchRun(runId: string): Promise<HyperchartRunStatus> {
	return new Promise((resolveDone) => {
		const timer = setInterval(
			AsyncLocalStorage.bind(() => {
				const status = reconcileStoppedRunner(runId);
				if (status === undefined) {
					return;
				}
				if (isTerminalRunState(status.state)) {
					clearInterval(timer);
					resolveDone(status);
					return;
				}
				if (!isRunLive(status) && Date.now() - status.updatedAt > 20_000) {
					recoverStaleRunTerminalNotification(runId);
					const recovered = readRunStatus(runId);
					if (recovered !== undefined && isTerminalRunState(recovered.state)) {
						clearInterval(timer);
						resolveDone(recovered);
					}
				}
			}),
			1_000,
		);
		timer.unref();
	});
}

// A runner can exit during shutdown before its final status write. Process death
// ends the stop wait, but does not prove that application cleanup succeeded.
function reconcileStoppedRunner(runId: string): HyperchartRunStatus | undefined {
	const status = readRunStatus(runId);
	if (status?.state === "stopping" && status.pid !== undefined && !isPidAlive(status.pid)) {
		return patchRunStatus(runId, {
			state: "stopped",
			branchIds: [],
			exitCode: undefined,
			error: "runner exited during stop before recording completion; cleanup could not be confirmed",
		});
	}
	return status;
}

async function statusCommand(ctx: HyperchartContext): Promise<void> {
	const snapshots = await recentRunSnapshots(8);
	const activeIds = new Set(currentRuns().active.keys());
	if (currentRuns().active.size === 0 && snapshots.length === 0) {
		ctx.ui.notify("No hyperchart runs", "info");
		return;
	}
	ctx.ui.notify(
		[
			...[...currentRuns().active.values()].map((run) => formatSnapshot(run, activeIds)),
			...snapshots.filter((run) => !activeIds.has(run.runId)).map((run) => formatSnapshot(run, activeIds)),
		].join("\n"),
		"info",
	);
}

async function stopHyperchartRuns(params: { runId?: string; all?: boolean }, ctx: HyperchartContext) {
	if ((params.runId === undefined) === (params.all !== true)) {
		throw new Error("hyperchart action=stop requires exactly one of runId or all=true");
	}
	const targets = params.all === true ? await activeRunIdsForWorkDir(ctx.cwd) : [checkedRunId(params.runId as string)];
	const stopped = await Promise.all(targets.map((runId) => stopOwnedRun(runId, ctx)));
	const stoppedDigest = stopped.slice(0, 20).map((run) => ({
		runId: truncateToolText(run.runId),
		...(run.pid === undefined ? {} : { pid: run.pid }),
	}));
	return {
		content: [
			{
				type: "text" as const,
				text:
					stopped.length === 0
						? "No active Hyperchart runs found"
						: `Stopping ${stopped.length} Hyperchart run${stopped.length === 1 ? "" : "s"}${stopped.length > stoppedDigest.length ? ` (showing ${stoppedDigest.length})` : ""}:\n${stoppedDigest.map((run) => `- ${run.runId}${run.pid === undefined ? " (marked stopped)" : ` (pid ${run.pid})`}`).join("\n")}`,
			},
		],
		details: safeToolDetails({
			stoppedCount: stopped.length,
			stopped: stoppedDigest,
			...(stopped.length <= stoppedDigest.length ? {} : { omittedStoppedCount: stopped.length - stoppedDigest.length }),
		}),
	};
}

async function activeRunIdsForWorkDir(cwd: string): Promise<string[]> {
	const candidates = await Promise.all(
		(await listRunIds()).map(async (runId) => {
			const meta = await loadRunMetaIfPresent(runId);
			if (meta === undefined || resolve(meta.workDir) !== resolve(cwd)) {
				return undefined;
			}
			const status = readRunStatus(runId);
			return status !== undefined && (isRunLive(status) || ["starting", "running", "stopping"].includes(status.state))
				? runId
				: undefined;
		}),
	);
	return candidates.filter((runId): runId is string => runId !== undefined);
}

async function stopOwnedRun(runId: string, ctx: HyperchartContext): Promise<{ runId: string; pid?: number }> {
	const meta = await loadRunMeta(runId);
	if (resolve(meta.workDir) !== resolve(ctx.cwd)) {
		throw new Error(`Run '${runId}' belongs to ${meta.workDir}; open that directory first`);
	}
	assertRunId(runId);
	const active = currentRuns().get(runId);
	const status = readRunStatus(runId);
	patchRunStatus(runId, { state: "stopping" });
	const pid = status?.pid !== undefined && isPidAlive(status.pid) ? status.pid : undefined;
	if (pid === undefined) {
		patchRunStatus(runId, { state: "stopped", exitCode: 0, error: "runner was not live" });
	} else {
		process.kill(pid, "SIGTERM");
	}
	// A successful stop boundary means the runner has quiesced and cannot race a
	// caller that immediately removes, rewinds, or reuses its run directory.
	if (pid !== undefined) {
		await waitForRunProcessExit(pid);
		reconcileStoppedRunner(runId);
	}
	if (active !== undefined) {
		await active.done;
	}
	if (currentRuns().get(runId) === active) {
		currentRuns().remove(runId);
		ctx.ui.setWidget(`hyperchart:${runId}`, undefined);
		ctx.ui.setStatus("hyperchart", currentRuns().active.size === 0 ? undefined : `▶ ${currentRuns().active.size} runs`);
	}
	return { runId, ...(pid === undefined ? {} : { pid }) };
}

async function waitForRunProcessExit(pid: number): Promise<void> {
	while (isPidAlive(pid)) {
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
	}
}

async function stopCommand(tokens: string[], ctx: HyperchartContext): Promise<void> {
	await stopRun(tokens[0], ctx);
}

async function stopRun(runId: string | undefined, ctx: HyperchartContext): Promise<void> {
	const target = currentRuns().get(runId) ?? (await resolveRunForView(runId, ctx.cwd));
	if (target === undefined) {
		throw new Error(`Run '${runId ?? "<last>"}' was not found`);
	}
	const result = await stopOwnedRun(target.runId, ctx);
	ctx.ui.notify(
		result.pid === undefined
			? `Marked hyperchart run ${target.runId} stopped`
			: `Stopping hyperchart run ${target.runId} (pid ${result.pid})`,
		"warning",
	);
}

async function deleteRun(runId: string, ctx: HyperchartContext): Promise<void> {
	assertRunId(runId);
	const meta = await loadRunMeta(runId);
	if (resolve(meta.workDir) !== resolve(ctx.cwd)) {
		throw new Error(`Run '${runId}' belongs to ${meta.workDir}; open that directory first`);
	}
	const status = readRunStatus(runId);
	const live = isRunLive(status);
	const confirmed = await ctx.ui.confirm(
		`Delete hyperchart run ${runId}?`,
		`${meta.chartId}${live ? " is running and will be stopped. " : ". "}This removes ${runId}`,
	);
	if (!confirmed) {
		return;
	}
	if (status?.pid !== undefined && isPidAlive(status.pid)) {
		process.kill(status.pid, "SIGTERM");
		await waitForRunProcessExit(status.pid);
	}
	await deleteRunStorage(runId);
	rmSync(resolveRunPaths(runId).runDir, { recursive: true, force: true });
	currentRuns().remove(runId);
	ctx.ui.setWidget(`hyperchart:${runId}`, undefined);
	ctx.ui.setStatus("hyperchart", currentRuns().active.size === 0 ? undefined : `▶ ${currentRuns().active.size} runs`);
	ctx.ui.notify(`Deleted hyperchart run ${runId}`, "info");
}

async function viewCommand(tokens: string[], ctx: HyperchartContext, delivery: PiTerminalDelivery): Promise<void> {
	const activeRun = currentRuns().get(tokens[0]);
	const run = activeRun ?? (await resolveRunForView(tokens[0], ctx.cwd));
	if (run === undefined) {
		ctx.ui.notify("No hyperchart run to view", "warning");
		return;
	}
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`Run ${run.runId}: ${run.runId}`, "info");
		return;
	}
	const readTranscript = transcriptReaderForRun(delivery, run.runId);
	const { url } = await openRunInspector({
		runId: run.runId,
		historyDataSource: await createRunInspectorDataSource(run.runId, { readTranscript }),
		// The snapshot's parsed AST avoids a synchronous chart-module re-parse on every poll.
		loadRun: (branchId) =>
			inspectRunForCurrentWorkDir(run.runId, ctx, {
				ast: run.ast,
				...(branchId === undefined ? {} : { branchId }),
				includeTranscripts: false,
			}),
		steerSession: (branchId, actionKey, message) => {
			queueLiveSessionSteering(join(resolveRunPaths(run.runId).runDir, "sessions"), branchId, actionKey, message);
		},
	});
	ctx.ui.notify(`Opened Hyperchart inspector for ${run.runId}: ${url}`, "info");
}

function setRunWidget(ctx: HyperchartContext, run: RunSnapshot): void {
	ctx.ui.setWidget(
		`hyperchart:${run.runId}`,
		AsyncLocalStorage.bind(
			(tui, theme) =>
				new RunWidget(tui, theme, {
					runId: run.runId,
					ast: run.ast,
					branchId: "main",
					live: run.live,
					cwd: ctx.cwd,
				}),
		),
		{ placement: "aboveEditor" },
	);
}

async function restoreRunWidgets(ctx: HyperchartContext): Promise<void> {
	const snapshots = await recentRunSnapshots(5, ctx.cwd, ctx.sessionManager.getSessionId());
	for (const run of snapshots) {
		if (currentRuns().active.has(run.runId)) {
			continue;
		}
		setRunWidget(ctx, run);
	}
	if (snapshots.length > 0 && currentRuns().active.size === 0) {
		currentRuns().lastRunId = snapshots[0]?.runId;
		const liveCount = snapshots.filter((snapshot) => snapshot.live).length;
		ctx.ui.setStatus(
			"hyperchart",
			`${liveCount > 0 ? "▶" : "↻"} ${snapshots.length} run${snapshots.length === 1 ? "" : "s"}`,
		);
	}
}

type BareRunIdLookup = { kind: "match" } | { kind: "foreign"; workDir: string } | { kind: "missing" };

async function lookupBareRunIdForView(runId: string, cwd: string): Promise<BareRunIdLookup> {
	const meta = await loadRunMetaIfPresent(checkedRunId(runId));
	if (meta === undefined) {
		return { kind: "missing" };
	}
	return resolve(meta.workDir) === resolve(cwd) ? { kind: "match" } : { kind: "foreign", workDir: meta.workDir };
}

function isBareRunIdSpec(spec: string): boolean {
	return spec.length > 0 && !isAbsolute(spec) && !spec.startsWith(".") && !spec.includes("/") && !spec.includes("\\");
}

async function resolveRunForView(runId: string | undefined, cwd: string): Promise<RunSnapshot | undefined> {
	if (runId !== undefined) {
		assertRunId(runId);
		const meta = await loadRunMetaForCurrentWorkDir(runId, cwd);
		return meta === undefined ? undefined : loadRunSnapshot(runId, meta);
	}
	return (await recentRunSnapshots(5, cwd))[0];
}

async function recentRunSnapshots(limit = 5, cwd?: string, originSessionId?: string): Promise<RunSnapshot[]> {
	const dirs = await listRunIds();
	const snapshots: RunSnapshot[] = [];
	for (const dir of dirs) {
		try {
			const meta = await loadRunMeta(dir);
			if (cwd !== undefined && resolve(meta.workDir) !== resolve(cwd)) {
				continue;
			}
			if (originSessionId !== undefined && meta.originSessionId !== originSessionId) {
				continue;
			}
			const snapshot = await loadRunSnapshot(dir, meta);
			if (snapshot.status !== undefined && isTerminalRunState(snapshot.status.state)) {
				continue;
			}
			const view = await readRunView(dir, snapshot.ast);
			if (!view.final) {
				snapshots.push(snapshot);
			}
		} catch {
			continue;
		}
		if (snapshots.length >= limit) {
			break;
		}
	}
	return snapshots;
}

async function loadRunHistory(options: { cwd: string; limit: number }): Promise<RunHistoryEntry[]> {
	const entries: RunHistoryEntry[] = [];
	for (const dir of await listRunIds()) {
		const entry = await loadRunHistoryEntry(dir, options.cwd).catch(() => undefined);
		if (entry === undefined) {
			continue;
		}
		entries.push(entry);
		if (entries.length >= options.limit) {
			break;
		}
	}
	return entries;
}

async function loadRunHistoryEntry(runId: string, cwd: string): Promise<RunHistoryEntry | undefined> {
	const meta = await loadRunMeta(runId);
	if (resolve(meta.workDir) !== resolve(cwd)) {
		return undefined;
	}
	const status = readRunStatus(runId);
	let final = status?.state === "complete" || status?.state === "failed";
	let terminalState: RunTerminalState | undefined =
		status?.state === "complete" || status?.state === "failed" ? status.state : undefined;
	try {
		const snapshot = await loadRunSnapshot(runId);
		const view = await readRunView(runId, snapshot.ast);
		final = view.final;
		terminalState = view.final ? (isFailedRunView(view) ? "failed" : "complete") : undefined;
	} catch {
		// Keep status-derived state when old chart code no longer parses.
	}
	return {
		runId,
		meta,
		...(status === undefined ? {} : { status }),
		live: isRunLive(status),
		final,
		...(terminalState === undefined ? {} : { terminalState }),
		sessionCount: countSessionDirs(runId),
		updatedAt: status?.updatedAt ?? statSync(resolveRunPaths(runId).runDir).mtimeMs,
	};
}

function isFailedRunView(view: RunView): boolean {
	return view.failedTerminal;
}

async function loadRunMetaForCurrentWorkDir(runId: string, cwd: string): Promise<RunMeta | undefined> {
	const meta = await loadRunMetaIfPresent(runId);
	return meta !== undefined && resolve(meta.workDir) === resolve(cwd) ? meta : undefined;
}

async function loadRunMetaIfPresent(runId: string): Promise<RunMeta | undefined> {
	try {
		return await loadRunMeta(runId);
	} catch (error) {
		if (isNotFoundError(error)) {
			return undefined;
		}
		throw error;
	}
}

function isNotFoundError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function loadRunSnapshot(runId: string, suppliedMeta?: RunMeta): Promise<RunSnapshot> {
	const meta = suppliedMeta ?? (await loadRunMeta(runId));
	const parsed = parseChartModuleSync(
		meta.chartPath,
		meta.exportName === undefined ? {} : { exportName: meta.exportName },
	);
	if (!parsed.ok) {
		throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
	}
	const status = readRunStatus(runId);
	return {
		runId,
		ast: parsed.ast,
		...(status === undefined ? {} : { status }),
		live: isRunLive(status),
	};
}

function formatSnapshot(run: RunSnapshot, activeIds: ReadonlySet<string>): string {
	const status = run.status;
	const state = activeIds.has(run.runId)
		? "attached"
		: run.live
			? `live pid ${status?.pid ?? "?"}`
			: (status?.state ?? "detached");
	return `${run.runId} · ${run.ast.id} · ${state} · ${run.runId}`;
}

function formatRunHistory(entries: readonly RunHistoryEntry[], cwd: string): string {
	return [
		`Hyperchart runs in ${cwd}`,
		`Use /hyperchart runs in TUI for interactive selection.`,
		"",
		...entries.map(formatRunHistoryEntry),
	].join("\n");
}

function runHistoryItem(entry: RunHistoryEntry): RunHistoryItem {
	return {
		runId: entry.runId,
		chartId: entry.meta.chartId,
		state: historyState(entry),
		live: entry.live,
		final: entry.final,
		sessionCount: entry.sessionCount,
		createdAt: shortDate(entry.meta.createdAt),
		updatedAt: shortDate(entry.updatedAt),
	};
}

function formatRunHistoryEntry(entry: RunHistoryEntry): string {
	const state = historyState(entry);
	const created = shortDate(entry.meta.createdAt);
	const updated = shortDate(entry.updatedAt);
	return [
		`- ${entry.runId} · ${entry.meta.chartId} · ${state} · ${entry.sessionCount} session${entry.sessionCount === 1 ? "" : "s"} · ${created}`,
		`  view /hyperchart view ${entry.runId} · resume /hyperchart resume ${entry.runId} · stop /hyperchart stop ${entry.runId} · restart /hyperchart restart ${entry.runId}`,
		updated === created ? undefined : `  updated ${updated}`,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

function historyState(entry: RunHistoryEntry): string {
	if (entry.live) {
		return `live pid ${entry.status?.pid ?? "?"}`;
	}
	if (entry.terminalState !== undefined) {
		return entry.terminalState;
	}
	if (entry.status?.state !== undefined) {
		return entry.status.state;
	}
	return entry.final ? "complete" : "stale";
}

async function readRunView(runId: string, ast: ChartAst) {
	const store = await openRunLogStore(runId, { access: "read" });
	try {
		let syntheticEmptyBranch = false;
		let snapshot: { branchId: string; headSeqId: number | null };
		try {
			snapshot = await store.captureSnapshot(store.branchId);
		} catch (error) {
			if ((await store.countRecords()) !== 0) {
				throw error;
			}
			snapshot = { branchId: store.branchId, headSeqId: null };
			syntheticEmptyBranch = true;
		}
		const [execution, records] = await Promise.all([
			readBranchExecutionOverview(ast, store.branchId, store, snapshot),
			syntheticEmptyBranch
				? Promise.resolve({ snapshot, items: [] as readonly DurableLogRecord[] })
				: store.readRecords({ snapshot }),
		]);
		return buildRunView(ast, [...records.items].reverse(), Date.now(), { execution, branchId: snapshot.branchId });
	} finally {
		await store.close();
	}
}

async function loadRunArgs(runId: string): Promise<Record<string, unknown> | undefined> {
	const meta = await loadRunMeta(runId);
	const parsed = parseChartModuleSync(
		meta.chartPath,
		meta.exportName === undefined ? {} : { exportName: meta.exportName },
	);
	if (!parsed.ok) {
		throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
	}
	const store = await openRunLogStore(runId, { access: "read" });
	try {
		const execution = await readBranchExecutionOverview(parsed.ast, store.branchId, store);
		return execution.args === undefined ? undefined : { ...execution.args };
	} finally {
		await store.close();
	}
}

function countSessionDirs(runId: string): number {
	const sessionsDir = resolve(resolveRunPaths(runId).runDir, "sessions");
	if (!existsSync(sessionsDir)) {
		return 0;
	}
	return readdirSync(sessionsDir).filter((entry) => {
		const path = resolve(sessionsDir, entry);
		return entry !== "progress.json" && existsSync(path) && statSync(path).isDirectory();
	}).length;
}

function shortDate(value: string | number): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return String(value);
	}
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseRunsOptions(tokens: string[]): { limit: number } {
	let limit = 20;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token === "--limit" || token === "-n") {
			const value = tokens[++index];
			if (value === undefined) {
				throw new Error(`${token} requires a number`);
			}
			limit = Number(value);
			if (!Number.isInteger(limit) || limit <= 0) {
				throw new Error(`${token} must be a positive integer`);
			}
		} else {
			throw new Error(`Unexpected argument '${token}'`);
		}
	}
	return { limit };
}

function parseRunOptions(tokens: string[]): {
	chartPath?: string;
	args?: Record<string, unknown>;
	runId?: string;
	exportName?: string;
	branchIds?: string[];
	wait?: boolean;
	ignoreReplayWarnings?: boolean;
} {
	let chartPath: string | undefined;
	let args: Record<string, unknown> | undefined;
	let runId: string | undefined;
	let exportName: string | undefined;
	const branchIds: string[] = [];
	let wait = false;
	let ignoreReplayWarnings = false;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token === "--args") {
			const value = tokens[++index];
			if (value === undefined) {
				throw new Error("--args requires a JSON object");
			}
			const parsed = JSON.parse(value) as unknown;
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				throw new Error("--args must be a JSON object");
			}
			args = parsed as Record<string, unknown>;
		} else if (token === "--run-id") {
			runId = tokens[++index];
			if (runId === undefined) {
				throw new Error("--run-id requires a directory");
			}
		} else if (token === "--export") {
			exportName = tokens[++index];
			if (exportName === undefined) {
				throw new Error("--export requires a name");
			}
		} else if (token === "--branch") {
			const branchId = tokens[++index];
			if (branchId === undefined) {
				throw new Error("--branch requires an id");
			}
			branchIds.push(branchId);
		} else if (token === "--wait") {
			wait = true;
		} else if (token === "--ignore-replay-warnings") {
			ignoreReplayWarnings = true;
		} else if (chartPath === undefined) {
			chartPath = token;
		} else {
			throw new Error(`Unexpected argument '${token}'`);
		}
	}
	return {
		...(chartPath === undefined ? {} : { chartPath }),
		...(args === undefined ? {} : { args }),
		...(runId === undefined ? {} : { runId }),
		...(exportName === undefined ? {} : { exportName }),
		...(branchIds.length === 0 ? {} : { branchIds }),
		...(wait ? { wait: true } : {}),
		...(ignoreReplayWarnings ? { ignoreReplayWarnings: true } : {}),
	};
}

function parseResumeOptions(tokens: string[]): { runId: string; branchIds?: string[]; ignoreReplayWarnings?: boolean } {
	let runId: string | undefined;
	const branchIds: string[] = [];
	let ignoreReplayWarnings = false;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token === "--ignore-replay-warnings") {
			ignoreReplayWarnings = true;
		} else if (token === "--branch") {
			const branchId = tokens[++index];
			if (branchId === undefined) {
				throw new Error("--branch requires an id");
			}
			branchIds.push(branchId);
		} else if (runId === undefined) {
			runId = token;
		} else {
			throw new Error(`Unexpected argument '${token}'`);
		}
	}
	if (runId === undefined) {
		throw new Error("resume requires a runId");
	}
	return {
		runId,
		...(branchIds.length === 0 ? {} : { branchIds }),
		...(ignoreReplayWarnings ? { ignoreReplayWarnings: true } : {}),
	};
}

function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaping = false;
	for (const char of input) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}
		if (char === "\\") {
			escaping = true;
			continue;
		}
		if (quote !== undefined) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (quote !== undefined) {
		throw new Error("Unterminated quote in command arguments");
	}
	if (escaping) {
		current += "\\";
	}
	if (current.length > 0) {
		tokens.push(current);
	}
	return tokens;
}
