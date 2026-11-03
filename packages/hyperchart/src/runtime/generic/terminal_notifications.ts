import { resolveRunPaths } from "./run_paths.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { BranchId } from "../../core/durable_events.js";
type RunTerminalState = "complete" | "failed";
import { isRunLive, patchRunStatus, readRunStatus } from "./run_status.js";

export const TERMINAL_NOTIFICATION_DIR = "terminal-notification";
export const TERMINAL_NOTIFICATION_HISTORY_DIR = "terminal-notification-history";
export const TERMINAL_NOTIFICATION_REQUEST = "request.json";

export type TerminalNotificationPayload = Readonly<{
	runId: string;
	branchId: BranchId;
	chartId: string;
	outcome: RunTerminalState;
	prompt: string;
	artifacts: readonly string[];
	/** Present for failed outcomes so stale recovery can preserve the real runner error. */
	error?: string;
}>;

export type TerminalNotificationRequest = Readonly<{
	version: 2;
	requestId: string;
	createdAt: string;
	/** Runner attempt that produced this request; absent only on legacy outboxes. */
	attemptId?: string;
	payload: TerminalNotificationPayload;
}>;

export type TerminalNotificationReceipt = Readonly<{
	version: 1;
	requestId: string;
	host: string;
	sessionId: string;
	state: "claimed" | "confirmed";
	claimedAt?: string;
	deliveredAt?: string;
}>;

export const TERMINAL_NOTIFICATION_CLAIM_LEASE_MS = 30_000;

export function terminalNotificationRequestPath(runId: string): string {
	return join(resolveRunPaths(runId).runDir, TERMINAL_NOTIFICATION_DIR, TERMINAL_NOTIFICATION_REQUEST);
}

export function defaultFailedTerminalNotificationPayload(input: {
	runId: string;
	branchId: BranchId;
	chartId: string;
	error: string;
}): TerminalNotificationPayload {
	return {
		runId: input.runId,
		branchId: input.branchId,
		chartId: input.chartId,
		outcome: "failed",
		prompt: `Hyperchart run ${input.runId} (${input.chartId}) failed: ${input.error}. Inspect run ${input.runId}.`,
		artifacts: [],
		error: input.error,
	};
}

/** A request becomes deliverable only after the run status records the same terminal outcome. */
export async function readDeliverableTerminalNotificationRequest(
	runId: string,
): Promise<TerminalNotificationRequest | undefined> {
	const request = readTerminalNotificationRequest(runId);
	if (request === undefined) {
		return undefined;
	}
	const status = await readRunStatus(runId);
	if (status?.state !== request.payload.outcome) {
		return undefined;
	}
	// Current runners close with an empty live set, so attempt identity is the
	// authoritative generation match. Branch identity remains legacy fallback.
	if (status.attemptId !== undefined && request.attemptId !== undefined) {
		return status.attemptId === request.attemptId ? request : undefined;
	}
	return status.branchIds.includes(request.payload.branchId) ||
		(status.branchIds.length === 0 &&
			status.attemptId === undefined &&
			request.attemptId === undefined &&
			status.runId === request.payload.runId &&
			status.chartId === request.payload.chartId)
		? request
		: undefined;
}

/**
 * Repair a runner that died before publishing terminal status. If the outbox was
 * already written, its outcome wins; otherwise persist a failed request first.
 */
export async function recoverStaleRunTerminalNotification(
	runId: string,
	now = Date.now(),
): Promise<TerminalNotificationRequest | undefined> {
	const status = await readRunStatus(runId);
	if (status === undefined || (status.state !== "starting" && status.state !== "running") || isRunLive(status, now)) {
		return undefined;
	}
	let request = readTerminalNotificationRequest(runId);
	const belongsToCurrentAttempt =
		status.attemptId === undefined
			? request !== undefined // Legacy status/outbox pairs retain their original request-wins behavior.
			: request?.attemptId === status.attemptId;
	if (!belongsToCurrentAttempt) {
		// The host may have durably opened this attempt before the runner got far
		// enough to archive the previous outbox. Never let that older outcome win.
		if (request !== undefined) {
			archiveTerminalNotificationGeneration(runId);
		}
		const error = status.error ?? "runner exited before recording a terminal status";
		request = await persistTerminalNotificationRequest(
			runId,
			defaultFailedTerminalNotificationPayload({
				runId: status.runId,
				branchId: status.branchIds[0] ?? request?.payload.branchId ?? "main",
				chartId: status.chartId,
				error,
			}),
		);
	}
	if (request === undefined) {
		throw new Error(`Failed to recover terminal notification request for ${runId}`);
	}
	await patchRunStatus(runId, {
		state: request.payload.outcome,
		branchIds: [],
		pid: undefined,
		heartbeatAt: undefined,
		exitCode: request.payload.outcome === "complete" ? 0 : 1,
		error:
			request.payload.outcome === "failed"
				? (request.payload.error ?? status.error ?? "runner exited before recording a terminal status")
				: undefined,
	});
	return request;
}

/**
 * Retire the previous attempt's complete outbox before a resumed runner can
 * publish a new terminal result. The status must become non-terminal first so
 * hosts cannot begin a new delivery while the directory is being archived.
 */
export function archiveTerminalNotificationGeneration(runId: string): string | undefined {
	const request = readTerminalNotificationRequest(runId);
	if (request === undefined) {
		return undefined;
	}
	const historyDir = join(resolveRunPaths(runId).runDir, TERMINAL_NOTIFICATION_HISTORY_DIR);
	mkdirSync(historyDir, { recursive: true });
	const createdAt = request.createdAt.replace(/[^\dA-Za-z.-]/g, "-");
	const requestKey = createHash("sha256").update(request.requestId).digest("hex").slice(0, 16);
	const archiveDir = join(historyDir, `${createdAt}-${requestKey}`);
	renameSync(join(resolveRunPaths(runId).runDir, TERMINAL_NOTIFICATION_DIR), archiveDir);
	return archiveDir;
}

/** Persist-once outbox write. Existing identical payloads are reused; divergent terminal replay fails loud. */
export async function persistTerminalNotificationRequest(
	runId: string,
	payload: TerminalNotificationPayload,
): Promise<TerminalNotificationRequest> {
	const path = terminalNotificationRequestPath(runId);
	const existing = readTerminalNotificationRequest(runId);
	if (existing !== undefined) {
		if (stableJson(existing.payload) !== stableJson(payload)) {
			throw new Error(`Terminal notification payload conflict for run '${payload.runId}'`);
		}
		return existing;
	}
	mkdirSync(join(resolveRunPaths(runId).runDir, TERMINAL_NOTIFICATION_DIR), { recursive: true });
	const attemptId = (await readRunStatus(runId))?.attemptId;
	const request: TerminalNotificationRequest = {
		version: 2,
		// Identity belongs to this outbox generation, not its payload. Rewind removes the
		// outbox, so replaying an identical terminal creates a notification that hosts can
		// distinguish from the pre-rewind delivery.
		requestId: randomUUID(),
		createdAt: new Date().toISOString(),
		...(attemptId === undefined ? {} : { attemptId }),
		payload,
	};
	atomicWriteJson(path, request);
	return request;
}

export function readTerminalNotificationRequest(runId: string): TerminalNotificationRequest | undefined {
	const path = terminalNotificationRequestPath(runId);
	if (!existsSync(path)) {
		return undefined;
	}
	const value = JSON.parse(readFileSync(path, "utf8")) as TerminalNotificationRequest;
	if (
		value.version !== 2 ||
		typeof value.requestId !== "string" ||
		typeof value.payload?.prompt !== "string" ||
		typeof value.payload?.branchId !== "string"
	) {
		throw new Error(`Invalid terminal notification request: ${path}`);
	}
	return value;
}

export function terminalNotificationReceiptPath(
	runId: string,
	requestId: string,
	host: string,
	sessionId: string,
): string {
	const generationKey = createHash("sha256").update(requestId).digest("hex");
	const ownerKey = createHash("sha256").update(`${host}\0${sessionId}`).digest("hex");
	return join(resolveRunPaths(runId).runDir, TERMINAL_NOTIFICATION_DIR, "receipts", generationKey, `${ownerKey}.json`);
}

function legacyTerminalNotificationReceiptPath(runId: string, host: string, sessionId: string): string {
	const ownerKey = createHash("sha256").update(`${host}\0${sessionId}`).digest("hex");
	return join(resolveRunPaths(runId).runDir, TERMINAL_NOTIFICATION_DIR, "receipts", `${ownerKey}.json`);
}

export function hasTerminalNotificationReceipt(runId: string, host: string, sessionId: string): boolean {
	const request = readTerminalNotificationRequest(runId);
	if (request === undefined) {
		return false;
	}
	const receipt =
		readReceipt(terminalNotificationReceiptPath(runId, request.requestId, host, sessionId)) ??
		readReceipt(legacyTerminalNotificationReceiptPath(runId, host, sessionId));
	return (
		receipt !== undefined &&
		receipt.requestId === request.requestId &&
		receipt.host === host &&
		receipt.sessionId === sessionId &&
		// Receipts written by the original implementation had no state. Treat them as
		// confirmed so upgrading does not duplicate notifications already delivered.
		(receipt.state === "confirmed" || (receipt.state === undefined && typeof receipt.deliveredAt === "string"))
	);
}

/**
 * Atomically acquire a recoverable delivery lease. A claim is not a receipt: only
 * markTerminalNotificationReceipt confirms delivery. If a process dies before
 * delivery, another process may reclaim after the lease expires.
 */
export function claimTerminalNotificationReceipt(
	runId: string,
	requestId: string,
	host: string,
	sessionId: string,
	options: { now?: number; leaseMs?: number } = {},
): boolean {
	const request = readTerminalNotificationRequest(runId);
	if (request === undefined || request.requestId !== requestId) {
		return false;
	}
	const legacy = readReceipt(legacyTerminalNotificationReceiptPath(runId, host, sessionId));
	if (
		legacy?.requestId === requestId &&
		legacy.host === host &&
		legacy.sessionId === sessionId &&
		(legacy.state === "confirmed" || (legacy.state === undefined && typeof legacy.deliveredAt === "string"))
	) {
		return false;
	}
	const path = terminalNotificationReceiptPath(runId, requestId, host, sessionId);
	const now = options.now ?? Date.now();
	const leaseMs = options.leaseMs ?? TERMINAL_NOTIFICATION_CLAIM_LEASE_MS;
	const claim: TerminalNotificationReceipt = {
		version: 1,
		requestId: request.requestId,
		host,
		sessionId,
		state: "claimed",
		claimedAt: new Date(now).toISOString(),
	};
	mkdirSync(dirname(path), { recursive: true });
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			writeFileSync(path, `${JSON.stringify(claim, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
			return true;
		} catch (error) {
			if (!isNodeError(error) || error.code !== "EEXIST") {
				throw error;
			}
		}
		const existing = readReceipt(path);
		if (
			existing !== undefined &&
			existing.requestId === request.requestId &&
			existing.host === host &&
			existing.sessionId === sessionId
		) {
			if (
				existing.state === "confirmed" ||
				(existing.state === undefined && typeof existing.deliveredAt === "string")
			) {
				return false;
			}
			const claimedAt = existing.claimedAt === undefined ? Number.NaN : Date.parse(existing.claimedAt);
			if (Number.isFinite(claimedAt) && now - claimedAt < leaseMs) {
				return false;
			}
		}
		const displaced = `${path}.${process.pid}.${randomUUID()}.stale`;
		try {
			renameSync(path, displaced);
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") {
				continue;
			}
			throw error;
		}
		const displacedReceipt = readReceipt(displaced);
		if (stableJson(displacedReceipt) !== stableJson(existing)) {
			// The receipt changed after our stale read (most importantly, it may now
			// be confirmed). Restore it only if no concurrent writer already won.
			try {
				linkSync(displaced, path);
			} catch (error) {
				if (!isNodeError(error) || error.code !== "EEXIST") {
					throw error;
				}
			} finally {
				rmSync(displaced, { force: true });
			}
			return false;
		}
		try {
			writeFileSync(path, `${JSON.stringify(claim, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
			return true;
		} catch (error) {
			if (!isNodeError(error) || error.code !== "EEXIST") {
				throw error;
			}
			return false;
		} finally {
			rmSync(displaced, { force: true });
		}
	}
	return false;
}

/** Confirm only after the host-facing delivery operation succeeds. */
export function markTerminalNotificationReceipt(
	runId: string,
	requestId: string,
	host: string,
	sessionId: string,
): TerminalNotificationReceipt {
	const request = readTerminalNotificationRequest(runId);
	if (request === undefined || request.requestId !== requestId) {
		throw new Error(`Terminal notification generation '${requestId}' is no longer active for ${runId}`);
	}
	const path = terminalNotificationReceiptPath(runId, requestId, host, sessionId);
	const existing = readReceipt(path) ?? readReceipt(legacyTerminalNotificationReceiptPath(runId, host, sessionId));
	if (
		existing !== undefined &&
		existing.requestId === request.requestId &&
		existing.host === host &&
		existing.sessionId === sessionId &&
		existing.state === "confirmed"
	) {
		return existing as TerminalNotificationReceipt;
	}
	const receipt: TerminalNotificationReceipt = {
		version: 1,
		requestId: request.requestId,
		host,
		sessionId,
		state: "confirmed",
		deliveredAt: new Date().toISOString(),
	};
	mkdirSync(dirname(path), { recursive: true });
	atomicWriteJson(path, receipt);
	return receipt;
}

export function removeTerminalNotificationReceipt(
	runId: string,
	requestId: string,
	host: string,
	sessionId: string,
): void {
	rmSync(terminalNotificationReceiptPath(runId, requestId, host, sessionId), { force: true });
	rmSync(legacyTerminalNotificationReceiptPath(runId, host, sessionId), { force: true });
}

export function removeTerminalNotificationOutbox(runId: string): void {
	rmSync(join(resolveRunPaths(runId).runDir, TERMINAL_NOTIFICATION_DIR), { recursive: true, force: true });
}

function atomicWriteJson(path: string, value: unknown): void {
	const temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
	try {
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function readReceipt(
	path: string,
):
	| (Partial<TerminalNotificationReceipt> & Pick<TerminalNotificationReceipt, "requestId" | "host" | "sessionId">)
	| undefined {
	if (!existsSync(path)) {
		return undefined;
	}
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		if (typeof value.requestId !== "string" || typeof value.host !== "string" || typeof value.sessionId !== "string") {
			return undefined;
		}
		return value as Partial<TerminalNotificationReceipt> &
			Pick<TerminalNotificationReceipt, "requestId" | "host" | "sessionId">;
	} catch {
		return undefined;
	}
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableJson).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
