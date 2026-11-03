import { StaleUserInteractionError } from "../execution/user_interaction.js";
import { hasBlockingReplayWarnings } from "../core/replay_check.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { resolveRunPaths, withRunStorage } from "../runtime/generic/run_paths.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { start } from "../execution/execution_loop.js";
import { BranchExecution } from "../execution/branch_execution.js";
import { artifactSnapshotValidator } from "../execution/artifact_admission.js";
import { parseChartModuleSync } from "../core/inspect.js";
import type { ReplayExplanation } from "../core/replay_check.js";
import type { ChartAst, ChartEvent } from "../core/types.js";
import type { BranchHead, BranchId, BranchMetadata, DurableLogRecord } from "../core/durable_events.js";
import type { SchemaRegistry } from "../core/schema_registry.js";
import { ChartRuntime } from "../runtime/generic/chart_runtime.js";
import { ArtifactStore } from "../runtime/generic/artifact_store.js";
import { materializeWorkspaceFromPins } from "../runtime/generic/artifact_workspace.js";
import {
	BranchHeadMovedError,
	collectBranches,
	type AppendAtHeadInput,
	type RunLogStore,
	type UserInteractionResponseCommit,
} from "../runtime/generic/log_store.js";
import { openRunLogStore, parseRunLogStorage, type RunLogStorage } from "../runtime/generic/log_store_factory.js";
import { supportsSqlTransactions, type SqlCommitParticipant } from "../runtime/generic/postgres_log_store.js";
import type { RunTerminalState } from "../execution/run_outcome.js";
import { patchRunStatus, type RunStatusPatch } from "../runtime/generic/run_status.js";
import {
	archiveTerminalNotificationGeneration,
	defaultFailedTerminalNotificationPayload,
	persistTerminalNotificationRequest,
} from "../runtime/generic/terminal_notifications.js";
import type { TerminalNotificationPayload } from "../runtime/generic/terminal_notifications.js";
import { watchSessionSteering } from "../runtime/generic/session_steering.js";
import { watchRunnerControl, type RunnerMoveBranchCommit } from "../runtime/generic/runner_control.js";
import { assertChartPreflight } from "../runtime/generic/chart_typecheck.js";
import type { AgentExecutor } from "../runtime/generic/agent_executor.js";
import { errorMessage } from "../utils/errors.js";

export type RunnerCommonConfig = {
	runId: string;
	chartPath: string;
	chartId: string;
	exportName?: string;
	workDir: string;
	attemptId?: string;
	args?: Record<string, unknown>;
	defaultModel?: string;
	modelRoles?: Record<string, string>;
	toolsets?: Record<string, string[]>;
	ignoreReplayWarnings?: boolean;
	agentDir?: string;
	storage?: RunLogStorage;
};

/** Legacy singleton input remains accepted; branchIds are initial runner seeds. */
export type HyperchartRunnerConfig = RunnerCommonConfig &
	({ branchId: BranchId; branchIds?: never } | { branchIds: BranchId[]; branchId?: never });

export type BranchHyperchartRunnerConfig = RunnerCommonConfig & {
	branchId: BranchId;
	/** Repository/project directory that owns the run. Unlike workDir, this is not branch-isolated. */
	projectDir: string;
	/** Launch provenance only. This is not the controller's changing live set. */
	initialBranchIds: readonly BranchId[];
};

export type SteerableAgentExecutor = AgentExecutor & {
	steer(actionKey: string, invokeSeqId: number, message: string): Promise<boolean>;
};
export type ExecutorContext = {
	/** Branch-scoped config; hosts must construct one executor from each callback. */
	config: BranchHyperchartRunnerConfig;
	ast: ChartAst;
	schemaRegistry: SchemaRegistry;
	sessionsDir: string;
};

export type RunnerBranchOutcome = Readonly<{
	branchId: BranchId;
	outcome: "complete" | "failed" | "drained";
	error?: string;
	/** Original local cleanup failure; not a durable log fact or transport identity. */
	cause?: unknown;
	/** Accepted results of a branch that reached a terminal state, by state path, from its projection. */
	results?: Readonly<Record<string, unknown>>;
}>;

/** How a started controller ended: its aggregate terminal state, or stopped before one. */
export type RunnerOutcome = Readonly<{
	state: RunTerminalState | "stopped";
	error?: string;
	/** Settled outcome of every branch, in settlement order. */
	branches: readonly RunnerBranchOutcome[];
}>;

export type RunnerForkOptions = Readonly<{
	branchId: BranchId;
	fromSeqId: number;
	sourceBranchId?: BranchId;
	reason?: string;
}>;

export type RunnerCommitUserInteractionOptions = Readonly<{
	branchId: BranchId;
	gateSeqId: number;
	event: ChartEvent;
}>;

export type RunnerForkAndCommitUserInteractionOptions = RunnerForkOptions &
	Readonly<{
		responseBranchId: BranchId;
		gateSeqId: number;
		event: ChartEvent;
	}>;

export interface RunnerHold {
	/** Idempotently release this hold. If no branches remain, aggregate termination begins. */
	release(): void;
}

export class BranchSealedError extends Error {
	constructor(
		readonly branchId: BranchId,
		readonly operation: string,
	) {
		super(`Hyperchart branch '${branchId}' is sealed; cannot ${operation}`);
		this.name = "BranchSealedError";
	}
}

/** A failed drain retains the runner admission fence and cannot be readmitted in this attempt. */
export class BranchDrainError extends Error {
	constructor(
		readonly branchId: BranchId,
		readonly outcomes: readonly RunnerBranchOutcome[],
	) {
		super(
			`Cannot move branch '${branchId}': ${outcomes
				.filter((outcome) => outcome.outcome !== "drained")
				.map((outcome) => outcome.error ?? `${outcome.branchId} did not drain`)
				.join("; ")}`,
			{ cause: outcomes.find((outcome) => outcome.outcome !== "drained")?.cause },
		);
		this.name = "BranchDrainError";
	}
}

/** An admission fence retained by this attempt cannot be retried as a fresh reservation. */
export class BranchAdmissionError extends Error {
	constructor(
		readonly branchId: BranchId,
		options?: ErrorOptions,
	) {
		super(`Hyperchart branch '${branchId}' was already admitted to this runner attempt`, options);
		this.name = "BranchAdmissionError";
	}
}

export interface HyperchartRunnerController {
	/** Observe reservation settlement and admission readiness, including changes without journal writes. */
	onBranchChange(listener: () => void): () => void;
	/** Whether a fresh reservation can be made now. Failed cleanup throws with its original cause. */
	canStartBranch(branchId: BranchId): boolean;
	/** Every durable branch currently known to this controller. */
	durableBranchIds(): Promise<readonly BranchId[]>;
	readonly liveBranchIds: readonly BranchId[];
	/** Live branches occupying execution capacity, including setup/drain but excluding journal-native open user gates. */
	activeBranchIds(): Promise<readonly BranchId[]>;
	/** Launch the reserved initial branches and resolve with the outcome at aggregate termination. */
	start(): Promise<RunnerOutcome>;
	/** Stop every live branch and close the controller without terminating the host process. */
	stop(): Promise<void>;
	/** Keep an accepting controller alive across idle gaps with no live branches. */
	acquireHold(): RunnerHold;
	/** Create only a durable branch head. No executor or runtime is started. */
	forkBranch(options: RunnerForkOptions): Promise<BranchHead>;
	/** Commit one response through this runtime's sole journal writer. */
	respondToUserInteraction(
		branchId: BranchId,
		gateSeqId: number,
		event: ChartEvent,
	): Promise<UserInteractionResponseCommit>;
	/** Atomically commit one response and trusted application SQL. PostgreSQL only. */
	commitUserInteraction<T>(
		options: RunnerCommitUserInteractionOptions,
		participate: SqlCommitParticipant<T>,
	): Promise<{ response: UserInteractionResponseCommit; participant: T }>;
	/** Atomically fork, commit the selected response, and run trusted application SQL. PostgreSQL only. */
	forkAndCommitUserInteraction<T>(
		options: RunnerForkAndCommitUserInteractionOptions,
		participate: SqlCommitParticipant<T>,
	): Promise<{ branch: BranchHead; response: UserInteractionResponseCommit; participant: T }>;
	/** Seal and drain the affected fork subtree, then atomically append one durable head move. */
	moveBranch(branchId: BranchId, targetHeadSeqId: number | null): Promise<number>;
	/** Reserve, replay-gate, execute, dispose, and return this branch's outcome. A settled failure without a durable failure intent may be replay-gated and readmitted. */
	startBranch(branchId: BranchId): Promise<RunnerBranchOutcome>;
	/** Release an idle user-gated branch runtime without writing a new checkpoint. The branch remains replay-gated and eligible for readmission. */
	unloadBranch(branchId: BranchId): Promise<RunnerBranchOutcome>;
	/** Seal one live branch and drain all already admitted work. A successful drain remains eligible for replay-gated readmission. */
	stopAndDrain(branchId: BranchId): Promise<RunnerBranchOutcome>;
}

type RunnerPhase = "accepting" | "closing" | "closed";
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };
type BranchSetupState = "reserved" | "replaying" | "building" | "running";
type BranchEntry = {
	branchId: BranchId;
	store: RunLogStore;
	ready: Deferred<void>;
	outcome: Deferred<RunnerBranchOutcome>;
	setupState: BranchSetupState;
	setup?: Promise<void>;
	execution?: Promise<void>;
	executor?: SteerableAgentExecutor;
	runtime?: ChartRuntime;
	semantic?: BranchExecution;
	/** Public/controller admission closes synchronously before asynchronous drain work. */
	admissionClosed: boolean;
	draining: boolean;
	operations: Set<Promise<unknown>>;
	drain?: Promise<RunnerBranchOutcome>;
	disposal?: Promise<void>;
};
type ReplayGate = { warnings: string[]; semantic?: BranchExecution; error?: string };
type PreparedUserResponse = {
	semantic: BranchExecution;
	input: AppendAtHeadInput;
	gateSeqId: number;
	existing?: UserInteractionResponseCommit["record"];
};
type ExecutorFactory = (context: ExecutorContext) => Promise<SteerableAgentExecutor> | SteerableAgentExecutor;

export function runnerBranchIds(config: Pick<HyperchartRunnerConfig, "branchId" | "branchIds">): BranchId[] {
	if (config.branchId !== undefined && config.branchIds !== undefined) {
		throw new Error("Hyperchart runner config accepts branchId or branchIds, not both");
	}
	const branchIds = config.branchIds ?? (config.branchId === undefined ? undefined : [config.branchId]);
	if (branchIds === undefined || branchIds.length === 0) {
		throw new Error("Hyperchart runner config requires branchId or non-empty branchIds");
	}
	const seen = new Set<string>();
	for (const branchId of branchIds) {
		assertRunnerBranchId(branchId);
		if (seen.has(branchId)) {
			throw new Error(`Duplicate Hyperchart runner branchId '${branchId}'`);
		}
		seen.add(branchId);
	}
	return [...branchIds];
}

export function readRunnerConfig(path: string): HyperchartRunnerConfig {
	const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	if (
		typeof value.runId !== "string" ||
		typeof value.chartPath !== "string" ||
		typeof value.chartId !== "string" ||
		typeof value.workDir !== "string"
	) {
		throw new Error(`Invalid hyperchart runner config: ${path}`);
	}
	const hasBranchId = Object.hasOwn(value, "branchId");
	const hasBranchIds = Object.hasOwn(value, "branchIds");
	if (
		(hasBranchId && typeof value.branchId !== "string") ||
		(hasBranchIds && (!Array.isArray(value.branchIds) || !value.branchIds.every((entry) => typeof entry === "string")))
	) {
		throw new Error(`Invalid hyperchart runner config: ${path} (branch selectors must be strings)`);
	}
	const branchInput = {
		...(hasBranchId ? { branchId: value.branchId as string } : {}),
		...(hasBranchIds ? { branchIds: value.branchIds as string[] } : {}),
	} as Pick<HyperchartRunnerConfig, "branchId" | "branchIds">;
	try {
		runnerBranchIds(branchInput);
	} catch (error) {
		throw new Error(
			`Invalid hyperchart runner config: ${path} (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	const storage = parseRunLogStorage(value.storage);
	if (value.storage !== undefined && storage === undefined) {
		throw new Error(
			`Invalid hyperchart runner config: ${path} (storage must select jsonl or postgres with a non-empty dsn)`,
		);
	}
	const common: RunnerCommonConfig = {
		runId: value.runId,
		chartPath: value.chartPath,
		chartId: value.chartId,
		workDir: value.workDir,
		...(typeof value.attemptId === "string" ? { attemptId: value.attemptId } : {}),
		...(typeof value.agentDir === "string" ? { agentDir: value.agentDir } : {}),
		...(typeof value.exportName === "string" ? { exportName: value.exportName } : {}),
		...(isRecord(value.args) ? { args: value.args } : {}),
		...(typeof value.defaultModel === "string" ? { defaultModel: value.defaultModel } : {}),
		...(isRecord(value.modelRoles) ? { modelRoles: stringEntries(value.modelRoles) } : {}),
		...(isRecord(value.toolsets) ? { toolsets: stringArrayEntries(value.toolsets) } : {}),
		...(value.ignoreReplayWarnings === true ? { ignoreReplayWarnings: true } : {}),
		...(storage === undefined ? {} : { storage }),
	};
	return hasBranchId
		? { ...common, branchId: value.branchId as string }
		: { ...common, branchIds: value.branchIds as string[] };
}

class HyperchartRunnerControllerImpl implements HyperchartRunnerController {
	private readonly branchListeners = new Set<() => void>();
	private phase: RunnerPhase = "accepting";
	private readonly live = new Map<BranchId, BranchEntry>();
	private readonly admitted = new Map<BranchId, BranchAdmissionError | undefined>();
	private readonly knownDurableBranches: Set<BranchId>;
	private readonly sealedBranches = new Set<BranchId>();
	private readonly movingBranches = new Set<BranchId>();
	private readonly readmissionRequired = new Set<BranchId>();
	private writerChain: Promise<void> = Promise.resolve();
	private moveChain: Promise<void> = Promise.resolve();
	private readonly outcomes: RunnerBranchOutcome[] = [];
	private readonly notificationRenderers = new Map<
		BranchId,
		(outcome: RunTerminalState, error?: string) => TerminalNotificationPayload
	>();
	private readonly executors = new Map<BranchId, SteerableAgentExecutor>();
	private readonly completion = deferred<RunnerOutcome>();
	private readonly initialReplayBarrier = deferred<void>();
	private readonly initialSetupTurns: Deferred<void>[];
	private readonly artifactStore: ArtifactStore;
	private holdCount = 0;
	private started = false;
	private heartbeat: NodeJS.Timeout | undefined;
	private stopSteering: (() => void) | undefined;
	private stopControl: (() => void) | undefined;
	private shutdownSignal: NodeJS.Signals | undefined;
	private readonly onSigterm = AsyncLocalStorage.bind(() => void this.close("SIGTERM"));
	private readonly onSigint = AsyncLocalStorage.bind(() => void this.close("SIGINT"));

	constructor(
		private readonly config: HyperchartRunnerConfig & { runDir: string },
		private readonly initialBranchIds: readonly BranchId[],
		private readonly attemptId: string,
		private readonly ast: ChartAst,
		private readonly schemaRegistry: SchemaRegistry,
		private readonly rootStore: RunLogStore,
		durableBranchIds: readonly BranchId[],
		private readonly sessionsDir: string,
		private readonly buildExecutor: ExecutorFactory,
	) {
		this.artifactStore = new ArtifactStore(config.runDir);
		this.knownDurableBranches = new Set(durableBranchIds);
		this.initialSetupTurns = Array.from({ length: initialBranchIds.length + 1 }, () => deferred<void>());
		this.initialSetupTurns[0]!.resolve();
		for (const branchId of initialBranchIds) {
			this.reserve(branchId);
		}
		this.stopSteering = watchSessionSteering(
			sessionsDir,
			(request) =>
				this.executors.get(request.branchId)?.steer(request.actionKey, request.invokeSeqId, request.message) ?? false,
		);
		this.stopControl = watchRunnerControl(config.runId, attemptId, (request) =>
			request.kind === "move_branch"
				? this.queueBranchMove(request.branchId, request.targetHeadSeqId)
				: this.respondToUserInteraction(request.branchId, request.gateSeqId, request.event),
		);
		this.heartbeat = setInterval(() => this.patchStatus({ pid: process.pid, heartbeatAt: Date.now() }), 2_000);
		this.heartbeat.unref();
		process.on("SIGTERM", this.onSigterm);
		process.on("SIGINT", this.onSigint);
	}

	onBranchChange(listener: () => void): () => void {
		this.branchListeners.add(listener);
		return () => {
			this.branchListeners.delete(listener);
		};
	}

	private notifyBranchChange(): void {
		for (const listener of this.branchListeners) {
			listener();
		}
	}

	canStartBranch(branchId: BranchId): boolean {
		const failure = this.admitted.get(branchId);
		if (failure?.cause !== undefined) {
			throw failure;
		}
		return (
			this.phase === "accepting" &&
			this.knownDurableBranches.has(branchId) &&
			(this.admitted.has(branchId) === false || failure !== undefined) &&
			!this.movingBranches.has(branchId) &&
			(!this.sealedBranches.has(branchId) || this.readmissionRequired.has(branchId))
		);
	}

	async durableBranchIds(): Promise<readonly BranchId[]> {
		return [...this.knownDurableBranches];
	}
	get liveBranchIds(): readonly BranchId[] {
		return [...this.live.keys()];
	}
	async activeBranchIds(): Promise<readonly BranchId[]> {
		const active = await Promise.all(
			[...this.live.entries()].map(async ([branchId, entry]) => {
				if (entry.draining) {
					return branchId;
				}
				const semantic =
					entry.semantic ??
					(await BranchExecution.restore({ ast: this.ast, branchId, store: entry.store, saveCheckpoint: "never" }));
				return semantic.openUserInteractions().length === 0 ? branchId : undefined;
			}),
		);
		return active.filter((branchId): branchId is BranchId => branchId !== undefined);
	}

	start(): Promise<RunnerOutcome> {
		if (!this.started) {
			this.started = true;
			if (this.phase === "accepting") {
				void this.launchInitialBranches();
			}
		}
		return this.completion.promise;
	}

	acquireHold(): RunnerHold {
		this.assertAccepting("acquire a hold");
		this.holdCount++;
		let released = false;
		return {
			release: AsyncLocalStorage.bind(() => {
				if (released) {
					return;
				}
				released = true;
				if (this.holdCount > 0) {
					this.holdCount--;
				}
				this.finishIfDrained();
			}),
		};
	}

	async forkBranch(options: RunnerForkOptions): Promise<BranchHead> {
		this.assertAccepting("fork a branch");
		assertRunnerBranchId(options.branchId);
		const sourceBranchId = options.sourceBranchId ?? this.rootStore.branchId;
		assertRunnerBranchId(sourceBranchId);
		return this.trackBranchOperation([sourceBranchId], "fork a branch", () =>
			this.mutateJournal([sourceBranchId, options.branchId], "fork a branch", async () => {
				const source = await this.rootStore.captureSnapshot(sourceBranchId);
				if (!(await this.rootStore.containsInHistory({ headSeqId: source.headSeqId, seqId: options.fromSeqId }))) {
					throw new Error(`Fork point ${options.fromSeqId} is not in source branch '${sourceBranchId}' ancestry`);
				}
				const semantic = await BranchExecution.restore({
					ast: this.ast,
					branchId: options.branchId,
					store: this.rootStore,
					saveCheckpoint: "never",
					snapshot: { branchId: options.branchId, headSeqId: options.fromSeqId },
				});
				const checkpoint = semantic.prepareExactCheckpoint(options.fromSeqId);
				const branch = await this.rootStore.createBranch(
					options.branchId,
					options.fromSeqId,
					forkMetadata(options, sourceBranchId),
					checkpoint === undefined ? undefined : { checkpoint },
				);
				this.knownDurableBranches.add(branch.branchId);
				return branch;
			}),
		);
	}

	async respondToUserInteraction(
		branchId: BranchId,
		gateSeqId: number,
		event: ChartEvent,
	): Promise<UserInteractionResponseCommit> {
		this.assertAccepting("respond to a user interaction");
		this.assertBranchesNotDraining([branchId], "respond to a user interaction");
		const store = branchId === this.rootStore.branchId ? this.rootStore : this.rootStore.forBranch(branchId);
		return this.trackBranchOperation([branchId], "respond to a user interaction", async () => {
			await store.getBranch(branchId);
			await this.awaitLiveBranchReadiness(branchId, "respond to a user interaction");
			return this.mutateJournal([branchId], "respond to a user interaction", () =>
				this.commitUserResponse(store, branchId, gateSeqId, event, "control:user-response"),
			);
		});
	}

	async commitUserInteraction<T>(
		options: RunnerCommitUserInteractionOptions,
		participate: SqlCommitParticipant<T>,
	): Promise<{ response: UserInteractionResponseCommit; participant: T }> {
		this.assertAccepting("atomically commit a user interaction");
		this.assertBranchesNotDraining([options.branchId], "atomically commit a user interaction");
		const store = this.rootStore;
		if (!supportsSqlTransactions(store)) {
			throw new Error("Atomic application commit requires the PostgreSQL Hyperchart backend");
		}
		return this.trackBranchOperation([options.branchId], "atomically commit a user interaction", async () => {
			await store.getBranch(options.branchId);
			await this.awaitLiveBranchReadiness(options.branchId, "atomically commit a user interaction");
			return this.mutateJournal([options.branchId], "atomically commit a user interaction", async () => {
				for (let attempt = 0; attempt < 3; attempt++) {
					const prepared = await this.prepareUserInteractionCommit(
						store.forBranch(options.branchId),
						options.branchId,
						options.gateSeqId,
						options.event,
					);
					try {
						const committed = await store.appendDraftsAtHeadWithParticipant(
							options.branchId,
							prepared.input,
							prepared.input.drafts.length === 0 ? undefined : prepared.semantic.prepareStampedCommit,
							participate,
						);
						const response =
							prepared.existing === undefined
								? { record: committed.records[0] as UserInteractionResponseCommit["record"], idempotent: false }
								: { record: prepared.existing, idempotent: true };
						this.acknowledgeUserInteraction(
							options.branchId,
							options.gateSeqId,
							response,
							"control:atomic-user-response",
							committed.records,
						);
						return { response, participant: committed.participant };
					} catch (error) {
						if (!isHeadMovedError(error) || attempt === 2) {
							throw error;
						}
					}
				}
				throw new Error("Unreachable atomic user response retry state");
			});
		});
	}

	async forkAndCommitUserInteraction<T>(
		options: RunnerForkAndCommitUserInteractionOptions,
		participate: SqlCommitParticipant<T>,
	): Promise<{ branch: BranchHead; response: UserInteractionResponseCommit; participant: T }> {
		this.assertAccepting("atomically fork and commit a user interaction");
		assertRunnerBranchId(options.branchId);
		assertRunnerBranchId(options.responseBranchId);
		const store = this.rootStore;
		if (!supportsSqlTransactions(store)) {
			throw new Error("Atomic application commit requires the PostgreSQL Hyperchart backend");
		}
		const sourceBranchId = options.sourceBranchId ?? store.branchId;
		this.assertBranchesNotDraining(
			[sourceBranchId, options.responseBranchId],
			"atomically fork and commit a user interaction",
		);
		return this.trackBranchOperation(
			[sourceBranchId, options.responseBranchId],
			"atomically fork and commit a user interaction",
			async () => {
				await this.awaitLiveBranchReadiness(options.responseBranchId, "atomically fork and commit a user interaction");
				return this.mutateJournal(
					[sourceBranchId, options.branchId, options.responseBranchId],
					"atomically fork and commit a user interaction",
					async () => {
						const forkSnapshot = { branchId: options.branchId, headSeqId: options.fromSeqId } as const;
						const forkSemantic = await BranchExecution.restore({
							ast: this.ast,
							branchId: options.branchId,
							store,
							saveCheckpoint: "never",
							snapshot: forkSnapshot,
						});
						const checkpoint = forkSemantic.prepareExactCheckpoint(options.fromSeqId);
						for (let attempt = 0; attempt < 3; attempt++) {
							const responseStore =
								options.responseBranchId === options.branchId ? store : store.forBranch(options.responseBranchId);
							let responseSnapshot: Readonly<{ branchId: BranchId; headSeqId: number | null }> | undefined;
							if (options.responseBranchId === options.branchId) {
								try {
									responseSnapshot = await store.captureSnapshot(options.branchId);
								} catch (error) {
									if (!(error instanceof Error) || !error.message.includes("Unknown Hyperchart branch")) {
										throw error;
									}
									responseSnapshot = forkSnapshot;
								}
							}
							const prepared = await this.prepareUserInteractionCommit(
								responseStore,
								options.responseBranchId,
								options.gateSeqId,
								options.event,
								responseSnapshot,
							);
							try {
								const committed = await store.forkAndAppend(
									{
										sourceBranchId,
										newBranchId: options.branchId,
										fromSeqId: options.fromSeqId,
										appendBranchId: options.responseBranchId,
										metadata: forkMetadata(options, sourceBranchId),
										...(checkpoint === undefined ? {} : { checkpoint }),
										append: prepared.input,
										...(prepared.input.drafts.length === 0 ? {} : { prepare: prepared.semantic.prepareStampedCommit }),
									},
									participate,
								);
								this.knownDurableBranches.add(committed.branch.branchId);
								const response =
									prepared.existing === undefined
										? { record: committed.records[0] as UserInteractionResponseCommit["record"], idempotent: false }
										: { record: prepared.existing, idempotent: true };
								this.acknowledgeUserInteraction(
									options.responseBranchId,
									options.gateSeqId,
									response,
									"control:atomic-fork-response",
									committed.records,
								);
								return { branch: committed.branch, response, participant: committed.participant };
							} catch (error) {
								if (!isHeadMovedError(error) || attempt === 2) {
									throw error;
								}
							}
						}
						throw new Error("Unreachable atomic fork response retry state");
					},
				);
			},
		);
	}

	moveBranch(branchId: BranchId, targetHeadSeqId: number | null): Promise<number> {
		return this.queueBranchMove(branchId, targetHeadSeqId).then((commit) => commit.moveSeqId);
	}

	private queueBranchMove(branchId: BranchId, targetHeadSeqId: number | null): Promise<RunnerMoveBranchCommit> {
		this.assertAccepting("move a branch");
		assertRunnerBranchId(branchId);
		if (targetHeadSeqId !== null && (!Number.isSafeInteger(targetHeadSeqId) || targetHeadSeqId <= 0)) {
			return Promise.reject(new Error("targetHeadSeqId must be null or a positive safe integer"));
		}
		const result = this.moveChain.then(() => this.performBranchMove(branchId, targetHeadSeqId));
		this.moveChain = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async prepareUserInteractionCommit(
		store: RunLogStore,
		branchId: BranchId,
		gateSeqId: number,
		event: ChartEvent,
		fixedSnapshot?: Readonly<{ branchId: BranchId; headSeqId: number | null }>,
	): Promise<PreparedUserResponse> {
		const snapshot = fixedSnapshot ?? (await store.captureSnapshot(branchId));
		const liveSemantic = this.live.get(branchId)?.semantic;
		const semantic =
			liveSemantic !== undefined && liveSemantic.headSeqId() === snapshot.headSeqId
				? liveSemantic
				: await BranchExecution.restore({
						ast: this.ast,
						branchId,
						store,
						saveCheckpoint: "never",
						snapshot,
					});
		const existing = await store.findUserInteractionResponse({ headSeqId: snapshot.headSeqId, gateSeqId });
		if (existing !== undefined) {
			if (!isDeepStrictEqual(existing.event, event)) {
				throw new Error(`Conflicting response for user interaction ${gateSeqId}`);
			}
			return { semantic, input: { expectedHeadSeqId: snapshot.headSeqId, drafts: [] }, gateSeqId, existing };
		}
		const gate = await store.getRecord(gateSeqId);
		if (
			(gate?.type !== "user_interaction" && gate?.type !== "gate") ||
			gate.kind !== "opened" ||
			!(await store.containsInHistory({ headSeqId: snapshot.headSeqId, seqId: gateSeqId }))
		) {
			throw new StaleUserInteractionError(branchId, gateSeqId);
		}
		const drafts = await semantic.prepareUserInteraction(gate, event, this.schemaRegistry);
		return { semantic, input: { expectedHeadSeqId: snapshot.headSeqId, drafts }, gateSeqId };
	}

	private async commitUserResponse(
		store: RunLogStore,
		branchId: BranchId,
		gateSeqId: number,
		event: ChartEvent,
		source: string,
	): Promise<UserInteractionResponseCommit> {
		for (let attempt = 0; attempt < 3; attempt++) {
			const prepared = await this.prepareUserInteractionCommit(store, branchId, gateSeqId, event);
			if (prepared.existing !== undefined) {
				return { record: prepared.existing, idempotent: true };
			}
			try {
				const records = await store.appendDraftsAtHead(prepared.input, prepared.semantic.prepareStampedCommit);
				const committed = { record: records[0] as UserInteractionResponseCommit["record"], idempotent: false };
				this.acknowledgeUserInteraction(branchId, gateSeqId, committed, source, records);
				return committed;
			} catch (error) {
				if (!isHeadMovedError(error) || attempt === 2) {
					throw error;
				}
			}
		}
		throw new Error("Unreachable user response retry state");
	}

	private acknowledgeUserInteraction(
		branchId: BranchId,
		gateSeqId: number,
		committed: UserInteractionResponseCommit,
		source: string,
		records: readonly DurableLogRecord[] = [committed.record],
	): void {
		if (committed.idempotent) {
			return;
		}
		this.live
			.get(branchId)
			?.runtime?.acknowledgeCommittedRecords(records, `${source}:${gateSeqId}:${committed.record.seqId}`);
	}

	async startBranch(branchId: BranchId): Promise<RunnerBranchOutcome> {
		this.assertAccepting("start a branch");
		if (!this.started) {
			throw new Error(
				"Hyperchart runner must be started before starting a dynamic branch; call controller.start() first",
			);
		}
		assertRunnerBranchId(branchId);
		const previous = this.admitted.get(branchId);
		if (this.admitted.has(branchId) && (previous === undefined || previous.cause !== undefined)) {
			throw previous ?? new BranchAdmissionError(branchId);
		}
		if (!this.knownDurableBranches.has(branchId)) {
			throw new Error(`Unknown Hyperchart branch '${branchId}'`);
		}
		if (previous !== undefined) {
			// Claim this failed admission before the async replay check so concurrent
			// callers cannot both reserve the same branch.
			this.admitted.set(branchId, undefined);
			try {
				const store = branchId === this.rootStore.branchId ? this.rootStore : this.rootStore.forBranch(branchId);
				const semantic = await BranchExecution.restore({ ast: this.ast, branchId, store, saveCheckpoint: "never" });
				if (semantic.machineState().projection.failure !== undefined) {
					throw new Error(`Hyperchart branch '${branchId}' has a durable failure intent and cannot be retried`);
				}
			} catch (error) {
				this.admitted.set(branchId, previous);
				throw error;
			}
			this.assertAccepting("start a branch");
			this.admitted.delete(branchId);
			this.readmissionRequired.add(branchId);
		}
		const readmission = this.readmissionRequired.has(branchId);
		if (this.movingBranches.has(branchId) || (this.sealedBranches.has(branchId) && !readmission)) {
			throw new BranchSealedError(branchId, "start the branch");
		}
		const entry = this.reserve(branchId);
		this.publishLiveStatus();
		entry.setup = readmission ? this.setupReadmittedEntry(entry) : this.setupDynamicEntry(entry);
		return entry.outcome.promise;
	}

	async unloadBranch(branchId: BranchId): Promise<RunnerBranchOutcome> {
		this.assertAccepting("unload a branch");
		if (!this.started) {
			throw new Error("Hyperchart runner must be started before unloading a branch; call controller.start() first");
		}
		assertRunnerBranchId(branchId);
		const entry = this.live.get(branchId);
		if (entry === undefined) {
			throw new Error(`Hyperchart branch '${branchId}' is not live in this runner attempt`);
		}
		if (entry.drain !== undefined) {
			return entry.drain;
		}
		entry.admissionClosed = true;
		try {
			await entry.ready.promise;
			const idle = await this.enqueueWriterStep(async () => {
				if (this.live.get(branchId) !== entry || entry.semantic === undefined) {
					return false;
				}
				const snapshot = await entry.store.captureSnapshot(branchId);
				const semantic =
					entry.semantic.headSeqId() === snapshot.headSeqId
						? entry.semantic
						: await BranchExecution.restore({
								ast: this.ast,
								branchId,
								store: entry.store,
								saveCheckpoint: "never",
								snapshot,
							});
				return semantic.openUserInteractions().length > 0;
			});
			if (!idle) {
				throw new Error(`Hyperchart branch '${branchId}' is not idle at a durable user gate`);
			}
			entry.draining = true;
			entry.runtime?.beginDrain();
			entry.drain = this.drainEntry(entry, false, false);
			return entry.drain;
		} catch (error) {
			entry.admissionClosed = false;
			throw error;
		}
	}

	stopAndDrain(branchId: BranchId): Promise<RunnerBranchOutcome> {
		this.assertAccepting("stop and drain a branch");
		if (!this.started) {
			throw new Error(
				"Hyperchart runner must be started before stopping and draining a branch; call controller.start() first",
			);
		}
		assertRunnerBranchId(branchId);
		const entry = this.live.get(branchId);
		if (entry === undefined) {
			throw new Error(`Hyperchart branch '${branchId}' is not live in this runner attempt`);
		}
		if (entry.drain !== undefined) {
			return entry.drain;
		}
		// Reject newly admitted controller work synchronously. If setup is still
		// in flight, let it publish readiness so operations already enrolled by
		// the caller can settle before runtime draining and the durable seal.
		entry.admissionClosed = true;
		if (entry.setupState === "running") {
			entry.draining = true;
			entry.runtime?.beginDrain();
		}
		entry.drain = this.drainEntry(entry);
		return entry.drain;
	}

	private reserve(branchId: BranchId): BranchEntry {
		const entry: BranchEntry = {
			branchId,
			store: branchId === this.rootStore.branchId ? this.rootStore : this.rootStore.forBranch(branchId),
			ready: deferred<void>(),
			outcome: deferred<RunnerBranchOutcome>(),
			setupState: "reserved",
			admissionClosed: false,
			draining: false,
			operations: new Set(),
		};
		this.admitted.set(branchId, undefined);
		this.live.set(branchId, entry);
		return entry;
	}

	private runtimeStore(branchId: BranchId): RunLogStore {
		const store = branchId === this.rootStore.branchId ? this.rootStore : this.rootStore.forBranch(branchId);
		const controller = this;
		return new Proxy(store, {
			get(target, property) {
				if (property === "appendDrafts") {
					return (
						drafts: Parameters<RunLogStore["appendDrafts"]>[0],
						prepare?: Parameters<RunLogStore["appendDrafts"]>[1],
					) =>
						controller.mutateJournal([branchId], "append durable records", () => target.appendDrafts(drafts, prepare));
				}
				if (property === "appendDraftsAtHead") {
					return (
						input: Parameters<RunLogStore["appendDraftsAtHead"]>[0],
						prepare?: Parameters<RunLogStore["appendDraftsAtHead"]>[1],
					) =>
						controller.mutateJournal([branchId], "append durable records", () =>
							target.appendDraftsAtHead(input, prepare),
						);
				}
				const value = Reflect.get(target, property, target) as unknown;
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}

	private mutateJournal<T>(branchIds: readonly BranchId[], operation: string, task: () => T | Promise<T>): Promise<T> {
		return this.enqueueWriterStep(() => {
			for (const branchId of new Set(branchIds)) {
				if (this.sealedBranches.has(branchId)) {
					throw new BranchSealedError(branchId, operation);
				}
			}
			return task();
		});
	}

	private enqueueWriterStep<T>(task: () => T | Promise<T>): Promise<T> {
		const result = this.writerChain.then(task);
		this.writerChain = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async performBranchMove(branchId: BranchId, targetHeadSeqId: number | null): Promise<RunnerMoveBranchCommit> {
		let affected: readonly BranchId[] = [];
		let preexistingSeals: ReadonlySet<BranchId> = new Set();
		try {
			const sealed = await this.enqueueWriterStep(async () => {
				if (targetHeadSeqId !== null && (await this.rootStore.getRecord(targetHeadSeqId)) === undefined) {
					throw new Error(`No durable log record with seqId ${targetHeadSeqId}`);
				}
				const subtree = await affectedBranchSubtree(this.rootStore, branchId);
				const preexisting = new Set(subtree.filter((affectedBranchId) => this.sealedBranches.has(affectedBranchId)));
				for (const affectedBranchId of subtree) {
					this.sealedBranches.add(affectedBranchId);
					this.movingBranches.add(affectedBranchId);
				}
				return { subtree, preexisting };
			});
			affected = sealed.subtree;
			preexistingSeals = sealed.preexisting;

			const live = new Set(this.liveBranchIds);
			const outcomes = this.started
				? await Promise.all(
						affected
							.filter((affectedBranchId) => live.has(affectedBranchId))
							.map((affectedBranchId) => this.stopAndDrain(affectedBranchId)),
					)
				: [];
			const failed = outcomes.find((outcome) => outcome.outcome !== "drained");
			if (failed !== undefined) {
				throw new BranchDrainError(branchId, outcomes);
			}

			return await this.enqueueWriterStep(async () => {
				const semantic = await BranchExecution.restore({
					ast: this.ast,
					branchId,
					store: this.rootStore,
					saveCheckpoint: "never",
					snapshot: { branchId, headSeqId: targetHeadSeqId },
				});
				const checkpoint = semantic.prepareExactCheckpoint(targetHeadSeqId);
				const moved = await this.rootStore.moveBranch(
					branchId,
					targetHeadSeqId,
					checkpoint === undefined ? undefined : { checkpoint },
				);
				return {
					moveSeqId: moved.moveSeqId,
					previousHeadSeqId: moved.previousHeadSeqId,
					preservedRecords: moved.preservedRecords,
				};
			});
		} finally {
			if (affected.length > 0) {
				await this.enqueueWriterStep(() => {
					for (const affectedBranchId of affected) {
						this.movingBranches.delete(affectedBranchId);
						if (!preexistingSeals.has(affectedBranchId)) {
							this.sealedBranches.delete(affectedBranchId);
						}
					}
				});
				this.notifyBranchChange();
			}
		}
	}

	private async launchInitialBranches(): Promise<void> {
		const entries = this.initialBranchIds.map((branchId) => this.live.get(branchId)!);
		const gatePromises = entries.map((entry) => {
			entry.setupState = "replaying";
			return this.replayGate(entry);
		});
		for (const [index, entry] of entries.entries()) {
			entry.setup = this.setupInitialEntry(entry, gatePromises[index]!);
		}
		try {
			const gates = await Promise.all(gatePromises);
			if (this.phase !== "accepting") {
				return;
			}
			const warnings = gates.flatMap((gate) => gate.warnings);
			await this.rootStore.patchRunStatus({
				chartId: this.ast.id,
				state: "running",
				branchIds: [...this.liveBranchIds],
				pid: process.pid,
				heartbeatAt: Date.now(),
				error: undefined,
				exitCode: undefined,
				...(warnings.length === 0 ? { replayWarnings: undefined } : { replayWarnings: warnings }),
			});
		} finally {
			// Dynamic admissions may reserve immediately after start(), but cannot
			// inspect or execute their branch until every initial replay has gated.
			this.initialReplayBarrier.resolve();
		}
	}

	private async setupInitialEntry(entry: BranchEntry, gatePromise: Promise<ReplayGate>): Promise<void> {
		const gate = await gatePromise;
		await this.initialReplayBarrier.promise;
		const index = this.initialBranchIds.indexOf(entry.branchId);
		await this.initialSetupTurns[index]!.promise;
		try {
			await this.setupGatedEntry(entry, gate);
		} finally {
			this.initialSetupTurns[index + 1]!.resolve();
		}
	}

	private async setupDynamicEntry(entry: BranchEntry): Promise<void> {
		await this.initialReplayBarrier.promise;
		if (!this.isRunnable(entry)) {
			entry.ready.resolve();
			return;
		}
		entry.setupState = "replaying";
		const gate = await this.replayGate(entry);
		await this.setupGatedEntry(entry, gate);
	}

	private async setupReadmittedEntry(entry: BranchEntry): Promise<void> {
		await this.initialReplayBarrier.promise;
		await this.enqueueWriterStep(() => {
			this.sealedBranches.add(entry.branchId);
		});
		if (!this.isRunnable(entry)) {
			entry.ready.resolve();
			return;
		}
		entry.setupState = "replaying";
		const gate = await this.replayGate(entry);
		if (gate.error !== undefined || gate.semantic === undefined) {
			entry.ready.resolve();
			await this.settle(entry, {
				branchId: entry.branchId,
				outcome: "failed",
				error: gate.error ?? "Replay gate did not restore execution state",
			});
			return;
		}
		for (const warning of gate.warnings) {
			console.warn(warning);
		}
		entry.setupState = "building";
		const workDir = join(this.config.runDir, "workspaces", entry.branchId);
		const branchConfig: BranchHyperchartRunnerConfig = {
			...commonRunnerConfig(this.config),
			projectDir: this.config.workDir,
			workDir,
			branchId: entry.branchId,
			initialBranchIds: this.initialBranchIds,
		};
		let executor: SteerableAgentExecutor;
		try {
			entry.semantic = gate.semantic;
			await materializeWorkspaceFromPins(gate.semantic.workspaceArtifactPins(), this.artifactStore, workDir);
			if (!this.isRunnable(entry)) {
				entry.ready.resolve();
				return;
			}
			executor = await this.buildExecutor({
				config: branchConfig,
				ast: this.ast,
				schemaRegistry: this.schemaRegistry,
				sessionsDir: this.sessionsDir,
			});
		} catch (error) {
			entry.ready.resolve();
			if (this.isRunnable(entry)) {
				await this.settle(entry, { branchId: entry.branchId, outcome: "failed", error: errorMessage(error) });
			}
			return;
		}
		if (!this.isRunnable(entry)) {
			try {
				await executor.dispose();
			} finally {
				entry.ready.resolve();
			}
			return;
		}
		try {
			const activated = await this.enqueueWriterStep(async () => {
				if (!this.isRunnable(entry) || this.movingBranches.has(entry.branchId)) {
					return false;
				}
				const current = await this.rootStore.getBranch(entry.branchId);
				if (current.headSeqId !== gate.semantic!.headSeqId()) {
					throw new Error(`Hyperchart branch '${entry.branchId}' moved during readmission replay`);
				}
				entry.executor = executor;
				this.executors.set(entry.branchId, executor);
				entry.runtime = new ChartRuntime({
					ast: this.ast,
					branchId: entry.branchId,
					logStore: this.runtimeStore(entry.branchId),
					agentExecutor: executor,
					projectDir: this.config.workDir,
					workDir,
					chartDir: dirname(this.config.chartPath),
					runId: this.config.runId,
					schemaRegistry: this.schemaRegistry,
					onWarn: (message) => console.warn(message),
					prepareStampedCommit: gate.semantic!.prepareStampedCommit,
					validateArtifactSnapshot: artifactSnapshotValidator(this.schemaRegistry),
				});
				entry.setupState = "running";
				this.readmissionRequired.delete(entry.branchId);
				this.sealedBranches.delete(entry.branchId);
				entry.ready.resolve();
				entry.execution = this.runEntry(entry);
				void entry.execution;
				return true;
			});
			if (!activated) {
				try {
					await executor.dispose();
				} finally {
					entry.ready.resolve();
				}
			}
		} catch (error) {
			entry.ready.resolve();
			if (this.isRunnable(entry)) {
				await this.settle(entry, { branchId: entry.branchId, outcome: "failed", error: errorMessage(error) });
			}
		}
	}

	private async setupGatedEntry(entry: BranchEntry, gate: ReplayGate): Promise<void> {
		if (!this.isRunnable(entry)) {
			entry.ready.resolve();
			return;
		}
		if (gate.error !== undefined) {
			entry.ready.resolve();
			await this.settle(entry, { branchId: entry.branchId, outcome: "failed", error: gate.error });
			return;
		}
		for (const warning of gate.warnings) {
			console.warn(warning);
		}
		await this.buildEntry(entry, gate);
	}

	private async replayGate(entry: BranchEntry): Promise<ReplayGate> {
		try {
			const semantic = await BranchExecution.restore({ ast: this.ast, branchId: entry.branchId, store: entry.store });
			const explanation: ReplayExplanation = {
				prefixEnd: semantic.replayedRecords,
				...(semantic.snapshot.headSeqId === null ? {} : { seqId: semantic.snapshot.headSeqId }),
				skipped: semantic.replay.skipped.map((item, index) => ({ ...item, index, seqId: item.record.seqId })),
				stale: semantic.replay.stale,
				unpinned: semantic.replay.unpinned,
			};
			const warnings = formatReplayWarnings(explanation).map((warning) => `[branch ${entry.branchId}] ${warning}`);
			if (hasBlockingReplayWarnings(explanation) && this.config.ignoreReplayWarnings !== true) {
				return { warnings: [], error: formatReplayWarningsError(this.config.runId, warnings) };
			}
			return { warnings, semantic };
		} catch (error) {
			return {
				warnings: [],
				error: `[branch ${entry.branchId}] Replay gate failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	private async buildEntry(entry: BranchEntry, gate: ReplayGate): Promise<void> {
		entry.setupState = "building";
		const workDir = join(this.config.runDir, "workspaces", entry.branchId);
		const branchConfig: BranchHyperchartRunnerConfig = {
			...commonRunnerConfig(this.config),
			projectDir: this.config.workDir,
			workDir,
			branchId: entry.branchId,
			initialBranchIds: this.initialBranchIds,
		};
		let executor: SteerableAgentExecutor;
		try {
			if (gate.semantic === undefined) {
				throw new Error("Replay gate did not restore execution state");
			}
			entry.semantic = gate.semantic;
			await materializeWorkspaceFromPins(gate.semantic.workspaceArtifactPins(), this.artifactStore, workDir);
			if (!this.isRunnable(entry)) {
				entry.ready.resolve();
				return;
			}
			executor = await this.buildExecutor({
				config: branchConfig,
				ast: this.ast,
				schemaRegistry: this.schemaRegistry,
				sessionsDir: this.sessionsDir,
			});
		} catch (error) {
			entry.ready.resolve();
			if (this.isRunnable(entry)) {
				await this.settle(entry, {
					branchId: entry.branchId,
					outcome: "failed",
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return;
		}
		if (!this.isRunnable(entry)) {
			try {
				await executor.dispose();
			} finally {
				entry.ready.resolve();
			}
			return;
		}
		try {
			entry.executor = executor;
			this.executors.set(entry.branchId, executor);
			entry.runtime = new ChartRuntime({
				ast: this.ast,
				branchId: entry.branchId,
				logStore: this.runtimeStore(entry.branchId),
				agentExecutor: executor,
				projectDir: this.config.workDir,
				workDir,
				chartDir: dirname(this.config.chartPath),
				runId: this.config.runId,
				schemaRegistry: this.schemaRegistry,
				onWarn: (message) => console.warn(message),
				prepareStampedCommit: gate.semantic.prepareStampedCommit,
				validateArtifactSnapshot: artifactSnapshotValidator(this.schemaRegistry),
			});
		} catch (error) {
			entry.ready.resolve();
			if (this.isRunnable(entry)) {
				await this.settle(entry, {
					branchId: entry.branchId,
					outcome: "failed",
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return;
		}
		entry.setupState = "running";
		entry.ready.resolve();
		entry.execution = this.runEntry(entry);
		void entry.execution;
	}

	private async runEntry(entry: BranchEntry): Promise<void> {
		try {
			if (!this.isRunnable(entry) || entry.runtime === undefined || entry.semantic === undefined) {
				return;
			}
			const state = await start(entry.runtime, entry.semantic, this.config.args);
			if (!this.isRunnable(entry)) {
				return;
			}
			const classified = await entry.semantic.finalOutcome(state);
			// The loop's terminal state is its own copy of the projection, never
			// used again: its results are handed over without another copy.
			const results = state.projection.results;
			this.notificationRenderers.set(
				entry.branchId,
				entry.semantic.notificationRenderer(state, {
					runId: this.config.runId,
					workDir: join(this.config.runDir, "workspaces", entry.branchId),
				}),
			);
			await this.settle(entry, {
				branchId: entry.branchId,
				outcome: classified.terminal,
				...(classified.error === undefined ? {} : { error: classified.error }),
				results,
			});
		} catch (error) {
			if (this.isRunnable(entry)) {
				await this.settle(entry, {
					branchId: entry.branchId,
					outcome: "failed",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	private async drainEntry(
		entry: BranchEntry,
		saveCheckpoint = true,
		leaveSealed = true,
	): Promise<RunnerBranchOutcome> {
		let outcome: RunnerBranchOutcome = { branchId: entry.branchId, outcome: "drained" };
		const results = [];
		results.push(
			await Promise.resolve(entry.setup ?? Promise.resolve()).then(
				() => ({ status: "fulfilled" as const, value: undefined }),
				(reason) => ({ status: "rejected" as const, reason }),
			),
		);
		entry.draining = true;
		entry.runtime?.beginDrain();
		results.push(...(await this.awaitAdmittedOperations(entry)));
		results.push(
			await this.enqueueWriterStep(() => {
				this.sealedBranches.add(entry.branchId);
			}).then(
				() => ({ status: "fulfilled" as const, value: undefined }),
				(reason) => ({ status: "rejected" as const, reason }),
			),
		);
		results.push(
			await this.disposeEntry(entry, saveCheckpoint).then(
				() => ({ status: "fulfilled" as const, value: undefined }),
				(reason) => ({ status: "rejected" as const, reason }),
			),
		);
		results.push(
			await Promise.resolve(entry.execution ?? Promise.resolve()).then(
				() => ({ status: "fulfilled" as const, value: undefined }),
				(reason) => ({ status: "rejected" as const, reason }),
			),
		);
		const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (failures.length > 0) {
			outcome = {
				branchId: entry.branchId,
				outcome: "failed",
				error: `Branch drain failed: ${failures.map(errorMessage).join("; ")}`,
				cause: failures.length === 1 ? failures[0] : new AggregateError(failures, "Branch drain failed"),
			};
		}
		if (outcome.outcome === "drained" && !leaveSealed) {
			await this.enqueueWriterStep(() => {
				this.sealedBranches.delete(entry.branchId);
			});
		}
		if (this.live.get(entry.branchId) === entry) {
			this.outcomes.push(outcome);
			if (outcome.outcome === "drained") {
				this.admitted.delete(entry.branchId);
				this.readmissionRequired.add(entry.branchId);
			} else {
				this.admitted.set(entry.branchId, new BranchAdmissionError(entry.branchId, { cause: outcome.cause }));
			}
			entry.outcome.resolve(outcome);
			this.live.delete(entry.branchId);
			this.notifyBranchChange();
			this.publishLiveStatus();
			this.finishIfDrained();
		}
		return outcome;
	}

	private async awaitAdmittedOperations(entry: BranchEntry): Promise<PromiseSettledResult<unknown>[]> {
		const results: PromiseSettledResult<unknown>[] = [];
		while (entry.operations.size > 0) {
			const operations = [...entry.operations];
			results.push(...(await Promise.allSettled(operations)));
			for (const operation of operations) {
				entry.operations.delete(operation);
			}
		}
		return results;
	}

	private disposeEntry(entry: BranchEntry, saveCheckpoint = true): Promise<void> {
		entry.disposal ??= (async () => {
			await entry.ready.promise;
			try {
				if (entry.runtime !== undefined) {
					await entry.runtime.dispose();
				} else if (entry.executor !== undefined) {
					await entry.executor.dispose();
				}
				if (saveCheckpoint && entry.semantic !== undefined) {
					await entry.semantic.storeExactCheckpoint();
				}
			} finally {
				this.executors.delete(entry.branchId);
			}
		})();
		return entry.disposal;
	}

	private async settle(entry: BranchEntry, outcome: RunnerBranchOutcome): Promise<void> {
		if (!this.isRunnable(entry) || entry.drain !== undefined) {
			return;
		}
		entry.admissionClosed = true;
		entry.draining = true;
		entry.runtime?.beginDrain();
		let settledOutcome = outcome;
		try {
			const operationResults = await this.awaitAdmittedOperations(entry);
			const operationErrors = operationResults.flatMap((result) =>
				result.status === "rejected" ? [errorMessage(result.reason)] : [],
			);
			if (operationErrors.length > 0) {
				settledOutcome = {
					...outcome,
					outcome: "failed",
					error: `${outcome.error === undefined ? "Branch operation failed" : outcome.error}: ${operationErrors.join("; ")}`,
				};
			}
			await this.disposeEntry(entry);
		} catch (error) {
			const disposalError = error instanceof Error ? error.message : String(error);
			settledOutcome = {
				...outcome,
				outcome: "failed",
				error:
					outcome.error === undefined
						? `Executor disposal failed: ${disposalError}`
						: `${outcome.error}; executor disposal failed: ${disposalError}`,
			};
		}
		if (this.phase !== "accepting" || this.live.get(entry.branchId) !== entry) {
			return;
		}
		this.outcomes.push(settledOutcome);
		if (settledOutcome.outcome === "failed") {
			this.admitted.set(entry.branchId, new BranchAdmissionError(entry.branchId, { cause: settledOutcome.cause }));
		}
		entry.outcome.resolve(settledOutcome);
		this.live.delete(entry.branchId);
		this.notifyBranchChange();
		if (this.live.size > 0 || this.holdCount > 0) {
			this.publishLiveStatus();
			return;
		}
		// This synchronous phase claim is the deterministic admission/last-settlement boundary.
		this.phase = "closing";
		await this.finishAggregate(settledOutcome);
	}

	private finishIfDrained(): void {
		if (this.phase !== "accepting" || this.live.size > 0 || this.holdCount > 0 || this.movingBranches.size > 0) {
			return;
		}
		const representative = this.outcomes.at(-1);
		if (representative === undefined) {
			return;
		}
		this.phase = "closing";
		void this.finishAggregate(representative);
	}

	private async finishAggregate(finalOutcome: RunnerBranchOutcome): Promise<void> {
		if (this.shutdownSignal !== undefined) {
			return;
		}
		const failed = this.outcomes.filter((entry) => entry.outcome === "failed");
		const terminalState: RunTerminalState = failed.length === 0 ? "complete" : "failed";
		const representative = failed[0] ?? this.outcomes[0] ?? finalOutcome;
		let error =
			failed.length === 0
				? undefined
				: failed.map((entry) => `${entry.branchId}: ${entry.error ?? "machine failed"}`).join("; ");
		let state = terminalState;
		this.stopLifetimeResources();
		try {
			const renderNotification = this.notificationRenderers.get(representative.branchId);
			await persistTerminalNotificationRequest(
				this.config.runId,
				renderNotification === undefined
					? defaultFailedTerminalNotificationPayload({
							runId: this.config.runId,
							branchId: representative.branchId,
							chartId: this.ast.id,
							error: representative.error ?? "branch runtime failed",
						})
					: renderNotification(terminalState, error),
			);
			await this.rootStore.patchRunStatus({
				chartId: this.ast.id,
				state: terminalState,
				branchIds: [],
				pid: process.pid,
				heartbeatAt: Date.now(),
				exitCode: terminalState === "failed" ? 1 : 0,
				error,
			});
			if (terminalState === "failed") {
				process.exitCode = 1;
			}
		} catch (terminalError) {
			const message = terminalError instanceof Error ? terminalError.message : String(terminalError);
			await this.rootStore
				.patchRunStatus({ state: "failed", branchIds: [], exitCode: 1, error: message })
				.catch((statusError: unknown) => console.warn(`Hyperchart status write failed: ${errorMessage(statusError)}`));
			process.exitCode = 1;
			state = "failed";
			error = message;
		}
		await this.rootStore
			.close()
			.catch((error: unknown) => console.warn(`Hyperchart journal close failed: ${errorMessage(error)}`));
		this.phase = "closed";
		this.completion.resolve({ state, ...(error === undefined ? {} : { error }), branches: [...this.outcomes] });
	}

	private publishLiveStatus(): void {
		if (this.phase !== "accepting") {
			return;
		}
		this.patchStatus({
			branchIds: [...this.liveBranchIds],
			pid: process.pid,
			heartbeatAt: Date.now(),
		});
	}

	/** Fire-and-forget status publication for synchronous admission paths; ordering follows call order. */
	private patchStatus(patch: RunStatusPatch): void {
		void this.rootStore
			.patchRunStatus(patch)
			.catch((error: unknown) => console.warn(`Hyperchart status write failed: ${errorMessage(error)}`));
	}

	private isRunnable(entry: BranchEntry): boolean {
		return this.phase === "accepting" && this.live.get(entry.branchId) === entry && !entry.draining;
	}

	private async awaitLiveBranchReadiness(branchId: BranchId, operation: string): Promise<void> {
		const entry = this.live.get(branchId);
		// A reserved branch has not taken its replay snapshot yet, so a durable
		// response committed now will be included when admission starts.
		if (entry === undefined || entry.setupState === "reserved") {
			return;
		}
		await entry.ready.promise;
		if (this.live.get(branchId) !== entry || entry.runtime === undefined) {
			throw new Error(`Hyperchart branch '${branchId}' did not become runtime-ready; cannot ${operation}`);
		}
	}

	private assertBranchesNotDraining(branchIds: readonly BranchId[], operation: string): void {
		for (const branchId of new Set(branchIds)) {
			if (this.sealedBranches.has(branchId)) {
				throw new BranchSealedError(branchId, operation);
			}
			if (this.live.get(branchId)?.admissionClosed === true) {
				throw new Error(`Hyperchart branch '${branchId}' is draining; cannot ${operation}`);
			}
		}
	}

	private trackBranchOperation<T>(
		branchIds: readonly BranchId[],
		operation: string,
		task: () => Promise<T>,
	): Promise<T> {
		const entries = [...new Set(branchIds)].flatMap((branchId) => {
			const entry = this.live.get(branchId);
			if (this.sealedBranches.has(branchId)) {
				throw new BranchSealedError(branchId, operation);
			}
			if (entry?.admissionClosed === true) {
				throw new Error(`Hyperchart branch '${branchId}' is draining; cannot ${operation}`);
			}
			return entry === undefined ? [] : [entry];
		});
		const promise = Promise.resolve().then(task);
		for (const entry of entries) {
			entry.operations.add(promise);
		}
		void promise.then(
			() => {
				for (const entry of entries) {
					entry.operations.delete(promise);
				}
			},
			() => {
				for (const entry of entries) {
					entry.operations.delete(promise);
				}
			},
		);
		return promise;
	}

	private assertAccepting(operation: string): void {
		if (this.phase !== "accepting") {
			throw new Error(`Hyperchart runner is ${this.phase}; cannot ${operation}`);
		}
	}

	async stop(): Promise<void> {
		await this.close("SIGTERM", false);
	}

	/** Signal handlers exit the standalone runner; embedded hosts use stop(). */
	private async close(signal: NodeJS.Signals, exitProcess = true): Promise<void> {
		if (this.phase !== "accepting") {
			return;
		}
		this.shutdownSignal = signal;
		this.phase = "closing";
		this.holdCount = 0;
		this.stopLifetimeResources();
		// Wake dynamic reservations parked behind the initial replay barrier. Initial
		// entries still await their own in-flight replay before reporting setup done.
		this.initialReplayBarrier.resolve();
		const entries = [...this.live.values()];
		const stoppedOutcome = (entry: BranchEntry): RunnerBranchOutcome => ({
			branchId: entry.branchId,
			outcome: "failed",
			error: `Runner stopped by ${signal}`,
		});
		for (const entry of entries) {
			entry.admissionClosed = true;
			entry.draining = true;
			entry.runtime?.beginDrain();
			// A reservation with no replay/build in flight has nothing to quiesce.
			if (entry.setupState === "reserved") {
				entry.ready.resolve();
			}
			entry.outcome.resolve(stoppedOutcome(entry));
		}
		const setupResults = await Promise.allSettled(entries.map((entry) => entry.setup ?? Promise.resolve()));
		const operationResults = await Promise.all(entries.map((entry) => this.awaitAdmittedOperations(entry)));
		const disposalResults = await Promise.allSettled(entries.map((entry) => this.disposeEntry(entry)));
		if (this.phase !== "closing" || this.shutdownSignal !== signal) {
			return;
		}
		this.live.clear();
		const cleanupErrors = [
			...setupResults.flatMap((result, index) =>
				result.status === "rejected" ? [`${entries[index]!.branchId} setup: ${errorMessage(result.reason)}`] : [],
			),
			...operationResults.flatMap((results, index) =>
				results.flatMap((result) =>
					result.status === "rejected" ? [`${entries[index]!.branchId} operation: ${errorMessage(result.reason)}`] : [],
				),
			),
			...disposalResults.flatMap((result, index) =>
				result.status === "rejected" ? [`${entries[index]!.branchId} disposal: ${errorMessage(result.reason)}`] : [],
			),
		];
		const exitCode = signal === "SIGTERM" ? 143 : 130;
		const error =
			cleanupErrors.length === 0
				? undefined
				: `Runner stopped by ${signal}; cleanup failed: ${cleanupErrors.join("; ")}`;
		await this.rootStore.patchRunStatus({
			state: "stopped",
			branchIds: [],
			pid: process.pid,
			heartbeatAt: Date.now(),
			exitCode,
			error,
		});
		await this.rootStore
			.close()
			.catch((error: unknown) => console.warn(`Hyperchart journal close failed: ${errorMessage(error)}`));
		this.phase = "closed";
		this.completion.resolve({
			state: "stopped",
			...(error === undefined ? {} : { error }),
			branches: entries.map(stoppedOutcome),
		});
		if (exitProcess) {
			process.exit(exitCode);
		}
	}

	private stopLifetimeResources(): void {
		if (this.heartbeat !== undefined) {
			clearInterval(this.heartbeat);
		}
		this.heartbeat = undefined;
		this.stopSteering?.();
		this.stopSteering = undefined;
		this.stopControl?.();
		this.stopControl = undefined;
		process.off("SIGTERM", this.onSigterm);
		process.off("SIGINT", this.onSigint);
	}
}

/** Prepare a shared journal and reserve initial branches without launching them. */
export async function createHyperchartRunnerController(
	config: HyperchartRunnerConfig,
	buildExecutor: ExecutorFactory,
): Promise<HyperchartRunnerController> {
	if ("runDir" in config) {
		throw new Error("Runner config accepts runId only, not runDir");
	}
	const { runDir, storage } = resolveRunPaths(config.runId, config.storage);
	return withRunStorage(storage, async () => {
		const controller = await prepareRunnerController({ ...config, storage, runDir }, buildExecutor);
		return new Proxy(controller, {
			get(target, key) {
				const value = Reflect.get(target, key, target) as unknown;
				return typeof value === "function"
					? (...args: unknown[]) => withRunStorage(storage, () => value.apply(target, args))
					: value;
			},
		});
	});
}

async function prepareRunnerController(
	config: HyperchartRunnerConfig & { runDir: string },
	buildExecutor: ExecutorFactory,
): Promise<HyperchartRunnerController> {
	const initialBranchIds = runnerBranchIds(config);
	const attemptId = config.attemptId ?? randomUUID();
	mkdirSync(join(config.runDir, "sessions"), { recursive: true });
	await patchRunStatus(config.runId, {
		chartId: config.chartId,
		state: "starting",
		branchIds: initialBranchIds,
		attemptId,
		pid: process.pid,
		heartbeatAt: Date.now(),
		error: undefined,
		exitCode: undefined,
	});
	try {
		archiveTerminalNotificationGeneration(config.runId);
		await assertChartPreflight(config.chartPath);
		const parsed = parseChartModuleSync(
			config.chartPath,
			config.exportName === undefined ? {} : { exportName: config.exportName },
		);
		if (!parsed.ok) {
			throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
		}
		const rootStore = await openRunLogStore(config.runId, {
			...(initialBranchIds[0] === undefined ? {} : { branchId: initialBranchIds[0] }),
			onWarn: (message) => console.warn(message),
			access: "writer",
			...(config.storage === undefined ? {} : { storage: config.storage }),
		});
		let durableBranchIds = (await collectBranches(rootStore)).map((branch) => branch.branchId);
		if (durableBranchIds.length === 0) {
			const fresh = BranchExecution.fresh(parsed.ast, rootStore.branchId, rootStore);
			const checkpoint = fresh.prepareExactCheckpoint(null);
			await rootStore.initializeRootBranch(undefined, checkpoint === undefined ? undefined : { checkpoint });
			durableBranchIds = [rootStore.branchId];
		}
		return new HyperchartRunnerControllerImpl(
			config,
			initialBranchIds,
			attemptId,
			parsed.ast,
			parsed.schemaRegistry,
			rootStore,
			durableBranchIds,
			join(config.runDir, "sessions"),
			buildExecutor,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		try {
			await persistTerminalNotificationRequest(
				config.runId,
				defaultFailedTerminalNotificationPayload({
					runId: config.runId,
					branchId: initialBranchIds[0]!,
					chartId: config.chartId,
					error: message,
				}),
			);
		} catch (notificationError) {
			console.error(notificationError);
		}
		await patchRunStatus(config.runId, {
			state: "failed",
			branchIds: [],
			pid: process.pid,
			heartbeatAt: Date.now(),
			exitCode: 1,
			error: message,
		});
		process.exitCode = 1;
		throw error;
	}
}

/** Compatibility wrapper: create a controller, launch its initial seeds, and await closure. */
export async function runHyperchartRunner(
	config: HyperchartRunnerConfig,
	buildExecutor: ExecutorFactory,
): Promise<void> {
	try {
		const controller = await createHyperchartRunnerController(config, buildExecutor);
		await controller.start();
	} catch {
		// Factory failures are already durably reported through status and the outbox.
	}
}

function commonRunnerConfig(config: HyperchartRunnerConfig & { runDir?: string }): RunnerCommonConfig {
	const { branchId: _branchId, branchIds: _branchIds, runDir: _runDir, ...common } = config;
	return common;
}
function forkMetadata(options: RunnerForkOptions, sourceBranchId: BranchId): BranchMetadata {
	return {
		name: options.branchId,
		...(options.reason === undefined ? {} : { reason: options.reason }),
		sourceBranchId,
		sourceSeqId: options.fromSeqId,
	};
}

async function affectedBranchSubtree(store: RunLogStore, rootBranchId: BranchId): Promise<readonly BranchId[]> {
	await store.getBranch(rootBranchId);
	const branches = await collectBranches(store);
	const children = new Map<BranchId, BranchId[]>();
	for (const branch of branches) {
		if (branch.branchId === rootBranchId) {
			continue;
		}
		const explicitParent = branch.metadata?.sourceBranchId;
		const sourceSeqId = branch.metadata?.sourceSeqId;
		const inferredParent = sourceSeqId === undefined ? undefined : (await store.getRecord(sourceSeqId))?.branchId;
		const parentBranchId = explicitParent ?? inferredParent;
		if (parentBranchId === undefined) {
			continue;
		}
		const siblings = children.get(parentBranchId) ?? [];
		siblings.push(branch.branchId);
		children.set(parentBranchId, siblings);
	}
	for (const siblings of children.values()) {
		siblings.sort();
	}
	const affected: BranchId[] = [];
	const pending: BranchId[] = [rootBranchId];
	const seen = new Set<BranchId>();
	while (pending.length > 0) {
		const branchId = pending.shift()!;
		if (seen.has(branchId)) {
			continue;
		}
		seen.add(branchId);
		affected.push(branchId);
		pending.push(...(children.get(branchId) ?? []));
	}
	return affected;
}
function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function assertRunnerBranchId(branchId: string): void {
	if (
		typeof branchId !== "string" ||
		branchId.trim().length === 0 ||
		branchId.length > 128 ||
		/[\0/\\]/.test(branchId)
	) {
		throw new Error("Invalid Hyperchart runner branchId");
	}
}
function formatReplayWarningsError(runId: string, warnings: readonly string[]): string {
	return [
		"Replay over the current chart produced warning-level compatibility issues.",
		...warnings,
		`Resolve them by rewinding, or explicitly confirm continuing with: hyperchart action=run runId=${runId} ignoreReplayWarnings=true`,
	].join("\n");
}
function formatReplayCompatibilityError(runId: string, explanation: ReplayExplanation): string {
	const broken = explanation.broken;
	if (broken === undefined) {
		return "Replay compatibility check failed";
	}
	const target = broken.invokeSeqId ?? broken.seqId;
	return [
		`Replay over the current chart is incompatible at seqId ${broken.seqId}${broken.state === undefined ? "" : ` (${broken.state})`}.`,
		`Original error: ${broken.error}`,
		`Rewind to the compatible prefix explicitly before resuming: hyperchart action=rewind runId=${runId} seqId=${target} mode=before`,
		`Or use: hyperchart action=rewind runId=${runId} to=compatible`,
	].join("\n");
}
function formatReplayWarnings(explanation: ReplayExplanation): string[] {
	const warnings: string[] = [];
	if (explanation.skipped.length > 0) {
		const states = [...new Set(explanation.skipped.map((entry) => entry.state))].slice(0, 8).join(", ");
		warnings.push(
			`Replay warning: ${explanation.skipped.length} durable record(s) were skipped because their states were inactive under the current chart${states.length === 0 ? "" : ` (${states})`}.`,
		);
	}
	for (const entry of explanation.stale.filter((entry) => entry.reason === "guard_removed")) {
		warnings.push(`Replay warning: ${entry.message}`);
	}
	const stale = explanation.stale.filter((entry) => entry.reason !== "guard_removed");
	if (stale.length > 0) {
		const states = [...new Set(stale.map((entry) => entry.state))].slice(0, 8).join(", ");
		warnings.push(
			`Replay warning: ${stale.length} durable record(s) have stale provenance under the current chart${states.length === 0 ? "" : ` (${states})`}.`,
		);
	}
	return warnings;
}
function isHeadMovedError(error: unknown): error is BranchHeadMovedError {
	return error instanceof BranchHeadMovedError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringEntries(value: Record<string, unknown>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);
}
function stringArrayEntries(value: Record<string, unknown>): Record<string, string[]> {
	return Object.fromEntries(
		Object.entries(value).filter(
			(entry): entry is [string, string[]] =>
				Array.isArray(entry[1]) && entry[1].every((item) => typeof item === "string"),
		),
	);
}
