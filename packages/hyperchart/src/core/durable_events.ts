import type {
	ActionUID,
	ActorEndpointDeclarationAst,
	ChartEvent,
	CompletionDeclarationAst,
	GuardOutcome,
	GuardRefAst,
	SchemaAst,
	SendStateAst,
	SendBatchStateAst,
	CallStateAst,
	CallBatchStateAst,
	StateActionAst,
	StatePath,
	JsonValue,
	NotifyActionAst,
	WaitForActionAst,
} from "./types.js";

/** Durable named branch (the storage lane). Branch ids are public, stable names. */
export type BranchId = string;

/** Explicit, non-durable checkout handle carried by a runner, command, or UI view. */
export type SelectedBranchHandle = Readonly<{ branchId: BranchId }>;

/** Optional durable branch provenance. It never represents an active/selected branch. */
export type BranchMetadata = Readonly<{
	name?: string;
	reason?: string;
	sourceBranchId?: BranchId;
	sourceSeqId?: number;
}>;

/** Materialized durable head for one named branch. */
export type BranchHead = Readonly<{
	branchId: BranchId;
	headSeqId: number | null;
	createdAt: number;
	metadata?: BranchMetadata;
}>;

export type DurableRecordCoordinates = {
	seqId: number;
	parentId: number | null;
	branchId: BranchId;
	timestamp: number;
};

type SessionParams = DurableRecordCoordinates;

type SessionRefLog = {
	type: "session_ref";
	index: number;
	file: string;
	actionUid?: ActionUID;
} & SessionParams;

// The run's input arguments — external data, hence a fact: the first record of a fresh log,
// seeded by start() when the run is created. Everything downstream (template rendering, replay)
// reads args from here and only here.
type ArgsLog = {
	type: "args";
	args: Readonly<Record<string, unknown>>;
} & SessionParams;

// A map's fan-out is a fact: which instance keys exist and what item each carries, pinned when
// the map is entered. The instance's input is frozen at birth — later changes to the `over`
// source do not reach spawned instances, and replay re-creates exactly the same fan-out.
type SpawnedLog = {
	type: "spawned";
	path: StatePath;
	instances: Readonly<Record<string, unknown>>;
} & SessionParams;

export type ResolvedStateInput = Readonly<Record<string, JsonValue>>;

/** Independent invocation facts may share one atomic commit; each retains its own coordinates and session. */
export type StateActionInvokeLog = {
	type: "state_action";
	kind: "invoke";
	actionUid: ActionUID;
	/** Opaque runtime identity for resources owned by this durable action invocation. */
	sessionId: string;
	/** Resolved visit input; informational provenance excluded from replay identity. */
	input?: ResolvedStateInput;
	// Mandatory provenance for replay over a modified chart. Logs without it are structurally
	// incompatible and must be rewound/restarted instead of silently replayed.
	definition: StateActionAst;
} & SessionParams;

/** Immutable content revision of an accepted artifact: sha256 of the full content plus byte size. */
export type ArtifactPin = Readonly<{ hash: string; size: number }>;

// The emitted event is the fact; transitions are never logged — the projection recomputes the
// route from the chart AST, so a log stays applicable to a modified chart.
type StateActionCompleteLog = {
	type: "state_action";
	kind: "complete";
	actionUid: ActionUID;
	/** Resolved visit input; informational provenance excluded from replay identity. */
	input?: ResolvedStateInput;
	event: ChartEvent;
	// Revisions of declared deliverables observed when this completion was admitted. On guarded
	// actions these are provisional until validated(true), and are not accepted ancestry pins.
	// Same-branch retry recovery may materialize them without accepting them. Keyed by
	// rendered path. The pin is provenance: replay never re-hashes. Absent on pre-versioning logs
	// and on runtimes without an artifact store — such completions are unpinned, not invalid.
	artifacts?: Readonly<Record<string, ArtifactPin>>;
} & SessionParams;

// Validation verdict for a completion claim. Stored like any other fact: replay reads the
// outcome instead of re-running the validator. The guard ref is provenance — a later "can this
// log replay unchanged?" check compares it (docker-cache style) against the current chart.
export type AgentFailureKind = "incomplete" | "artifacts" | "validation" | "provider" | "runtime" | "explicit";
export type AgentRecoveryMode = "nudge" | "restart";
export type AgentRecoveryScope = "general" | "validation";

export type StateActionRetryLog = {
	type: "state_action";
	kind: "retry";
	actionUid: ActionUID;
	failure: Readonly<{
		kind: AgentFailureKind;
		message: string;
		code?: string;
	}>;
	scope: AgentRecoveryScope;
	mode: AgentRecoveryMode;
	previousSessionId: string;
	/** Same as previousSessionId for nudge; a fresh durable identity for restart. */
	resultingSessionId: string;
	nudgeAttempt: number;
	restartAttempt: number;
} & SessionParams;

type StateActionValidatedLog = {
	type: "state_action";
	kind: "validated";
	actionUid: ActionUID;
	/** Resolved visit input; informational provenance excluded from replay identity. */
	input?: ResolvedStateInput;
	event: ChartEvent;
	guard: GuardRefAst;
	outcome: GuardOutcome;
} & SessionParams;

// The action's deadline expired before a completion landed. Like transitions, the target is not
// logged — the projection recomputes it from the state's `after` in the current chart.
type StateActionTimerFiredLog = {
	type: "state_action";
	kind: "timer_fired";
	actionUid: ActionUID;
} & SessionParams;

type StateAction =
	| StateActionInvokeLog
	| StateActionCompleteLog
	| StateActionValidatedLog
	| StateActionRetryLog
	| StateActionTimerFiredLog;

/** Durable, fully-rendered host boundary for one exact user-action phase. */
export type UserInteractionOpenedLog = {
	type: "user_interaction";
	kind: "opened";
	actionUid: ActionUID;
	/** Record that started the running/rejected phase represented by this gate. */
	phaseSeqId: number;
	/**
	 * Fully resolved declared input for this state phase. Absent when the state declares no input.
	 * This is informational durable provenance and is deliberately excluded from replay identity.
	 */
	input?: Readonly<Record<string, JsonValue>>;
	prompt: string;
	options: readonly string[];
	events: readonly string[];
	reply?: SchemaAst;
} & SessionParams;

/** The sole durable external-input fact; projection applies it as the user completion. */
export type UserInteractionResolvedLog = {
	type: "user_interaction";
	kind: "resolved";
	/** seqId of the exact UserInteractionOpenedLog being answered. */
	gateSeqId: number;
	actionUid: ActionUID;
	event: ChartEvent;
} & SessionParams;

export type UserInteractionLog = UserInteractionOpenedLog | UserInteractionResolvedLog;

/** Durable, fully rendered host boundary for a chart-level machine gate. */
export type GateOpenedLog = {
	type: "gate";
	kind: "opened";
	actionUid: ActionUID;
	phaseSeqId: number;
	event: string;
	payload: JsonValue;
	reply?: SchemaAst;
	/** Informational durable provenance excluded from replay identity. */
	input?: ResolvedStateInput;
} & SessionParams;

export type GateResolvedLog = {
	type: "gate";
	kind: "resolved";
	gateSeqId: number;
	actionUid: ActionUID;
	event: ChartEvent;
} & SessionParams;

export type GateLog = GateOpenedLog | GateResolvedLog;
export type OpenedGateLog = UserInteractionOpenedLog | GateOpenedLog;
export type ResolvedGateLog = UserInteractionResolvedLog | GateResolvedLog;

/** Stable typed domain event published by an accepted chart action. */
export type EmitLog = {
	type: "emit";
	actionUid: ActionUID;
	event: string;
	payload: JsonValue;
} & SessionParams;

/** One validated, chart-owned one-shot completion notification. */
export type CompletionNotifiedLog = {
	type: "completion";
	kind: "notified";
	endpoint: string;
	event: string;
	payload: unknown;
	source: Readonly<{
		actionUid: ActionUID;
		visitId: number;
		definition: NotifyActionAst;
		declaration: CompletionDeclarationAst;
	}>;
} & SessionParams;

/** Atomic ownership claim linking one notification to one exact wait action visit. */
export type CompletionConsumedLog = {
	type: "completion";
	kind: "consumed";
	endpoint: string;
	notificationSeqId: number;
	actionUid: ActionUID;
	visitId: number;
	definition: WaitForActionAst;
} & SessionParams;

export type CompletionLog = CompletionNotifiedLog | CompletionConsumedLog;

/** First durable fact of global fail-fast. No successor state may start after this record. */
export type FailureIntentLog = {
	type: "failure_intent";
	origin: StatePath;
	error: unknown;
} & SessionParams;

export type ActorMessageEnvelope = Readonly<{
	messageId: string;
	event: string;
	input: unknown;
	producerState: StatePath;
	producerVisit: number;
	callId?: string;
	batchIndex: number;
}>;

export type ActorCreatedLog = {
	type: "actor_created";
	declaration: StatePath;
	/** Concrete occurrence path; generation 1 uses the logical path, later generations use ~N. */
	occurrence: StatePath;
	generation: number;
	owner?: StatePath;
	input: unknown;
	definition: ActorEndpointDeclarationAst;
} & SessionParams;

export type ActorMessageSource = Readonly<{
	producerState: StatePath;
	kind: "send" | "sendBatch" | "call" | "callBatch";
	definition: SendStateAst | SendBatchStateAst | CallStateAst | CallBatchStateAst;
	targetDeclaration: StatePath;
	event: string;
	inputSchema: SchemaAst;
}>;

/** One record is the atomic mailbox transaction for both a singleton and authored-order batch. */
export type ActorMessagesEnqueuedLog = {
	type: "actor_messages_enqueued";
	occurrence: StatePath;
	generation: number;
	source: ActorMessageSource;
	messages: readonly ActorMessageEnvelope[];
} & SessionParams;

export type ActorMessageAcceptedLog = {
	type: "actor_message";
	kind: "accepted";
	/** Endpoint occurrence. Pool worker identity is carried separately. */
	occurrence: StatePath;
	messageId: string;
	receiveState: StatePath;
	workerIndex?: number;
} & SessionParams;

export type ActorMessageRepliedLog = {
	type: "actor_message";
	kind: "replied";
	occurrence: StatePath;
	messageId: string;
	message: string;
	replyEvent?: string;
	output?: unknown;
	/** Exact selected schema (or absence for void) is replay provenance. */
	schema?: SchemaAst;
	workerIndex?: number;
} & SessionParams;

export type ActorMessageSettledLog = {
	type: "actor_message";
	kind: "settled";
	occurrence: StatePath;
	messageId: string;
	workerIndex?: number;
} & SessionParams;

export type ActorCallResolvedLog = {
	type: "actor_call_resolved";
	callId: string;
	callerState: StatePath;
	messageId: string;
	replyEvent?: string;
	output?: unknown;
} & SessionParams;

export type ActorBatchCallResolvedLog = {
	type: "actor_batch_call_resolved";
	callId: string;
	callerState: StatePath;
	/** Authored input order; item payloads remain in actor_message/replied facts. */
	messageIds: readonly string[];
} & SessionParams;

export type ActorScopeLog = {
	type: "actor_scope";
	kind: "closing" | "stopped";
	occurrence: StatePath;
} & SessionParams;

export type ActorLogRecord =
	| ActorCreatedLog
	| ActorMessagesEnqueuedLog
	| ActorMessageAcceptedLog
	| ActorMessageRepliedLog
	| ActorMessageSettledLog
	| ActorCallResolvedLog
	| ActorBatchCallResolvedLog
	| ActorScopeLog;

export type DurableLogRecord =
	| SessionRefLog
	| ArgsLog
	| SpawnedLog
	| StateAction
	| UserInteractionLog
	| GateLog
	| EmitLog
	| CompletionLog
	| FailureIntentLog
	| ActorLogRecord;

/** Machine payload before the storage writer assigns durable coordinates. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type DurableRecordDraft = DistributiveOmit<DurableLogRecord, keyof DurableRecordCoordinates>;

export type BranchCreateMutation = Readonly<{
	kind: "branch";
	op: "create";
	/** Universal positive per-run journal sequence shared with machine records. */
	seqId: number;
	branchId: BranchId;
	headSeqId: number | null;
	metadata?: BranchMetadata;
	committedAt: number;
}>;

export type BranchMoveMutation = Readonly<{
	kind: "branch";
	op: "move";
	/** Universal per-run journal sequence shared with machine records. */
	seqId: number;
	branchId: BranchId;
	headSeqId: number | null;
	committedAt: number;
}>;

/** Flat durable entries accepted as lines in the current log.jsonl journal. */
export type StorageEntry = DurableLogRecord | BranchCreateMutation | BranchMoveMutation;

export function isDurableRecordEntry(entry: StorageEntry): entry is DurableLogRecord {
	return "type" in entry;
}
