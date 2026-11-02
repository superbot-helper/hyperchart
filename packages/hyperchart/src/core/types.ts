import type { z, ZodType } from "zod";
import type { RuntimeContractMetadata } from "./schema_contract.js";
import type { SchemaRegistry } from "./schema_registry.js";

export type { RuntimeContractMetadata } from "./schema_contract.js";

export type StateId = string;
export type ActionUID = Readonly<{
	chart: string;
	state: StateId;
	action: string;
}>;
export type EventType = string;
export type ReservedSystemEventType = "FAILED";
export type JsonSchema = Record<string, unknown>;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Serializable launch metadata and an optional runtime contract for one run argument. */
export type ChartArgumentCst = {
	/** Human-readable guidance for launch UIs. */
	description?: string;
	/** Zod contract used for type metadata and default validation during normalization. */
	schema?: SchemaCst;
	/** Launch value used when the run omits this argument; hosts may let the user edit it. */
	default?: JsonValue;
};

export type ChartArgumentAst = Readonly<{
	description?: string;
	schema?: SchemaAst;
	default?: JsonValue;
}>;

export type ChartSource = {
	path?: string;
	exportName?: string;
	line?: number;
	column?: number;
};

export type AuthoringDiagnostic = {
	code: string;
	message: string;
	path?: string;
	source?: ChartSource;
};

// Shapes are authored as zod values, and only as zod values — one source for the TS type
// (z.infer), the agent-facing description and the runtime validation. Normalize converts the
// value to plain JSON Schema for the AST, so the chart-as-data doctrine holds where it matters
// (AST, log, hashes) while a zod instance never enters serialized data.
export type SchemaCst = ZodType;

/** A protocol message always has one input contract and exactly one reply shape. */
export type ProtocolMessageCst =
	| { input: SchemaCst; reply?: never; replies?: never }
	| { input: SchemaCst; reply: SchemaCst; replies?: never }
	| { input: SchemaCst; reply?: never; replies: Record<string, SchemaCst> };

export type ProtocolCst = Readonly<Record<string, ProtocolMessageCst>>;

// Actor DSL type-level inference and graph verification live with the rest of the
// public CST/AST types. dsl.ts remains the runtime constructor surface.
export type InferSchema<S> = S extends z.ZodType ? z.infer<S> : unknown;
export type MessageTypes<P extends ProtocolCst> = keyof P & string;
export type MessageInput<P extends ProtocolCst, M extends keyof P> = P[M] extends { input: infer S }
	? InferSchema<S>
	: never;
export type ReplyEvents<P extends ProtocolCst, M extends keyof P> = P[M] extends {
	replies: infer R extends Record<string, SchemaCst>;
}
	? keyof R & string
	: never;
export type ReplyOutput<P extends ProtocolCst, M extends keyof P, R extends string = ReplyEvents<P, M>> = P[M] extends {
	replies: infer Replies extends Record<string, SchemaCst>;
}
	? R extends keyof Replies
		? InferSchema<Replies[R]>
		: never
	: P[M] extends { reply: infer S }
		? InferSchema<S>
		: undefined;
export type ReplyUnion<P extends ProtocolCst, M extends keyof P> = P[M] extends {
	replies: infer Replies extends Record<string, SchemaCst>;
}
	? { [R in keyof Replies]: InferSchema<Replies[R]> }[keyof Replies]
	: P[M] extends { reply: infer S }
		? InferSchema<S>
		: undefined;

export type ActorPlacement<T> = T extends string | number | boolean | null
	? T | InputRef<T>
	: T extends readonly (infer E)[]
		? readonly ActorPlacement<E>[] | InputRef<T>
		: T extends object
			? { [K in keyof T]: ActorPlacement<T[K]> } | InputRef<T>
			: ValueExpr<T>;

export type ActorTemplate<P extends ProtocolCst, I, Brand> = {
	(input: ActorPlacement<I>): StaticActorDeclaration<P, I, Brand>;
	readonly definition: ActorDefinitionCst;
};

export type ActorPoolTemplate<P extends ProtocolCst, I, Brand> = {
	(input: ActorPlacement<I>): StaticActorPoolDeclaration<P, I, Brand>;
	readonly definition: ActorPoolDefinitionCst;
};

type ActorPath<T> = T extends readonly unknown[]
	? never
	: T extends object
		? { [K in keyof T & string]: K | `${K}.${ActorPath<NonNullable<T[K]>>}` }[keyof T & string]
		: never;
type ActorValueAt<T, Path extends string> = Path extends `${infer Head}.${infer Tail}`
	? Head extends keyof T
		? ActorValueAt<NonNullable<T[Head]>, Tail>
		: never
	: Path extends keyof T
		? T[Path]
		: never;
type RefSelected<T, Path> = Path extends string ? ActorValueAt<T, Path> : T;

export type ActorInputRefMarker<Path extends string | undefined> = { readonly __actorInputPath: Path };
export type ActorMessageInputRefMarker<Message extends string, Path extends string | undefined> = {
	readonly __actorMessage: Message;
	readonly __actorMessagePath: Path;
};
export type ActorResultRefMarker<State extends string, Path extends string | undefined> = {
	readonly __actorResultState: State;
	readonly __actorResultPath: Path;
};
export type ActorStateInputRefMarker<Name extends string, Path extends string | undefined> = {
	readonly __actorStateInput: Name;
	readonly __actorStateInputPath: Path;
};
export type ActorArtifactRefMarker<
	State extends string,
	Artifact extends string | undefined,
	Select extends string | undefined,
> = {
	readonly __actorArtifactState: State;
	readonly __actorArtifactName: Artifact;
	readonly __actorArtifactSelect: Select;
};

/** Authoring-only symbolic capability resolved to the current actor endpoint at placement normalization. */
export type ActorSelfTarget = Readonly<{ kind: "actorSelf" }>;

declare const actorForwardRefBrand: unique symbol;

/**
 * Typed authoring-only forward reference to a statically bound actor name. `refs().chart()` owns
 * the binding identity; normalization resolves this marker to one concrete lexical declaration
 * path before the serializable AST is produced. The private brand prevents structural string
 * targets from bypassing actorRef().
 */
export type ActorForwardRef<P extends ProtocolCst = ProtocolCst, Name extends string = string> = Readonly<{
	kind: "actorRef";
	name: Name;
	[actorForwardRefBrand]: { protocol: P; name: Name };
}>;

export type CompletionContract<Event extends string = string, Payload = unknown> = Readonly<{
	event: Event;
	payload: Payload;
}>;

declare const completionForwardRefBrand: unique symbol;

/** Typed authoring-only reference to one chart-owned, one-shot completion endpoint. */
export type CompletionForwardRef<
	C extends CompletionContract = CompletionContract,
	Name extends string = string,
> = Readonly<{
	kind: "completionRef";
	name: Name;
	[completionForwardRefBrand]: { contract: C; name: Name };
}>;

export type AnyCompletionTarget = CompletionForwardRef<CompletionContract, string>;

export type CompletionOf<D> = D extends CompletionForwardRef<infer C, string> ? C : never;

export type CompletionDeclarationCst<S extends SchemaCst = SchemaCst, Event extends string = string> = Readonly<{
	kind: "completion";
	event: Event;
	schema: S;
	readonly __payload?: InferSchema<S>;
}>;

type StateSuccessors<Node> = Node extends { kind: "state"; transitions: infer T; after?: infer A }
	?
			| (T extends Record<string, infer V>
					? V extends string
						? V
						: V extends { target: infer Target extends string }
							? Target
							: never
					: never)
			| (A extends { target: infer Target extends string } ? Target : never)
	: Node extends { kind: "send" | "sendBatch"; target: infer Target extends string }
		? Target
		: Node extends { kind: "call" | "callBatch"; target: infer Target extends string }
			? Target
			: Node extends { kind: "call"; transitions: infer T }
				? T extends Record<string, infer V>
					? V extends string
						? V
						: V extends { target: infer Target extends string }
							? Target
							: never
					: never
				: never;

type Reaches<S, Current extends string, Goal extends string, Seen extends string = never> = Current extends Goal
	? true
	: Current extends Seen
		? false
		: Current extends keyof S
			? StateSuccessors<S[Current]> extends infer Next
				? Next extends string
					? Reaches<S, Next, Goal, Seen | Current>
					: false
				: false
			: false;
type ReceiveTargets<S, Message extends string> = {
	[K in keyof S & string]: S[K] extends { kind: "receive"; on: infer On }
		? Message extends keyof On
			? On[Message] & string
			: never
		: never;
}[keyof S & string];
type MessageReaches<S, Message extends string, Goal extends string> =
	true extends Reaches<S, ReceiveTargets<S, Message>, Goal> ? true : false;
type MessagesAt<P extends ProtocolCst, S, Goal extends string> = {
	[M in keyof P & string]: MessageReaches<S, M, Goal> extends true ? M : never;
}[keyof P & string];
type IsUnion<T, Whole = T> = T extends unknown ? ([Whole] extends [T] ? false : true) : never;
type SingleMessage<T> = [T] extends [never] ? never : true extends IsUnion<T> ? never : T;

type ActionReplyFor<S, State extends string> = State extends keyof S
	? S[State] extends { action: { reply: infer Reply } }
		? InferSchema<Reply>
		: S[State] extends { kind: "callBatch"; __result?: infer Reply }
			? Reply
			: never
	: never;
type ActionInputFor<S, State extends string, Name extends string> = State extends keyof S
	? S[State] extends { input: infer Inputs }
		? Name extends keyof Inputs
			? InferSchema<Inputs[Name]>
			: never
		: never
	: never;
type ArtifactFor<S, State extends string, Name extends string | undefined> = State extends keyof S
	? S[State] extends { action: { artifacts: infer Artifacts } }
		? Name extends keyof Artifacts
			? Artifacts[Name] extends { shape: infer Shape }
				? InferSchema<Shape>
				: unknown
			: Name extends undefined
				? Artifacts[keyof Artifacts] extends { shape: infer Shape }
					? InferSchema<Shape>
					: unknown
				: never
		: never
	: never;

type ResolveActorValue<Value, P extends ProtocolCst, I, S> =
	Value extends ActorInputRefMarker<infer Path>
		? RefSelected<I, Path>
		: Value extends ActorMessageInputRefMarker<infer Message, infer Path>
			? Message extends keyof P
				? RefSelected<MessageInput<P, Message>, Path>
				: never
			: Value extends ActorResultRefMarker<infer State, infer Path>
				? RefSelected<ActionReplyFor<S, State>, Path>
				: Value extends ActorStateInputRefMarker<infer Name, infer Path>
					? Value
					: Value extends InputRef<infer Resolved>
						? Resolved
						: Value extends readonly unknown[]
							? { [K in keyof Value]: ResolveActorValue<Value[K], P, I, S> }
							: Value extends object
								? { [K in keyof Value as K extends `__${string}` ? never : K]: ResolveActorValue<Value[K], P, I, S> }
								: Value;
type SameShape<Actual, Expected> = [Actual] extends [never] ? false : [Actual] extends [Expected] ? true : false;

type SelfSendNodeValid<Node, P extends ProtocolCst, I, S> = Node extends { to: ActorSelfTarget }
	? Node extends { kind: "send"; event: infer Event; input: infer Input }
		? Event extends keyof P
			? SameShape<ResolveActorValue<Input, P, I, S>, MessageInput<P, Event>>
			: false
		: Node extends { kind: "sendBatch"; event: infer Event; inputs: infer Inputs }
			? Event extends keyof P
				? ResolveActorValue<Inputs, P, I, S> extends infer Resolved
					? Resolved extends readonly unknown[]
						? SameShape<Resolved[number], MessageInput<P, Event>>
						: false
					: false
				: false
			: false
	: true;

type ReplyIsValid<Node, Contract, P extends ProtocolCst, I, S> = Contract extends {
	input: unknown;
	replies: infer Replies extends Record<string, SchemaCst>;
}
	? Node extends { event: infer Event extends keyof Replies; output: infer Output }
		? SameShape<ResolveActorValue<Output, P, I, S>, InferSchema<Replies[Event]>>
		: false
	: Contract extends { input: unknown; reply: infer Reply }
		? "event" extends keyof Node
			? false
			: Node extends { output: infer Output }
				? SameShape<ResolveActorValue<Output, P, I, S>, InferSchema<Reply>>
				: false
		: "event" extends keyof Node
			? false
			: "output" extends keyof Node
				? false
				: true;
type ReplyNodeValid<P extends ProtocolCst, I, S, Id extends keyof S & string> = S[Id] extends { kind: "reply" }
	? [SingleMessage<MessagesAt<P, S, Id>>] extends [never]
		? false
		: SingleMessage<MessagesAt<P, S, Id>> extends infer Message
			? Message extends keyof P
				? ReplyIsValid<S[Id], P[Message], P, I, S>
				: false
			: false
	: true;
type AllPathsReachReply<S, Current, Seen extends string = never> = [Current] extends [never]
	? false
	: false extends (
				Current extends string
					? Current extends Seen
						? false
						: Current extends keyof S
							? S[Current] extends { kind: "reply" }
								? true
								: AllPathsReachReply<S, StateSuccessors<S[Current]>, Seen | Current>
							: false
					: false
			)
		? false
		: true;
type MessageAllPathsReply<S, Message extends string> = AllPathsReachReply<S, ReceiveTargets<S, Message>>;
type ReceiveNodeValid<P extends ProtocolCst, S, Id extends keyof S & string> = S[Id] extends {
	kind: "receive";
	on: infer On;
}
	? Exclude<keyof On, keyof P> extends never
		? false extends { [Message in keyof On & string]: MessageAllPathsReply<S, Message> }[keyof On & string]
			? false
			: true
		: false
	: true;
type PathValid<Value, Path> = Path extends undefined ? true : Path extends ActorPath<Value> ? true : false;
type SelectorValid<Value, P extends ProtocolCst, I, S, Id extends keyof S & string> =
	Value extends ActorInputRefMarker<infer Path>
		? PathValid<I, Path>
		: Value extends ActorMessageInputRefMarker<infer Message, infer Path>
			? Message extends keyof P
				? Message extends MessagesAt<P, S, Id>
					? PathValid<MessageInput<P, Message>, Path>
					: false
				: false
			: Value extends ActorResultRefMarker<infer State, infer Path>
				? ActionReplyFor<S, State> extends never
					? false
					: PathValid<ActionReplyFor<S, State>, Path>
				: Value extends ActorStateInputRefMarker<infer Name, infer Path>
					? PathValid<ActionInputFor<S, Id, Name>, Path>
					: Value extends ActorArtifactRefMarker<infer State, infer Name, infer Select>
						? ArtifactFor<S, State, Name> extends never
							? false
							: PathValid<ArtifactFor<S, State, Name>, Select>
						: Value extends readonly unknown[]
							? false extends { [K in keyof Value]: SelectorValid<Value[K], P, I, S, Id> }[number]
								? false
								: true
							: Value extends InputRef
								? true
								: Value extends object
									? false extends { [K in keyof Value]: SelectorValid<Value[K], P, I, S, Id> }[keyof Value]
										? false
										: true
									: true;
type TemplateValues<Value> = Value extends { readonly __actorRefs?: infer Refs } ? Refs : never;
type ArtifactPathValues<Artifacts> =
	Artifacts extends Record<string, infer Artifact>
		? Artifact extends { path: infer Path }
			? TemplateValues<Path>
			: TemplateValues<Artifact>
		: never;
type ActionValues<Action> = Action extends { kind: "agent" }
	?
			| TemplateValues<Action extends { task: infer Task } ? Task : never>
			| (Action extends { reads: infer Reads } ? Reads : never)
			| ArtifactPathValues<Action extends { artifacts: infer Artifacts } ? Artifacts : never>
	: Action extends { kind: "script" | "tsImport" }
		?
				| (Action extends { env: infer Env } ? Env[keyof Env] : never)
				| ArtifactPathValues<Action extends { artifacts: infer Artifacts } ? Artifacts : never>
		: Action extends { kind: "user" }
			? TemplateValues<Action extends { prompt: infer Prompt } ? Prompt : never>
			: Action extends { kind: "gate" | "notify"; payload: infer Payload }
				? Payload
				: never;
type NodeValues<Node> = Node extends { kind: "reply"; output: infer Output }
	? Output
	: Node extends { kind: "send"; input: infer Input }
		? Input
		: Node extends { kind: "sendBatch"; inputs: infer Inputs }
			? Inputs
			: Node extends { kind: "call"; input: infer Input }
				? Input
				: Node extends { kind: "callBatch"; inputs: infer Inputs }
					? Inputs
					: Node extends { kind: "state"; action: infer Action; emit?: infer Emits }
						?
								| ActionValues<Action>
								| (Emits extends readonly (infer Emit)[]
										? Emit extends { payload: infer Payload }
											? Payload
											: never
										: never)
						: never;
type NodeSelectorsValid<P extends ProtocolCst, I, S, Id extends keyof S & string> = [NodeValues<S[Id]>] extends [never]
	? true
	: SelectorValid<NodeValues<S[Id]>, P, I, S, Id>;
type ReservedNodeValid<Node> = Node extends { transitions: infer Transitions }
	? "FAILED" extends keyof Transitions
		? false
		: true
	: true;
type ActorReplyGraphValid<P extends ProtocolCst, I, S> = false extends {
	[K in keyof S & string]: ReplyNodeValid<P, I, S, K> extends true
		? ReceiveNodeValid<P, S, K> extends true
			? ReservedNodeValid<S[K]>
			: false
		: false;
}[keyof S & string]
	? false
	: true;
type ActorSelectorsValid<P extends ProtocolCst, I, S> = false extends {
	[K in keyof S & string]: NodeSelectorsValid<P, I, S, K>;
}[keyof S & string]
	? false
	: true;
type ActorSelfSendsValid<P extends ProtocolCst, I, S> = false extends {
	[K in keyof S & string]: SelfSendNodeValid<S[K], P, I, S>;
}[keyof S & string]
	? false
	: true;
export type ActorVerification<
	I extends SchemaCst,
	P extends ProtocolCst,
	S,
	Initial extends string,
> = Initial extends keyof S
	? S[Initial] extends { kind: "receive" }
		? ActorReplyGraphValid<P, InferSchema<I>, S> extends true
			? ActorSelectorsValid<P, InferSchema<I>, S> extends true
				? ActorSelfSendsValid<P, InferSchema<I>, S> extends true
					? unknown
					: { readonly "self() send does not match the actor protocol": never }
				: { readonly "actor-local selector is invalid": never }
			: { readonly "actor protocol/reply graph is invalid": never }
		: { readonly "actor initial state must be receive()": never }
	: { readonly "actor initial state is unknown": never };

export type ProtocolOf<D> =
	D extends StaticActorDeclaration<infer P, unknown, unknown>
		? P
		: D extends StaticActorPoolDeclaration<infer P, unknown, unknown>
			? P
			: D extends ActorForwardRef<infer P, string>
				? P
				: never;

export type NonEmptyActorBatch<I> = readonly [ActorPlacement<I>, ...ActorPlacement<I>[]] | InputRef<readonly I[] | I[]>;

export type SingleReplyMessageTypes<P extends ProtocolCst> = {
	[M in keyof P & string]: P[M] extends { reply: SchemaCst } ? M : never;
}[keyof P & string];

export type CallRouting<P extends ProtocolCst, M extends keyof P, Target extends string = string> = P[M] extends {
	replies: infer R extends Record<string, SchemaCst>;
}
	? { target?: never; transitions: { [E in keyof R]: Target | TransitionCst } }
	: { target: Target; transitions?: never };

export type ProtocolMessageAst = Readonly<{
	input: SchemaAst;
	reply:
		| Readonly<{ kind: "void" }>
		| Readonly<{ kind: "single"; schema: SchemaAst }>
		| Readonly<{ kind: "named"; schemas: Readonly<Record<string, SchemaAst>> }>;
}>;

export type ProtocolAst = Readonly<Record<string, ProtocolMessageAst>>;

export type SchemaAst = Readonly<{
	kind: "jsonSchema";
	schema: Readonly<JsonSchema>;
	/** Stable identity for an exact runtime Zod contract. */
	runtimeContract?: RuntimeContractMetadata;
}>;

// A deliverable file the agent must produce: where to write and — optionally — what shape the
// CONTENT has (a zod value declared next to the chart). The runtime tells the agent
// to write this shape and may verify the written file; consumers reading via fileOf() inherit
// path and shape from here, so they cannot drift. Artifacts are NOT the step's result — the
// result is the completion event's payload (see `reply`).
export type ArtifactCst = {
	kind: "artifact";
	path: Templatable;
	shape?: SchemaCst;
};

// A read of another state's declared artifact, by producer rather than by path. `artifact` names
// which one (may be omitted when the producer declares exactly one). An optional dot-path
// selector narrows the read to a field of the file's content — the machine only carries it (it
// never touches disk); the runtime reads the file, validates it against the declared shape and
// hands the agent just the selected part.
export type ArtifactOfCst = {
	kind: "artifactOf";
	// Absolute path of the producing action state; it must declare artifacts.
	state: StatePath;
	artifact?: string;
	select?: string;
};

// A fan-in read: the artifact of EVERY instance of a map, addressed by the producer's template
// path inside it. In an agent's reads it expands to one file per spawned instance; in a script's
// env it renders to a JSON array of paths. Instance set comes from the spawned fact; keys use
// canonical numeric-then-lexicographic order so JSONB replay is stable.
export type JoinArtifactOfCst = {
	kind: "joinArtifactOf";
	state: StatePath;
	artifact?: string;
};

// A fan-in value read: the result of EVERY instance of a map, addressed by the
// producing action's template path. Script environments receive a JSON array in
// canonical numeric-then-lexicographic spawn-key order.
export type JoinResultOfCst = {
	kind: "joinResultOf";
	state: StatePath;
	path?: string;
};

// The per-invocation surface of a subagent, mirroring pi-subagents' chain step: `name` points at
// the definition (markdown file: identity, description, system prompt — not overridable);
// everything else parameterizes this call. The engine treats model/thinking/tools as opaque
// overrides of the definition's frontmatter.
export type RecoveryPolicyCst =
	| "fail"
	| Readonly<{
			/** Additional prompts delivered to the current persisted session. */
			nudge?: number;
			/** Fresh durable sessions created after the current session's nudges are exhausted. */
			restart?: number;
	  }>;

export type AgentValidationCst = Readonly<{
	guard: GuardRef;
	/** Overrides the agent-wide policy only when this guard rejects a completion. */
	onFail?: RecoveryPolicyCst;
}>;

export type AgentReentryCst = "restart" | Readonly<{ resume: Templatable }>;

export type AgentActionCst = {
	kind: "agent";
	name: string;
	// Task text (the user message; the definition's markdown body stays the system prompt).
	task?: Templatable;
	// Named deliverable files this call must produce — the runtime injects them into the task
	// ("[Write to: ...]") and may verify each (existence, and shape when declared). A plain
	// Templatable value is an artifact with just a path.
	artifacts?: Record<string, Templatable | ArtifactCst>;
	// Files the agent should read first: previous steps' artifacts via fileOf(), or raw paths.
	reads?: readonly (Templatable | ArtifactOfCst | JoinArtifactOfCst)[];
	model?: string;
	thinking?: string;
	tools?: readonly string[];
	// The step's RESULT: the shape of the completion event's payload. Small routing data only —
	// deliverables go through artifacts.
	reply?: SchemaCst;
	/** Overrides the chart recovery policy for this agent. */
	onFail?: RecoveryPolicyCst;
	/** Optional machine-owned acceptance guard for this agent's completion. */
	validation?: AgentValidationCst;
	/** Session behavior when the containing state is entered again. */
	reentry?: AgentReentryCst;
};

export type UserActionCst = {
	kind: "user";
	prompt: Templatable;
	options?: readonly string[];
	reply?: SchemaCst;
};

/** A journal-native host-resolved gate with a typed request payload. */
export type GateActionCst = {
	kind: "gate";
	event: string;
	payload: ValueExpr;
	reply?: SchemaCst;
};

export type WaitForActionCst<C extends CompletionContract = CompletionContract> = {
	kind: "waitFor";
	from: CompletionForwardRef<C, string>;
	event: C["event"];
	readonly __result?: C["payload"];
};

export type NotifyActionCst<C extends CompletionContract = CompletionContract> = {
	kind: "notify";
	to: CompletionForwardRef<C, string>;
	event: C["event"];
	payload: ValueExpr<C["payload"]>;
};

// A command step: the runtime executes the command and answers with a completion event, exactly
// like an agent — same artifact/reads channels, same reply shape for the parsed stdout. The
// command and args are static; parameters flow through env templates (the taskflow contract).
// The same shape doubles as a script GuardRef when used in a validate position.
export type ScriptActionCst = {
	kind: "script";
	command: string;
	args?: readonly string[];
	// All dynamic values flow through env: templates render from args/results, artifactOf renders
	// to the producer's artifact PATH — the process reads the file itself, no prompt channel.
	env?: Record<string, Templatable | ArtifactOfCst | JoinArtifactOfCst | JoinResultOfCst>;
	artifacts?: Record<string, Templatable | ArtifactCst>;
	reply?: SchemaCst;
};

// A trusted in-process imported function. Like script(), the definition is serializable and all
// dynamic parameters are declared through env; unlike a script, the function also receives the
// resolved state input and runtime paths in its invocation context.
export type ImportedActionCst = {
	kind: "tsImport";
	module: string;
	export: string;
	env?: Record<string, Templatable | ArtifactOfCst | JoinArtifactOfCst | JoinResultOfCst>;
	artifacts?: Record<string, Templatable | ArtifactCst>;
	reply?: SchemaCst;
};

export type StateActionCst =
	| AgentActionCst
	| UserActionCst
	| GateActionCst
	| WaitForActionCst
	| NotifyActionCst
	| ScriptActionCst
	| ImportedActionCst;

// Serializable reference to validation code. Inline closures are not allowed: the chart stays
// plain data. A validator is an acceptance check on the action's completion claim — it runs live
// exactly once, when the claim arrives; accepted facts are never re-validated on replay.
export type GuardRef =
	| {
			kind: "tsImport";
			module: string;
			export: string;
			// Imported guards run in process and support rendered inputs only.
			env?: Record<string, Templatable | ArtifactOfCst | JoinArtifactOfCst | JoinResultOfCst>;
	  }
	| {
			kind: "script";
			command: string;
			args?: readonly string[];
			// Guards share the script-option surface. Imported guards receive rendered
			// options in process rather than through environment variables and files.
			env?: Record<string, Templatable | ArtifactOfCst | JoinArtifactOfCst | JoinResultOfCst>;
			artifacts?: Record<string, Templatable | ArtifactCst>;
			reply?: SchemaCst;
	  };

/** Normalized, replayable guard definition (the runtime normalizer converts templates to AST values). */
export type GuardRefAst =
	| {
			kind: "tsImport";
			module: string;
			export: string;
			env?: Readonly<Record<string, TemplateAst | ArtifactOfAst | JoinArtifactOfAst | JoinResultOfAst>>;
	  }
	| {
			kind: "script";
			command: string;
			args?: readonly string[];
			env?: Readonly<Record<string, TemplateAst | ArtifactOfAst | JoinArtifactOfAst | JoinResultOfAst>>;
			artifacts?: Readonly<Record<string, ArtifactAst>>;
			reply?: SchemaAst;
	  };

export type GuardOutcome = boolean | { ok: false; reason: string };

// What to do when validation rejects a completion claim: feed the reason back into the still
export type EventBindingCst = {
	kind: "event";
	path?: string;
};

/** A transition input is selected either from the firing event or from durable run state. */
export type TransitionInputCst = EventBindingCst | InputRef;

export type TransitionCst = {
	target: StateId;
	input?: Record<string, TransitionInputCst>;
};

export type TransitionMapCst = Record<EventType, StateId | TransitionCst>;

export type EventBindingAst = Readonly<EventBindingCst>;
export type TransitionInputAst = EventBindingAst | InputRef;

export type TransitionAst = Readonly<{
	target: StateId;
	input?: Readonly<Record<string, TransitionInputAst>>;
}>;

// Deadline for an action state: if the action is still running delayMs after its invoke fact,
// the chart transitions to target and the runtime is told to cancel the action. The timer covers
// only the running phase — validation of a completion is not raced against the clock.
export type AfterCst = {
	delayMs: number;
	target: StateId;
};

// Serializable reference to durable run state, optionally narrowed by a dot-path selector.
// Refs appear in templates, effect-boundary value expressions, and transition inputs. The ref
// expression itself is not logged: the same ancestry facts resolve it identically on replay.
//
// V is a phantom: the TS type of the value the ref resolves to, carried by the typed layer
// (refs<Args, Results>()) so templates can insist on primitives. Never present at runtime.
// Declared as an optional method for bivariance: untyped refs (V = unknown) pass everywhere,
// refs with unrelated value types do not.
export type InputRef<V = unknown> = (
	| {
			kind: "arg";
			name: string;
	  }
	| {
			kind: "result";
			// Absolute state path: this is a data lookup, not control flow — no sibling scoping.
			state: StatePath;
			path?: string;
	  }
	// The instance args of an enclosing map: its key, and its spawn-pinned item (optionally
	// narrowed by a dot-path). `map` names the map by template path — required for nesting and
	// set by the typed layer; without it the nearest enclosing map is used. Only meaningful
	// inside that map's body.
	| {
			kind: "key";
			map?: StatePath;
	  }
	| {
			kind: "item";
			map?: StatePath;
			path?: string;
	  }
	| {
			kind: "input";
			name: string;
			path?: string;
	  }
	| {
			kind: "visit";
			state?: StatePath;
	  }
	| {
			kind: "actorInput";
			path?: string;
	  }
	| {
			kind: "messageInput";
			message: string;
			path?: string;
	  }
) & {
	// Set by json(): the value is embedded as JSON text. Without it the renderer admits only
	// primitives — the runtime twin of the static rule enforced by t().
	json?: true;
	__value?(value: V): void;
};

const INPUT_REF_KINDS: ReadonlySet<string> = new Set([
	"arg",
	"result",
	"input",
	"visit",
	"key",
	"item",
	"actorInput",
	"messageInput",
]);

export function isInputRef(value: unknown): value is InputRef {
	return (
		typeof value === "object" &&
		value !== null &&
		"kind" in value &&
		typeof value.kind === "string" &&
		INPUT_REF_KINDS.has(value.kind)
	);
}

// A string with interpolated refs, authored as a tagged template:
//   t`Report on ${arg("topic")} using ${result("plan", "steps")}`
// Plain data (strings.length === refs.length + 1), no placeholder grammar to parse; the machine
// renders it right before dispatch (string values verbatim, everything else as JSON).
export type TemplateCst = {
	kind: "template";
	strings: readonly string[];
	refs: readonly InputRef[];
};

// Anywhere a template is accepted, a plain string is too (a template with no refs).
export type Templatable = string | TemplateCst;

/**
 * Immutable data assembled at an effect boundary. InputRef leaves are resolved from durable
 * facts; arrays/objects preserve their authored shape. Actor declarations are deliberately not
 * part of this union, so a capability cannot be smuggled through runtime data.
 */
export type ValueExpr<T = unknown> =
	| InputRef<T>
	| (T extends JsonPrimitive ? T : JsonPrimitive)
	| { readonly [key: string]: ValueExpr }
	| readonly ValueExpr[];

export type ValueAst = JsonPrimitive | InputRef | Readonly<{ readonly [key: string]: ValueAst }> | readonly ValueAst[];

export type TemplateAst = Readonly<{
	kind: "template";
	strings: readonly string[];
	refs: readonly InputRef[];
}>;

export type OnReenterCst = "restart" | { kind: "resume"; message: Templatable };
export type OnReenterAst = "restart" | { kind: "resume"; message: TemplateAst };

export type EmitCst = {
	event: string;
	payload: ValueExpr;
	schema?: SchemaCst;
};

export type ActionStateCst = {
	kind: "state";
	action: StateActionCst;
	/** Ordered domain events published atomically with accepted completion. */
	emit?: readonly EmitCst[];
	input?: Record<string, SchemaCst>;
	transitions?: TransitionMapCst;
	after?: AfterCst;
};

export type TerminalNotificationCst = {
	/** Optional text appended after the host's standard terminal message. */
	prompt?: Templatable;
	/** Declared artifacts to surface by authoritative path only (contents are never inlined). */
	artifacts?: readonly (ArtifactOfCst | JoinArtifactOfCst)[];
	/** Render scope for input()/map-local refs; defaults to the final state's path. */
	scope?: StatePath;
};

export type FinalStateCst = {
	kind: "final";
	outcome?: "complete" | "failed";
	notify?: TerminalNotificationCst;
};

// A container of nested states. Entering it drills down the initial chain to a leaf. Its
// transitions catch events its descendants leave unhandled (innermost-first); onDone is where the
// chart goes when a direct final child is reached — required if it has one. All targets, here and
// in children, resolve among the siblings of the level where they are declared.
export type ActorOwnerCst = {
	/** Static declarations owned by this lexical scope. There is intentionally no defineActors(). */
	actors?: Record<string, AnyStaticActorDeclaration>;
};

export type CompoundStateCst = ActorOwnerCst & {
	kind: "compound";
	initial: StateId;
	states: Record<StateId, StateCst>;
	transitions?: TransitionMapCst;
	onDone?: StateId;
};

// All children (regions) run concurrently; entering the parallel enters every region. A final
// inside a region marks that region complete (regions must not declare onDone); when every
// region is complete the parallel exits through its own onDone. An event bubbling past a region
// to the parallel (or above) exits all regions at once, abandoning their running actions.
export type ParallelStateCst = ActorOwnerCst & {
	kind: "parallel";
	states: Record<StateId, StateCst>;
	transitions?: TransitionMapCst;
	onDone?: StateId;
};

// A dynamic fan-out: a compound-shaped container whose instances are spawned per key of the
// `over` value (a Record resolved from run data). The keys AND items are pinned by a `spawned`
// fact — the instance's input is frozen at birth (its future actor args). An instance completes
// by reaching a final child; when all instances complete the map exits through onDone. The map's
// own transitions catch what instances leave unhandled — exiting ALL instances (abort).
export type MapStateCst = ActorOwnerCst & {
	kind: "map";
	input?: Record<string, SchemaCst>;
	over: InputRef;
	// At most this many instances run at once (invokes are gated, spawn is not); omitted = all.
	concurrency?: number;
	onReenter?: OnReenterCst;
	initial: StateId;
	states: Record<StateId, StateCst>;
	transitions?: TransitionMapCst;
	onDone?: StateId;
};

export type ReceiveStateCst = {
	kind: "receive";
	on: Record<string, StateId>;
};

export type SendStateCst = {
	kind: "send";
	to: AnyActorTarget | ActorSelfTarget;
	event: string;
	target: StateId;
	input: ValueExpr;
};

export type SendBatchStateCst = {
	kind: "sendBatch";
	to: AnyActorTarget | ActorSelfTarget;
	event: string;
	target: StateId;
	inputs: ValueExpr;
};

export type CallStateCst = {
	kind: "call";
	to: AnyActorTarget;
	event: string;
	input: ValueExpr;
	target?: StateId;
	transitions?: TransitionMapCst;
};

export type CallBatchStateCst = {
	kind: "callBatch";
	to: AnyActorTarget;
	event: string;
	inputs: ValueExpr;
	target: StateId;
};

export type ReplyStateCst = {
	kind: "reply";
	target: StateId;
	event?: string;
	output?: ValueExpr;
};

export type ActorWorkflowStateCst =
	| ActionStateCst
	| ReceiveStateCst
	| SendStateCst
	| SendBatchStateCst
	| CallStateCst
	| CallBatchStateCst
	| ReplyStateCst;

export type ActorDefinitionCst = {
	kind: "actorTemplate";
	input: SchemaCst;
	protocol: ProtocolCst;
	initial: StateId;
	states: Record<StateId, ActorWorkflowStateCst>;
};

export type ActorPoolDefinitionCst = {
	kind: "actorPoolTemplate";
	concurrency: number;
	worker: ActorDefinitionCst;
};

/** Runtime shape returned by actor template invocation; public typing is carried by phantoms. */
export type StaticActorDeclaration<P extends ProtocolCst = ProtocolCst, I = unknown, Brand = unknown> = {
	readonly kind: "actorDeclaration";
	readonly definition: ActorDefinitionCst;
	readonly input: ValueExpr<I>;
	readonly __protocol?: P;
	readonly __actorInput?: I;
	readonly __declarationBrand?: Brand;
};

export type StaticActorPoolDeclaration<P extends ProtocolCst = ProtocolCst, I = unknown, Brand = unknown> = {
	readonly kind: "actorPoolDeclaration";
	readonly definition: ActorPoolDefinitionCst;
	readonly input: ValueExpr<I>;
	readonly __protocol?: P;
	readonly __actorInput?: I;
	readonly __declarationBrand?: Brand;
};

export type AnyStaticActorDeclaration =
	| StaticActorDeclaration<ProtocolCst, unknown, unknown>
	| StaticActorPoolDeclaration<ProtocolCst, unknown, unknown>;

export type AnyActorTarget = AnyStaticActorDeclaration | ActorForwardRef<ProtocolCst, string>;

export type StateCst =
	| ActionStateCst
	| FinalStateCst
	| CompoundStateCst
	| ParallelStateCst
	| MapStateCst
	| SendStateCst
	| SendBatchStateCst
	| CallStateCst
	| CallBatchStateCst;

export type ChartCst = ActorOwnerCst & {
	kind: "chart";
	id: string;
	/** Default policy for agents that do not declare their own onFail policy. */
	recovery?: RecoveryPolicyCst;
	/** Optional serializable metadata for host launch forms; not runtime validation. */
	args?: Record<string, ChartArgumentCst>;
	/** Root-owned, one-shot completion endpoints. They are never actor mailboxes. */
	completions?: Record<string, CompletionDeclarationCst>;
	initial: StateId;
	states: Record<StateId, StateCst>;
};

export type ArtifactAst = Readonly<{
	path: TemplateAst;
	shape?: SchemaAst;
}>;

export type ArtifactOfAst = Readonly<ArtifactOfCst>;

export type JoinArtifactOfAst = Readonly<JoinArtifactOfCst>;

export type JoinResultOfAst = Readonly<JoinResultOfCst>;

export type RecoveryPolicyAst = Readonly<{ nudge: number; restart: number }>;

export type AgentValidationAst = Readonly<{
	guard: GuardRefAst;
	onFail: RecoveryPolicyAst;
}>;

export type AgentReentryAst = "restart" | Readonly<{ resume: TemplateAst }>;

export type AgentActionAst = Readonly<{
	kind: "agent";
	uid: ActionUID;
	name: string;
	task?: TemplateAst;
	artifacts?: Readonly<Record<string, ArtifactAst>>;
	reads?: readonly (TemplateAst | ArtifactOfAst | JoinArtifactOfAst)[];
	model?: string;
	thinking?: string;
	tools?: readonly string[];
	reply?: SchemaAst;
	onFail: RecoveryPolicyAst;
	validation?: AgentValidationAst;
	reentry?: AgentReentryAst;
}>;
export type UserActionAst = Readonly<{
	kind: "user";
	uid: ActionUID;
	prompt: TemplateAst;
	options: readonly string[];
	reply?: SchemaAst;
}>;
export type GateActionAst = Readonly<{
	kind: "gate";
	uid: ActionUID;
	event: string;
	payload: ValueAst;
	reply?: SchemaAst;
}>;
export type WaitForActionAst = Readonly<{
	kind: "waitFor";
	uid: ActionUID;
	from: string;
	event: string;
	reply: SchemaAst;
}>;
export type NotifyActionAst = Readonly<{
	kind: "notify";
	uid: ActionUID;
	to: string;
	event: string;
	payload: ValueAst;
	reply?: never;
}>;
export type ScriptActionAst = Readonly<{
	kind: "script";
	uid: ActionUID;
	command: string;
	args: readonly string[];
	env?: Readonly<Record<string, TemplateAst | ArtifactOfAst | JoinArtifactOfAst | JoinResultOfAst>>;
	artifacts?: Readonly<Record<string, ArtifactAst>>;
	reply?: SchemaAst;
}>;
export type ImportedActionAst = Readonly<{
	kind: "tsImport";
	uid: ActionUID;
	module: string;
	export: string;
	env?: Readonly<Record<string, TemplateAst | ArtifactOfAst | JoinArtifactOfAst | JoinResultOfAst>>;
	artifacts?: Readonly<Record<string, ArtifactAst>>;
	reply?: SchemaAst;
}>;
export type StateActionAst =
	| AgentActionAst
	| UserActionAst
	| GateActionAst
	| WaitForActionAst
	| NotifyActionAst
	| ScriptActionAst
	| ImportedActionAst;

// Absolute path of a state in the chart: local ids joined with "." (e.g. "review.analyze").
// Top-level states' paths equal their ids, so flat charts keep their addresses.
export type StatePath = string;

export type EmitAst = Readonly<{
	event: string;
	payload: ValueAst;
	schema?: SchemaAst;
}>;

export type ActionStateAst = Readonly<{
	kind: "state";
	id: StateId;
	// Path of the containing compound; absent at top level.
	parent?: StatePath;
	action: StateActionAst;
	emit?: readonly EmitAst[];
	input?: Readonly<Record<string, SchemaAst>>;
	transitions: Readonly<Record<EventType, TransitionAst>>;
	after?: Readonly<AfterCst>;
}>;

export type TerminalNotificationAst = Readonly<{
	prompt?: TemplateAst;
	artifacts?: readonly (ArtifactOfAst | JoinArtifactOfAst)[];
	scope?: StatePath;
}>;

export type FinalStateAst = Readonly<{
	kind: "final";
	id: StateId;
	parent?: StatePath;
	outcome: "complete" | "failed";
	notify?: TerminalNotificationAst;
}>;

// Every compound completes: it must contain a direct final child and exit through onDone. There
// is no "loop container" without a final — a repeat-until process expresses its exit condition
// as a final child instead.
export type CompoundStateAst = Readonly<{
	kind: "compound";
	id: StateId;
	parent?: StatePath;
	initial: StateId;
	transitions: Readonly<Record<EventType, TransitionAst>>;
	onDone: StateId;
}>;

// A compound written inside a parallel. Its final child marks the region complete for the join
// instead of exiting anywhere, hence no onDone; its own transitions may only restart itself.
export type RegionStateAst = Readonly<{
	kind: "region";
	id: StateId;
	parent?: StatePath;
	initial: StateId;
	transitions: Readonly<Record<EventType, TransitionAst>>;
}>;

export type ParallelStateAst = Readonly<{
	kind: "parallel";
	id: StateId;
	parent?: StatePath;
	// Local ids of the regions, all entered on entry. Regions are always completable, so the
	// join always has somewhere to go: onDone is mandatory.
	regions: readonly StateId[];
	transitions: Readonly<Record<EventType, TransitionAst>>;
	onDone: StateId;
}>;

export type ReceiveStateAst = Readonly<{
	kind: "receive";
	id: StateId;
	parent: StatePath;
	on: Readonly<Record<string, StateId>>;
}>;

export type SendStateAst = Readonly<{
	kind: "send";
	id: StateId;
	parent?: StatePath;
	to: StatePath;
	/** Authored with self(); `to` is the placement-resolved declaration path. */
	self?: true;
	event: string;
	target: StateId;
	/** Empty; present so generic control-flow inspection can treat messaging as a state node. */
	transitions: Readonly<Record<EventType, TransitionAst>>;
	input: ValueAst;
}>;

export type SendBatchStateAst = Readonly<{
	kind: "sendBatch";
	id: StateId;
	parent?: StatePath;
	to: StatePath;
	/** Authored with self(); `to` is the placement-resolved declaration path. */
	self?: true;
	event: string;
	target: StateId;
	transitions: Readonly<Record<EventType, TransitionAst>>;
	inputs: ValueAst;
}>;

export type CallStateAst = Readonly<{
	kind: "call";
	id: StateId;
	parent?: StatePath;
	to: StatePath;
	event: string;
	input: ValueAst;
	target?: StateId;
	transitions: Readonly<Record<EventType, TransitionAst>>;
}>;

export type CallBatchStateAst = Readonly<{
	kind: "callBatch";
	id: StateId;
	parent?: StatePath;
	to: StatePath;
	event: string;
	inputs: ValueAst;
	target: StateId;
	transitions: Readonly<Record<EventType, TransitionAst>>;
}>;

export type ReplyStateAst = Readonly<{
	kind: "reply";
	id: StateId;
	parent: StatePath;
	target: StateId;
	message: string;
	event?: string;
	output?: ValueAst;
}>;

export type ActorWorkflowStateAst =
	| ActionStateAst
	| ReceiveStateAst
	| SendStateAst
	| SendBatchStateAst
	| CallStateAst
	| CallBatchStateAst
	| ReplyStateAst;

export type ActorDefinitionAst = Readonly<{
	input: SchemaAst;
	protocol: ProtocolAst;
	initial: StateId;
	/** Flat actor-local graph keyed by paths relative to the executable actor. */
	states: Readonly<Record<StatePath, ActorWorkflowStateAst>>;
}>;

export type ActorDeclarationAst = Readonly<{
	kind: "actor";
	name: string;
	path: StatePath;
	owner?: StatePath;
	input: SchemaAst;
	inputValue: ValueAst;
	protocol: ProtocolAst;
	initial: StateId;
	states: Readonly<Record<StatePath, ActorWorkflowStateAst>>;
}>;

export type ActorPoolDeclarationAst = Readonly<{
	kind: "actorPool";
	name: string;
	path: StatePath;
	owner?: StatePath;
	input: SchemaAst;
	inputValue: ValueAst;
	protocol: ProtocolAst;
	concurrency: number;
	worker: ActorDefinitionAst;
}>;

export type ActorEndpointDeclarationAst = ActorDeclarationAst | ActorPoolDeclarationAst;

export type MapStateAst = Readonly<{
	kind: "map";
	id: StateId;
	parent?: StatePath;
	input?: Readonly<Record<string, SchemaAst>>;
	over: InputRef;
	concurrency?: number;
	onReenter?: OnReenterAst;
	initial: StateId;
	transitions: Readonly<Record<EventType, TransitionAst>>;
	onDone: StateId;
}>;

export type StateAst =
	| ActionStateAst
	| FinalStateAst
	| CompoundStateAst
	| RegionStateAst
	| ParallelStateAst
	| MapStateAst
	| SendStateAst
	| SendBatchStateAst
	| CallStateAst
	| CallBatchStateAst;

export type CompletionDeclarationAst = Readonly<{
	name: string;
	event: string;
	schema: SchemaAst;
}>;

export type ChartAst = Readonly<{
	kind: "chart";
	id: string;
	/** Resolved chart-wide fallback pinned into every agent action during normalization. */
	recovery: RecoveryPolicyAst;
	args?: Readonly<Record<string, ChartArgumentAst>>;
	initial: StateId;
	// Flat map keyed by absolute StatePath — nesting lives in `parent` links, lookups stay O(1).
	states: Readonly<Record<StatePath, StateAst>>;
	actors: Readonly<Record<StatePath, ActorEndpointDeclarationAst>>;
	completions: Readonly<Record<string, CompletionDeclarationAst>>;
}>;

export type ActionEvent = {
	type: string;
	// The action's result payload. Travels inside the complete fact, so it is durable for free;
	// the projection exposes it as results[statePath] once the completion is accepted.
	output?: unknown;
};

export type SystemEvent = {
	type: ReservedSystemEventType;
	error: unknown;
};

export type ChartEvent = ActionEvent | SystemEvent;

export type ParsedChart =
	| {
			ok: true;
			source: ChartSource;
			cst: ChartCst;
			ast: ChartAst;
			/** Original runtime Zod schemas for this parsed chart; never serialized. */
			schemaRegistry: SchemaRegistry;
			diagnostics: readonly [];
	  }
	| {
			ok: false;
			source: ChartSource;
			cst?: ChartCst;
			diagnostics: readonly AuthoringDiagnostic[];
	  };
