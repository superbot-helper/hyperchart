import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentSession,
	createAgentSessionFromServices,
	createAgentSessionServices,
	getAgentDir,
	SessionManager,
	type ModelRuntime,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { actionUidDirName, actionUidKey, sanitizeSegment } from "@surprisal/hyperchart/internal/core/action_uid";
import type { ActionUID, ChartEvent } from "@surprisal/hyperchart/internal/core/types";
import type { AgentEffect, AgentOutcome } from "@surprisal/hyperchart/internal/core/machine";
import { errorMessage } from "@surprisal/hyperchart/internal/utils/errors";
import type { AgentExecutor, EmitAgentOutcome, SessionPlan } from "@surprisal/hyperchart/runtime";
import type { HyperchartSessionMessageInfo } from "@surprisal/hyperchart/host";
import type { SchemaRegistryLike as SchemaRegistry } from "@surprisal/hyperchart/internal/core/schema_registry";
import {
	GenerationTracker,
	actionSessionDir,
	branchSessionSegment,
	buildRecoveryPrompt,
	buildResumePrompt,
	buildSessionPlan,
	buildTaskPrompt,
	checkEffectArtifacts,
	effectInvokeSeqId,
	previewText,
	resolveReads,
	evaluateAgentTurn,
	sessionKey,
	shouldRecoverRestoredFinish,
	stringifyToolArgs,
	validateDeclaredReadPaths,
} from "@surprisal/hyperchart/runtime";
import { loadAgentDefinition, resolvePiSubagentDefinitionDirs, type AgentDefinition } from "./agent_definitions.js";
import { createFinishTool, type CompletionSink, stopAfterRejectedFinish, validateFinishParams } from "./finish_tool.js";
import { strictFinishExtension } from "./strict_finish.js";
import { createThrottledProgressWriter, updateSessionProgress } from "@surprisal/hyperchart/sessions";

export { buildSessionPlan, shouldRecoverRestoredFinish, validateDeclaredReadPaths };
export type { SessionPlan };

/** Ambient discovery is the generic Pi default; isolated workers load no host extensions. */
export type PiExtensionPolicy = "ambient" | "isolated";

export type PiSessionOverridesContext = Readonly<{
	/** Original durable session identity; stable across retries, not the SDK attempt ID. */
	invocationId: string;
	branchId: string;
	actionUid: ActionUID;
	agentName: string;
	declaredRole?: string;
	declaredToolset?: string;
}>;

export type PiSessionOverrides = Readonly<{
	/** Concrete model reference for this invocation. */
	model?: string;
	/** Concrete allowlist for this invocation; replaces the declared toolset. */
	tools?: string[];
	/** Invocation-scoped context appended to the agent definition's system prompt. */
	appendSystemPrompt?: string;
	/** Custom tools registered only for this invocation. */
	customTools?: ToolDefinition[];
	/**
	 * Ask the provider to constrain `finish` arguments to the strict-mode finish schema. Enable
	 * only for routes whose providers honor strict tool calls.
	 */
	strictFinish?: boolean;
}>;

export type PiSessionHandle = Readonly<{
	manager: SessionManager;
	sessionId: string;
	restored: boolean;
	drain(): Promise<void>;
	close(): Promise<void>;
}>;

export interface PiSessionService {
	openOrCreate(sessionId: string): Promise<PiSessionHandle>;
	readTranscript(sessionId: string): Promise<HyperchartSessionMessageInfo[] | undefined>;
	close(): Promise<void>;
}

type PiExecutorOptionsBase = {
	/** Branch-isolated workspace used as the agent cwd. */
	workDir: string;
	/** Repository/project directory that owns the run. */
	projectDir?: string;
	agentDir?: string;
	extensionPolicy?: PiExtensionPolicy;
	definitionDirs?: string[];
	sessionsDir: string;
	branchId: string;
	modelRuntime: ModelRuntime;
	defaultModel?: string;
	modelRoles?: Record<string, string>;
	toolsets?: Record<string, string[]>;
	/** Resolve mutable host configuration immediately before a Pi session starts. */
	resolveSessionOverrides?: (context: PiSessionOverridesContext) => Promise<PiSessionOverrides | undefined>;
	schemaRegistry?: SchemaRegistry;
};

export type PiExecutorOptions = PiExecutorOptionsBase & {
	sessionService?: PiSessionService;
};

export function createInvocationCustomTools(
	effect: AgentEffect,
	sink: CompletionSink,
	registry: SchemaRegistry | undefined,
	customTools: readonly ToolDefinition[] | undefined,
	options: { strictFinish?: boolean } = {},
): ToolDefinition[] {
	return [...(customTools ?? []), createFinishTool(effect, sink, registry, { strict: options.strictFinish === true })];
}

export function sessionIdForAttempt(sessionId: string, attempt: number): string {
	return attempt === 0 ? sessionId : `${sessionId}:attempt:${attempt}`;
}

function workspaceContextNote(projectDir: string, branchWorkspace: string): string {
	if (projectDir === branchWorkspace) {
		return [
			`Project/repository directory: ${projectDir}`,
			`Branch workspace (current working directory): ${branchWorkspace}`,
			`Working directory: ${branchWorkspace}`,
		].join("\n");
	}
	return [
		`Project/repository directory: ${projectDir}`,
		`Branch workspace (current working directory): ${branchWorkspace}`,
		`Working directory: ${branchWorkspace}`,
		"The branch workspace is an isolated Hyperchart artifact workspace, not a checkout of the project repository. Do not assume project files are present in it. If the task requires project files, use the project/repository path explicitly; edits there are outside branch-workspace isolation.",
	].join("\n");
}

type LiveAgent = {
	session: AgentSession;
	effect: AgentEffect;
	sink: CompletionSink;
	generation: number;
	unsubscribeProgress?: () => void;
};

type RunOptions = {
	forceNewSession: boolean;
	sessionAttempt: number;
	resumePrompt?: string;
	resumeSessionFile?: string;
};

class SessionCleanupError extends AggregateError {}

export class PiAgentExecutor implements AgentExecutor {
	private readonly live = new Map<string, LiveAgent>();
	private readonly runs = new Map<string, Map<number, Promise<void>>>();
	private readonly cancellations = new Map<string, { generation: number; promise: Promise<void> }>();
	private readonly generations = new GenerationTracker();
	private readonly cleanupFailures: unknown[] = [];
	private readonly sessionCleanups = new WeakMap<AgentSession, Promise<void>>();
	private readonly sessionPrompts = new WeakMap<AgentSession, Promise<void>>();
	private readonly sessionHandles = new WeakMap<AgentSession, PiSessionHandle>();
	private readonly agentDir: string;
	private readonly definitionDirs: string[];
	private disposed = false;
	private disposal: Promise<void> | undefined;

	constructor(private readonly options: PiExecutorOptions) {
		this.agentDir = options.agentDir ?? getAgentDir();
		this.definitionDirs = options.definitionDirs ?? resolvePiSubagentDefinitionDirs(options.workDir, this.agentDir);
	}

	start(effect: AgentEffect, emit: EmitAgentOutcome): void {
		if (this.disposed) {
			emit({
				kind: "failed",
				failure: { kind: "runtime", retryable: false, message: "Pi agent executor is disposed" },
			});
			return;
		}
		const key = actionUidKey(effect.actionUid);
		const previous = this.cancelAction(effect.actionUid, true);
		const generation = this.generations.next(key);
		this.launch(
			key,
			generation,
			this.run(
				effect,
				emit,
				{
					forceNewSession: effect.recovery?.mode === "restart",
					sessionAttempt: effect.recovery?.restartAttempt ?? 0,
					...(effect.recovery !== undefined
						? { resumePrompt: buildRecoveryPrompt(effect) }
						: effect.resume === undefined
							? {}
							: {
									resumePrompt: effect.resume.message,
									...(effect.resume.session === undefined ? {} : { resumeSessionFile: effect.resume.session }),
								}),
				},
				generation,
				previous,
			).catch((error: unknown) => this.handleRunFailure(key, generation, effect, emit, error)),
		);
	}

	async steer(actionKey: string, invokeSeqId: number, message: string): Promise<boolean> {
		if (this.disposed) {
			return false;
		}
		const live = this.live.get(actionKey);
		if (live === undefined || effectInvokeSeqId(live.effect.id) !== invokeSeqId) {
			return false;
		}
		await live.session.steer(message);
		return true;
	}

	cancel(actionUid: ActionUID): Promise<void> {
		return this.cancelAction(actionUid, false);
	}

	private cancelAction(actionUid: ActionUID, superseded: boolean): Promise<void> {
		if (this.disposed) {
			return this.disposal ?? Promise.resolve();
		}
		const key = actionUidKey(actionUid);
		const generation = this.generations.current(key);
		if (generation === undefined) {
			return Promise.resolve();
		}
		const existing = this.cancellations.get(key);
		if (existing?.generation === generation) {
			return existing.promise;
		}
		// Replacement immediately advances the generation; do not accumulate a
		// cancelled-generation tombstone for every normally completed visit.
		if (!superseded) {
			this.generations.markCancelled(key, generation);
		}
		const failures: unknown[] = [];
		const live = this.live.get(key);
		if (live !== undefined) {
			this.live.delete(key);
			try {
				this.detachProgress(live);
			} catch (error) {
				failures.push(error);
			}
			try {
				this.updateProgress(live.effect, { status: "cancelled", completedAt: Date.now() });
			} catch (error) {
				failures.push(error);
			}
		}
		const run = this.runs.get(key)?.get(generation);
		const cancellation = (async () => {
			const results = await Promise.allSettled([
				...(live === undefined ? [] : [this.cleanupSession(live.session)]),
				...(run === undefined ? [] : [run]),
			]);
			failures.push(...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])));
			if (failures.length > 0) {
				throw new SessionCleanupError(failures, "Failed to cancel Pi agent action");
			}
		})();
		this.cancellations.set(key, { generation, promise: cancellation });
		const clearCancellation = () => {
			if (this.cancellations.get(key)?.promise === cancellation) {
				this.cancellations.delete(key);
			}
		};
		void cancellation.then(clearCancellation, clearCancellation);
		return cancellation;
	}

	dispose(): Promise<void> {
		if (this.disposal !== undefined) {
			return this.disposal;
		}
		this.disposed = true;
		this.disposal = this.disposeTrackedWork();
		return this.disposal;
	}

	private async disposeTrackedWork(): Promise<void> {
		for (const [key, runs] of this.runs) {
			for (const generation of runs.keys()) {
				this.generations.markCancelled(key, generation);
			}
		}
		const cleanup = [...this.live.entries()].map(([key, live]) => {
			this.generations.markCancelled(key, live.generation);
			try {
				this.detachProgress(live);
			} catch (error) {
				this.cleanupFailures.push(error);
			}
			try {
				this.updateProgress(live.effect, { status: "cancelled", completedAt: Date.now() });
			} catch (error) {
				this.cleanupFailures.push(error);
			}
			return this.cleanupSession(live.session);
		});
		const pending = [
			...cleanup,
			...[...this.runs.values()].flatMap((runs) => [...runs.values()]),
			...[...this.cancellations.values()].map((cancellation) => cancellation.promise),
		];
		const results = await Promise.allSettled(pending);
		const failures = [
			...results
				.filter((result): result is PromiseRejectedResult => result.status === "rejected")
				.map((result) => result.reason),
			...this.cleanupFailures,
		];
		try {
			await this.options.sessionService?.close();
		} catch (error) {
			failures.push(error);
		}
		this.live.clear();
		this.runs.clear();
		this.cancellations.clear();
		this.cleanupFailures.length = 0;
		if (failures.length > 0) {
			throw new AggregateError(failures, "Failed to dispose Pi agent executor cleanly");
		}
	}

	private launch(key: string, generation: number, run: Promise<void>): void {
		let runs = this.runs.get(key);
		if (runs === undefined) {
			runs = new Map();
			this.runs.set(key, runs);
		}
		const tracked = run.finally(() => {
			const current = this.runs.get(key);
			if (current?.get(generation) !== tracked) {
				return;
			}
			current.delete(generation);
			if (current.size === 0) {
				this.runs.delete(key);
			}
		});
		runs.set(generation, tracked);
		void tracked.catch(() => undefined);
	}

	private async run(
		effect: AgentEffect,
		emit: EmitAgentOutcome,
		runOptions: RunOptions,
		generation: number,
		previous: Promise<void> = Promise.resolve(),
	): Promise<void> {
		await previous;
		let outcome: AgentOutcome | undefined;
		await this.runSession(
			effect,
			(value) => {
				outcome = value;
			},
			runOptions,
			generation,
		);
		// Deliver only after the physical session and recorder have fully closed.
		if (outcome !== undefined) {
			this.safeEmit(actionUidKey(effect.actionUid), generation, emit, outcome);
		}
	}

	private async runSession(
		effect: AgentEffect,
		emit: EmitAgentOutcome,
		runOptions: RunOptions,
		generation: number,
	): Promise<void> {
		const key = actionUidKey(effect.actionUid);
		if (this.isStopped(key, generation)) {
			return;
		}
		this.updateProgress(effect, {
			actionName: effect.action.name,
			status: "starting",
			startedAt: Date.now(),
			role: undefined,
			model: undefined,
			thinking: undefined,
			toolset: undefined,
			tools: undefined,
			currentTool: undefined,
			currentToolArgs: undefined,
			currentToolStartedAt: undefined,
			error: undefined,
		});
		const definition = loadAgentDefinition(effect.action.name, this.definitionDirs);
		if (this.isStopped(key, generation)) {
			return;
		}
		// Validate every declared read before selecting or opening any restored session. A resumed
		// session must not bypass the local-artifact/URL boundary that a fresh run enforces.
		const reads = await resolveReads(effect, this.options.workDir, this.options.schemaRegistry);
		if (this.isStopped(key, generation)) {
			return;
		}
		const dir = actionSessionDir(this.options.sessionsDir, this.options.branchId, effect);
		const latest =
			this.options.sessionService === undefined
				? latestSessionForRunOptions(this.options.sessionsDir, this.options.branchId, dir, effect, runOptions)
				: undefined;
		const sink: CompletionSink = { captured: undefined };
		const session = await this.createSession(effect, definition, dir, latest, runOptions, sink, () =>
			this.isStopped(key, generation),
		);
		if (session === undefined) {
			return;
		}
		if (this.isStopped(key, generation)) {
			await this.cleanupSession(session);
			return;
		}
		const live: LiveAgent = { session, effect, sink, generation };
		this.live.set(key, live);
		try {
			live.unsubscribeProgress = this.attachProgress(session, effect, definition);
			if (this.isStopped(key, generation)) {
				return;
			}

			const restored = this.sessionHandles.get(session)?.restored ?? latest !== undefined;
			if (restored && shouldRecoverRestoredFinish(runOptions)) {
				const captured = await findCapturedFinish(session.messages, effect, this.options.schemaRegistry);
				if (this.isStopped(key, generation)) {
					return;
				}
				if (captured !== undefined) {
					sink.captured = captured;
					await this.acceptanceLoop(key, generation, emit, live);
					return;
				}
			}
			if (restored) {
				await this.promptAndAccept(key, generation, emit, live, runOptions.resumePrompt ?? buildResumePrompt(effect));
				return;
			}

			const taskPrompt = [runOptions.resumePrompt, buildTaskPrompt(effect, reads)]
				.filter((part): part is string => part !== undefined)
				.join("\n\n");
			await this.promptAndAccept(key, generation, emit, live, taskPrompt);
		} finally {
			if (this.live.get(key) === live) {
				this.live.delete(key);
			}
			try {
				this.detachProgress(live);
			} finally {
				await this.cleanupSession(session);
			}
		}
	}

	private async createSession(
		effect: AgentEffect,
		definition: AgentDefinition,
		dir: string,
		latest: string | undefined,
		runOptions: RunOptions,
		sink: CompletionSink,
		isStopped: () => boolean,
	): Promise<AgentSession | undefined> {
		const plan = buildSessionPlan(definition, effect, {
			...(this.options.defaultModel === undefined ? {} : { defaultModel: this.options.defaultModel }),
			...(this.options.modelRoles === undefined ? {} : { modelRoles: this.options.modelRoles }),
			...(this.options.toolsets === undefined ? {} : { toolsets: this.options.toolsets }),
		});
		const overrides = await this.options.resolveSessionOverrides?.({
			invocationId: effect.sessionId,
			branchId: this.options.branchId,
			actionUid: effect.actionUid,
			agentName: definition.name,
			...(definition.role === undefined ? {} : { declaredRole: definition.role }),
			...(definition.toolset === undefined ? {} : { declaredToolset: definition.toolset }),
		});
		if (isStopped()) {
			return undefined;
		}
		const modelRef = overrides?.model ?? plan.modelRef;
		const requestedTools = overrides?.tools ?? plan.tools;
		const tools = requestedTools === undefined ? undefined : [...new Set([...requestedTools, "finish"])];
		const invocationSystemPrompt = [
			definition.systemPrompt,
			overrides?.appendSystemPrompt,
			workspaceContextNote(this.options.projectDir ?? this.options.workDir, this.options.workDir),
		]
			.filter((part): part is string => part !== undefined && part.trim().length > 0)
			.join("\n\n");
		// Services load extensions and register their providers before model lookup,
		// matching Pi startup. Reloading a loader alone only queues registrations.
		const services = await createAgentSessionServices({
			cwd: this.options.workDir,
			agentDir: this.agentDir,
			modelRuntime: this.options.modelRuntime,
			resourceLoaderOptions: {
				noExtensions: this.options.extensionPolicy === "isolated",
				// Inline extensions load under either policy.
				...(overrides?.strictFinish === true ? { extensionFactories: [strictFinishExtension()] } : {}),
				...(plan.promptMode === "append"
					? { appendSystemPromptOverride: (base: string[]) => [...base, invocationSystemPrompt] }
					: {
							systemPromptOverride: () => invocationSystemPrompt,
							appendSystemPromptOverride: () => [],
						}),
			},
		});
		if (isStopped()) {
			return undefined;
		}
		const errors = services.diagnostics.filter((diagnostic) => diagnostic.type === "error");
		if (errors.length > 0) {
			throw new Error(errors.map((diagnostic) => diagnostic.message).join("\n"));
		}
		const model = modelRef === undefined ? undefined : resolveModel(services.modelRuntime, modelRef);
		const invokeSeqId = effectInvokeSeqId(effect.id);
		let sessionHandle: PiSessionHandle | undefined;
		if (this.options.sessionService !== undefined) {
			if (invokeSeqId === undefined) {
				throw new Error(`Agent effect ${effect.id} has no durable invoke sequence`);
			}
			// The service owns transcripts by durable ID. Only explicit reentry may
			// request another invocation's ID; retries must remain on their own ID.
			const resumeId = effect.recovery === undefined ? effect.resume?.session : undefined;
			sessionHandle = await this.options.sessionService.openOrCreate(
				resumeId !== undefined && !existsSync(resumeId) ? resumeId : effect.sessionId,
			);
		}
		if (isStopped()) {
			await this.closeSessionHandle(sessionHandle);
			return undefined;
		}
		const sessionManager =
			sessionHandle?.manager ??
			(latest === undefined
				? SessionManager.create(this.options.workDir, dir, {
						id: effect.sessionId,
					})
				: SessionManager.open(latest, dir, this.options.workDir));
		let session: AgentSession;
		try {
			({ session } = await createAgentSessionFromServices({
				services,
				...(model === undefined ? {} : { model }),
				...(plan.thinkingLevel === undefined ? {} : { thinkingLevel: plan.thinkingLevel }),
				...(tools === undefined ? {} : { tools }),
				customTools: createInvocationCustomTools(effect, sink, this.options.schemaRegistry, overrides?.customTools, {
					strictFinish: overrides?.strictFinish === true,
				}),
				sessionManager,
			}));
		} catch (error) {
			await this.closeSessionHandle(sessionHandle);
			throw error;
		}
		// No session option exists; Pi sets its own tool hooks on the agent the same way.
		session.agent.shouldStopAfterTurn = stopAfterRejectedFinish(sink);
		if (sessionHandle !== undefined) {
			this.sessionHandles.set(session, sessionHandle);
		}
		if (isStopped()) {
			await this.cleanupSession(session);
			return undefined;
		}
		try {
			const sessionFile = session.sessionManager.getSessionFile();
			this.updateProgress(effect, {
				actionName: definition.name,
				status: "running",
				sessionId: sessionManager.getSessionId(),
				sessionAttempt: runOptions.sessionAttempt,
				...(sessionFile === undefined ? {} : { sessionFile }),
				...(definition.role === undefined ? {} : { role: definition.role }),
				...(modelRef === undefined ? {} : { model: modelRef }),
				...(plan.thinkingLevel === undefined ? {} : { thinking: plan.thinkingLevel }),
				...(definition.toolset === undefined ? {} : { toolset: definition.toolset }),
				...(tools === undefined ? {} : { tools }),
			});
			return session;
		} catch (error) {
			await this.cleanupSession(session);
			throw error;
		}
	}

	private async promptAndAccept(
		key: string,
		generation: number,
		emit: EmitAgentOutcome,
		live: LiveAgent,
		prompt: string,
	): Promise<void> {
		if (this.isStopped(key, generation)) {
			return;
		}
		await this.promptSession(live.session, prompt);
		await this.sessionHandles.get(live.session)?.drain();
		if (this.isStopped(key, generation)) {
			return;
		}
		await this.acceptanceLoop(key, generation, emit, live);
	}

	private async promptSession(session: AgentSession, text: string): Promise<void> {
		// Register before invoking SDK/extension code, including asynchronous preflight.
		const prompt = Promise.resolve().then(() => session.prompt(text));
		this.sessionPrompts.set(session, prompt);
		try {
			await prompt;
		} finally {
			if (this.sessionPrompts.get(session) === prompt) {
				this.sessionPrompts.delete(session);
			}
		}
	}

	private async acceptanceLoop(
		key: string,
		generation: number,
		emit: EmitAgentOutcome,
		live: LiveAgent,
	): Promise<void> {
		const outcome = await evaluateAgentTurn({
			effect: live.effect,
			sink: live.sink,
			isCancelled: () => this.generations.isCancelled(key, generation),
			lastAssistantText: () => lastAssistantText(live.session.messages),
			lastAssistantError: () => lastAssistantError(live.session.messages),
			checkArtifacts: () => checkEffectArtifacts(live.effect, this.options.workDir, this.options.schemaRegistry),
		});
		if (outcome !== undefined) {
			this.safeEmit(key, generation, emit, outcome);
		}
	}

	private attachProgress(session: AgentSession, effect: AgentEffect, definition: AgentDefinition): () => void {
		let turnCount = 0;
		let toolCount = 0;
		let tokenCount = 0;
		const stream = createThrottledProgressWriter(
			this.options.sessionsDir,
			effect.actionUid,
			definition.name,
			effect.id,
			this.options.branchId,
		);
		const clearStreamFields = { currentText: undefined, currentReasoning: undefined };
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "turn_start") {
				turnCount++;
				stream.reset();
				this.updateProgress(effect, {
					actionName: definition.name,
					status: "running",
					turnCount,
					...clearStreamFields,
				});
				return;
			}
			if (event.type === "message_update") {
				if (event.assistantMessageEvent.type === "text_delta") {
					stream.appendText(event.assistantMessageEvent.delta);
				}
				if (event.assistantMessageEvent.type === "thinking_delta") {
					stream.appendReasoning(event.assistantMessageEvent.delta);
				}
				return;
			}
			if (event.type === "tool_execution_start") {
				toolCount++;
				this.updateProgress(effect, {
					actionName: definition.name,
					status: "running",
					toolCount,
					currentTool: event.toolName,
					currentToolArgs: stringifyToolArgs(event.args),
					currentToolStartedAt: Date.now(),
				});
				return;
			}
			if (event.type === "tool_execution_end") {
				this.updateProgress(effect, {
					actionName: definition.name,
					status: "running",
					toolCount,
					currentTool: undefined,
					currentToolArgs: undefined,
					currentToolStartedAt: undefined,
					...(event.isError ? { error: `${event.toolName} failed` } : { error: undefined }),
				});
				return;
			}
			if (event.type === "message_end") {
				tokenCount += usageTokens(event.message);
				stream.reset();
				this.updateProgress(effect, {
					actionName: definition.name,
					status: "running",
					...clearStreamFields,
					lastMessage: messagePreview(event.message),
					...(tokenCount > 0 ? { tokenCount } : {}),
				});
				return;
			}
			if (event.type === "agent_end") {
				stream.reset();
				this.updateProgress(effect, {
					actionName: definition.name,
					status: event.willRetry ? "running" : "completed",
					completedAt: event.willRetry ? undefined : Date.now(),
					currentTool: undefined,
					currentToolArgs: undefined,
					currentToolStartedAt: undefined,
					...clearStreamFields,
				});
			}
		});
		return () => {
			stream.dispose();
			unsubscribe();
		};
	}

	private updateProgress(effect: AgentEffect, patch: Parameters<typeof updateSessionProgress>[2]): void {
		updateSessionProgress(this.options.sessionsDir, effect.actionUid, patch, effect.id, this.options.branchId);
	}

	private markProgressFailed(effect: AgentEffect, error: string): void {
		this.updateProgress(effect, { status: "failed", error, completedAt: Date.now() });
	}

	private isStopped(key: string, generation: number): boolean {
		return this.disposed || this.generations.isCancelled(key, generation);
	}

	private handleRunFailure(
		key: string,
		generation: number,
		effect: AgentEffect,
		emit: EmitAgentOutcome,
		error: unknown,
	): void {
		if (this.isStopped(key, generation) && error instanceof SessionCleanupError) {
			throw error;
		}
		if (!this.isStopped(key, generation)) {
			this.markProgressFailed(effect, errorMessage(error));
		}
		this.safeEmit(key, generation, emit, {
			kind: "failed",
			failure: { kind: "runtime", retryable: false, message: errorMessage(error) },
		});
	}

	private detachProgress(live: LiveAgent): void {
		const unsubscribe = live.unsubscribeProgress;
		delete live.unsubscribeProgress;
		unsubscribe?.();
	}

	private async closeSessionHandle(handle: PiSessionHandle | undefined): Promise<void> {
		try {
			await handle?.close();
		} catch (error) {
			throw new SessionCleanupError([error], "Failed to close Pi session recorder");
		}
	}

	private cleanupSession(session: AgentSession): Promise<void> {
		const existing = this.sessionCleanups.get(session);
		if (existing !== undefined) {
			return existing;
		}
		const cleanup = Promise.resolve().then(() => this.closeSession(session));
		this.sessionCleanups.set(session, cleanup);
		return cleanup;
	}

	private async closeSession(session: AgentSession): Promise<void> {
		const failures: unknown[] = [];
		try {
			await session.abort();
		} catch (error) {
			failures.push(error);
		}
		// SDK abort()/waitForIdle() can return during before_agent_start preflight.
		// Await the prompt, NOT the overall run (whose finally awaits this cleanup).
		// Prompt failures are handled by the run; they must not skip shutdown.
		await this.sessionPrompts.get(session)?.catch(() => undefined);
		try {
			// SDK dispose invalidates extension contexts, but does not notify their
			// shutdown handlers (sockets, timers and bus subscriptions live there).
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		} catch (error) {
			// A notification failure must not replace an already accepted finish.
			// Still surface it at executor disposal, after releasing SDK/recorder resources.
			this.cleanupFailures.push(error);
		}
		try {
			session.dispose();
		} catch (error) {
			failures.push(error);
		}
		try {
			await this.sessionHandles.get(session)?.close();
		} catch (error) {
			failures.push(error);
		} finally {
			this.sessionHandles.delete(session);
		}
		if (failures.length > 0) {
			throw new SessionCleanupError(failures, "Failed to clean up Pi agent session");
		}
	}

	private safeEmit(key: string, generation: number, emit: EmitAgentOutcome, outcome: AgentOutcome): void {
		if (!this.isStopped(key, generation)) {
			emit(outcome);
		}
	}
}

export async function findCapturedFinish(
	messages: readonly unknown[],
	effect: AgentEffect,
	registry?: SchemaRegistry,
): Promise<ChartEvent | undefined> {
	let lastUser = -1;
	messages.forEach((message, index) => {
		if (isRecord(message) && message.role === "user") {
			lastUser = index;
		}
	});
	const calls = new Map<string, unknown>();
	let captured: ChartEvent | undefined;
	for (const message of messages.slice(lastUser + 1)) {
		if (!isRecord(message)) {
			continue;
		}
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const item of message.content) {
				if (isRecord(item) && item.type === "toolCall" && item.name === "finish" && typeof item.id === "string") {
					calls.set(item.id, item.arguments);
				}
			}
		}
		if (
			message.role === "toolResult" &&
			message.toolName === "finish" &&
			message.isError === false &&
			typeof message.toolCallId === "string" &&
			calls.has(message.toolCallId)
		) {
			const params = calls.get(message.toolCallId) as { event?: unknown; output?: unknown };
			const result = await validateFinishParams(effect, params, registry);
			if (result.ok) {
				captured = result.event;
			}
		}
	}
	return captured;
}

function resolveModel(modelRuntime: ModelRuntime, modelRef: string) {
	const [provider, ...rest] = modelRef.split("/");
	const modelId = rest.join("/");
	if (!provider || !modelId) {
		throw new Error(`Model '${modelRef}' must be in provider/model-id format`);
	}
	const model = modelRuntime.getModel(provider, modelId);
	if (model === undefined) {
		throw new Error(`Model '${modelRef}' was not found in the model registry`);
	}
	return model;
}

function latestSessionForRunOptions(
	sessionsDir: string,
	branchId: string,
	dir: string,
	effect: AgentEffect,
	runOptions: RunOptions,
): string | undefined {
	if (runOptions.forceNewSession) {
		return undefined;
	}
	// An explicit reentry may name a previous file or durable session ID.
	// A same-invocation recovery must instead restore its own pinned session.
	if (effect.recovery === undefined && effect.resume !== undefined) {
		if (runOptions.resumeSessionFile !== undefined && existsSync(runOptions.resumeSessionFile)) {
			return runOptions.resumeSessionFile;
		}
		return effect.resume.session === undefined
			? undefined
			: latestJsonlForPreviousActionSession(sessionsDir, branchId, effect, effect.resume.session);
	}
	return latestJsonl(dir, effect.sessionId);
}

function sessionIdInFile(file: string): string | undefined {
	const fd = openSync(file, "r");
	try {
		const header = Buffer.alloc(4096);
		const length = readSync(fd, header, 0, header.length, 0);
		const newline = header.subarray(0, length).indexOf(10);
		if (newline < 0) {
			return undefined;
		}
		const record: unknown = JSON.parse(header.toString("utf8", 0, newline));
		return typeof record === "object" &&
			record !== null &&
			"type" in record &&
			record.type === "session" &&
			"id" in record &&
			typeof record.id === "string"
			? record.id
			: undefined;
	} catch {
		return undefined;
	} finally {
		closeSync(fd);
	}
}

function latestJsonl(dir: string, sessionId: string): string | undefined {
	if (!existsSync(dir)) {
		return undefined;
	}
	return readdirSync(dir)
		.filter((file) => file.endsWith(".jsonl"))
		.map((file) => join(dir, file))
		.filter((file) => sessionIdInFile(file) === sessionId)
		.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
}

function latestJsonlForPreviousActionSession(
	sessionsDir: string,
	branchId: string,
	effect: AgentEffect,
	previousSessionId: string,
): string | undefined {
	const root = join(sessionsDir, branchSessionSegment(branchId), actionUidDirName(effect.actionUid));
	if (!existsSync(root)) {
		return undefined;
	}
	const currentKey = sanitizeSegment(sessionKey(effect.id));
	const candidates = readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name !== currentKey)
		.map((entry) => latestJsonl(join(root, entry.name), previousSessionId))
		.filter((file): file is string => file !== undefined);
	return candidates.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function usageTokens(message: unknown): number {
	if (!isRecord(message) || !isRecord(message.usage)) {
		return 0;
	}
	const usage = message.usage;
	if (typeof usage.totalTokens === "number") {
		return usage.totalTokens;
	}
	const input =
		typeof usage.input === "number" ? usage.input : typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
	const output =
		typeof usage.output === "number" ? usage.output : typeof usage.outputTokens === "number" ? usage.outputTokens : 0;
	const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
	const cacheWrite = typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
	return input + output + cacheRead + cacheWrite;
}

export function lastAssistantError(messages: readonly unknown[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!isRecord(message) || message.role !== "assistant") {
			continue;
		}
		if (message.stopReason !== "error") {
			return undefined;
		}
		return typeof message.errorMessage === "string" && message.errorMessage.trim().length > 0
			? message.errorMessage
			: "agent provider/runtime error";
	}
	return undefined;
}

function lastAssistantText(messages: readonly unknown[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!isRecord(message) || message.role !== "assistant") {
			continue;
		}
		const text = messageText(message);
		if (text !== undefined) {
			return text;
		}
	}
	return undefined;
}

function messagePreview(message: unknown): string | undefined {
	const text = messageText(message);
	if (text === undefined) {
		return undefined;
	}
	return previewText(text);
}

function messageText(message: unknown): string | undefined {
	if (!isRecord(message)) {
		return undefined;
	}
	const content = message.content;
	let text: string | undefined;
	if (typeof content === "string") {
		text = content;
	} else if (Array.isArray(content)) {
		text = content
			.map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : undefined))
			.filter((item): item is string => item !== undefined)
			.join(" ");
	}
	if (text === undefined) {
		return undefined;
	}
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length === 0 ? undefined : compact;
}
