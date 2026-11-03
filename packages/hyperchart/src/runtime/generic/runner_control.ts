import { randomUUID } from "node:crypto";
import type { ChartEvent } from "../../core/types.js";
import type { BranchId } from "../../core/durable_events.js";
import type { RunLogStore, UserInteractionResponseCommit } from "./log_store.js";
import { openRunLogStore } from "./log_store_factory.js";
import { isRunLive } from "./run_status_model.js";
import {
	CONTROL_VERSION,
	isMoveCommit,
	RunnerControlUnavailableError,
	type RunnerControlRequest,
	type RunnerControlResult,
	type RunnerMoveBranchCommit,
	type RunnerMoveBranchRequest,
	type RunnerUserResponseRequest,
} from "./runner_control_model.js";

export {
	RunnerControlUnavailableError,
	type RunnerControlRequest,
	type RunnerControlResult,
	type RunnerMoveBranchCommit,
	type RunnerMoveBranchRequest,
	type RunnerMoveBranchResult,
	type RunnerUserResponseRequest,
	type RunnerUserResponseResult,
} from "./runner_control_model.js";

export type RunnerControlCommit = UserInteractionResponseCommit | RunnerMoveBranchCommit;

/** Fallback wake-ups only; change notifications normally wake waiters within milliseconds. */
const HOST_WAIT_FALLBACK_MS = 1_000;
const RUNNER_WAIT_FALLBACK_MS = 1_000;
const CONTROL_TIMEOUT_MS = 30_000;

/** Submit a gate response through the owning live runtime and wait for its durable acknowledgement. */
export async function requestLiveRunnerUserResponse(
	runId: string,
	input: { attemptId: string; branchId: BranchId; gateSeqId: number; event: ChartEvent },
	options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<UserInteractionResponseCommit> {
	const request: RunnerUserResponseRequest = {
		version: CONTROL_VERSION,
		kind: "respond_user_interaction",
		id: randomUUID(),
		attemptId: input.attemptId,
		branchId: input.branchId,
		gateSeqId: input.gateSeqId,
		event: input.event,
		createdAt: Date.now(),
	};
	const result = await publishAndWait(runId, request, options);
	if (result.kind !== "respond_user_interaction") {
		throw new RunnerControlUnavailableError("Runner returned the wrong control result kind");
	}
	return { record: result.record, idempotent: result.idempotent };
}

/** Submit a live branch-head move through the owning runtime's sealed writer. */
export async function requestLiveRunnerBranchMove(
	runId: string,
	input: { attemptId: string; branchId: BranchId; targetHeadSeqId: number | null },
	options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<RunnerMoveBranchCommit> {
	const request: RunnerMoveBranchRequest = {
		version: CONTROL_VERSION,
		kind: "move_branch",
		id: randomUUID(),
		attemptId: input.attemptId,
		branchId: input.branchId,
		targetHeadSeqId: input.targetHeadSeqId,
		createdAt: Date.now(),
	};
	const result = await publishAndWait(runId, request, options);
	if (result.kind !== "move_branch") {
		throw new RunnerControlUnavailableError("Runner returned the wrong control result kind");
	}
	return {
		moveSeqId: result.moveSeqId,
		previousHeadSeqId: result.previousHeadSeqId,
		preservedRecords: result.preservedRecords,
	};
}

/**
 * Runner-owned control drain. Commands are transport only; the journal remains
 * semantic truth. The wait is persistent: it keeps a detached runtime alive while
 * every branch is durably parked at a user gate. Controller shutdown disposes it.
 */
export function watchRunnerControl(
	runId: string,
	attemptId: string,
	deliver: (request: RunnerControlRequest) => Promise<RunnerControlCommit>,
): () => void {
	const controller = new AbortController();
	void (async () => {
		const store = await openRunLogStore(runId, { access: "read" });
		try {
			while (!controller.signal.aborted) {
				// Arm before draining: a request published during the drain wakes the next iteration at once.
				const wait = store.watchRunChange(["control"], {
					timeoutMs: RUNNER_WAIT_FALLBACK_MS,
					signal: controller.signal,
					persistent: true,
				});
				await drainControlRequests(store, attemptId, deliver, controller.signal);
				await wait.changed;
			}
		} catch (error) {
			if (!controller.signal.aborted) {
				console.warn(`Hyperchart runner control watcher stopped: ${errorMessage(error)}`);
			}
		} finally {
			await store.close();
		}
	})();
	return () => controller.abort();
}

/** Backward-compatible response-only watcher used by focused admission tests. */
export function watchRunnerUserResponses(
	runId: string,
	attemptId: string,
	deliver: (request: RunnerUserResponseRequest) => Promise<UserInteractionResponseCommit>,
): () => void {
	return watchRunnerControl(runId, attemptId, (request) => {
		if (request.kind !== "respond_user_interaction") {
			return Promise.reject(new Error("This runner control watcher does not accept branch moves"));
		}
		return deliver(request);
	});
}

async function drainControlRequests(
	store: RunLogStore,
	attemptId: string,
	deliver: (request: RunnerControlRequest) => Promise<RunnerControlCommit>,
	signal: AbortSignal,
): Promise<void> {
	for (const request of await store.listControlRequests()) {
		if (signal.aborted) {
			return;
		}
		if (request.attemptId !== attemptId) {
			await store.discardControlRequest(request.id);
			continue;
		}
		const result = await resultFor(request, attemptId, deliver);
		// A result already published for this id (for example by a previous drain
		// interrupted before discarding the request) stays; this request is done either way.
		await store.publishControlResult(result);
		await store.discardControlRequest(request.id);
	}
}

async function resultFor(
	request: RunnerControlRequest,
	attemptId: string,
	deliver: (request: RunnerControlRequest) => Promise<RunnerControlCommit>,
): Promise<RunnerControlResult> {
	try {
		const committed = await deliver(request);
		if (request.kind === "move_branch") {
			if (!isMoveCommit(committed)) {
				throw new Error("Runner move control returned invalid commit metadata");
			}
			return {
				version: CONTROL_VERSION,
				kind: request.kind,
				requestId: request.id,
				attemptId,
				ok: true,
				...committed,
				completedAt: Date.now(),
			};
		}
		if (typeof committed !== "object" || committed === null || !("record" in committed)) {
			throw new Error("Runner response control returned an invalid commit");
		}
		return {
			version: CONTROL_VERSION,
			kind: request.kind,
			requestId: request.id,
			attemptId,
			ok: true,
			idempotent: committed.idempotent,
			record: committed.record,
			completedAt: Date.now(),
		};
	} catch (error) {
		return {
			version: CONTROL_VERSION,
			kind: request.kind,
			requestId: request.id,
			attemptId,
			ok: false,
			error: errorMessage(error),
			completedAt: Date.now(),
		};
	}
}

async function publishAndWait(
	runId: string,
	request: RunnerControlRequest,
	options: { timeoutMs?: number; pollMs?: number },
): Promise<Extract<RunnerControlResult, { ok: true }>> {
	const timeoutMs = options.timeoutMs ?? CONTROL_TIMEOUT_MS;
	const fallbackMs = options.pollMs ?? HOST_WAIT_FALLBACK_MS;
	const started = Date.now();
	const store = await openRunLogStore(runId, { access: "read" });
	try {
		await store.publishControlRequest(request);
		const abandon = async (message: string): Promise<never> => {
			await store.discardControlRequest(request.id);
			throw new RunnerControlUnavailableError(message);
		};
		for (;;) {
			// Arm before reading so an acknowledgement landing mid-read is not lost to the fallback.
			const wait = store.watchRunChange(["control", "status"], {
				timeoutMs: Math.min(fallbackMs, Math.max(1, timeoutMs - (Date.now() - started))),
			});
			const result = await store.readControlResult(request.id);
			if (result !== undefined) {
				wait.cancel();
				await store.discardControlResult(request.id);
				if (result.attemptId !== request.attemptId) {
					throw new RunnerControlUnavailableError("Runner attempt changed before control acknowledgement");
				}
				if (result.kind !== request.kind) {
					throw new RunnerControlUnavailableError("Runner returned the wrong control result kind");
				}
				if (!result.ok) {
					throw new Error(result.error);
				}
				return result;
			}
			const status = await store.readRunStatus();
			if (!isRunLive(status) || status?.attemptId !== request.attemptId) {
				wait.cancel();
				await abandon("Owning Hyperchart runtime stopped before control acknowledgement");
			}
			if (Date.now() - started >= timeoutMs) {
				wait.cancel();
				await abandon("Timed out waiting for owning Hyperchart runtime control acknowledgement");
			}
			await wait.changed;
		}
	} finally {
		await store.close();
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
