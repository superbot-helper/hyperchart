import { randomUUID } from "../utils/random_uuid.js";
import assert from "./assert.js";
import type {
	ChartEvent,
	ActionStateAst,
	ActionUID,
	ActorEndpointDeclarationAst,
	ActorWorkflowStateAst,
	AgentActionAst,
	ChartAst,
	CompletionDeclarationAst,
	GuardOutcome,
	ArtifactAst,
	ArtifactOfAst,
	ArtifactOfCst,
	JoinArtifactOfAst,
	JoinArtifactOfCst,
	JoinResultOfAst,
	JoinResultOfCst,
	GuardRefAst,
	InputRef,
	JsonValue,
	GateActionAst,
	NotifyActionAst,
	WaitForActionAst,
	RecoveryPolicyAst,
	OnReenterAst,
	SchemaAst,
	ScriptActionAst,
	ImportedActionAst,
	StatePath,
	TemplateAst,
	Templatable,
	UserActionAst,
	ValueAst,
} from "./types.js";
import { isInputRef } from "./types.js";
import type {
	ActorMessageEnvelope,
	ActorMessageSource,
	AgentFailureKind,
	AgentRecoveryMode,
	AgentRecoveryScope,
	ArtifactPin,
	DurableLogRecord,
	DurableRecordDraft,
} from "./durable_events.js";
import {
	actorContextForState,
	actorDefinitionForEndpoint,
	actorGenerationPath,
	actorOccurrencePath,
	actorStatePath,
} from "./actors.js";
import { actionUidKey } from "./action_uid.js";
import { batchInvocationAppends } from "./invocation_batch.js";
import { declaredArtifactsForState } from "./normalize.js";
import {
	allowedEventsForAction,
	type BranchProjection,
	hasTransition,
	isFinalState,
	type PendingAction,
	type ProjectedActorEndpointOccurrence,
	type ProjectedActorOccurrence,
	type ProjectedActorPoolOccurrence,
	type ProjectedActorPoolWorker,
	projectedActorCurrentMessage,
	projectedActorEndpoint,
	projectedActorEndpoints,
	projectedActorMessage,
	projectBranch,
	resolveRef,
} from "./projection.js";
import {
	canonicalMapKeys,
	instancePathFor,
	lastSegmentKey,
	matchesDeclaredUid,
	nearestInstance,
	nodeAt,
	parentPath,
	stripLastKey,
	templatePath,
	underScope,
} from "./paths.js";

export type MachineState = {
	ast: ChartAst;
	projection: BranchProjection;
	// Ids of effects already dispatched in this machine lifetime. Guards against dispatching the
	// same invoke/run/validation/feedback twice; starts empty on restart, so unfinished work
	// re-runs.
	dispatched: Set<EffectId>;
	// Accepted pool facts can be in flight while unrelated runtime events continue. These
	// reservations are a machine-lifetime scheduling view only: projection remains the durable
	// owner of mailbox and worker state once the matching append is acknowledged.
	poolAdmissionReservations: Map<StatePath, ActorPoolAdmissionReservation[]>;
};

export type EffectId = string;

export type ResumeRequest = Readonly<{
	message: string;
	session?: string;
}>;

export type AgentFailure = Readonly<{
	kind: AgentFailureKind;
	retryable: boolean;
	message: string;
	code?: string;
}>;

export type AgentOutcome =
	| Readonly<{ kind: "completed"; event: ChartEvent }>
	| Readonly<{ kind: "failed"; failure: AgentFailure }>;

export type AgentRecoveryRequest = Readonly<{
	mode: AgentRecoveryMode;
	scope: AgentRecoveryScope;
	nudgeAttempt: number;
	restartAttempt: number;
	failure: Readonly<{ kind: AgentFailureKind; message: string; code?: string }>;
}>;

// A file parameter with its path rendered and — when the producer declared one — the shape of
// its content; the runtime uses the shape both to instruct the agent and to verify the file.
export type RenderedArtifact = Readonly<{
	// Present on the producing side: the artifact's declared name.
	name?: string;
	/** Producer state for artifact-backed reads; absent for raw paths and produced outputs. */
	sourceState?: string;
	/** One producer artifact or one expanded member of a map fan-in. */
	readKind?: "artifact" | "join";
	path: string;
	shape?: SchemaAst;
	// Present on artifactOf reads with a selector: the runtime hands the agent only this field of the
	// file's content (validated against `shape`, which describes the WHOLE file).
	select?: string;
	/** Latest accepted durable revision for this rendered read path. */
	pin?: ArtifactPin;
}>;

// A spawn-ready subagent call: the definition name and frontmatter overrides live in `action`;
// task/output/reads are the templated parameters rendered into final text by the machine.
export type AgentEffect = Readonly<{
	kind: "agent";
	id: EffectId;
	actionUid: ActionUID;
	action: AgentActionAst;
	task?: string;
	// The artifact channel: named deliverable files to produce (with shapes), files to read first.
	artifacts?: readonly RenderedArtifact[];
	reads?: readonly RenderedArtifact[];
	// The reply (stdout) channel — the step's RESULT: which completion event types the machine
	// will accept (own transitions plus bubbling ancestors), and what shape the event's payload
	// must have — it becomes results[state] once accepted. The runtime tells the agent both
	// upfront and validates the actual reply at the boundary.
	events: readonly string[];
	reply?: SchemaAst;
	resume?: ResumeRequest;
	/** Durable retry instruction; absent on the original invocation. */
	recovery?: AgentRecoveryRequest;
	/** Opaque identity durably assigned to this action invocation. */
	sessionId: string;
}>;

export type UserEffect = Readonly<{
	kind: "user";
	id: EffectId;
	/** Durable record that caused this user phase; public gate identity is (runId, branchId, seqId). */
	seqId: number;
	actionUid: ActionUID;
	action: UserActionAst;
	prompt: string;
	events: readonly string[];
	reply?: SchemaAst;
}>;

/** Render-only gate invocation metadata; pending gates never dispatch this to a runtime executor. */
export type GateEffect = Readonly<{
	kind: "gate";
	id: EffectId;
	seqId: number;
	actionUid: ActionUID;
	action: GateActionAst;
	event: string;
	payload: JsonValue;
	events: readonly string[];
	reply?: SchemaAst;
}>;

// A command to execute: same completion contract as an agent (events + reply for the parsed
// stdout), same artifact channels; parameters arrive as rendered env vars.
export type ScriptEffect = Readonly<{
	kind: "script";
	id: EffectId;
	actionUid: ActionUID;
	action: ScriptActionAst;
	command: string;
	args: readonly string[];
	// Rendered env. A string is final (templates; artifactOf without select renders to the
	// producer's file path). A RenderedArtifact appears for artifactOf WITH select: the runtime
	// resolves it at spawn — read the file, validate against shape, extract the field, serialize
	// (string verbatim, everything else as JSON) — same rules as an agent's reads.
	env?: Readonly<Record<string, string | RenderedArtifact>>;
	/** Pinned env artifacts restored before invocation; kept separate from path-valued env. */
	reads?: readonly RenderedArtifact[];
	artifacts?: readonly RenderedArtifact[];
	events: readonly string[];
	reply?: SchemaAst;
}>;

// A trusted in-process imported function invocation. The runtime resolves `env` values into the
// function's `params` argument and supplies paths/cancellation separately in its context.
export type ImportedActionEffect = Readonly<{
	kind: "tsImport";
	id: EffectId;
	actionUid: ActionUID;
	action: ImportedActionAst;
	module: string;
	export: string;
	env?: Readonly<Record<string, string | RenderedArtifact>>;
	/** Pinned env artifacts restored before invocation; kept separate from path-valued env. */
	reads?: readonly RenderedArtifact[];
	artifacts?: readonly RenderedArtifact[];
	events: readonly string[];
	reply?: SchemaAst;
	input?: Readonly<Record<string, JsonValue>>;
}>;

export type CompletionNotifyEffect = Readonly<{
	kind: "completion_notify";
	id: EffectId;
	actionUid: ActionUID;
	visitId: number;
	action: NotifyActionAst;
	declaration: CompletionDeclarationAst;
	payload: JsonValue;
	schema: SchemaAst;
}>;

/** Render-only description of a root wait; the machine dispatches no executor effect for it. */
export type WaitForEffect = Readonly<{
	kind: "waitFor";
	id: EffectId;
	actionUid: ActionUID;
	visitId: number;
	action: WaitForActionAst;
	declaration: CompletionDeclarationAst;
}>;

export type ActionEffect =
	| AgentEffect
	| UserEffect
	| GateEffect
	| ScriptEffect
	| ImportedActionEffect
	| CompletionNotifyEffect
	| WaitForEffect;

export type DurableRecordsEffect = Readonly<{
	kind: "durable_records";
	id: EffectId;
	/**
	 * One effect is one atomic append unit: the runtime must commit every record
	 * together or commit none. Records are unstamped; the selected branch writer
	 * assigns every durable coordinate.
	 */
	records: readonly DurableRecordDraft[];
}>;

export type ActorCreateEffect = Readonly<{
	kind: "actor_create";
	id: EffectId;
	declaration: ActorEndpointDeclarationAst;
	occurrence: StatePath;
	generation: number;
	owner?: StatePath;
	input: unknown;
}>;

export type ActorEnqueueEffect = Readonly<{
	kind: "actor_enqueue";
	id: EffectId;
	occurrence: StatePath;
	generation: number;
	schema: SchemaAst;
	source: ActorMessageSource;
	messages: readonly ActorMessageEnvelope[];
}>;

export type ActorReplyEffect = Readonly<{
	kind: "actor_reply";
	id: EffectId;
	occurrence: StatePath;
	messageId: string;
	message: string;
	callerState?: StatePath;
	callId?: string;
	replyEvent?: string;
	output?: unknown;
	schema?: SchemaAst;
	workerIndex?: number;
}>;

export type ActorEffect = ActorCreateEffect | ActorEnqueueEffect | ActorReplyEffect;

// Asks the runtime to run the state's validator against an action's completion. The runtime
// answers with a `validated` event; the completion is not processed until then.
export type ValidateEffect = Readonly<{
	kind: "validate";
	/** Provisional artifact ownership; a fork must obtain a local completion first. */
	completionBranchId?: string;
	/** Identity of the originating action, not this validation phase. */
	invocationId: string;
	id: EffectId;
	actionUid: ActionUID;
	guard: GuardRefAst;
	event: ChartEvent;
	// Rendered exactly like a script action's options. Values are resolved only while this
	// completion is pending; they are never durable facts or action results.
	env?: Readonly<Record<string, string | RenderedArtifact>>;
	artifacts?: readonly RenderedArtifact[];
	reply?: SchemaAst;
}>;

// A deadline racing a running action: fires at `firesAt` (absolute — the invoke fact's timestamp
// plus the state's after.delayMs, so a restarted machine waits only the remaining time). The
// runtime answers with a `timer` event; whether the firing still matters is the machine's call.
export type TimerEffect = Readonly<{
	kind: "timer";
	id: EffectId;
	actionUid: ActionUID;
	firesAt: number;
}>;

// The action lost to its deadline: the runtime must stop the agent. Purely a kill signal — the
// chart has already moved on via the timer_fired fact.
export type CancelEffect = Readonly<{
	kind: "cancel";
	id: EffectId;
	actionUid: ActionUID;
}>;

export type Effect = ActionEffect | DurableRecordsEffect | ActorEffect | ValidateEffect | TimerEffect | CancelEffect;

// A record the machine wants to append, before global numbering and branch provenance. Building
// an append is pure; only the serialized storage writer may stamp durable coordinates.
export type RecordAppend = Readonly<{
	kind: "append";
	id: EffectId;
	records: readonly DurableRecordDraft[];
}>;

export type AgentMachineEvent = Readonly<{
	kind: "agent";
	effectId: EffectId;
	outcome:
		| Readonly<{
				kind: "completed";
				event: ChartEvent;
				/** Revisions of declared deliverables snapshotted at admission. */
				artifacts?: Readonly<Record<string, ArtifactPin>>;
		  }>
		| Readonly<{ kind: "failed"; failure: AgentFailure }>;
}>;

// A script's completion: same shape and handling as an agent's — the runtime maps the process
// outcome (exit code, parsed stdout) into a chart event.
export type ScriptMachineEvent = Readonly<{
	kind: "script";
	effectId: EffectId;
	event: ChartEvent;
	artifacts?: Readonly<Record<string, ArtifactPin>>;
}>;

export type ImportedActionMachineEvent = Readonly<{
	kind: "tsImport";
	effectId: EffectId;
	event: ChartEvent;
	artifacts?: Readonly<Record<string, ArtifactPin>>;
}>;

export type DurableRecordsAddedMachineEvent = Readonly<{
	kind: "durable_records_added";
	effectId: EffectId;
	records: readonly DurableLogRecord[];
}>;

// The runtime's answer to a validate effect.
export type ValidatedMachineEvent = Readonly<{
	kind: "validated";
	effectId: EffectId;
	outcome: GuardOutcome;
}>;

// The runtime's answer to a timer effect: the deadline passed.
export type TimerMachineEvent = Readonly<{
	kind: "timer";
	effectId: EffectId;
}>;

export type CompletionEffectMachineEvent = Readonly<{
	kind: "completion_effect";
	effectId: EffectId;
	operation: "notify";
	ok: boolean;
	error?: string;
}>;

export type ActorEffectMachineEvent = Readonly<{
	kind: "actor_effect";
	effectId: EffectId;
	operation: "create" | "enqueue" | "reply";
	ok: boolean;
	error?: string;
}>;

export type MachineStartEvent = Readonly<{
	kind: "start";
}>;

export type MachineEvent =
	| MachineStartEvent
	| AgentMachineEvent
	| ScriptMachineEvent
	| ImportedActionMachineEvent
	| DurableRecordsAddedMachineEvent
	| ValidatedMachineEvent
	| TimerMachineEvent
	| ActorEffectMachineEvent
	| CompletionEffectMachineEvent;

export type MachineOutput = MachineOutputEffect | MachineOutputFinal | MachineOutputError;

export type MachineOutputError = Readonly<{
	kind: "error";
	state: MachineState;
	error: string;
}>;

export type MachineOutputFinal = Readonly<{
	kind: "final";
	state: MachineState;
	// Parting effects the runtime must still execute — e.g. cancels for agents abandoned by the
	// transition that finished the chart.
	effects: Effect[];
	result: unknown;
}>;

export type MachineOutputEffect = Readonly<{
	kind: "effect";
	state: MachineState;
	effects: Effect[];
}>;

export function createMachineOutput(state: MachineState, responses: readonly (Effect | RecordAppend)[]): MachineOutput {
	const executionError = pendingValidationExecutionError(state.ast, state.projection);
	if (executionError !== undefined) {
		return { kind: "error", state, error: executionError };
	}
	if (state.projection.failure !== undefined) {
		// Failure terminalizes immediately. Runtime cancellation is best-effort, just like
		// timeout/scope-exit cancellation; it is not part of the durable log contract.
		return {
			kind: "final",
			state,
			effects: [
				...responses.map((entry) => (entry.kind === "append" ? prepareAppend(state, entry) : entry)),
				...state.projection.pendingActions.map(
					(pending): CancelEffect => ({
						kind: "cancel",
						id: pendingEffectId(pending),
						actionUid: pending.actionUid,
					}),
				),
			],
			result: undefined,
		};
	}
	if (isFinalState(state.projection, state.ast) && actorsTerminalForRun(state)) {
		return {
			kind: "final",
			state,
			effects: responses.map((entry) => (entry.kind === "append" ? prepareAppend(state, entry) : entry)),
			result: state.projection.results[state.projection.activeLeaves[0] ?? ""],
		};
	}

	// What the runtime should be doing right now, derived entirely from the projection: an invoke
	// record for every active action-leaf with nothing pending yet, plus the effects of each
	// pending action — run it (with a deadline timer, if the state has one), validate its
	// completion, or deliver the rejection.
	const completionFailures = dueCompletionLifecycleFailures(state);
	const desired: (Effect | RecordAppend)[] =
		completionFailures.length > 0
			? completionFailures
			: [
					...dueCompletionNotifications(state),
					...dueCompletionConsumptions(state),
					...dueSpawns(state),
					...dueActorCreates(state),
					...dueActorAdmissionFailures(state),
					...dueActorEnqueues(state),
					...dueActorAccepts(state),
					...dueInvokes(state).map((actionUid) => invokeAppend(state, actionUid)),
					...dueUserInteractionOpens(state),
					...dueActorReplies(state),
					...dueActorBatchResolutions(state),
					...dueActorScopeFacts(state),
					...state.projection.pendingActions.flatMap((pending) => pendingEffects(state, pending)),
				];

	// Each desired entry is dispatched once per machine lifetime; markers of entries no longer
	// desired are dropped, so re-entering the same state later dispatches again.
	const desiredIds = new Set(desired.map((entry) => entry.id));
	for (const id of state.dispatched) {
		if (!desiredIds.has(id)) {
			state.dispatched.delete(id);
		}
	}
	const fresh = desired.filter((entry) => !state.dispatched.has(entry.id));
	for (const entry of fresh) {
		state.dispatched.add(entry.id);
	}

	// Keep per-invocation dispatch reservations, but acknowledge bounded groups of simultaneous
	// starts together. No executor runs before its invocation group is durably acknowledged.
	// Responses (including completion/emit units) retain their original commit boundaries.
	// Appends remain unstamped until the selected branch writer commits them.
	const effects = [...responses, ...batchInvocationAppends(fresh)].map((entry) =>
		entry.kind === "append" ? prepareAppend(state, entry) : entry,
	);

	return { kind: "effect", state, effects };
}

function prepareAppend(state: MachineState, append: RecordAppend): DurableRecordsEffect {
	for (const record of append.records) {
		if (record.type !== "actor_message" || record.kind !== "accepted" || record.workerIndex === undefined) {
			continue;
		}
		const reservations = state.poolAdmissionReservations.get(record.occurrence) ?? [];
		reservations.push({
			effectId: append.id,
			messageId: record.messageId,
			workerIndex: record.workerIndex,
			receiveState: record.receiveState,
		});
		state.poolAdmissionReservations.set(record.occurrence, reservations);
	}
	return { kind: "durable_records", id: append.id, records: append.records };
}

// Every pending action's effect answers the log record that started its phase: invoke → run the
// action, complete → validate it, validated(false) → deliver the rejection. The record's seqId
// makes the id unique per phase, so each phase dispatches exactly once.
function pendingEffectId(pending: PendingAction): EffectId {
	return actionEffectId(pending.actionUid, pending.visitId, pending.seqId);
}

function actionEffectId(actionUid: ActionUID, visitId: number, seqId: number): EffectId {
	return `${actionUidKey(actionUid)}:${visitId}:${seqId}`;
}

function dueUserInteractionOpens(state: MachineState): RecordAppend[] {
	return state.projection.pendingActions.flatMap((pending): RecordAppend[] => {
		if (pending.phase === "validating" || pending.gateSeqId !== undefined) {
			return [];
		}
		const draft = openedGateDraft(state, pending);
		if (draft === undefined) {
			return [];
		}
		return [{ kind: "append", id: `gate:open:${pendingEffectId(pending)}`, records: [draft] }];
	});
}

function openedGateDraft(
	state: Pick<MachineState, "ast" | "projection">,
	pending: PendingAction,
): Extract<DurableRecordDraft, { kind: "opened" }> | undefined {
	return userInteractionOpenedDraft(state, pending) ?? gateOpenedDraft(state, pending);
}

/** Exact durable rendering shared by fresh execution and replay provenance checks. */
export function userInteractionOpenedDraft(
	state: Pick<MachineState, "ast" | "projection">,
	pending: PendingAction,
): Extract<DurableRecordDraft, { type: "user_interaction"; kind: "opened" }> | undefined {
	if (pending.phase === "validating") {
		return undefined;
	}
	const node = actionStateAtMachine(state.ast, pending.actionUid.state);
	if (node?.action.kind !== "user") {
		return undefined;
	}
	return {
		type: "user_interaction",
		kind: "opened",
		actionUid: pending.actionUid,
		phaseSeqId: pending.seqId,
		...resolvedStateInput(state, pending.actionUid),
		prompt: renderTemplate(state as MachineState, node.action.prompt, pending.actionUid.state),
		options: node.action.options,
		events: allowedEventsForAction(state.ast, pending.actionUid.state).filter((event) => event !== "FAILED"),
		...(node.action.reply === undefined ? {} : { reply: node.action.reply }),
	};
}

/** Exact durable rendering for a chart-level host gate. */
export function gateOpenedDraft(
	state: Pick<MachineState, "ast" | "projection">,
	pending: PendingAction,
): Extract<DurableRecordDraft, { type: "gate"; kind: "opened" }> | undefined {
	if (pending.phase === "validating") {
		return undefined;
	}
	const node = actionStateAtMachine(state.ast, pending.actionUid.state);
	if (node?.action.kind !== "gate") {
		return undefined;
	}
	return {
		type: "gate",
		kind: "opened",
		actionUid: pending.actionUid,
		phaseSeqId: pending.seqId,
		...resolvedStateInput(state, pending.actionUid),
		event: node.action.event,
		payload: asJsonValue(
			resolveValueAst(state as MachineState, node.action.payload, pending.actionUid.state),
			`Gate payload in state ${pending.actionUid.state}`,
		),
		...(node.action.reply === undefined ? {} : { reply: node.action.reply }),
	};
}

// All effects a pending action currently wants: its phase effect, plus — while running under a
// deadline — the timer racing it.
function pendingEffects(state: MachineState, pending: PendingAction): Effect[] {
	const ast = state.ast;
	const node = actionStateAtMachine(ast, pending.actionUid.state);
	// User phases are represented and completed exclusively by journal facts. They never
	// dispatch a live executor effect; validation after a resolved fact remains ordinary.
	const journalAction =
		node?.action.kind === "user" ||
		node?.action.kind === "gate" ||
		node?.action.kind === "waitFor" ||
		node?.action.kind === "notify";
	const effects: Effect[] = journalAction && pending.phase !== "validating" ? [] : [pendingEffect(state, pending)];
	if (pending.phase === "running") {
		if (node?.after !== undefined) {
			effects.push({
				kind: "timer",
				id: timerEffectId(pending),
				actionUid: pending.actionUid,
				firesAt: pending.timestamp + node.after.delayMs,
			});
		}
	}
	return effects;
}

function timerEffectId(pending: PendingAction): EffectId {
	return actionEffectId(pending.actionUid, pending.visitId, pending.seqId);
}

function pendingEffect(state: MachineState, pending: PendingAction): Effect {
	const node = actionStateAtMachine(state.ast, pending.actionUid.state);
	if (node === undefined || !matchesDeclaredUid(pending.actionUid, node.action.uid)) {
		throw new Error(`Pending action does not match the chart in state ${pending.actionUid.state}`);
	}
	const id = pendingEffectId(pending);
	switch (pending.phase) {
		case "running":
			return actionInvocationForAction(
				state,
				pending.actionUid,
				pending.definition,
				id,
				pending.seqId,
				pending.sessionId,
				pending.lastRetry,
			);
		case "validating": {
			const validation = pending.definition.kind === "agent" ? pending.definition.validation : undefined;
			if (validation === undefined) {
				throw new Error(`Cannot validate a completion for state ${pending.actionUid.state} without an agent validator`);
			}
			// Render from the same projection and original invoke context as the action effect. The
			// completion is still pending, so its output has not entered results and cannot perturb
			// the rendered paths. This also makes a replayed pending completion deterministic.
			return {
				kind: "validate",
				...(pending.completionArtifacts === undefined
					? {}
					: { completionBranchId: pending.completionArtifacts.branchId }),
				invocationId: pending.sessionId,
				id,
				actionUid: pending.actionUid,
				guard: validation.guard,
				event: pending.event,
				...renderScriptOptions(
					state,
					validation.guard as ScriptOptionsAst,
					pending.actionUid.state,
					pending.actionUid.state,
				),
			};
		}
	}
}

export function renderPendingActionInvocation(
	ast: ChartAst,
	projection: BranchProjection,
	pending: Extract<PendingAction, { phase: "running" }>,
): ActionEffect {
	const node = actionStateAtMachine(ast, pending.actionUid.state);
	if (node === undefined || !matchesDeclaredUid(pending.actionUid, node.action.uid)) {
		throw new Error(`Pending action does not match the chart in state ${pending.actionUid.state}`);
	}
	return actionInvocationForAction(
		createMachine(ast, projection),
		pending.actionUid,
		node.action,
		actionEffectId(pending.actionUid, pending.visitId, pending.invokeSeqId),
		pending.seqId,
		pending.sessionId,
	);
}

function actionInvocationForAction(
	state: MachineState,
	actionUid: ActionUID,
	action: ActionStateAst["action"],
	id: EffectId,
	seqId: number,
	sessionId: string,
	recovery?: PendingAction["lastRetry"],
): ActionEffect {
	switch (action.kind) {
		case "agent":
			return agentInvocationForAction(state, actionUid, action, id, sessionId, recovery);
		case "script":
			return scriptInvocationForAction(state, actionUid, action, id);
		case "tsImport":
			return importedActionInvocationForAction(state, actionUid, action, id);
		case "user":
			return userInvocationForAction(state, actionUid, action, id, seqId);
		case "gate":
			return gateInvocationForAction(state, actionUid, action, id, seqId);
		case "notify":
			return completionNotifyInvocation(state, actionUid, action, id);
		case "waitFor":
			return waitForInvocation(state, actionUid, action, id);
	}
}

function agentInvocationForAction(
	state: MachineState,
	actionUid: ActionUID,
	action: AgentActionAst,
	id: EffectId,
	sessionId: string,
	recovery?: PendingAction["lastRetry"],
): AgentEffect {
	const resume = resumeRequestForAction(state, actionUid, id);
	return {
		kind: "agent",
		id,
		actionUid,
		action,
		sessionId,
		events: allowedEventsForAction(state.ast, actionUid.state),
		...(action.reply === undefined ? {} : { reply: action.reply }),
		...(resume === undefined ? {} : { resume }),
		...(recovery === undefined ? {} : { recovery }),
		...(action.task === undefined ? {} : { task: renderTemplate(state, action.task, actionUid.state) }),
		...(action.artifacts === undefined
			? {}
			: {
					artifacts: Object.entries(action.artifacts).map(([name, declared]) => ({
						name,
						...renderArtifact(state, declared, actionUid.state),
					})),
				}),
		...(action.reads === undefined
			? {}
			: {
					reads: action.reads.flatMap((read) =>
						read.kind === "joinArtifactOf"
							? renderJoin(state, read, actionUid.state)
							: [renderRead(state, read, actionUid.state)],
					),
				}),
	};
}

type ScriptOptionsAst = {
	env?: Readonly<Record<string, TemplateAst | ArtifactOfAst | JoinArtifactOfAst | JoinResultOfAst>>;
	artifacts?: Readonly<Record<string, ArtifactAst>>;
	reply?: SchemaAst;
};

function renderScriptOptions(
	state: MachineState,
	action: ScriptOptionsAst,
	stateId: StatePath,
	selfActionArtifactsState?: StatePath,
): {
	env?: Readonly<Record<string, string | RenderedArtifact>>;
	reads?: readonly RenderedArtifact[];
	artifacts?: readonly RenderedArtifact[];
	reply?: SchemaAst;
} {
	const renderedEnv =
		action.env === undefined ? undefined : renderScriptEnv(state, action.env, stateId, selfActionArtifactsState);
	const reads = Object.values(renderedEnv ?? {}).filter(
		(value): value is RenderedArtifact => typeof value !== "string",
	);
	const env =
		renderedEnv === undefined
			? undefined
			: Object.fromEntries(
					Object.entries(renderedEnv).map(([name, value]) => [
						name,
						typeof value !== "string" && value.select === undefined ? value.path : value,
					]),
				);
	return {
		...(env === undefined ? {} : { env }),
		...(reads.length === 0 ? {} : { reads }),
		...(action.artifacts === undefined
			? {}
			: {
					artifacts: Object.entries(action.artifacts).map(([name, declared]) => ({
						name,
						...renderArtifact(state, declared, stateId),
					})),
				}),
		...(action.reply === undefined ? {} : { reply: action.reply }),
	};
}

function renderScriptEnv(
	state: MachineState,
	env: Readonly<Record<string, Templatable | ArtifactOfCst | JoinArtifactOfCst | JoinResultOfCst>>,
	stateId: StatePath,
	selfActionArtifactsState?: StatePath,
): Readonly<Record<string, string | RenderedArtifact>> {
	return Object.fromEntries(
		Object.entries(env).map(([name, value]) => {
			if (typeof value === "string") {
				return [name, value];
			}
			if (value.kind === "template") {
				return [name, renderTemplate(state, value, stateId)];
			}
			if (value.kind === "joinArtifactOf") {
				const paths = renderJoin(state, value, stateId).map((read) => read.path);
				return [name, JSON.stringify(paths)];
			}
			if (value.kind === "joinResultOf") {
				return [name, JSON.stringify(renderResultJoin(state, value, stateId))];
			}
			const read = renderRead(state, value, stateId, selfActionArtifactsState);
			return [name, read];
		}),
	);
}

function scriptInvocationForAction(
	state: MachineState,
	actionUid: ActionUID,
	action: ScriptActionAst,
	id: EffectId,
): ScriptEffect {
	return {
		kind: "script",
		id,
		actionUid,
		action,
		command: action.command,
		args: action.args,
		events: allowedEventsForAction(state.ast, actionUid.state),
		...renderScriptOptions(state, action, actionUid.state),
	};
}

function importedActionInvocationForAction(
	state: MachineState,
	actionUid: ActionUID,
	action: ImportedActionAst,
	id: EffectId,
): ImportedActionEffect {
	return {
		kind: "tsImport",
		id,
		actionUid,
		action,
		module: action.module,
		export: action.export,
		events: allowedEventsForAction(state.ast, actionUid.state),
		...renderScriptOptions(state, action, actionUid.state),
		...resolvedStateInput(state, actionUid),
	};
}

function userInvocationForAction(
	state: MachineState,
	actionUid: ActionUID,
	action: UserActionAst,
	id: EffectId,
	seqId: number,
): UserEffect {
	return {
		kind: "user",
		id,
		seqId,
		actionUid,
		action,
		prompt: renderTemplate(state, action.prompt, actionUid.state),
		events: allowedEventsForAction(state.ast, actionUid.state),
		...(action.reply === undefined ? {} : { reply: action.reply }),
	};
}

function gateInvocationForAction(
	state: MachineState,
	actionUid: ActionUID,
	action: GateActionAst,
	id: EffectId,
	seqId: number,
): GateEffect {
	return {
		kind: "gate",
		id,
		seqId,
		actionUid,
		action,
		event: action.event,
		payload: asJsonValue(
			resolveValueAst(state, action.payload, actionUid.state),
			`Gate payload in state ${actionUid.state}`,
		),
		events: allowedEventsForAction(state.ast, actionUid.state).filter((event) => event !== "FAILED"),
		...(action.reply === undefined ? {} : { reply: action.reply }),
	};
}

function completionNotifyInvocation(
	state: MachineState,
	actionUid: ActionUID,
	action: NotifyActionAst,
	id: EffectId,
): CompletionNotifyEffect {
	const declaration = state.ast.completions[action.to];
	assert(declaration !== undefined, `notify() in ${actionUid.state} targets unknown completion ${action.to}`);
	const parts = effectIdParts(id);
	assert(parts !== null, `notify() in ${actionUid.state} has invalid effect id ${id}`);
	return {
		kind: "completion_notify",
		id,
		actionUid,
		visitId: parts.visitId,
		action,
		declaration,
		payload: asJsonValue(
			resolveValueAst(state, action.payload, actionUid.state),
			`Completion payload in state ${actionUid.state}`,
		),
		schema: declaration.schema,
	};
}

function waitForInvocation(
	state: MachineState,
	actionUid: ActionUID,
	action: WaitForActionAst,
	id: EffectId,
): WaitForEffect {
	const declaration = state.ast.completions[action.from];
	assert(declaration !== undefined, `waitFor() in ${actionUid.state} targets unknown completion ${action.from}`);
	const parts = effectIdParts(id);
	assert(parts !== null, `waitFor() in ${actionUid.state} has invalid effect id ${id}`);
	return { kind: "waitFor", id, actionUid, visitId: parts.visitId, action, declaration };
}

function resumeRequestForAction(state: MachineState, actionUid: ActionUID, id: EffectId): ResumeRequest | undefined {
	const parts = effectIdParts(id);
	if (parts === null || parts.visitId <= 1) {
		return undefined;
	}
	const match = onReenterForAction(state.ast, actionUid.state);
	if (match === undefined || match.policy === "restart") {
		return undefined;
	}
	return {
		message: renderTemplate(state, match.policy.message, match.scope),
		...(state.projection.sessions[actionUidKey(actionUid)] === undefined
			? {}
			: { session: state.projection.sessions[actionUidKey(actionUid)] }),
	};
}

function onReenterForAction(
	ast: ChartAst,
	statePath: StatePath,
): { policy: OnReenterAst; scope: StatePath } | undefined {
	const own = nodeAt(ast, statePath);
	if (own?.kind === "state" && own.action.kind === "agent" && own.action.reentry !== undefined) {
		const policy: OnReenterAst =
			own.action.reentry === "restart" ? "restart" : { kind: "resume", message: own.action.reentry.resume };
		return { policy, scope: statePath };
	}
	let cur = parentPath(statePath);
	while (cur !== undefined) {
		const node = nodeAt(ast, cur);
		if (node?.kind === "map" && node.onReenter !== undefined) {
			return { policy: node.onReenter, scope: cur };
		}
		cur = parentPath(cur);
	}
	return undefined;
}

function effectIdParts(id: EffectId): { actionUid: ActionUID; visitId: number; seqId: number } | null {
	const [chart, state, action, visit, seq] = id.split(":");
	const visitId = Number(visit);
	const seqId = Number(seq);
	if (!chart || !state || !action || !Number.isInteger(visitId) || !Number.isInteger(seqId)) {
		return null;
	}

	return { actionUid: { chart, state, action }, visitId, seqId };
}

function sameActionUid(left: ActionUID, right: ActionUID): boolean {
	return left.chart === right.chart && left.state === right.state && left.action === right.action;
}

function recoveryDecisionRecords(
	pending: PendingAction,
	failure: AgentFailure,
	scope: AgentRecoveryScope,
): DurableRecordDraft[] {
	if (!failure.retryable || pending.definition.kind !== "agent") {
		return [{ type: "failure_intent", origin: pending.actionUid.state, error: failure.message }];
	}
	const policy: RecoveryPolicyAst =
		scope === "validation"
			? (pending.definition.validation?.onFail ?? pending.definition.onFail)
			: pending.definition.onFail;
	const counters = pending.recovery[scope];
	let mode: AgentRecoveryMode | undefined;
	if (counters.nudges < policy.nudge) {
		mode = "nudge";
	} else if (counters.restarts < policy.restart) {
		mode = "restart";
	}
	if (mode === undefined) {
		return [{ type: "failure_intent", origin: pending.actionUid.state, error: failure.message }];
	}
	const sessionId = mode === "restart" ? randomUUID() : pending.sessionId;
	return [
		{
			type: "state_action",
			kind: "retry",
			actionUid: pending.actionUid,
			failure: {
				kind: failure.kind,
				message: failure.message,
				...(failure.code === undefined ? {} : { code: failure.code }),
			},
			scope,
			mode,
			previousSessionId: pending.sessionId,
			resultingSessionId: sessionId,
			nudgeAttempt: mode === "nudge" ? counters.nudges + 1 : 0,
			restartAttempt: mode === "restart" ? counters.restarts + 1 : counters.restarts,
		},
	];
}

export function emittedRecordsForAcceptedCompletion(
	state: MachineState,
	actionUid: ActionUID,
	event: ChartEvent,
): DurableRecordDraft[] {
	const node = actionStateAtMachine(state.ast, actionUid.state);
	assert(node !== undefined, `Cannot emit for non-action state ${actionUid.state}`);
	return (node.emit ?? []).map((emitted) => {
		const payload = asJsonValue(
			resolveValueAst(state, emitted.payload, actionUid.state, event),
			`Emit '${emitted.event}' payload in state ${actionUid.state}`,
		);
		return {
			type: "emit",
			actionUid,
			event: emitted.event,
			payload,
		};
	});
}

export function stepMachine(state: MachineState, event: MachineEvent): MachineOutput {
	if (state.projection.failure !== undefined && event.kind !== "durable_records_added" && event.kind !== "start") {
		return createMachineOutput(state, []);
	}
	switch (event.kind) {
		case "agent": {
			const pending = findPendingAction(state, event.effectId);
			if (pending === null) {
				break;
			}
			if (typeof pending === "string") {
				return { kind: "error", state, error: pending };
			}
			if (event.outcome.kind === "failed") {
				return createMachineOutput(state, [
					{
						kind: "append",
						id: `recovery:${event.effectId}`,
						records: recoveryDecisionRecords(pending, event.outcome.failure, "general"),
					},
				]);
			}
			const completion = event.outcome;
			if (completion.event.type === "FAILED") {
				return createMachineOutput(state, [
					{
						kind: "append",
						id: `failure:${event.effectId}`,
						records: [
							{
								type: "failure_intent",
								origin: pending.actionUid.state,
								error: "error" in completion.event ? completion.event.error : "Agent emitted FAILED",
							},
						],
					},
				]);
			}
			if (!hasActionTransition(state.ast, pending.actionUid.state, completion.event.type)) {
				return {
					kind: "error",
					state,
					error: `No transition found for event type ${completion.event.type} in state ${pending.actionUid.state}`,
				};
			}
			const complete: DurableRecordDraft = {
				type: "state_action",
				kind: "complete",
				actionUid: pending.actionUid,
				...resolvedStateInput(state, pending.actionUid),
				event: completion.event,
				...(completion.artifacts === undefined ? {} : { artifacts: completion.artifacts }),
			};
			const guarded = pending.definition.kind === "agent" && pending.definition.validation !== undefined;
			return createMachineOutput(state, [
				{
					kind: "append",
					id: event.effectId,
					records: [
						complete,
						...(guarded ? [] : emittedRecordsForAcceptedCompletion(state, pending.actionUid, completion.event)),
					],
				},
			]);
		}
		case "script":
		case "tsImport": {
			const pending = findPendingAction(state, event.effectId);
			if (pending === null) {
				break;
			}
			if (typeof pending === "string") {
				return { kind: "error", state, error: pending };
			}
			if (event.event.type === "FAILED") {
				return createMachineOutput(state, [
					{
						kind: "append",
						id: `failure:${event.effectId}`,
						records: [
							{
								type: "failure_intent",
								origin: pending.actionUid.state,
								error: "error" in event.event ? event.event.error : "Action emitted FAILED",
							},
						],
					},
				]);
			}
			if (!hasActionTransition(state.ast, pending.actionUid.state, event.event.type)) {
				return {
					kind: "error",
					state,
					error: `No transition found for event type ${event.event.type} in state ${pending.actionUid.state}`,
				};
			}
			return createMachineOutput(state, [
				{
					kind: "append",
					id: event.effectId,
					records: [
						{
							type: "state_action",
							kind: "complete",
							actionUid: pending.actionUid,
							...resolvedStateInput(state, pending.actionUid),
							event: event.event,
							...(event.artifacts === undefined ? {} : { artifacts: event.artifacts }),
						},
						...emittedRecordsForAcceptedCompletion(state, pending.actionUid, event.event),
					],
				},
			]);
		}
		case "validated": {
			const validating = state.projection.pendingActions.find(
				(pending): pending is Extract<PendingAction, { phase: "validating" }> =>
					pending.phase === "validating" && pendingEffectId(pending) === event.effectId,
			);
			if (!validating) {
				return { kind: "error", state, error: `No pending validation found for effectId ${event.effectId}` };
			}
			const validation = validating.definition.kind === "agent" ? validating.definition.validation : undefined;
			if (validation === undefined) {
				return { kind: "error", state, error: `State ${validating.actionUid.state} has no agent validator` };
			}
			const validated: DurableRecordDraft = {
				type: "state_action",
				kind: "validated",
				actionUid: validating.actionUid,
				...resolvedStateInput(state, validating.actionUid),
				event: validating.event,
				guard: validation.guard,
				outcome: event.outcome,
			};
			const records =
				event.outcome === true
					? [validated, ...emittedRecordsForAcceptedCompletion(state, validating.actionUid, validating.event)]
					: [
							validated,
							...recoveryDecisionRecords(
								validating,
								{
									kind: "validation",
									retryable: true,
									message:
										typeof event.outcome === "object"
											? event.outcome.reason
											: "Agent completion was rejected by validation",
								},
								"validation",
							),
						];
			return createMachineOutput(state, [{ kind: "append", id: event.effectId, records }]);
		}
		case "completion_effect": {
			const pending = state.projection.pendingActions.find(
				(entry) => entry.phase === "running" && pendingEffectId(entry) === event.effectId,
			);
			// Async schema validation can lose to actor-scope exit or global failure.
			// Like stale actor-effect responses, a completion response with no current
			// notify owner is a race loser and cannot publish or fail the chart.
			if (pending === undefined || pending.definition.kind !== "notify") {
				break;
			}
			if (!event.ok) {
				return createMachineOutput(state, [
					{
						kind: "append",
						id: `failure:${event.effectId}`,
						records: [
							{
								type: "failure_intent",
								origin: pending.actionUid.state,
								error: event.error ?? "Completion payload validation failed",
							},
						],
					},
				]);
			}
			if (state.projection.completions[pending.definition.to] !== undefined) {
				return createMachineOutput(state, dueCompletionLifecycleFailures(state));
			}
			const effect = completionNotifyInvocation(state, pending.actionUid, pending.definition, event.effectId);
			return createMachineOutput(state, [
				{
					kind: "append",
					id: event.effectId,
					records: [
						{
							type: "completion",
							kind: "notified",
							endpoint: effect.declaration.name,
							event: effect.declaration.event,
							payload: effect.payload,
							source: {
								actionUid: pending.actionUid,
								visitId: pending.visitId,
								definition: pending.definition,
								declaration: effect.declaration,
							},
						},
						{
							type: "state_action",
							kind: "complete",
							actionUid: pending.actionUid,
							...resolvedStateInput(state, pending.actionUid),
							event: { type: "NOTIFIED" },
						},
					],
				},
			]);
		}
		case "actor_effect": {
			const effect = [...dueActorCreates(state), ...dueActorEnqueues(state), ...dueActorReplies(state)].find(
				(candidate) => candidate.id === event.effectId,
			);
			// A response whose effect is no longer due lost a race — e.g. the owner
			// scope exited before actor-create validation returned. Race losers are
			// no-ops, mirroring invoke/spawn facts on inactive leaves.
			if (effect === undefined) {
				break;
			}
			if (!event.ok) {
				const origin =
					effect.kind === "actor_enqueue"
						? (effect.messages[0]?.producerState ?? effect.occurrence)
						: effect.occurrence;
				return createMachineOutput(state, [
					{
						kind: "append",
						id: `failure:${effect.id}`,
						records: [
							{ type: "failure_intent", origin, error: event.error ?? `Actor ${event.operation} validation failed` },
						],
					},
				]);
			}
			if (effect.kind === "actor_create") {
				return createMachineOutput(state, [
					{
						kind: "append",
						id: effect.id,
						records: [
							{
								type: "actor_created",
								declaration: effect.declaration.path,
								occurrence: effect.occurrence,
								generation: effect.generation,
								...(effect.owner === undefined ? {} : { owner: effect.owner }),
								input: effect.input,
								definition: effect.declaration,
							},
						],
					},
				]);
			}
			if (effect.kind === "actor_enqueue") {
				return createMachineOutput(state, [
					{
						kind: "append",
						id: effect.id,
						records: [
							{
								type: "actor_messages_enqueued",
								occurrence: effect.occurrence,
								generation: effect.generation,
								source: effect.source,
								messages: effect.messages,
							},
						],
					},
				]);
			}
			const resolution = actorCallResolutionAfterReply(state, effect);
			return createMachineOutput(state, [
				{
					kind: "append",
					id: effect.id,
					records: [
						{
							type: "actor_message",
							kind: "replied",
							occurrence: effect.occurrence,
							messageId: effect.messageId,
							message: effect.message,
							...(effect.workerIndex === undefined ? {} : { workerIndex: effect.workerIndex }),
							...(effect.replyEvent === undefined ? {} : { replyEvent: effect.replyEvent }),
							...(Object.hasOwn(effect, "output") ? { output: effect.output } : {}),
							...(effect.schema === undefined ? {} : { schema: effect.schema }),
						},
						{
							type: "actor_message",
							kind: "settled",
							occurrence: effect.occurrence,
							messageId: effect.messageId,
							...(effect.workerIndex === undefined ? {} : { workerIndex: effect.workerIndex }),
						},
						...resolution,
					],
				},
			]);
		}
		case "timer": {
			const running = state.projection.pendingActions.find(
				(pending) => pending.phase === "running" && timerEffectId(pending) === event.effectId,
			);
			if (!running) {
				// The action completed (or moved into validation) before its deadline: stale, ignored.
				break;
			}
			// The expiry is a fact; the transition target is the projection's job. The cancel signal
			// rides along — the runtime must stop the now-abandoned agent.
			return createMachineOutput(state, [
				{
					kind: "append",
					id: event.effectId,
					records: [{ type: "state_action", kind: "timer_fired", actionUid: running.actionUid }],
				},
				{ kind: "cancel", id: event.effectId, actionUid: running.actionUid },
			]);
		}
		case "start":
			// Nothing to apply: the derivation in createMachineOutput starts whatever is due.
			break;
		case "durable_records_added": {
			// The projection reports what an exit dropped while its session was alive — e.g. one
			// region's event exited the whole parallel. The runtime must kill it.
			const abandoned: PendingAction[] = [];
			state.projection = projectBranch(state.projection, state.ast, event.records, abandoned);
			removePoolAdmissionReservations(state, event.effectId);
			const cancels = abandoned.map(
				(pending): Effect => ({
					kind: "cancel",
					id: pendingEffectId(pending),
					actionUid: pending.actionUid,
				}),
			);
			return createMachineOutput(state, cancels);
		}
	}

	return createMachineOutput(state, []);
}

function dueCompletionLifecycleFailures(state: MachineState): RecordAppend[] {
	for (const pending of state.projection.pendingActions) {
		if (pending.phase !== "running") {
			continue;
		}
		if (pending.definition.kind === "notify" && state.projection.completions[pending.definition.to] !== undefined) {
			return [
				{
					kind: "append",
					id: `completion:duplicate:${pendingEffectId(pending)}`,
					records: [
						{
							type: "failure_intent",
							origin: pending.actionUid.state,
							error: `Completion '${pending.definition.to}' was notified more than once`,
						},
					],
				},
			];
		}
		if (pending.definition.kind === "waitFor") {
			const completion = state.projection.completions[pending.definition.from];
			if (completion?.consumed !== undefined) {
				return [
					{
						kind: "append",
						id: `completion:stale-wait:${pendingEffectId(pending)}`,
						records: [
							{
								type: "failure_intent",
								origin: pending.actionUid.state,
								error: `Completion '${pending.definition.from}' cannot be consumed by another wait visit`,
							},
						],
					},
				];
			}
		}
	}
	return [];
}

function dueCompletionNotifications(state: MachineState): CompletionNotifyEffect[] {
	const reserved = new Set<string>();
	return state.projection.pendingActions.flatMap((pending): CompletionNotifyEffect[] => {
		if (
			pending.phase !== "running" ||
			pending.definition.kind !== "notify" ||
			state.projection.completions[pending.definition.to] !== undefined ||
			reserved.has(pending.definition.to)
		) {
			return [];
		}
		// At most one schema-validation effect per endpoint may be in flight. The
		// first pending notifier deterministically owns this machine-lifetime
		// reservation until its append is acknowledged or the action is canceled.
		reserved.add(pending.definition.to);
		return [completionNotifyInvocation(state, pending.actionUid, pending.definition, pendingEffectId(pending))];
	});
}

function dueCompletionConsumptions(state: MachineState): RecordAppend[] {
	return state.projection.pendingActions.flatMap((pending): RecordAppend[] => {
		if (pending.phase !== "running" || pending.definition.kind !== "waitFor") {
			return [];
		}
		const completion = state.projection.completions[pending.definition.from];
		if (completion === undefined || completion.consumed !== undefined) {
			return [];
		}
		return [
			{
				kind: "append",
				id: `completion:consume:${pendingEffectId(pending)}:${completion.notificationSeqId}`,
				records: [
					{
						type: "completion",
						kind: "consumed",
						endpoint: pending.definition.from,
						notificationSeqId: completion.notificationSeqId,
						actionUid: pending.actionUid,
						visitId: pending.visitId,
						definition: pending.definition,
					},
					{
						type: "state_action",
						kind: "complete",
						actionUid: pending.actionUid,
						...resolvedStateInput(state, pending.actionUid),
						event: { type: completion.event, output: completion.payload },
					},
				],
			},
		];
	});
}

function dueActorBatchResolutions(state: MachineState): RecordAppend[] {
	return Object.values(state.projection.pendingActorCalls).flatMap((pending) => {
		if (pending.kind !== "batch") {
			return [];
		}
		const endpoint = projectedActorEndpoint(state.projection, pending.occurrence);
		if (
			endpoint === undefined ||
			!pending.messageIds.every((messageId) => projectedActorMessage(state.projection, messageId)?.status === "settled")
		) {
			return [];
		}
		return [
			{
				kind: "append",
				id: `actor:batch-resolve:${pending.callId}`,
				records: [
					{
						type: "actor_batch_call_resolved",
						callId: pending.callId,
						callerState: pending.callerState,
						messageIds: pending.messageIds,
					},
				],
			},
		];
	});
}

function actorCallResolutionAfterReply(state: MachineState, effect: ActorReplyEffect): DurableRecordDraft[] {
	if (effect.callId === undefined || effect.callerState === undefined) {
		return [];
	}
	const pending = state.projection.pendingActorCalls[effect.callId];
	if (pending?.kind === "batch") {
		const endpoint = projectedActorEndpoint(state.projection, pending.occurrence);
		const complete =
			endpoint !== undefined &&
			pending.messageIds.every(
				(messageId) =>
					messageId === effect.messageId || projectedActorMessage(state.projection, messageId)?.status === "settled",
			);
		return complete
			? [
					{
						type: "actor_batch_call_resolved",
						callId: pending.callId,
						callerState: pending.callerState,
						messageIds: pending.messageIds,
					},
				]
			: [];
	}
	return [
		{
			type: "actor_call_resolved",
			callId: effect.callId,
			callerState: effect.callerState,
			messageId: effect.messageId,
			...(effect.replyEvent === undefined ? {} : { replyEvent: effect.replyEvent }),
			...(Object.hasOwn(effect, "output") ? { output: effect.output } : {}),
		},
	];
}

// null means "nothing pending for this action" — not an error, the completion may simply have
// lost a race; a string is a protocol violation to report.
function findPendingAction(machine: MachineState, effectId: EffectId): PendingAction | string | null {
	const parsed = effectIdParts(effectId);
	if (!parsed) {
		return `Invalid effectId ${effectId}`;
	}
	const pending = machine.projection.pendingActions.find(
		(el) => sameActionUid(el.actionUid, parsed.actionUid) && el.visitId === parsed.visitId,
	);
	if (!pending || pendingEffectId(pending) !== effectId) {
		return null;
	}
	if (pending.phase === "validating") {
		return `Validation already in flight for ${effectId}`;
	}
	const curState = actionStateAtMachine(machine.ast, parsed.actionUid.state);
	if (curState === undefined) {
		return `State ${parsed.actionUid.state} is not actionable`;
	}
	return pending;
}

// The machine decides when actions start: an invoke record is due for every active action-leaf
// whose action is not pending yet. This covers the initial state, every transition target and
// all parallel regions — the runtime never initiates anything on its own. The id carries no
// seqId, but between two entries into the same state the action is always pending, so the
// dispatch marker is dropped in between.
function dueInvokes(state: MachineState): ActionUID[] {
	const blocked = concurrencyBlockedActionLeaves(state.ast, state.projection);
	const due: ActionUID[] = [];
	for (const leaf of state.projection.activeLeaves) {
		const node = nodeAt(state.ast, leaf);
		if (node?.kind !== "state" || blocked.has(leaf)) {
			continue;
		}
		// The uid of the invoke carries the INSTANCE path — that is the action's identity in the
		// log and in effect ids; the chart's declared uid keeps the template path.
		const actionUid = { ...node.action.uid, state: leaf };
		if (!state.projection.pendingActions.some((entry) => sameActionUid(entry.actionUid, actionUid))) {
			due.push(actionUid);
		}
	}
	for (const actor of executableActorInstances(state)) {
		if (actor.status === "stopped" || actor.status === "failed" || actor.status === "cancelled") {
			continue;
		}
		const node = actor.definition.states[actor.currentState];
		if (node?.kind !== "state") {
			continue;
		}
		const actionUid = { ...node.action.uid, state: actorStatePath(actor.occurrence, actor.currentState) };
		if (!state.projection.pendingActions.some((entry) => sameActionUid(entry.actionUid, actionUid))) {
			due.push(actionUid);
		}
	}
	return due;
}

// The action leaves a map's concurrency gate holds shut right now. Per limited map: instances
// already holding pending work keep their slots; idle instances take the free slots in
// activeLeaves order — the spawn fact's key order, so slots fill deterministically — and the rest
// wait. A completed instance has nothing pending and no action leaf, so it holds no slot.
//
// The host adapter reuses this exact admission view so inspector status cannot drift from the
// machine and label a gated action as running before its invoke exists.
export function concurrencyBlockedActionLeaves(ast: ChartAst, projection: BranchProjection): Set<StatePath> {
	const blocked = new Set<StatePath>();
	const running = new Map<StatePath, Set<string>>();
	for (const entry of projection.pendingActions) {
		const instance = nearestInstance(entry.actionUid.state);
		if (instance === undefined) {
			continue;
		}
		const keys = running.get(instance.container) ?? new Set<string>();
		keys.add(instance.key);
		running.set(instance.container, keys);
	}
	for (const leaf of projection.activeLeaves) {
		if (nodeAt(ast, leaf)?.kind !== "state") {
			continue;
		}
		const instance = nearestInstance(leaf);
		if (instance === undefined) {
			continue;
		}
		const container = nodeAt(ast, instance.container);
		if (container?.kind !== "map" || container.concurrency === undefined) {
			continue;
		}
		const keys = running.get(instance.container) ?? new Set<string>();
		if (keys.has(instance.key)) {
			continue;
		}
		if (keys.size >= container.concurrency) {
			blocked.add(leaf);
			continue;
		}
		keys.add(instance.key);
		running.set(instance.container, keys);
	}
	return blocked;
}

// A bare map leaf is a placeholder awaiting its fan-out: resolve `over` from the same facts
// templates render from and pin the keys and items as a spawned fact. Replay reads the fact and
// never re-resolves — the instances are frozen at birth.
function dueSpawns(state: MachineState): RecordAppend[] {
	const appends: RecordAppend[] = [];
	for (const leaf of state.projection.activeLeaves) {
		const node = nodeAt(state.ast, leaf);
		if (node?.kind !== "map" || lastSegmentKey(leaf) !== undefined) {
			continue;
		}
		const over = resolveRef(state, node.over, leaf);
		const instances = Array.isArray(over) ? Object.fromEntries(over.map((item, index) => [String(index), item])) : over;
		if (typeof instances !== "object" || instances === null) {
			throw new Error(`Map ${leaf}: 'over' must resolve to a record or an array, got ${typeof over}`);
		}
		for (const key of canonicalMapKeys(instances)) {
			if (!/^[A-Za-z0-9_-]+$/.test(key)) {
				throw new Error(`Map ${leaf}: instance key '${key}' must match [A-Za-z0-9_-]+`);
			}
		}
		appends.push({
			kind: "append",
			id: `spawn:${leaf}`,
			records: [{ type: "spawned", path: leaf, instances: instances as Record<string, unknown> }],
		});
	}
	return appends;
}

function ownerOccurrencesForActor(
	state: MachineState,
	declaration: ActorEndpointDeclarationAst,
): Array<StatePath | undefined> {
	if (declaration.owner === undefined) {
		return [undefined];
	}
	const ownerNode = nodeAt(state.ast, declaration.owner);
	if (ownerNode?.kind === "map") {
		const occurrences: StatePath[] = [];
		for (const [mapPath, instances] of Object.entries(state.projection.spawns)) {
			if (templatePath(mapPath) !== declaration.owner) {
				continue;
			}
			for (const key of canonicalMapKeys(instances)) {
				const occurrence = `${mapPath}#${key}`;
				if (state.projection.activeLeaves.some((leaf) => underScope(leaf, occurrence))) {
					occurrences.push(occurrence);
				}
			}
		}
		return occurrences;
	}
	const occurrences = new Set<StatePath>();
	for (const leaf of state.projection.activeLeaves) {
		const concrete = instancePathFor(declaration.owner, leaf);
		if (underScope(leaf, concrete)) {
			occurrences.add(concrete);
		}
	}
	return [...occurrences];
}

function dueActorCreates(state: MachineState): ActorCreateEffect[] {
	const effects: ActorCreateEffect[] = [];
	for (const declaration of Object.values(state.ast.actors)) {
		for (const owner of ownerOccurrencesForActor(state, declaration)) {
			const logicalOccurrence = actorOccurrencePath(declaration, owner);
			const generations = projectedActorEndpoints(state.projection)
				.filter((actor) => actor.logicalOccurrence === logicalOccurrence)
				.sort((left, right) => right.generation - left.generation);
			const latest = generations[0];
			if (
				latest !== undefined &&
				(declaration.owner === undefined || latest.status !== "stopped" || actorOwnerIsClosing(state, latest))
			) {
				continue;
			}
			const generation = (latest?.generation ?? 0) + 1;
			const occurrence = actorGenerationPath(logicalOccurrence, generation);
			const scope = owner ?? state.projection.activeLeaves[0] ?? state.ast.initial;
			effects.push({
				kind: "actor_create",
				id: `actor:create:${occurrence}`,
				declaration,
				occurrence,
				generation,
				...(owner === undefined ? {} : { owner }),
				input: resolveValueAst(state, declaration.inputValue, scope),
			});
		}
	}
	return effects;
}

type MessagingNode = Extract<
	ActorWorkflowStateAst | import("./types.js").StateAst,
	{ kind: "send" | "sendBatch" | "call" | "callBatch" }
>;

function messagingStates(state: MachineState): Array<{ path: StatePath; node: MessagingNode }> {
	const states: Array<{ path: StatePath; node: MessagingNode }> = [];
	for (const leaf of state.projection.activeLeaves) {
		const node = nodeAt(state.ast, leaf);
		if (node?.kind === "send" || node?.kind === "sendBatch" || node?.kind === "call" || node?.kind === "callBatch") {
			states.push({ path: leaf, node });
		}
	}
	for (const actor of executableActorInstances(state)) {
		if (actor.status === "stopped" || actor.status === "failed" || actor.status === "cancelled") {
			continue;
		}
		const node = actor.definition.states[actor.currentState];
		if (node?.kind === "send" || node?.kind === "sendBatch" || node?.kind === "call" || node?.kind === "callBatch") {
			states.push({ path: actorStatePath(actor.occurrence, actor.currentState), node });
		}
	}
	return states;
}

function targetActorForProducer(
	state: MachineState,
	declaration: StatePath,
	producerState: StatePath,
): ProjectedActorEndpointOccurrence | undefined {
	const logicalOccurrence = instancePathFor(declaration, producerState);
	return projectedActorEndpoints(state.projection)
		.filter(
			(actor) =>
				actor.logicalOccurrence === logicalOccurrence &&
				actor.status !== "stopped" &&
				actor.status !== "failed" &&
				actor.status !== "cancelled",
		)
		.sort((left, right) => right.generation - left.generation)[0];
}

function producerMayUseClosingActor(state: MachineState, producerState: StatePath): boolean {
	const context = actorContextForState(state.ast, producerState);
	if (context === undefined) {
		return false;
	}
	const endpoint = projectedActorEndpoint(state.projection, context.endpointOccurrence);
	if (endpoint === undefined) {
		return false;
	}
	if (context.workerIndex !== undefined && endpoint.definition.kind === "actorPool") {
		return (endpoint as ProjectedActorPoolOccurrence).workers[context.workerIndex]?.currentMessageId !== undefined;
	}
	return (endpoint as ProjectedActorOccurrence).currentMessageId !== undefined;
}

function dueActorAdmissionFailures(state: MachineState): RecordAppend[] {
	for (const { path, node } of messagingStates(state)) {
		const target = targetActorForProducer(state, node.to, path);
		if (
			target !== undefined &&
			(target.status === "closing" || target.status === "draining") &&
			!producerMayUseClosingActor(state, path)
		) {
			return [
				{
					kind: "append",
					id: `failure:closing-admission:${path}:${target.occurrence}`,
					records: [
						{
							type: "failure_intent",
							origin: path,
							error: `External ${node.kind} cannot target closing actor ${target.logicalOccurrence}`,
						},
					],
				},
			];
		}
	}
	return [];
}

function dueActorEnqueues(state: MachineState): ActorEnqueueEffect[] {
	const effects: ActorEnqueueEffect[] = [];
	for (const { path, node } of messagingStates(state)) {
		if (
			(node.kind === "call" || node.kind === "callBatch") &&
			Object.values(state.projection.pendingActorCalls).some((call) => call.callerState === path)
		) {
			continue;
		}
		const target = targetActorForProducer(state, node.to, path);
		if (target === undefined) {
			continue;
		}
		if ((target.status === "closing" || target.status === "draining") && !producerMayUseClosingActor(state, path)) {
			continue;
		}
		const contract = liveActorDeclaration(state, target).protocol[node.event];
		assert(contract !== undefined, `${node.kind} in ${path} names unknown protocol message ${node.event}`);
		const visit = (state.projection.actorProducerVisits[path] ?? 0) + 1;
		const batch = node.kind === "sendBatch" || node.kind === "callBatch";
		const values = batch ? resolveValueAst(state, node.inputs, path) : [resolveValueAst(state, node.input, path)];
		assert(Array.isArray(values), `${node.kind} in ${path} inputs must resolve to an array`);
		assert(values.length > 0, `${node.kind} in ${path} must contain at least one message`);
		assert(batch || values.length === 1, `${node.kind} in ${path} sends exactly one message`);
		if (node.kind === "callBatch") {
			assert(contract.reply.kind === "single", `callBatch() in ${path} requires a single-reply protocol message`);
		}
		const callId = node.kind === "call" || node.kind === "callBatch" ? `${path}:call:${visit}` : undefined;
		const messages = values.map(
			(input, batchIndex): ActorMessageEnvelope => ({
				messageId: `${path}:message:${visit}:${batchIndex}`,
				event: node.event,
				input,
				producerState: path,
				producerVisit: visit,
				...(callId === undefined ? {} : { callId }),
				batchIndex,
			}),
		);
		const source: ActorMessageSource = {
			producerState: path,
			kind: node.kind,
			definition: node,
			targetDeclaration: node.to,
			event: node.event,
			inputSchema: contract.input,
		};
		effects.push({
			kind: "actor_enqueue",
			id: `actor:enqueue:${path}:${visit}`,
			occurrence: target.occurrence,
			generation: target.generation,
			schema: contract.input,
			source,
			messages,
		});
	}
	return effects;
}

export type ActorAdmissionAssignment = Readonly<{
	occurrence: StatePath;
	messageId: string;
	receiveState: StatePath;
	workerIndex?: number;
}>;

export type ActorPoolAdmissionReservation = Readonly<{
	effectId: EffectId;
	messageId: string;
	workerIndex: number;
	receiveState: StatePath;
}>;

export type ActorAdmissionView = Readonly<{
	assignments: readonly ActorAdmissionAssignment[];
	failure?: { origin: StatePath; error: string; occurrence: StatePath; messageId: string };
}>;

type ActorAdmissionOptions = Readonly<{
	poolReservations?: ReadonlyMap<StatePath, readonly ActorPoolAdmissionReservation[]>;
	selectPoolWorker?: (eligible: readonly ProjectedActorPoolWorker[]) => ProjectedActorPoolWorker;
}>;

/** Shared FIFO admission view used by execution and hosts. Worker selection is a scheduler choice. */
export function actorEndpointAdmission(
	ast: ChartAst,
	projection: BranchProjection,
	options: ActorAdmissionOptions = {},
): ActorAdmissionView {
	const assignments: ActorAdmissionAssignment[] = [];
	for (const endpoint of projectedActorEndpoints(projection)) {
		if (
			endpoint.mailbox.length === 0 ||
			endpoint.status === "stopped" ||
			endpoint.status === "cancelled" ||
			endpoint.status === "failed"
		) {
			continue;
		}
		const definition = actorDefinitionForEndpoint(ast.actors[endpoint.declaration] ?? endpoint.definition);
		if (endpoint.definition.kind !== "actorPool") {
			const actor = endpoint as ProjectedActorOccurrence;
			if (actor.currentMessageId !== undefined) {
				continue;
			}
			const head = projectedActorMessage(projection, actor.mailbox[0]);
			const receive = definition.states[actor.currentState];
			if (head === undefined || receive?.kind !== "receive") {
				continue;
			}
			if (receive.on[head.event] === undefined) {
				return {
					assignments: [],
					failure: {
						origin: actorStatePath(actor.occurrence, actor.currentState),
						error: `FIFO head '${head.event}' is unsupported by receive '${actor.currentState}'`,
						occurrence: actor.occurrence,
						messageId: head.messageId,
					},
				};
			}
			assignments.push({
				occurrence: actor.occurrence,
				messageId: head.messageId,
				receiveState: actorStatePath(actor.occurrence, actor.currentState),
			});
			continue;
		}
		const pool = endpoint as ProjectedActorPoolOccurrence;
		const inFlight = options.poolReservations?.get(pool.occurrence) ?? [];
		const reservedWorkers = new Set(
			pool.workers.filter((worker) => worker.currentMessageId !== undefined).map((worker) => worker.index),
		);
		for (const reservation of inFlight) {
			reservedWorkers.add(reservation.workerIndex);
		}
		let mailboxIndex = 0;
		for (const reservation of inFlight) {
			const reservedMessage = projectedActorMessage(projection, pool.mailbox[mailboxIndex]);
			assert.equal(
				reservedMessage?.messageId,
				reservation.messageId,
				`Pool ${pool.occurrence} in-flight reservations must remain an ordered mailbox prefix`,
			);
			mailboxIndex++;
		}
		for (; mailboxIndex < pool.mailbox.length; mailboxIndex++) {
			const head = projectedActorMessage(projection, pool.mailbox[mailboxIndex]);
			if (head === undefined) {
				break;
			}
			const eligible = pool.workers.filter((candidate) => {
				if (
					reservedWorkers.has(candidate.index) ||
					candidate.status === "stopped" ||
					candidate.status === "failed" ||
					candidate.status === "cancelled"
				) {
					return false;
				}
				const receive = definition.states[candidate.currentState];
				return receive?.kind === "receive" && receive.on[head.event] !== undefined;
			});
			if (eligible.length === 0) {
				const anyBusy = pool.workers.some((candidate) => reservedWorkers.has(candidate.index));
				if (!anyBusy) {
					const states = pool.workers.map((candidate) => candidate.currentState).join(", ");
					return {
						assignments: [],
						failure: {
							origin: actorStatePath(
								pool.workers[0]?.occurrence ?? pool.occurrence,
								pool.workers[0]?.currentState ?? "",
							),
							error: `FIFO head '${head.event}' is unsupported by idle pool workers in receive states [${states}]`,
							occurrence: pool.occurrence,
							messageId: head.messageId,
						},
					};
				}
				break;
			}
			const worker = options.selectPoolWorker?.(eligible) ?? eligible[0]!;
			assert(eligible.includes(worker), `Pool ${pool.occurrence} scheduler selected an ineligible worker`);
			reservedWorkers.add(worker.index);
			assignments.push({
				occurrence: pool.occurrence,
				messageId: head.messageId,
				receiveState: actorStatePath(worker.occurrence, worker.currentState),
				workerIndex: worker.index,
			});
		}
	}
	return { assignments };
}

function dueActorAccepts(state: MachineState): RecordAppend[] {
	const admission = actorEndpointAdmission(state.ast, state.projection, {
		poolReservations: state.poolAdmissionReservations,
	});
	if (admission.failure !== undefined) {
		return [
			{
				kind: "append",
				id: `failure:unsupported-head:${admission.failure.occurrence}:${admission.failure.messageId}`,
				records: [{ type: "failure_intent", origin: admission.failure.origin, error: admission.failure.error }],
			},
		];
	}
	return admission.assignments.map((assignment) => ({
		kind: "append",
		id: `actor:accept:${assignment.occurrence}:${assignment.messageId}`,
		records: [
			{
				type: "actor_message",
				kind: "accepted",
				occurrence: assignment.occurrence,
				messageId: assignment.messageId,
				receiveState: assignment.receiveState,
				...(assignment.workerIndex === undefined ? {} : { workerIndex: assignment.workerIndex }),
			},
		],
	}));
}

function dueActorReplies(state: MachineState): ActorReplyEffect[] {
	const effects: ActorReplyEffect[] = [];
	for (const actor of executableActorInstances(state)) {
		const message = actor.currentMessage;
		const reply = actor.definition.states[actor.currentState];
		if (message === undefined || reply?.kind !== "reply" || message.status === "replied") {
			continue;
		}
		const contract = actor.definition.protocol[message.event]?.reply;
		assert(contract !== undefined, `Actor ${actor.occurrence} has no protocol contract for ${message.event}`);
		const schema =
			contract.kind === "single"
				? contract.schema
				: contract.kind === "named" && reply.event !== undefined
					? contract.schemas[reply.event]
					: undefined;
		const output =
			reply.output === undefined
				? undefined
				: resolveValueAst(state, reply.output, actorStatePath(actor.occurrence, actor.currentState));
		effects.push({
			kind: "actor_reply",
			id: `actor:reply:${actor.occurrence}:${message.messageId}`,
			occurrence: actor.endpoint.occurrence,
			messageId: message.messageId,
			message: message.event,
			...(actor.workerIndex === undefined ? {} : { workerIndex: actor.workerIndex }),
			...(message.callId === undefined ? {} : { callId: message.callId, callerState: message.producerState }),
			...(reply.event === undefined ? {} : { replyEvent: reply.event }),
			...(reply.output === undefined ? {} : { output }),
			...(schema === undefined ? {} : { schema }),
		});
	}
	return effects;
}

function liveActorDeclaration(
	state: MachineState,
	actor: ProjectedActorEndpointOccurrence,
): ActorEndpointDeclarationAst {
	const declaration = state.ast.actors[actor.declaration];
	assert(
		declaration !== undefined,
		`Actor ${actor.occurrence} declaration ${actor.declaration} is missing from the live chart`,
	);
	return declaration;
}

type ExecutableActorInstance = {
	endpoint: ProjectedActorEndpointOccurrence;
	occurrence: StatePath;
	currentState: StatePath;
	currentMessage?: import("./projection.js").ProjectedActorMessage;
	status: "idle" | "busy" | "draining" | "stopped" | "failed" | "cancelled";
	definition: ReturnType<typeof actorDefinitionForEndpoint>;
	workerIndex?: number;
};

function executableActorInstances(state: MachineState): ExecutableActorInstance[] {
	return projectedActorEndpoints(state.projection).flatMap((endpoint): ExecutableActorInstance[] => {
		const live = liveActorDeclaration(state, endpoint);
		const definition = actorDefinitionForEndpoint(live);
		if (endpoint.definition.kind !== "actorPool") {
			const actor = endpoint as ProjectedActorOccurrence;
			const currentMessage = projectedActorCurrentMessage(state.projection, actor);
			return [
				{
					endpoint,
					occurrence: actor.occurrence,
					currentState: actor.currentState,
					...(currentMessage === undefined ? {} : { currentMessage }),
					status: actor.status === "closing" ? "draining" : actor.status,
					definition,
				},
			];
		}
		const pool = endpoint as ProjectedActorPoolOccurrence;
		return pool.workers.map((worker) => {
			const currentMessage = projectedActorCurrentMessage(state.projection, pool, worker);
			return {
				endpoint,
				occurrence: worker.occurrence,
				currentState: worker.currentState,
				...(currentMessage === undefined ? {} : { currentMessage }),
				status: worker.status,
				definition,
				workerIndex: worker.index,
			};
		});
	});
}

function actorOwnerIsClosing(state: MachineState, actor: ProjectedActorEndpointOccurrence): boolean {
	if (actor.owner === undefined) {
		return state.projection.activeLeaves.some((leaf) => {
			const node = nodeAt(state.ast, leaf);
			return node?.kind === "final" && node.parent === undefined;
		});
	}
	const ownerNode = nodeAt(state.ast, actor.owner);
	const leaves = state.projection.activeLeaves.filter((leaf) => underScope(leaf, actor.owner as string));
	if (ownerNode?.kind === "map" && leaves.length > 0) {
		return leaves.every((leaf) => nodeAt(state.ast, leaf)?.kind === "final");
	}
	return leaves.length === 0 || leaves.every((leaf) => nodeAt(state.ast, leaf)?.kind === "final");
}

function dueActorScopeFacts(state: MachineState): RecordAppend[] {
	const appends: RecordAppend[] = [];
	const enqueueTargets = new Set(dueActorEnqueues(state).map((effect) => effect.occurrence));
	for (const actor of projectedActorEndpoints(state.projection)) {
		if (
			(actor.status === "idle" || actor.status === "busy") &&
			actorOwnerIsClosing(state, actor) &&
			!enqueueTargets.has(actor.occurrence)
		) {
			appends.push({
				kind: "append",
				id: `actor:closing:${actor.occurrence}`,
				records: [{ type: "actor_scope", kind: "closing", occurrence: actor.occurrence }],
			});
			continue;
		}
		const quiescent =
			actor.definition.kind === "actorPool"
				? (actor as ProjectedActorPoolOccurrence).workers.every((worker) => worker.currentMessageId === undefined)
				: (actor as ProjectedActorOccurrence).currentMessageId === undefined;
		if ((actor.status === "closing" || actor.status === "draining") && quiescent && actor.mailbox.length === 0) {
			appends.push({
				kind: "append",
				id: `actor:stopped:${actor.occurrence}`,
				records: [{ type: "actor_scope", kind: "stopped", occurrence: actor.occurrence }],
			});
		}
	}
	return appends;
}

function actorsTerminalForRun(state: MachineState): boolean {
	const rootDeclarations = Object.values(state.ast.actors).filter((actor) => actor.owner === undefined);
	const endpoints = projectedActorEndpoints(state.projection);
	if (
		rootDeclarations.some(
			(declaration) => !endpoints.some((actor) => actor.declaration === declaration.path && actor.status === "stopped"),
		)
	) {
		return false;
	}
	return endpoints.every((actor) => actor.status === "stopped");
}

function resolveValueAst(
	state: MachineState,
	value: ValueAst,
	stateId: StatePath,
	acceptedEvent?: ChartEvent,
): unknown {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((entry) => resolveValueAst(state, entry, stateId, acceptedEvent));
	}
	if (isInputRef(value)) {
		if (
			acceptedEvent !== undefined &&
			value.kind === "result" &&
			(value.state === stateId || value.state === templatePath(stateId))
		) {
			if (!("output" in acceptedEvent) || acceptedEvent.output === undefined) {
				throw new Error(`Emit in state ${stateId}: result('${value.state}') has no accepted output`);
			}
			const selected = selectPath(acceptedEvent.output, value.path);
			if (selected === undefined) {
				throw new Error(`Emit in state ${stateId}: result('${value.state}') selector '${value.path}' is missing`);
			}
			return selected;
		}
		return resolveRef(state, value, stateId);
	}
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [key, resolveValueAst(state, entry, stateId, acceptedEvent)]),
	);
}

function selectPath(value: unknown, path: string | undefined): unknown {
	if (path === undefined || path.length === 0) {
		return value;
	}
	let current = value;
	for (const segment of path.split(".")) {
		if (typeof current !== "object" || current === null || !(segment in current)) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function asJsonValue(value: unknown, context: string): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((entry, index) => asJsonValue(entry, `${context}[${index}]`));
	}
	if (typeof value === "object" && value !== null) {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new Error(`${context} must resolve to plain JSON data`);
		}
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, asJsonValue(entry, `${context}.${key}`)]),
		);
	}
	throw new Error(`${context} must resolve to JSON data`);
}

// Templates are rendered, never logged: the same args/results facts always render to the same
// text, so a restarted machine hands the agent an identical call. This is the effect boundary —
// the last moment the engine holds the value — so the parameter contract is enforced here: a ref
// into a missing arg/result and a non-primitive value without a json() mark both fail loud.
export function renderTemplate(state: MachineState, template: TemplateAst, stateId: string): string {
	const parts: string[] = [template.strings[0] ?? ""];
	template.refs.forEach((ref, index) => {
		parts.push(renderValue(resolveRef(state, ref, stateId), ref, stateId));
		parts.push(template.strings[index + 1] ?? "");
	});
	return parts.join("");
}

function renderValue(value: unknown, ref: InputRef, stateId: string): string {
	if (ref.json === true) {
		const text = JSON.stringify(value);
		if (text === undefined) {
			throw new Error(`Template in state ${stateId}: ${refLabel(ref)} is not JSON-serializable`);
		}
		return text;
	}
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	throw new Error(
		`Template in state ${stateId}: ${refLabel(ref)} resolved to a non-primitive value; wrap the ref in json() to embed it as JSON`,
	);
}

function renderArtifact(state: MachineState, declared: ArtifactAst, stateId: string): RenderedArtifact {
	return {
		path: renderTemplate(state, declared.path, stateId),
		...(declared.shape === undefined ? {} : { shape: declared.shape }),
	};
}

// An artifactOf read resolves to the producer's declared artifact — rendered from the same facts, so
// path and shape can never drift from what the producer was told to write. Normalize guarantees
// the reference resolves to exactly one artifact; a miss here means the chart changed under a
// live log — fail loud.
export function renderRead(
	state: MachineState,
	read: TemplateAst | ArtifactOfAst,
	stateId: string,
	selfActionArtifactsState?: StatePath,
): RenderedArtifact {
	if (read.kind === "template") {
		return { path: renderTemplate(state, read, stateId) };
	}
	const actor = actorContextForState(state.ast, stateId);
	const producerState =
		actor === undefined ? instancePathFor(read.state, stateId) : actorStatePath(actor.occurrence, read.state);
	const producer = actionStateAtMachine(state.ast, producerState);
	const artifacts =
		producer === undefined
			? undefined
			: producerState === selfActionArtifactsState && "artifacts" in producer.action
				? producer.action.artifacts
				: declaredArtifactsForState(producer);
	const names = Object.keys(artifacts ?? {});
	const name = read.artifact ?? (names.length === 1 ? names[0] : undefined);
	const declared = name === undefined ? undefined : artifacts?.[name];
	if (declared === undefined) {
		throw new Error(`Read in state ${stateId}: cannot resolve artifact '${read.artifact ?? "*"}' of ${read.state}`);
	}
	const rendered = renderArtifact(state, declared, producerState);
	// A validator reading its own output needs provisional bytes, not a stale accepted pin.
	const pin = producerState === selfActionArtifactsState ? undefined : state.projection.artifactPins[rendered.path];
	if (actor === undefined && actorContextForState(state.ast, producerState) !== undefined && pin === undefined) {
		throw new Error(`Read in state ${stateId}: actor artifact '${rendered.path}' has no accepted durable pin`);
	}
	return {
		...rendered,
		...(name === undefined ? {} : { name }),
		sourceState: producerState,
		...(read.select === undefined ? {} : { select: read.select }),
		...(pin === undefined ? {} : { pin }),
	};
}

// A fan-in read over a map: one artifact per spawned instance, in spawn-fact key order. The
// producer's declared path renders in each instance's scope — key()/item() and result() refs in
// it resolve exactly as they did for the producer itself.
export function renderJoin(state: MachineState, read: JoinArtifactOfAst, stateId: string): RenderedArtifact[] {
	const container = enclosingMapPath(state.ast, read.state, stateId);
	// A top-level map has one shared spawn fact. A nested map has one spawn fact per enclosing
	// parent instance (for example `chapters#intro.visuals`). Re-scope the template container to
	// the caller, then strip the joined map's own instance key: a join inside `items#a.check` still
	// fans in all `items`, while a join inside `chapters#intro` fans in only that chapter's nested
	// `visuals` instances.
	const mapPath = stripLastKey(instancePathFor(container, stateId));
	const instances = state.projection.spawns[mapPath];
	if (instances === undefined) {
		throw new Error(`Read in state ${stateId}: map ${mapPath} has no spawned instances`);
	}
	const single: ArtifactOfAst = {
		kind: "artifactOf",
		state: read.state,
		...(read.artifact === undefined ? {} : { artifact: read.artifact }),
	};
	return canonicalMapKeys(instances).map((key) => ({
		...renderRead(state, single, `${mapPath}#${key}${read.state.slice(container.length)}`),
		readKind: "join" as const,
	}));
}

function renderResultJoin(state: MachineState, read: JoinResultOfAst, stateId: string): unknown[] {
	const container = enclosingMapPath(state.ast, read.state, stateId);
	const mapPath = stripLastKey(instancePathFor(container, stateId));
	const instances = state.projection.spawns[mapPath];
	if (instances === undefined) {
		throw new Error(`Read in state ${stateId}: map ${mapPath} has no spawned instances`);
	}
	const single: InputRef = {
		kind: "result",
		state: read.state,
		...(read.path === undefined ? {} : { path: read.path }),
	};
	return canonicalMapKeys(instances).map((key) =>
		resolveRef(state, single, `${mapPath}#${key}${read.state.slice(container.length)}`),
	);
}

// The innermost map the producer's template path sits in — the container whose instances the
// fan-in expands over. Normalize guarantees one exists; a miss means the chart changed under a
// live log.
function enclosingMapPath(ast: ChartAst, producer: StatePath, stateId: string): StatePath {
	let path = parentPath(producer);
	while (path !== undefined) {
		if (nodeAt(ast, path)?.kind === "map") {
			return path;
		}
		path = parentPath(path);
	}
	throw new Error(`Read in state ${stateId}: joinArtifactOf('${producer}') is not inside a map`);
}

function refLabel(ref: InputRef): string {
	switch (ref.kind) {
		case "arg":
			return `arg '${ref.name}'`;
		case "result":
			return `result of '${ref.state}'${ref.path === undefined ? "" : ` at '${ref.path}'`}`;
		case "key":
			return `map key${ref.map === undefined ? "" : ` of '${ref.map}'`}`;
		case "item":
			return `map item${ref.map === undefined ? "" : ` of '${ref.map}'`}${ref.path === undefined ? "" : ` at '${ref.path}'`}`;
		case "input":
			return `input '${ref.name}'${ref.path === undefined ? "" : ` at '${ref.path}'`}`;
		case "visit":
			return `visit${ref.state === undefined ? "" : ` of '${ref.state}'`}`;
		case "actorInput":
			return `actor input${ref.path === undefined ? "" : ` at '${ref.path}'`}`;
		case "messageInput":
			return `message '${ref.message}' input${ref.path === undefined ? "" : ` at '${ref.path}'`}`;
	}
}

function resolvedStateInput(
	state: Pick<MachineState, "ast" | "projection">,
	actionUid: ActionUID,
): { input?: Readonly<Record<string, JsonValue>> } {
	const node = actionStateAtMachine(state.ast, actionUid.state);
	assert(node !== undefined, `Cannot resolve input for non-action state ${actionUid.state}`);
	if (node.input === undefined) {
		return {};
	}
	const input = state.projection.inputs[actionUid.state];
	assert(input !== undefined, `State ${actionUid.state} has no resolved input`);
	return { input: structuredClone(input) as Readonly<Record<string, JsonValue>> };
}

function invokeAppend(state: MachineState, actionUid: ActionUID): RecordAppend {
	const node = actionStateAtMachine(state.ast, actionUid.state);
	assert(node !== undefined, `Cannot invoke non-action state ${actionUid.state}`);
	return {
		kind: "append",
		id: `invoke:${actionUidKey(actionUid)}`,
		records: [
			{
				type: "state_action",
				kind: "invoke",
				actionUid,
				sessionId: randomUUID(),
				...resolvedStateInput(state, actionUid),
				definition: node.action,
			},
		],
	};
}

function hasActionTransition(ast: ChartAst, statePath: StatePath, event: string): boolean {
	const actor = actorContextForState(ast, statePath)?.node;
	return actor?.kind === "state" ? actor.transitions[event] !== undefined : hasTransition(ast, statePath, event);
}

function actionStateAtMachine(ast: ChartAst, statePath: StatePath): ActionStateAst | undefined {
	const main = nodeAt(ast, statePath);
	if (main?.kind === "state") {
		return main;
	}
	const actor = actorContextForState(ast, statePath)?.node;
	return actor?.kind === "state" ? actor : undefined;
}

function removePoolAdmissionReservations(state: MachineState, effectId: EffectId): void {
	for (const [occurrence, reservations] of state.poolAdmissionReservations) {
		const remaining = reservations.filter((reservation) => reservation.effectId !== effectId);
		if (remaining.length === 0) {
			state.poolAdmissionReservations.delete(occurrence);
		} else if (remaining.length !== reservations.length) {
			state.poolAdmissionReservations.set(occurrence, remaining);
		}
	}
}

/** Restoring durable facts does not imply that their unfinished work can run on this chart. */
function pendingValidationExecutionError(ast: ChartAst, projection: BranchProjection): string | undefined {
	// Failure cleanup must still cancel outstanding work, even if its validator is gone.
	if (projection.failure !== undefined) {
		return undefined;
	}

	for (const pending of projection.pendingActions) {
		if (pending.phase === "running") {
			continue;
		}
		const statePath = pending.actionUid.state;
		const currentState = actionStateAtMachine(ast, statePath);
		if (currentState?.action.kind === "agent" && currentState.action.validation !== undefined) {
			continue;
		}
		return (
			`Cannot resume state ${statePath} (invoke seqId ${pending.invokeSeqId}): historical agent validator was removed; ` +
			"restore it or rewind before the invocation."
		);
	}

	return undefined;
}

export function createMachine(ast: ChartAst, projection: BranchProjection): MachineState {
	return {
		ast,
		projection,
		dispatched: new Set(),
		poolAdmissionReservations: new Map(),
	};
}
