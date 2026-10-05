import type { ChartAst, ChartEvent } from "../core/types.js";
import type {
	ArtifactPin,
	BranchId,
	DurableLogRecord,
	DurableRecordDraft,
	OpenedGateLog,
} from "../core/durable_events.js";
import type { SchemaRegistryLike } from "../core/schema_registry.js";
import { createMachine, type MachineState } from "../core/machine.js";
import {
	createBranchProjection,
	isFinalState,
	projectBranch,
	type BranchProjection,
	type ProjectionSkippedRecord,
} from "../core/projection.js";
import { replayRecordDiagnostics } from "../core/replay_check.js";
import {
	openExecutionReplay,
	type CheckpointRepository,
	type OpaqueCheckpointEnvelope,
	type PrepareStampedCommit,
} from "../runtime/generic/log_store.js";
import { compactProjection, compileProjectionRetention } from "./projection_retention.js";
import {
	loadBranchProjection,
	prepareProjectionCheckpoint,
	projectionContractForAst,
	PROJECTION_CHECKPOINT_INTERVAL,
	type LoadedBranchProjection,
} from "./projection_restore.js";
import {
	prepareUserInteractionResponseFromProjection,
	type RespondToUserInteractionInput,
} from "./user_interaction.js";
import { createFailureProvenanceTracker, terminalStateForFinalMachine, type RunTerminalState } from "./run_outcome.js";
import { renderTerminalNotificationPayload } from "./terminal_notification.js";
import type { TerminalNotificationPayload } from "../runtime/generic/terminal_notifications.js";

export type BranchExecutionOverview = Readonly<{
	activeLeaves: readonly string[];
	spawns: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
	pendingActions: BranchProjection["pendingActions"];
	results: Readonly<Record<string, unknown>>;
	args?: Readonly<Record<string, unknown>>;
	final: boolean;
	failedTerminal: boolean;
}>;

/** Execution-owned state for one immutable branch lineage. Runtime sees only its generic commit callback. */
export class BranchExecution {
	private projection: BranchProjection;
	private recordsSinceCheckpoint: number;
	private readonly retention;
	private readonly contract;
	private checkpointableValue: boolean;
	readonly replay: LoadedBranchProjection["replay"];
	readonly snapshot: LoadedBranchProjection["snapshot"];
	readonly replayedRecords: number;

	private constructor(
		readonly ast: ChartAst,
		readonly branchId: BranchId,
		private readonly store: CheckpointRepository | undefined,
		loaded: LoadedBranchProjection,
	) {
		this.projection = structuredClone(loaded.projection);
		this.recordsSinceCheckpoint = loaded.checkpointSaved ? 0 : loaded.replayedRecords % PROJECTION_CHECKPOINT_INTERVAL;
		this.checkpointableValue = loaded.checkpointable;
		this.replay = loaded.replay;
		this.snapshot = loaded.snapshot;
		this.replayedRecords = loaded.replayedRecords;
		this.retention = compileProjectionRetention(ast);
		this.contract = projectionContractForAst(ast);
	}

	static async restore(input: {
		ast: ChartAst;
		branchId: BranchId;
		store: CheckpointRepository;
		snapshot?: { branchId: BranchId; headSeqId: number | null };
		saveCheckpoint?: "rebuild" | "always" | "never";
	}): Promise<BranchExecution> {
		const loaded = await loadBranchProjection({
			ast: input.ast,
			branchId: input.branchId,
			store: input.store,
			contract: projectionContractForAst(input.ast),
			...(input.snapshot === undefined ? {} : { snapshot: input.snapshot }),
			...(input.saveCheckpoint === undefined ? {} : { saveCheckpoint: input.saveCheckpoint }),
		});
		return new BranchExecution(input.ast, input.branchId, input.store, loaded);
	}

	static fromProjection(ast: ChartAst, branchId: BranchId, projection: BranchProjection): BranchExecution {
		return new BranchExecution(ast, branchId, undefined, {
			projection,
			snapshot: { branchId, headSeqId: projection.seqId === 0 ? null : projection.seqId },
			contract: projectionContractForAst(ast),
			checkpointHeadSeqId: null,
			replayedRecords: 0,
			replayBatches: 0,
			checkpointSaved: false,
			checkpointable: false,
			replay: { skipped: [], stale: [], unpinned: [] },
		});
	}

	static fresh(ast: ChartAst, branchId: BranchId, store: CheckpointRepository): BranchExecution {
		return new BranchExecution(ast, branchId, store, {
			projection: createBranchProjection(ast),
			snapshot: { branchId, headSeqId: null },
			contract: projectionContractForAst(ast),
			checkpointHeadSeqId: null,
			replayedRecords: 0,
			replayBatches: 0,
			checkpointSaved: false,
			checkpointable: true,
			replay: { skipped: [], stale: [], unpinned: [] },
		});
	}

	readonly prepareStampedCommit: PrepareStampedCommit = (records) => {
		// One private working copy per atomic commit. Never mutate the confirmed
		// projection before storage confirms; checkpoint encoding snapshots each
		// cadence boundary independently of the remaining records in this batch.
		const next = structuredClone(this.projection);
		let remaining = this.recordsSinceCheckpoint;
		let checkpointable = this.checkpointableValue;
		const checkpoints: OpaqueCheckpointEnvelope[] = [];
		for (const record of records) {
			const diagnostics = replayRecordDiagnostics(this.ast, next, record.seqId, record);
			const skipped: ProjectionSkippedRecord[] = [];
			projectBranch(next, this.ast, [record], [], skipped);
			compactProjection(next, this.ast, this.retention);
			checkpointable &&= diagnostics.stale.length === 0 && diagnostics.unpinned.length === 0 && skipped.length === 0;
			remaining++;
			if (remaining === PROJECTION_CHECKPOINT_INTERVAL) {
				if (checkpointable) {
					checkpoints.push(prepareProjectionCheckpoint(next, this.contract, record.seqId));
				}
				remaining = 0;
			}
		}
		let confirmed = false;
		return {
			checkpoints,
			committed: () => {
				if (confirmed) {
					throw new Error("Stamped commit confirmed twice");
				}
				confirmed = true;
				this.projection = next;
				this.recordsSinceCheckpoint = remaining;
				this.checkpointableValue = checkpointable;
			},
		};
	};

	machineState(): MachineState {
		return createMachine(this.ast, structuredClone(this.projection));
	}
	/** Internal execution-to-inspector bridge; never exposed by runtime or storage declarations. */
	inspectionProjection(): BranchProjection {
		return structuredClone(this.projection);
	}
	inspectionOverview(): BranchExecutionOverview {
		const final = isFinalState(this.projection, this.ast);
		return {
			activeLeaves: [...this.projection.activeLeaves],
			spawns: structuredClone(this.projection.spawns),
			pendingActions: structuredClone(this.projection.pendingActions),
			results: structuredClone(this.projection.results),
			...(this.projection.args === undefined ? {} : { args: structuredClone(this.projection.args) }),
			final,
			failedTerminal:
				final &&
				this.projection.activeLeaves.some(
					(leaf) => this.ast.states[leaf]?.kind === "final" && this.ast.states[leaf]?.outcome === "failed",
				),
		};
	}
	headSeqId(): number | null {
		return this.projection.seqId === 0 ? null : this.projection.seqId;
	}
	isFresh(): boolean {
		return this.projection.seqId === 0;
	}
	isUnseen(records: readonly DurableLogRecord[]): boolean {
		return records.some((record) => record.seqId > this.projection.seqId);
	}
	openUserInteraction(gateSeqId: number): OpenedGateLog | undefined {
		return this.projection.openUserInteractions[gateSeqId]?.opened;
	}
	openUserInteractions(): readonly OpenedGateLog[] {
		return Object.values(this.projection.openUserInteractions).map((entry) => entry.opened);
	}
	artifactPins(): Readonly<Record<string, ArtifactPin>> {
		return structuredClone(this.projection.artifactPins);
	}
	/** Same-branch retry overlay; never part of accepted ancestry or inherited by forks. */
	workspaceArtifactPins(): Readonly<Record<string, ArtifactPin>> {
		const pins = structuredClone(this.projection.artifactPins);
		for (const pending of this.projection.pendingActions) {
			if (pending.phase !== "running" && pending.completionArtifacts?.branchId === this.branchId) {
				Object.assign(pins, pending.completionArtifacts.pins);
			}
		}
		return pins;
	}
	checkpointable(): boolean {
		return this.checkpointableValue;
	}
	prepareExactCheckpoint(headSeqId: number | null = this.headSeqId()): OpaqueCheckpointEnvelope | undefined {
		return this.checkpointableValue
			? prepareProjectionCheckpoint(this.projection, this.contract, headSeqId)
			: undefined;
	}
	async storeExactCheckpoint(): Promise<void> {
		if (!this.checkpointableValue || this.recordsSinceCheckpoint === 0) {
			return;
		}
		if (this.store === undefined) {
			return;
		}
		await this.store.storeCheckpoint(prepareProjectionCheckpoint(this.projection, this.contract));
		this.recordsSinceCheckpoint = 0;
	}
	notificationRenderer(
		state: MachineState,
		input: { runId: string; workDir: string },
	): (outcome: RunTerminalState, error?: string) => TerminalNotificationPayload {
		const branchId = this.branchId;
		return (outcome, error) =>
			renderTerminalNotificationPayload(state, {
				...input,
				branchId,
				outcome,
				...(error === undefined ? {} : { error }),
			});
	}

	async finalOutcome(state: MachineState): Promise<{ terminal: RunTerminalState; error?: string }> {
		const terminal = terminalStateForFinalMachine(state);
		if (terminal !== "failed") {
			return { terminal };
		}
		const provenance = createFailureProvenanceTracker(state);
		if (this.store !== undefined) {
			for await (const batch of openExecutionReplay(this.store, {
				targetHeadSeqId: this.headSeqId(),
				afterSeqId: null,
			})) {
				provenance.push(batch);
			}
		}
		const error = provenance.message();
		return { terminal, ...(error === undefined ? {} : { error }) };
	}

	async prepareUserInteraction(
		gate: OpenedGateLog,
		event: ChartEvent,
		schemaRegistry?: SchemaRegistryLike,
	): Promise<readonly DurableRecordDraft[]> {
		const input: RespondToUserInteractionInput = {
			ast: this.ast,
			gateSeqId: gate.seqId,
			event,
			...(schemaRegistry === undefined ? {} : { schemaRegistry }),
		};
		return prepareUserInteractionResponseFromProjection(this.projection, this.branchId, gate, input);
	}

}
