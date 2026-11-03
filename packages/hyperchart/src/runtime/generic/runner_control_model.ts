import type { ChartEvent } from "../../core/types.js";
import type { BranchId, ResolvedGateLog } from "../../core/durable_events.js";

/**
 * Runner control transport: attempt-fenced commands from a host to the one live
 * runtime that owns a run, and that runtime's acknowledgements. Commands are
 * transport only; the journal remains semantic truth. Each storage backend
 * persists the mailbox beside its run identity (files under the run directory
 * for JSONL, `hyperchart_control` rows for PostgreSQL); the shapes and
 * validation rules here are backend-independent.
 */
export const CONTROL_VERSION = 1;

type RunnerControlBase = Readonly<{
	version: 1;
	id: string;
	attemptId: string;
	branchId: BranchId;
	createdAt: number;
}>;

export type RunnerUserResponseRequest = RunnerControlBase &
	Readonly<{
		kind: "respond_user_interaction";
		gateSeqId: number;
		event: ChartEvent;
	}>;

export type RunnerMoveBranchRequest = RunnerControlBase &
	Readonly<{
		kind: "move_branch";
		targetHeadSeqId: number | null;
	}>;

export type RunnerControlRequest = RunnerUserResponseRequest | RunnerMoveBranchRequest;

export type RunnerControlFailure = Readonly<{
	version: 1;
	kind: RunnerControlRequest["kind"];
	requestId: string;
	attemptId: string;
	ok: false;
	error: string;
	completedAt: number;
}>;

export type RunnerUserResponseResult =
	| Readonly<{
			version: 1;
			kind: "respond_user_interaction";
			requestId: string;
			attemptId: string;
			ok: true;
			idempotent: boolean;
			record: ResolvedGateLog;
			completedAt: number;
	  }>
	| RunnerControlFailure;

export type RunnerMoveBranchCommit = Readonly<{
	moveSeqId: number;
	previousHeadSeqId: number | null;
	preservedRecords: number;
}>;

export type RunnerMoveBranchResult =
	| Readonly<{
			version: 1;
			kind: "move_branch";
			requestId: string;
			attemptId: string;
			ok: true;
			moveSeqId: number;
			previousHeadSeqId: number | null;
			preservedRecords: number;
			completedAt: number;
	  }>
	| RunnerControlFailure;

export type RunnerControlResult = RunnerUserResponseResult | RunnerMoveBranchResult;

export class RunnerControlUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RunnerControlUnavailableError";
	}
}

/** Operational run facts a waiter can be woken for. */
export type RunChangeTopic = "status" | "control";

export type WaitForRunChangeOptions = Readonly<{
	/** Fallback wake-up when no change notification arrives; never trust notifications alone. */
	timeoutMs: number;
	signal?: AbortSignal;
	/** Keep the process alive while waiting. A detached runner needs this; hosts usually do not. */
	persistent?: boolean;
}>;

/**
 * An armed change wait. Arm it before reading the state you are waiting on, then
 * read, then await `changed`: a change that lands between the read and the await
 * is already captured, so nothing is lost to the fallback timeout.
 */
export type RunChangeWait = Readonly<{
	/** Resolves on a change hint, the fallback timeout, or `cancel()`; rejects only on `signal` abort. */
	changed: Promise<void>;
	/** Release the watcher early when the awaited condition was already met. */
	cancel(): void;
}>;

/** Validate an untrusted persisted request. Unknown or malformed values are dropped, never thrown. */
export function parseControlRequest(value: unknown): RunnerControlRequest | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	if (
		value.version !== CONTROL_VERSION ||
		typeof value.id !== "string" ||
		typeof value.attemptId !== "string" ||
		typeof value.branchId !== "string" ||
		typeof value.createdAt !== "number"
	) {
		return undefined;
	}
	if (value.kind === "move_branch") {
		if (value.targetHeadSeqId !== null && !isPositiveInteger(value.targetHeadSeqId)) {
			return undefined;
		}
		return value as unknown as RunnerMoveBranchRequest;
	}
	if (value.kind !== "respond_user_interaction" || !isPositiveInteger(value.gateSeqId) || !isChartEvent(value.event)) {
		return undefined;
	}
	return value as unknown as RunnerUserResponseRequest;
}

/** Validate an untrusted persisted result. */
export function parseControlResult(value: unknown): RunnerControlResult | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	if (
		value.version !== CONTROL_VERSION ||
		(value.kind !== "respond_user_interaction" && value.kind !== "move_branch") ||
		typeof value.requestId !== "string" ||
		typeof value.attemptId !== "string" ||
		typeof value.ok !== "boolean" ||
		typeof value.completedAt !== "number"
	) {
		return undefined;
	}
	if (!value.ok) {
		return typeof value.error === "string" ? (value as unknown as RunnerControlFailure) : undefined;
	}
	if (value.kind === "move_branch") {
		return isPositiveInteger(value.moveSeqId) &&
			(value.previousHeadSeqId === null || isPositiveInteger(value.previousHeadSeqId)) &&
			isNonNegativeInteger(value.preservedRecords)
			? (value as unknown as RunnerMoveBranchResult)
			: undefined;
	}
	const record = value.record as Partial<ResolvedGateLog> | undefined;
	if (
		typeof value.idempotent !== "boolean" ||
		(record?.type !== "user_interaction" && record?.type !== "gate") ||
		record.kind !== "resolved" ||
		!isPositiveInteger(record.seqId) ||
		!isPositiveInteger(record.gateSeqId)
	) {
		return undefined;
	}
	return value as unknown as RunnerUserResponseResult;
}

export function isMoveCommit(value: unknown): value is RunnerMoveBranchCommit {
	return (
		isRecord(value) &&
		isPositiveInteger(value.moveSeqId) &&
		(value.previousHeadSeqId === null || isPositiveInteger(value.previousHeadSeqId)) &&
		isNonNegativeInteger(value.preservedRecords)
	);
}

function isChartEvent(value: unknown): value is ChartEvent {
	return isRecord(value) && typeof value.type === "string";
}
function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
