import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import {
	isDurableRecordEntry,
	type BranchHead,
	type BranchId,
	type BranchMetadata,
	type DurableLogRecord,
	type DurableRecordDraft,
	type ResolvedGateLog,
	type StorageEntry,
} from "../../core/durable_events.js";
import { actionUidKey } from "../../core/action_uid.js";
import { actorLogicalOccurrencePath } from "../../core/actors.js";
import type { StatePath } from "../../core/types.js";
import {
	applyRunStatusPatch,
	readRunStatusFile,
	runStatusFilePath,
	writeRunStatusFile,
	type HyperchartRunStatus,
	type RunStatusPatch,
} from "./run_status_model.js";
import {
	parseControlRequest,
	parseControlResult,
	type RunChangeTopic,
	type RunChangeWait,
	type RunnerControlRequest,
	type RunnerControlResult,
	type WaitForRunChangeOptions,
} from "./runner_control_model.js";

export const DEFAULT_BRANCH_ID: BranchId = "main";
/** Interval between JSONL change re-checks; see JsonlLogStore.watchRunChange. */
export const JSONL_CHANGE_FALLBACK_MS = 100;
export const HISTORY_READ_ITEMS = 100;
const REPLAY_PAGE_RECORDS = 500;

/** Opaque derived cache row. Runtime/storage compare selector and ancestry coordinates only. */
export type OpaqueCheckpointEnvelope = Readonly<{
	checkpointId: string;
	headSeqId: number | null;
	selectorKey: string;
	blob: unknown;
	createdAt: number;
}>;
export type CheckpointQuery = Readonly<{
	targetHeadSeqId: number | null;
	selectorKey: string;
}>;
export interface CheckpointRepository extends RunHistoryStore {
	readonly canStoreCheckpoints: boolean;
	loadExactCheckpoint(input: CheckpointQuery): Promise<OpaqueCheckpointEnvelope | undefined>;
	findNearestCheckpoint(input: CheckpointQuery): Promise<OpaqueCheckpointEnvelope | undefined>;
	discardCheckpoint(checkpointId: string): Promise<void>;
	storeCheckpoint(checkpoint: OpaqueCheckpointEnvelope): Promise<void>;
}

export type PreparedStampedCommit = Readonly<{
	checkpoints: readonly OpaqueCheckpointEnvelope[];
	/** Synchronous execution-owned confirmation invoked only after durability succeeds. */
	committed(): void;
}>;
export type PrepareStampedCommit = (records: readonly DurableLogRecord[]) => PreparedStampedCommit;

/** @internal Validate and clone before any backend mutates journal or cache state. */
export function cloneOpaqueCheckpoint(checkpoint: OpaqueCheckpointEnvelope): OpaqueCheckpointEnvelope {
	if (
		typeof checkpoint.checkpointId !== "string" ||
		checkpoint.checkpointId.length === 0 ||
		!(checkpoint.headSeqId === null || (Number.isSafeInteger(checkpoint.headSeqId) && checkpoint.headSeqId > 0)) ||
		typeof checkpoint.selectorKey !== "string" ||
		checkpoint.selectorKey.length === 0 ||
		!Number.isSafeInteger(checkpoint.createdAt) ||
		checkpoint.createdAt < 0
	) {
		throw new Error("Invalid opaque Hyperchart checkpoint coordinates");
	}
	return structuredClone(checkpoint);
}

export type HistorySnapshot = Readonly<{ branchId: BranchId; headSeqId: number | null }>;
/** Opaque versioned cursor bound to an exact snapshot, typed subject, boundary, and direction. */
export type HistoryCursor = string;
export type BranchListCursor = string;
export type HistoryChunk<T> = Readonly<{
	snapshot: HistorySnapshot;
	/** Canonical order is always newest-first; length is backend-capped at 100. */
	items: readonly T[];
	older?: HistoryCursor;
	newer?: HistoryCursor;
}>;
export type BranchListChunk = Readonly<{
	items: readonly BranchHead[];
	totalCount: number;
	next?: BranchListCursor;
}>;

export type HistorySubject =
	| Readonly<{ kind: "records" }>
	| Readonly<{ kind: "state-visits"; state: StatePath }>
	| Readonly<{ kind: "map-visits"; mapPath: StatePath }>
	| Readonly<{ kind: "actor-generations"; logicalOccurrence: StatePath }>
	| Readonly<{ kind: "actor-messages"; occurrence: StatePath }>;

export type StateVisitHistoryItem = Readonly<{
	kind: "state-visit";
	state: StatePath;
	seqId: number;
	/** One-based subject ordinal, derived from immutable ancestry order. */
	visit: number;
	invoke: Extract<DurableLogRecord, { type: "state_action"; kind: "invoke" }>;
	records: readonly DurableLogRecord[];
}>;
export type MapVisitHistoryItem = Readonly<{
	kind: "map-visit";
	mapPath: StatePath;
	seqId: number;
	/** One-based subject ordinal, derived from immutable ancestry order. */
	visit: number;
	spawn: Extract<DurableLogRecord, { type: "spawned" }>;
	records: readonly DurableLogRecord[];
}>;
export type ActorGenerationHistoryItem = Readonly<{
	kind: "actor-generation";
	logicalOccurrence: StatePath;
	seqId: number;
	created: Extract<DurableLogRecord, { type: "actor_created" }>;
	records: readonly DurableLogRecord[];
}>;
export type ActorMessageHistoryItem = Readonly<{
	kind: "actor-message-batch";
	occurrence: StatePath;
	seqId: number;
	enqueued: Extract<DurableLogRecord, { type: "actor_messages_enqueued" }>;
	records: readonly DurableLogRecord[];
}>;

export class BranchHeadMovedError extends Error {
	readonly name = "BranchHeadMovedError";
	constructor(
		readonly branchId: BranchId,
		readonly expectedHeadSeqId: number | null,
		readonly actualHeadSeqId: number | null,
	) {
		super(
			`Branch '${branchId}' moved: expected head ${expectedHeadSeqId ?? "null"}, found ${actualHeadSeqId ?? "null"}`,
		);
	}
}

export class HistoryCursorError extends Error {
	readonly name = "HistoryCursorError";
}

export type RunMeta = {
	/** Stored for hashed JSONL enumeration; literal-layout storage keys remain authoritative. */
	runId?: string;
	chartPath: string;
	exportName?: string;
	workDir: string;
	chartId: string;
	createdAt: string;
	originSessionId?: string;
};

/** Final public stateless history contract. Backends may temporarily scan trusted ancestry internally. */
export interface RunHistoryStore {
	captureSnapshot(branchId: BranchId): Promise<HistorySnapshot>;
	/** Read-committed keyset pagination; branch-list pages are deliberately not snapshot-stable. */
	listBranches(cursor?: BranchListCursor): Promise<BranchListChunk>;
	getBranch(branchId: BranchId): Promise<BranchHead>;
	getRecord(seqId: number): Promise<DurableLogRecord | undefined>;
	containsInHistory(input: { headSeqId: number | null; seqId: number }): Promise<boolean>;
	countRecords(): Promise<number>;
	readRecords(input: { snapshot: HistorySnapshot; cursor?: HistoryCursor }): Promise<HistoryChunk<DurableLogRecord>>;
	readStateVisits(input: {
		snapshot: HistorySnapshot;
		state: StatePath;
		cursor?: HistoryCursor;
	}): Promise<HistoryChunk<StateVisitHistoryItem>>;
	readMapVisits(input: {
		snapshot: HistorySnapshot;
		mapPath: StatePath;
		cursor?: HistoryCursor;
	}): Promise<HistoryChunk<MapVisitHistoryItem>>;
	readActorGenerations(input: {
		snapshot: HistorySnapshot;
		logicalOccurrence: StatePath;
		cursor?: HistoryCursor;
	}): Promise<HistoryChunk<ActorGenerationHistoryItem>>;
	readActorMessages(input: {
		snapshot: HistorySnapshot;
		occurrence: StatePath;
		cursor?: HistoryCursor;
	}): Promise<HistoryChunk<ActorMessageHistoryItem>>;
	cursorAt(input: {
		snapshot: HistorySnapshot;
		subject: HistorySubject;
		seqId: number;
	}): Promise<HistoryCursor | undefined>;
	findUserInteractionResponse(input: {
		headSeqId: number | null;
		gateSeqId: number;
	}): Promise<ResolvedGateLog | undefined>;
}

/** @internal Materialized index used only by file and memory backends. */
export class MaterializedRunLogIndex {
	readonly entries: StorageEntry[];
	readonly recordsBySeqId: Map<number, DurableLogRecord>;
	readonly branches: Map<BranchId, BranchHead>;
	nextSeqId: number;

	constructor(input: {
		entries: StorageEntry[];
		recordsBySeqId: Map<number, DurableLogRecord>;
		branches: Map<BranchId, BranchHead>;
		nextSeqId: number;
	}) {
		this.entries = input.entries;
		this.recordsBySeqId = input.recordsBySeqId;
		this.branches = input.branches;
		this.nextSeqId = input.nextSeqId;
	}

	applyEntry(entry: StorageEntry): void {
		this.entries.push(entry);
		if (!isDurableRecordEntry(entry)) {
			const previous = this.branches.get(entry.branchId);
			this.branches.set(
				entry.branchId,
				entry.op === "create"
					? {
							branchId: entry.branchId,
							headSeqId: entry.headSeqId,
							createdAt: entry.committedAt,
							...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
						}
					: { ...previous!, headSeqId: entry.headSeqId },
			);
			this.nextSeqId = entry.seqId + 1;
			return;
		}
		const branch = this.branches.get(entry.branchId)!;
		this.recordsBySeqId.set(entry.seqId, entry);
		this.nextSeqId = entry.seqId + 1;
		this.branches.set(entry.branchId, { ...branch, headSeqId: entry.seqId });
	}

	branch(branchId: BranchId): BranchHead {
		const branch = this.branches.get(branchId);
		if (branch === undefined) {
			throw new Error(`Unknown Hyperchart branch '${branchId}'`);
		}
		return branch;
	}

	materializeBranchHistory(branchId: BranchId): readonly DurableLogRecord[] {
		return this.materializeHistoryToHead(this.branch(branchId).headSeqId);
	}

	containsInBranchHistory(branchId: BranchId, targetSeqId: number): boolean {
		let seqId = this.branch(branchId).headSeqId;
		while (seqId !== null) {
			if (seqId === targetSeqId) {
				return true;
			}
			seqId = this.recordsBySeqId.get(seqId)!.parentId;
		}
		return false;
	}

	materializeHistoryToHead(headSeqId: number | null): readonly DurableLogRecord[] {
		if (headSeqId === null) {
			return [];
		}
		const reversed: DurableLogRecord[] = [];
		let seqId: number | null = headSeqId;
		while (seqId !== null) {
			const record: DurableLogRecord = this.recordsBySeqId.get(seqId)!;
			reversed.push(record);
			seqId = record.parentId;
		}
		return reversed.reverse();
	}
}

type HistoryCursorPayload = Readonly<{
	version: 1;
	snapshot: HistorySnapshot;
	subject: string;
	direction: "at" | "older" | "newer";
	boundarySeqId: number;
}>;
type BranchCursorPayload = Readonly<{ version: 1; createdSeqId: number; branchId: BranchId }>;

type AnyHistoryItem =
	| DurableLogRecord
	| StateVisitHistoryItem
	| MapVisitHistoryItem
	| ActorGenerationHistoryItem
	| ActorMessageHistoryItem;

/** @internal Canonical subject identity shared by cursor validation across backends. */
export function historySubjectKey(subject: HistorySubject): string {
	switch (subject.kind) {
		case "records":
			return JSON.stringify([subject.kind]);
		case "state-visits":
			return JSON.stringify([subject.kind, subject.state]);
		case "map-visits":
			return JSON.stringify([subject.kind, subject.mapPath]);
		case "actor-generations":
			return JSON.stringify([subject.kind, subject.logicalOccurrence]);
		case "actor-messages":
			return JSON.stringify([subject.kind, subject.occurrence]);
	}
}

function encodeOpaque(value: object): string {
	return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
function decodeOpaque(value: string, kind: "history" | "branch"): unknown {
	try {
		return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
	} catch {
		throw new HistoryCursorError(`Invalid Hyperchart ${kind} cursor`);
	}
}
function sameSnapshot(left: HistorySnapshot, right: HistorySnapshot): boolean {
	return left.branchId === right.branchId && left.headSeqId === right.headSeqId;
}
function itemSeqId(item: AnyHistoryItem): number {
	return item.seqId;
}

/** @internal */
export function encodeBranchListCursor(createdSeqId: number, branchId: BranchId): BranchListCursor {
	return encodeOpaque({ version: 1, createdSeqId, branchId } satisfies BranchCursorPayload);
}
/** @internal */
export function decodeBranchListCursor(cursor: BranchListCursor): BranchCursorPayload {
	const value = decodeOpaque(cursor, "branch");
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		!Number.isSafeInteger(value.createdSeqId) ||
		(value.createdSeqId as number) <= 0 ||
		typeof value.branchId !== "string"
	) {
		throw new HistoryCursorError("Invalid Hyperchart branch cursor");
	}
	return value as unknown as BranchCursorPayload;
}

function encodeHistoryCursor(payload: Omit<HistoryCursorPayload, "version">): HistoryCursor {
	return encodeOpaque({ version: 1, ...payload } satisfies HistoryCursorPayload);
}
function decodeHistoryCursor(cursor: HistoryCursor, snapshot: HistorySnapshot, subject: string): HistoryCursorPayload {
	const value = decodeOpaque(cursor, "history");
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		!isRecord(value.snapshot) ||
		typeof value.snapshot.branchId !== "string" ||
		!(value.snapshot.headSeqId === null || Number.isSafeInteger(value.snapshot.headSeqId)) ||
		typeof value.subject !== "string" ||
		!["at", "older", "newer"].includes(String(value.direction)) ||
		!Number.isSafeInteger(value.boundarySeqId)
	) {
		throw new HistoryCursorError("Invalid Hyperchart history cursor");
	}
	const decoded = value as unknown as HistoryCursorPayload;
	if (!sameSnapshot(decoded.snapshot, snapshot)) {
		throw new HistoryCursorError("Hyperchart history cursor belongs to a different snapshot");
	}
	if (decoded.subject !== subject) {
		throw new HistoryCursorError("Hyperchart history cursor belongs to a different subject");
	}
	return decoded;
}

/** @internal Build the final bounded stateless response from a newest-first subject chain. */
export function historyChunkFromItems<T extends AnyHistoryItem>(
	snapshot: HistorySnapshot,
	subject: HistorySubject,
	itemsNewestFirst: readonly T[],
	cursor?: HistoryCursor,
): HistoryChunk<T> {
	const subjectKey = historySubjectKey(subject);
	let start = 0;
	if (cursor !== undefined) {
		const decoded = decodeHistoryCursor(cursor, snapshot, subjectKey);
		const boundary = itemsNewestFirst.findIndex((item) => itemSeqId(item) === decoded.boundarySeqId);
		if (boundary < 0) {
			throw new HistoryCursorError("Hyperchart history cursor boundary is not visible in its snapshot subject");
		}
		start =
			decoded.direction === "older"
				? boundary + 1
				: decoded.direction === "newer"
					? Math.max(0, boundary - HISTORY_READ_ITEMS)
					: boundary;
		const end = decoded.direction === "newer" ? boundary : start + HISTORY_READ_ITEMS;
		const page = itemsNewestFirst.slice(start, end);
		return chunkWithEdges(snapshot, subjectKey, itemsNewestFirst, page, start, end);
	}
	const page = itemsNewestFirst.slice(0, HISTORY_READ_ITEMS);
	return chunkWithEdges(snapshot, subjectKey, itemsNewestFirst, page, 0, HISTORY_READ_ITEMS);
}

function chunkWithEdges<T extends AnyHistoryItem>(
	snapshot: HistorySnapshot,
	subject: string,
	all: readonly T[],
	page: readonly T[],
	start: number,
	requestedEnd: number,
): HistoryChunk<T> {
	if (page.length === 0) {
		return { snapshot, items: [] };
	}
	const end = Math.min(requestedEnd, all.length);
	const first = page[0]!;
	const last = page.at(-1)!;
	return {
		snapshot,
		items: page,
		...(end < all.length
			? { older: encodeHistoryCursor({ snapshot, subject, direction: "older", boundarySeqId: itemSeqId(last) }) }
			: {}),
		...(start > 0
			? { newer: encodeHistoryCursor({ snapshot, subject, direction: "newer", boundarySeqId: itemSeqId(first) }) }
			: {}),
	};
}

/** @internal Mint an exact-subject deep-link cursor. */
export function cursorAtItems<T extends AnyHistoryItem>(
	snapshot: HistorySnapshot,
	subject: HistorySubject,
	itemsNewestFirst: readonly T[],
	seqId: number,
): HistoryCursor | undefined {
	const item = itemsNewestFirst.find((candidate) => itemSeqId(candidate) === seqId);
	return item === undefined
		? undefined
		: encodeHistoryCursor({
				snapshot,
				subject: historySubjectKey(subject),
				direction: "at",
				boundarySeqId: itemSeqId(item),
			});
}

/** @internal Derive durable record-level subject groups without importing AST/projector/host layers. */
export function historyItemsForSubject(
	ancestry: readonly DurableLogRecord[],
	subject: HistorySubject,
): readonly AnyHistoryItem[] {
	switch (subject.kind) {
		case "records":
			return [...ancestry].reverse();
		case "state-visits":
			return stateVisitItems(ancestry, subject.state);
		case "map-visits":
			return ancestry
				.filter(
					(record): record is Extract<DurableLogRecord, { type: "spawned" }> =>
						record.type === "spawned" && record.path === subject.mapPath,
				)
				.map(
					(spawn, index): MapVisitHistoryItem => ({
						kind: "map-visit",
						mapPath: subject.mapPath,
						seqId: spawn.seqId,
						visit: index + 1,
						spawn,
						records: [spawn],
					}),
				)
				.reverse();
		case "actor-generations":
			return actorGenerationItems(ancestry, subject.logicalOccurrence);
		case "actor-messages":
			return actorMessageItems(ancestry, subject.occurrence);
	}
}

function stateVisitItems(ancestry: readonly DurableLogRecord[], state: StatePath): StateVisitHistoryItem[] {
	type Mutable = {
		kind: "state-visit";
		state: StatePath;
		seqId: number;
		visit: number;
		invoke: Extract<DurableLogRecord, { type: "state_action"; kind: "invoke" }>;
		records: DurableLogRecord[];
	};
	const items: Mutable[] = [];
	const current = new Map<string, Mutable>();
	for (const record of ancestry) {
		if (record.type === "state_action" && record.kind === "invoke") {
			if (record.actionUid.state !== state) {
				continue;
			}
			const item: Mutable = {
				kind: "state-visit",
				state,
				seqId: record.seqId,
				visit: items.length + 1,
				invoke: record,
				records: [record],
			};
			items.push(item);
			current.set(actionUidKey(record.actionUid), item);
			continue;
		}
		const actionUid = "actionUid" in record ? record.actionUid : undefined;
		if (actionUid !== undefined && actionUid.state === state) {
			current.get(actionUidKey(actionUid))?.records.push(record);
		} else if (record.type === "failure_intent" && record.origin === state) {
			items.at(-1)?.records.push(record);
		}
	}
	return items.reverse();
}

function actorGenerationItems(
	ancestry: readonly DurableLogRecord[],
	logicalOccurrence: StatePath,
): ActorGenerationHistoryItem[] {
	type Mutable = {
		kind: "actor-generation";
		logicalOccurrence: StatePath;
		seqId: number;
		created: Extract<DurableLogRecord, { type: "actor_created" }>;
		records: DurableLogRecord[];
	};
	const items: Mutable[] = [];
	const byOccurrence = new Map<StatePath, Mutable>();
	for (const record of ancestry) {
		if (record.type === "actor_created") {
			if (actorLogicalOccurrencePath(record.occurrence, record.generation) !== logicalOccurrence) {
				continue;
			}
			const item: Mutable = {
				kind: "actor-generation",
				logicalOccurrence,
				seqId: record.seqId,
				created: record,
				records: [record],
			};
			items.push(item);
			byOccurrence.set(record.occurrence, item);
			continue;
		}
		const occurrence = recordOccurrence(record);
		if (occurrence !== undefined) {
			byOccurrence.get(occurrence)?.records.push(record);
		}
	}
	return items.reverse();
}

function actorMessageItems(ancestry: readonly DurableLogRecord[], occurrence: StatePath): ActorMessageHistoryItem[] {
	type Mutable = {
		kind: "actor-message-batch";
		occurrence: StatePath;
		seqId: number;
		enqueued: Extract<DurableLogRecord, { type: "actor_messages_enqueued" }>;
		records: DurableLogRecord[];
	};
	const items: Mutable[] = [];
	const byMessageId = new Map<string, Mutable>();
	for (const record of ancestry) {
		if (record.type === "actor_messages_enqueued" && record.occurrence === occurrence) {
			const item: Mutable = {
				kind: "actor-message-batch",
				occurrence,
				seqId: record.seqId,
				enqueued: record,
				records: [record],
			};
			items.push(item);
			for (const message of record.messages) {
				byMessageId.set(message.messageId, item);
			}
			continue;
		}
		if (record.type === "actor_message" && record.occurrence === occurrence) {
			byMessageId.get(record.messageId)?.records.push(record);
		}
		if (record.type === "actor_call_resolved") {
			byMessageId.get(record.messageId)?.records.push(record);
		}
		if (record.type === "actor_batch_call_resolved") {
			const targets = new Set(
				record.messageIds
					.map((messageId) => byMessageId.get(messageId))
					.filter((item): item is Mutable => item !== undefined),
			);
			for (const item of targets) {
				item.records.push(record);
			}
		}
	}
	return items.reverse();
}

function recordOccurrence(record: DurableLogRecord): StatePath | undefined {
	return "occurrence" in record && typeof record.occurrence === "string" ? record.occurrence : undefined;
}

/** @internal Validate a replay boundary and return the first record after it. */
/** @internal */
export function findUserInteractionResponseInAncestry(
	ancestry: readonly DurableLogRecord[],
	gateSeqId: number,
): ResolvedGateLog | undefined {
	for (let index = ancestry.length - 1; index >= 0; index--) {
		const record = ancestry[index]!;
		if (
			(record.type === "user_interaction" || record.type === "gate") &&
			record.kind === "resolved" &&
			record.gateSeqId === gateSeqId
		) {
			return record;
		}
	}
	return undefined;
}

export function boundedForwardReplayPage(index: MaterializedRunLogIndex, input: ReplayPageInput): ReplayPage {
	if (input.targetHeadSeqId === null) {
		return { records: [] };
	}
	const retainedNewestFirst: DurableLogRecord[] = [];
	let current: number | null = input.targetHeadSeqId;
	let count = 0;
	let foundBoundary = input.afterSeqId === null;
	while (current !== null) {
		const record = index.recordsBySeqId.get(current);
		if (record === undefined) {
			throw new Error(`Missing durable parent record ${current}`);
		}
		if (input.afterSeqId !== null && record.seqId === input.afterSeqId) {
			foundBoundary = true;
			break;
		}
		retainedNewestFirst.push(record);
		if (retainedNewestFirst.length > REPLAY_PAGE_RECORDS) {
			retainedNewestFirst.shift();
		}
		count++;
		current = record.parentId;
	}
	if (!foundBoundary) {
		throw new Error(`Execution replay boundary ${input.afterSeqId} is not in target ancestry`);
	}
	const records = retainedNewestFirst.reverse();
	return {
		records,
		...(count > REPLAY_PAGE_RECORDS && records.at(-1) !== undefined ? { nextAfterSeqId: records.at(-1)!.seqId } : {}),
	};
}

function replayStart(ancestry: readonly DurableLogRecord[], afterSeqId: number | null): number {
	if (afterSeqId === null) {
		return 0;
	}
	const index = ancestry.findIndex((record) => record.seqId === afterSeqId);
	if (index < 0) {
		throw new Error(`Execution replay boundary ${afterSeqId} is not in target ancestry`);
	}
	return index + 1;
}

type ReplayPageInput = Readonly<{ targetHeadSeqId: number | null; afterSeqId: number | null }>;
type ReplayPage = Readonly<{ records: readonly DurableLogRecord[]; nextAfterSeqId?: number }>;
type ReplayPageReader = (input: ReplayPageInput) => Promise<ReplayPage>;
const replayReaders = new WeakMap<object, ReplayPageReader>();

/** @internal Register a backend-private, genuinely bounded forward ancestry reader. */
export function registerReplayPageReader(reader: object, readPage: ReplayPageReader): void {
	replayReaders.set(reader, readPage);
}

/** @internal Execution-only replay stream; every backend call and yielded batch is capped at 500. */
export async function* openExecutionReplay(
	reader: RunHistoryStore,
	input: ReplayPageInput,
): AsyncIterable<readonly DurableLogRecord[]> {
	const readPage = replayReaders.get(reader as object);
	if (readPage === undefined) {
		throw new Error("Run history backend has no execution replay port");
	}
	let afterSeqId = input.afterSeqId;
	for (;;) {
		const page = await readPage({ targetHeadSeqId: input.targetHeadSeqId, afterSeqId });
		if (page.records.length > REPLAY_PAGE_RECORDS) {
			throw new Error("Replay backend exceeded the 500-record page limit");
		}
		if (page.records.length > 0) {
			yield page.records;
		}
		if (page.nextAfterSeqId === undefined) {
			return;
		}
		afterSeqId = page.nextAfterSeqId;
	}
}

/** Collect bounded branch-list pages for package-internal control paths. */
export async function collectBranches(reader: Pick<RunHistoryStore, "listBranches">): Promise<readonly BranchHead[]> {
	const items: BranchHead[] = [];
	let cursor: BranchListCursor | undefined;
	do {
		const chunk = await reader.listBranches(cursor);
		items.push(...chunk.items);
		cursor = chunk.next;
	} while (cursor !== undefined);
	return items;
}

export type UserInteractionResponseCommit = Readonly<{
	record: ResolvedGateLog;
	idempotent: boolean;
}>;

export type AppendAtHeadInput = Readonly<{
	expectedHeadSeqId: number | null;
	drafts: readonly DurableRecordDraft[];
}>;
export type BranchMutationOptions = Readonly<{ checkpoint?: OpaqueCheckpointEnvelope }>;
export type BranchMoveResult = BranchHead &
	Readonly<{
		moveSeqId: number;
		/** Branch head observed at the serialized move commit boundary. */
		previousHeadSeqId: number | null;
		/** Durable machine-record count observed at that same boundary. */
		preservedRecords: number;
	}>;

export interface LogStore extends RunHistoryStore {
	readonly branchId: BranchId;
	appendDrafts(
		drafts: readonly DurableRecordDraft[],
		prepare?: PrepareStampedCommit,
	): Promise<readonly DurableLogRecord[]>;
	appendDraftsAtHead(input: AppendAtHeadInput, prepare?: PrepareStampedCommit): Promise<readonly DurableLogRecord[]>;
}

/** Full run-journal handle: branch entries plus lifecycle, shared across branch handles. */
export interface RunLogStore extends LogStore, CheckpointRepository {
	forBranch(branchId: BranchId): RunLogStore;
	readRunMeta(): Promise<RunMeta | undefined>;
	writeRunMeta(meta: RunMeta): Promise<void>;
	/** Operational runner status; never part of durable history. */
	readRunStatus(): Promise<HyperchartRunStatus | undefined>;
	/**
	 * Atomic read-merge-write of the operational status. Allowed from read-access
	 * handles too: hosts publish starting/stopping while the live runner holds the
	 * journal writer claim, so status is deliberately outside that claim.
	 */
	patchRunStatus(patch: RunStatusPatch): Promise<HyperchartRunStatus>;
	/**
	 * Runner control mailbox: attempt-fenced commands from hosts to the live runtime
	 * and its acknowledgements. Transport only; journal facts stay authoritative.
	 * Publishing is exclusive by id: a second publish of the same id is rejected for
	 * requests and reports `false` for results, so an acknowledgement is never replaced.
	 */
	publishControlRequest(request: RunnerControlRequest): Promise<void>;
	/** Pending requests in publication order. Malformed entries are dropped. */
	listControlRequests(): Promise<readonly RunnerControlRequest[]>;
	discardControlRequest(requestId: string): Promise<void>;
	publishControlResult(result: RunnerControlResult): Promise<boolean>;
	readControlResult(requestId: string): Promise<RunnerControlResult | undefined>;
	discardControlResult(requestId: string): Promise<void>;
	/**
	 * Arm a wait for an operational fact of one of the topics to change, bounded by
	 * the fallback timeout. Wake-ups are hints: callers always re-read state. Arm it
	 * before reading, so a change during the read is not lost.
	 */
	watchRunChange(topics: readonly RunChangeTopic[], options: WaitForRunChangeOptions): RunChangeWait;
	/** Remove run identity, journal, operational status, and the control mailbox. */
	deleteRunData(): Promise<void>;
	initializeRootBranch(metadata?: BranchMetadata, options?: BranchMutationOptions): Promise<BranchHead>;
	createBranch(
		branchId: BranchId,
		headSeqId: number,
		metadata?: BranchMetadata,
		options?: BranchMutationOptions,
	): Promise<BranchHead>;
	moveBranch(branchId: BranchId, headSeqId: number | null, options?: BranchMutationOptions): Promise<BranchMoveResult>;
	close(): Promise<void>;
}

/** Exclusive-create publication: a temp file renamed over a path that must not exist yet. */
function publishJsonExclusive(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	if (existsSync(path)) {
		const error = new Error(`Control entry already exists: ${path}`) as NodeJS.ErrnoException;
		error.code = "EEXIST";
		throw error;
	}
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
	try {
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

function readJsonIfPresent(path: string): unknown {
	if (!existsSync(path)) {
		return undefined;
	}
	try {
		return JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch {
		return undefined;
	}
}

/** @internal Stamp drafts against the file/memory writer's materialized index. */
export function stampDrafts(
	index: MaterializedRunLogIndex,
	branchId: BranchId,
	drafts: readonly DurableRecordDraft[],
	now: number,
): DurableLogRecord[] {
	const branch = index.branches.get(branchId);
	if (branch === undefined) {
		throw new Error(`Unknown Hyperchart branch '${branchId}'`);
	}
	let nextSeqId = index.nextSeqId;
	let parentId = branch.headSeqId;
	return drafts.map((draft) => {
		assertDurableRecordDraft(draft);
		const record = { ...draft, seqId: nextSeqId++, parentId, branchId, timestamp: now } as DurableLogRecord;
		parentId = record.seqId;
		return record;
	});
}

/** @internal */
export function materializeJournal(values: readonly unknown[]): MaterializedRunLogIndex {
	const entries = [...values] as StorageEntry[];
	const index = new MaterializedRunLogIndex({
		entries: [],
		recordsBySeqId: new Map(),
		branches: new Map(),
		nextSeqId: 1,
	});
	for (const entry of entries) {
		index.applyEntry(entry);
	}
	return index;
}

type SharedJournalState = {
	filePath: string;
	index?: MaterializedRunLogIndex;
	/** Disposable process-local opaque checkpoint cache. Never persisted beside JSONL. */
	checkpoints: OpaqueCheckpointEnvelope[];
	/** Exact durable byte boundary represented by the index. Shared branch handles advance it together. */
	expectedByteLength?: number;
	fullReadCount: number;
	poisoned: boolean;
};

function newJournal(filePath: string): SharedJournalState {
	return { filePath: resolve(filePath), checkpoints: [], fullReadCount: 0, poisoned: false };
}

export class JsonlLogStore implements RunLogStore {
	private journal: SharedJournalState;
	readonly canStoreCheckpoints = true;

	constructor(
		readonly filePath: string,
		readonly branchId: BranchId = DEFAULT_BRANCH_ID,
		/** Storage key; required only for operational status, whose persisted runId is verified. */
		private readonly runId?: string,
	) {
		requireBranchId(branchId, "selected branch");
		this.journal = newJournal(filePath);
		this.registerReplayReader();
	}

	/** Create another branch handle over this store's already-open incremental journal. */
	forBranch(branchId: BranchId): JsonlLogStore {
		const store = new JsonlLogStore(this.journal.filePath, branchId, this.runId);
		store.journal = this.journal;
		store.registerReplayReader();
		return store;
	}

	/** Number of full-file reads performed by this shared journal. */
	fullReadCount(): number {
		return this.journal.fullReadCount;
	}

	async initializeRootBranch(
		metadata: BranchMetadata = { name: this.branchId },
		options?: BranchMutationOptions,
	): Promise<BranchHead> {
		const checkpoint = options?.checkpoint === undefined ? undefined : cloneOpaqueCheckpoint(options.checkpoint);
		const branch = await this.commitBuilt((index) => {
			if (index.entries.length !== 0) {
				throw new Error("Cannot initialize a non-empty Hyperchart journal");
			}
			const committedAt = Date.now();
			const entry: StorageEntry = {
				kind: "branch",
				op: "create",
				seqId: index.nextSeqId,
				branchId: this.branchId,
				headSeqId: null,
				metadata,
				committedAt,
			};
			return {
				entries: [entry],
				result: { branchId: this.branchId, headSeqId: null, createdAt: committedAt, metadata },
			};
		});
		if (checkpoint !== undefined) {
			this.rememberClonedCheckpoint(checkpoint);
		}
		return branch;
	}

	async appendDrafts(
		drafts: readonly DurableRecordDraft[],
		prepare?: PrepareStampedCommit,
	): Promise<readonly DurableLogRecord[]> {
		if (drafts.length === 0) {
			return [];
		}
		return enqueueJsonlWrite(this.journal.filePath, async () => {
			if (this.journal.poisoned) {
				throw new Error("JSONL Hyperchart journal is unusable after a post-commit confirmation failure");
			}
			this.openJournal();
			const records = stampDrafts(this.index(), this.branchId, drafts, Date.now());
			const prepared = prepare?.(records);
			const checkpoints = (prepared?.checkpoints ?? []).map(cloneOpaqueCheckpoint);
			await this.appendLocked(records);
			for (const checkpoint of checkpoints) {
				this.rememberClonedCheckpoint(checkpoint);
			}
			try {
				prepared?.committed();
			} catch (error) {
				this.journal.poisoned = true;
				throw error;
			}
			return records;
		});
	}

	async appendDraftsAtHead(
		input: AppendAtHeadInput,
		prepare?: PrepareStampedCommit,
	): Promise<readonly DurableLogRecord[]> {
		if (input.drafts.length === 0) {
			return [];
		}
		return enqueueJsonlWrite(this.journal.filePath, async () => {
			if (this.journal.poisoned) {
				throw new Error("JSONL Hyperchart journal is unusable after a post-commit confirmation failure");
			}
			this.openJournal();
			const branch = this.index().branch(this.branchId);
			if (branch.headSeqId !== input.expectedHeadSeqId) {
				throw new BranchHeadMovedError(this.branchId, input.expectedHeadSeqId, branch.headSeqId);
			}
			const records = stampDrafts(this.index(), this.branchId, input.drafts, Date.now());
			const prepared = prepare?.(records);
			const checkpoints = (prepared?.checkpoints ?? []).map(cloneOpaqueCheckpoint);
			await this.appendLocked(records);
			for (const checkpoint of checkpoints) {
				this.rememberClonedCheckpoint(checkpoint);
			}
			try {
				prepared?.committed();
			} catch (error) {
				this.journal.poisoned = true;
				throw error;
			}
			return records;
		});
	}

	async captureSnapshot(branchId: BranchId): Promise<HistorySnapshot> {
		const branch = this.index().branch(branchId);
		return { branchId, headSeqId: branch.headSeqId };
	}
	async listBranches(cursor?: BranchListCursor): Promise<BranchListChunk> {
		const index = this.index();
		const decoded = cursor === undefined ? undefined : decodeBranchListCursor(cursor);
		const creates = index.entries
			.filter(
				(entry): entry is Extract<StorageEntry, { kind: "branch"; op: "create" }> =>
					!isDurableRecordEntry(entry) && entry.op === "create",
			)
			.sort((left, right) => left.seqId - right.seqId || left.branchId.localeCompare(right.branchId));
		const after = creates.filter(
			(entry) =>
				decoded === undefined ||
				entry.seqId > decoded.createdSeqId ||
				(entry.seqId === decoded.createdSeqId && entry.branchId > decoded.branchId),
		);
		const page = after.slice(0, HISTORY_READ_ITEMS);
		return {
			items: page.map((entry) => index.branch(entry.branchId)),
			totalCount: creates.length,
			...(after.length > page.length && page.at(-1) !== undefined
				? { next: encodeBranchListCursor(page.at(-1)!.seqId, page.at(-1)!.branchId) }
				: {}),
		};
	}
	async getBranch(branchId: BranchId): Promise<BranchHead> {
		return this.index().branch(branchId);
	}
	async getRecord(seqId: number): Promise<DurableLogRecord | undefined> {
		return this.index().recordsBySeqId.get(seqId);
	}
	async containsInHistory(input: { headSeqId: number | null; seqId: number }): Promise<boolean> {
		if (input.headSeqId === null) {
			return false;
		}
		let current: number | null = input.headSeqId;
		while (current !== null) {
			if (current === input.seqId) {
				return true;
			}
			const record = this.index().recordsBySeqId.get(current);
			if (record === undefined) {
				throw new Error(`No durable log record with seqId ${current}`);
			}
			current = record.parentId;
		}
		return false;
	}
	async readRecords(input: {
		snapshot: HistorySnapshot;
		cursor?: HistoryCursor;
	}): Promise<HistoryChunk<DurableLogRecord>> {
		return this.readSubject(input.snapshot, { kind: "records" }, input.cursor) as HistoryChunk<DurableLogRecord>;
	}
	async readStateVisits(input: {
		snapshot: HistorySnapshot;
		state: StatePath;
		cursor?: HistoryCursor;
	}): Promise<HistoryChunk<StateVisitHistoryItem>> {
		return this.readSubject(
			input.snapshot,
			{ kind: "state-visits", state: input.state },
			input.cursor,
		) as HistoryChunk<StateVisitHistoryItem>;
	}
	async readMapVisits(input: {
		snapshot: HistorySnapshot;
		mapPath: StatePath;
		cursor?: HistoryCursor;
	}): Promise<HistoryChunk<MapVisitHistoryItem>> {
		return this.readSubject(
			input.snapshot,
			{ kind: "map-visits", mapPath: input.mapPath },
			input.cursor,
		) as HistoryChunk<MapVisitHistoryItem>;
	}
	async readActorGenerations(input: {
		snapshot: HistorySnapshot;
		logicalOccurrence: StatePath;
		cursor?: HistoryCursor;
	}): Promise<HistoryChunk<ActorGenerationHistoryItem>> {
		return this.readSubject(
			input.snapshot,
			{ kind: "actor-generations", logicalOccurrence: input.logicalOccurrence },
			input.cursor,
		) as HistoryChunk<ActorGenerationHistoryItem>;
	}
	async readActorMessages(input: {
		snapshot: HistorySnapshot;
		occurrence: StatePath;
		cursor?: HistoryCursor;
	}): Promise<HistoryChunk<ActorMessageHistoryItem>> {
		return this.readSubject(
			input.snapshot,
			{ kind: "actor-messages", occurrence: input.occurrence },
			input.cursor,
		) as HistoryChunk<ActorMessageHistoryItem>;
	}
	async cursorAt(input: {
		snapshot: HistorySnapshot;
		subject: HistorySubject;
		seqId: number;
	}): Promise<HistoryCursor | undefined> {
		const ancestry = this.ancestryForSnapshot(input.snapshot);
		return cursorAtItems(input.snapshot, input.subject, historyItemsForSubject(ancestry, input.subject), input.seqId);
	}
	async findUserInteractionResponse(input: {
		headSeqId: number | null;
		gateSeqId: number;
	}): Promise<ResolvedGateLog | undefined> {
		return findUserInteractionResponseInAncestry(
			this.index().materializeHistoryToHead(input.headSeqId),
			input.gateSeqId,
		);
	}
	async countRecords(): Promise<number> {
		return this.index().recordsBySeqId.size;
	}
	async loadExactCheckpoint(input: CheckpointQuery): Promise<OpaqueCheckpointEnvelope | undefined> {
		const checkpoint = this.journal.checkpoints.find(
			(candidate) => candidate.headSeqId === input.targetHeadSeqId && candidate.selectorKey === input.selectorKey,
		);
		return checkpoint === undefined ? undefined : structuredClone(checkpoint);
	}
	async findNearestCheckpoint(input: CheckpointQuery): Promise<OpaqueCheckpointEnvelope | undefined> {
		const ancestry = this.index().materializeHistoryToHead(input.targetHeadSeqId);
		const distance = new Map(ancestry.map((record, index) => [record.seqId, ancestry.length - index - 1]));
		const checkpoint = this.journal.checkpoints
			.filter(
				(candidate) =>
					candidate.selectorKey === input.selectorKey &&
					(candidate.headSeqId === null || distance.has(candidate.headSeqId)),
			)
			.sort(
				(left, right) =>
					checkpointDistance(left, distance) - checkpointDistance(right, distance) || right.createdAt - left.createdAt,
			)[0];
		return checkpoint === undefined ? undefined : structuredClone(checkpoint);
	}
	async discardCheckpoint(checkpointId: string): Promise<void> {
		const index = this.journal.checkpoints.findIndex((checkpoint) => checkpoint.checkpointId === checkpointId);
		if (index >= 0) {
			this.journal.checkpoints.splice(index, 1);
		}
	}
	async storeCheckpoint(checkpoint: OpaqueCheckpointEnvelope): Promise<void> {
		this.rememberClonedCheckpoint(cloneOpaqueCheckpoint(checkpoint));
	}
	async close(): Promise<void> {}
	async readRunMeta(): Promise<RunMeta | undefined> {
		const path = join(dirname(this.journal.filePath), "meta.json");
		if (!existsSync(path)) {
			return undefined;
		}
		return JSON.parse(readFileSync(path, "utf8")) as RunMeta;
	}
	async writeRunMeta(meta: RunMeta): Promise<void> {
		mkdirSync(dirname(this.journal.filePath), { recursive: true });
		writeFileSync(join(dirname(this.journal.filePath), "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
	}
	async readRunStatus(): Promise<HyperchartRunStatus | undefined> {
		return readRunStatusFile(this.statusPath(), this.requireRunId());
	}
	async patchRunStatus(patch: RunStatusPatch): Promise<HyperchartRunStatus> {
		const runId = this.requireRunId();
		const path = this.statusPath();
		const next = applyRunStatusPatch(runId, readRunStatusFile(path, runId), patch);
		mkdirSync(dirname(path), { recursive: true });
		writeRunStatusFile(path, next);
		return next;
	}
	async publishControlRequest(request: RunnerControlRequest): Promise<void> {
		publishJsonExclusive(this.controlPath("requests", request.id), request);
	}
	async listControlRequests(): Promise<readonly RunnerControlRequest[]> {
		let files: string[];
		try {
			files = readdirSync(join(this.controlDir(), "requests"))
				.filter((file) => file.endsWith(".json"))
				.sort();
		} catch {
			return [];
		}
		const requests: RunnerControlRequest[] = [];
		for (const file of files) {
			const path = join(this.controlDir(), "requests", file);
			const request = parseControlRequest(readJsonIfPresent(path));
			if (request === undefined) {
				// Unreadable or malformed requests can never be acknowledged; drop them.
				rmSync(path, { force: true });
				continue;
			}
			requests.push(request);
		}
		return requests.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
	}
	async discardControlRequest(requestId: string): Promise<void> {
		rmSync(this.controlPath("requests", requestId), { force: true });
	}
	async publishControlResult(result: RunnerControlResult): Promise<boolean> {
		try {
			publishJsonExclusive(this.controlPath("results", result.requestId), result);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				return false;
			}
			throw error;
		}
	}
	async readControlResult(requestId: string): Promise<RunnerControlResult | undefined> {
		return parseControlResult(readJsonIfPresent(this.controlPath("results", requestId)));
	}
	async discardControlResult(requestId: string): Promise<void> {
		rmSync(this.controlPath("results", requestId), { force: true });
	}
	/**
	 * JSONL has no change signal worth trusting: macOS FSEvents can lag by seconds
	 * under load and would make waits nondeterministic, while a local re-read is a
	 * cheap readdir or stat. The wait is therefore a short timer; the caller's
	 * timeout only caps it. Topics are accepted for interface parity.
	 */
	watchRunChange(_topics: readonly RunChangeTopic[], options: WaitForRunChangeOptions): RunChangeWait {
		let cancel: () => void = () => {};
		const changed = new Promise<void>((resolve, reject) => {
			if (options.signal?.aborted) {
				reject(options.signal.reason);
				return;
			}
			const finish = () => {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
			};
			const onAbort = () => {
				finish();
				reject(options.signal?.reason);
			};
			const timer = setTimeout(
				() => {
					finish();
					resolve();
				},
				Math.min(options.timeoutMs, JSONL_CHANGE_FALLBACK_MS),
			);
			if (options.persistent !== true) {
				timer.unref();
			}
			cancel = () => {
				finish();
				resolve();
			};
			options.signal?.addEventListener("abort", onAbort, { once: true });
		});
		return { changed, cancel: () => cancel() };
	}
	async deleteRunData(): Promise<void> {
		rmSync(join(dirname(this.journal.filePath), "meta.json"), { force: true });
		rmSync(this.statusPath(), { force: true });
		rmSync(this.controlDir(), { recursive: true, force: true });
		rmSync(this.journal.filePath, { force: true });
	}
	private statusPath(): string {
		return runStatusFilePath(dirname(this.journal.filePath));
	}
	private controlDir(): string {
		return join(dirname(this.journal.filePath), "runner-control", "user-responses");
	}
	private controlPath(role: "requests" | "results", id: string): string {
		return join(this.controlDir(), role, `${id}.json`);
	}
	private requireRunId(): string {
		if (this.runId === undefined) {
			throw new Error("JSONL run status requires the store to be opened with a run identity");
		}
		return this.runId;
	}
	async createBranch(
		branchId: BranchId,
		headSeqId: number,
		metadata?: BranchMetadata,
		options?: BranchMutationOptions,
	): Promise<BranchHead> {
		requireBranchId(branchId, "branchId");
		const checkpoint = options?.checkpoint === undefined ? undefined : cloneOpaqueCheckpoint(options.checkpoint);
		const result = await this.commitBuilt((index) => {
			if (index.branches.has(branchId)) {
				throw new Error(`Hyperchart branch '${branchId}' already exists`);
			}
			if (!index.recordsBySeqId.has(headSeqId)) {
				throw new Error(`No durable log record with seqId ${headSeqId}`);
			}
			const committedAt = Date.now();
			return {
				entries: [
					{
						kind: "branch",
						op: "create",
						seqId: index.nextSeqId,
						branchId,
						headSeqId,
						...(metadata === undefined ? {} : { metadata }),
						committedAt,
					},
				],
				result: { branchId, headSeqId, createdAt: committedAt, ...(metadata === undefined ? {} : { metadata }) },
			};
		});
		if (checkpoint !== undefined) {
			this.rememberClonedCheckpoint(checkpoint);
		}
		return result;
	}

	async moveBranch(
		branchId: BranchId,
		headSeqId: number | null,
		options?: BranchMutationOptions,
	): Promise<BranchMoveResult> {
		requireBranchId(branchId, "branchId");
		const checkpoint = options?.checkpoint === undefined ? undefined : cloneOpaqueCheckpoint(options.checkpoint);
		const result = await this.commitBuilt((index) => {
			const branch = index.branches.get(branchId);
			if (branch === undefined) {
				throw new Error(`Unknown Hyperchart branch '${branchId}'`);
			}
			if (headSeqId !== null && !index.recordsBySeqId.has(headSeqId)) {
				throw new Error(`No durable log record with seqId ${headSeqId}`);
			}
			const moveSeqId = index.nextSeqId;
			return {
				entries: [{ kind: "branch", op: "move", seqId: moveSeqId, branchId, headSeqId, committedAt: Date.now() }],
				result: {
					...branch,
					headSeqId,
					moveSeqId,
					previousHeadSeqId: branch.headSeqId,
					preservedRecords: index.recordsBySeqId.size,
				},
			};
		});
		if (checkpoint !== undefined) {
			this.rememberClonedCheckpoint(checkpoint);
		}
		return result;
	}

	private rememberClonedCheckpoint(checkpoint: OpaqueCheckpointEnvelope): void {
		const duplicate = this.journal.checkpoints.find(
			(candidate) => candidate.headSeqId === checkpoint.headSeqId && candidate.selectorKey === checkpoint.selectorKey,
		);
		if (duplicate === undefined) {
			this.journal.checkpoints.push(checkpoint);
		}
	}

	private registerReplayReader(): void {
		registerReplayPageReader(this, async (input) => boundedForwardReplayPage(this.index(), input));
	}

	private readSubject(
		snapshot: HistorySnapshot,
		subject: HistorySubject,
		cursor?: HistoryCursor,
	): HistoryChunk<AnyHistoryItem> {
		const ancestry = this.ancestryForSnapshot(snapshot);
		return historyChunkFromItems(snapshot, subject, historyItemsForSubject(ancestry, subject), cursor);
	}

	private ancestryForSnapshot(snapshot: HistorySnapshot): readonly DurableLogRecord[] {
		const index = this.index();
		index.branch(snapshot.branchId);
		if (snapshot.headSeqId !== null && !index.recordsBySeqId.has(snapshot.headSeqId)) {
			throw new Error(`No durable log record with seqId ${snapshot.headSeqId}`);
		}
		return index.materializeHistoryToHead(snapshot.headSeqId);
	}

	private openJournal(): void {
		if (this.journal.index !== undefined) {
			return;
		}
		const opened = readEntryValues(this.journal.filePath);
		this.journal.fullReadCount++;
		this.journal.expectedByteLength = opened.byteLength;
		this.journal.index = materializeJournal(opened.values);
	}

	private index(): MaterializedRunLogIndex {
		this.openJournal();
		if (this.journal.index === undefined) {
			throw new Error("Hyperchart journal failed to open");
		}
		return this.journal.index;
	}

	private commitBuilt<T>(
		builder: (index: MaterializedRunLogIndex) => { entries: readonly StorageEntry[]; result: T },
	): Promise<T> {
		return enqueueJsonlWrite(this.journal.filePath, async () => {
			this.openJournal();
			const built = builder(this.index());
			await this.appendLocked(built.entries);
			return built.result;
		});
	}

	private async appendLocked(entries: readonly StorageEntry[]): Promise<void> {
		if (this.journal.poisoned) {
			throw new Error("JSONL Hyperchart journal is unusable after a post-commit confirmation failure");
		}
		const index = this.journal.index;
		const expectedByteLength = this.journal.expectedByteLength;
		if (index === undefined || expectedByteLength === undefined) {
			throw new Error("Hyperchart journal is not open");
		}
		const currentByteLength = await journalByteLengthAsync(this.journal.filePath);
		if (currentByteLength !== expectedByteLength) {
			throw new Error(
				`Stale Hyperchart journal writer: expected ${expectedByteLength} bytes but found ${currentByteLength}; reopen the run before writing`,
			);
		}
		const payload = Buffer.from(entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf8");
		await appendEntriesOnce(this.journal.filePath, payload);
		this.journal.expectedByteLength = expectedByteLength + payload.byteLength;
		for (const entry of entries) {
			index.applyEntry(entry);
		}
	}
}

type OpenedEntryValues = { values: unknown[]; byteLength: number };

function readEntryValues(filePath: string): OpenedEntryValues {
	if (!existsSync(filePath)) {
		return { values: [], byteLength: 0 };
	}
	const content = readFileSync(filePath, "utf8");
	const values: unknown[] = [];
	for (const [index, line] of content.split(/\r?\n/).entries()) {
		if (line.length === 0) {
			continue;
		}
		try {
			values.push(JSON.parse(line) as unknown);
		} catch (error) {
			throw new Error(
				`Failed to parse durable log ${filePath}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return { values, byteLength: Buffer.byteLength(content, "utf8") };
}

async function journalByteLengthAsync(filePath: string): Promise<number> {
	try {
		return (await stat(filePath)).size;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return 0;
		}
		throw error;
	}
}

async function appendEntriesOnce(filePath: string, payload: Buffer): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const handle = await open(filePath, "a");
	try {
		const { bytesWritten } = await handle.write(payload, 0, payload.byteLength, null);
		if (bytesWritten !== payload.byteLength) {
			throw new Error(`Short Hyperchart journal append: wrote ${bytesWritten} of ${payload.byteLength} bytes`);
		}
	} finally {
		await handle.close();
	}
}

const jsonlWriteChains = new Map<string, Promise<void>>();

function enqueueJsonlWrite<T>(filePath: string, task: () => Promise<T>): Promise<T> {
	const key = resolve(filePath);
	const previous = jsonlWriteChains.get(key) ?? Promise.resolve();
	const result = previous.then(task);
	const settled = result.then(
		() => undefined,
		() => undefined,
	);
	jsonlWriteChains.set(key, settled);
	void settled.finally(() => {
		if (jsonlWriteChains.get(key) === settled) {
			jsonlWriteChains.delete(key);
		}
	});
	return result;
}

/** @internal */
export function assertDurableRecordDraft(value: DurableRecordDraft): void {
	if (!isRecord(value) || typeof value.type !== "string") {
		throw new Error("Durable record draft must contain a machine record type");
	}
	if ("seqId" in value || "parentId" in value || "branchId" in value || "timestamp" in value) {
		throw new Error("Durable record coordinates are assigned only by the run writer");
	}
	if (
		"input" in value &&
		value.input !== undefined &&
		(value.type === "state_action" ||
			((value.type === "user_interaction" || value.type === "gate") && value.kind === "opened"))
	) {
		requireResolvedInput(value.input, `${value.type}.input`);
	}
}

function requireResolvedInput(value: unknown, coordinate: string): void {
	if (!isRecord(value)) {
		throw new Error(`${coordinate} must be a JSON object`);
	}
	requireJsonValue(value, coordinate);
}

function requireJsonValue(value: unknown, coordinate: string, ancestors = new Set<object>()): void {
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return;
	}
	if (typeof value === "number") {
		if (Number.isFinite(value)) {
			return;
		}
		throw new Error(`${coordinate} must contain only finite JSON numbers`);
	}
	if (typeof value !== "object") {
		throw new Error(`${coordinate} must contain only JSON values`);
	}
	if (ancestors.has(value)) {
		throw new Error(`${coordinate} must not contain circular references`);
	}
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			for (let index = 0; index < value.length; index++) {
				requireJsonValue(value[index], `${coordinate}[${index}]`, ancestors);
			}
			return;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new Error(`${coordinate} must contain only plain JSON objects`);
		}
		for (const [key, entry] of Object.entries(value)) {
			requireJsonValue(entry, `${coordinate}.${key}`, ancestors);
		}
	} finally {
		ancestors.delete(value);
	}
}

function checkpointDistance(checkpoint: OpaqueCheckpointEnvelope, distance: ReadonlyMap<number, number>): number {
	return checkpoint.headSeqId === null
		? Number.MAX_SAFE_INTEGER
		: (distance.get(checkpoint.headSeqId) ?? Number.MAX_SAFE_INTEGER);
}

function requireBranchId(value: unknown, coordinate: string): BranchId {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > 128 || /[\0/\\]/.test(value)) {
		throw new Error(`${coordinate} must be a non-empty branch id without path separators`);
	}
	return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
