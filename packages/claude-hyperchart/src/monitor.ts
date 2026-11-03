import { listRunIds, currentRunStorage, withRunStorage, type RunStorage } from "@surprisal/hyperchart/runtime";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	claimTerminalNotificationReceipt,
	hasTerminalNotificationReceipt,
	loadRunMeta,
	markTerminalNotificationReceipt,
	readDeliverableTerminalNotificationRequest,
	recoverStaleRunTerminalNotification,
	type TerminalNotificationRequest,
} from "@surprisal/hyperchart/runtime";
import {
	USER_INTERACTION_WAIT_LEASE_MS,
	acquireActiveUserInteraction,
	claimUserInteractionReceipt,
	markUserInteractionReceipt,
	readUserInteractionReceipt,
	scanOwnedOpenUserInteractions,
	type OwnedUserInteraction,
	type UserInteractionOwner,
} from "@surprisal/hyperchart/runner";
import { serializeModelEnvelope, summarizeUserGate } from "@surprisal/hyperchart/host";

export type ClaudeMonitorOptions = {
	runsRoot: string;
	storage?: RunStorage;
	cwd: string;
	sessionId?: string;
	/** Resolves once the line has been handed to the transport; a receipt is written only after that. */
	writeLine?: (line: string) => void | Promise<void>;
};

/** Default transport: one physical stdout line, awaited until the stream accepts or errors. */
function writeStdoutLine(line: string): Promise<void> {
	return new Promise((resolve, reject) => {
		process.stdout.write(`${line}\n`, (error) => (error === undefined || error === null ? resolve() : reject(error)));
	});
}

/** Backwards-compatible name retained for callers that only scan terminal notifications. */
export type ClaudeTerminalMonitorOptions = ClaudeMonitorOptions;

export type OwnedClaudeTerminalRequest = { runId: string; request: TerminalNotificationRequest };

export function claudeInteractionOwner(options: ClaudeMonitorOptions & { sessionId: string }): UserInteractionOwner {
	return { runsRoot: options.runsRoot, host: "claude", sessionId: options.sessionId, workDir: options.cwd };
}

export async function pendingOwnedClaudeTerminalRequests(
	options: ClaudeMonitorOptions,
): Promise<OwnedClaudeTerminalRequest[]> {
	if (!hasMonitorStorageScope(options)) {
		return withRunStorage(options.storage ?? { kind: "jsonl", rootDir: options.runsRoot, layout: "run-id" }, () =>
			pendingOwnedClaudeTerminalRequests(options),
		);
	}
	if (options.sessionId === undefined) {
		return [];
	}
	const pending: OwnedClaudeTerminalRequest[] = [];
	for (const runId of await listRunIds()) {
		try {
			const meta = await loadRunMeta(runId);
			if (canonicalPath(meta.workDir) !== canonicalPath(options.cwd) || meta.originSessionId !== options.sessionId) {
				continue;
			}
			await recoverStaleRunTerminalNotification(runId);
			const request = await readDeliverableTerminalNotificationRequest(runId);
			if (request === undefined || hasTerminalNotificationReceipt(runId, "claude", options.sessionId)) {
				continue;
			}
			pending.push({ runId, request });
		} catch {
			// A concurrently-created or unrelated malformed run must not break monitor routing.
		}
	}
	return pending.sort((left, right) => left.request.createdAt.localeCompare(right.request.createdAt));
}

export async function activeOwnedClaudeUserInteraction(
	options: ClaudeMonitorOptions,
): Promise<OwnedUserInteraction | undefined> {
	if (!hasMonitorStorageScope(options)) {
		return withRunStorage(options.storage ?? { kind: "jsonl", rootDir: options.runsRoot, layout: "run-id" }, () =>
			activeOwnedClaudeUserInteraction(options),
		);
	}
	if (options.sessionId === undefined) {
		return undefined;
	}
	return acquireActiveUserInteraction(claudeInteractionOwner({ ...options, sessionId: options.sessionId }));
}

export async function ownedClaudeUserInteractionSummary(options: ClaudeMonitorOptions): Promise<{
	active?: ReturnType<typeof claudeUserInteractionDetails> & { presentation: OwnedUserInteraction["presentation"] };
	queued: Array<
		ReturnType<typeof claudeUserInteractionDetails> & { presentation: OwnedUserInteraction["presentation"] }
	>;
}> {
	if (!hasMonitorStorageScope(options)) {
		return withRunStorage(options.storage ?? { kind: "jsonl", rootDir: options.runsRoot, layout: "run-id" }, () =>
			ownedClaudeUserInteractionSummary(options),
		);
	}
	if (options.sessionId === undefined) {
		return { queued: [] };
	}
	const owner = claudeInteractionOwner({ ...options, sessionId: options.sessionId });
	const interactions = await scanOwnedOpenUserInteractions(owner);
	const active = await acquireActiveUserInteraction(owner);
	const activeKey = active === undefined ? undefined : interactionKey(active);
	return {
		...(active === undefined
			? {}
			: { active: { ...claudeUserInteractionDetails(active), presentation: active.presentation } }),
		queued: interactions
			.filter((entry) => interactionKey(entry) !== activeKey)
			.map((entry) => ({ ...claudeUserInteractionDetails(entry), presentation: entry.presentation })),
	};
}

export function claudeUserInteractionDetails(interaction: OwnedUserInteraction) {
	return summarizeUserGate(interaction.request);
}

export function claudeUserInteractionInstruction(interaction: OwnedUserInteraction): string {
	const details = claudeUserInteractionDetails(interaction);
	return [
		`Hyperchart is waiting for real user input at (${details.runId}, ${details.branchId}, ${details.seqId}).`,
		`Question preview: ${details.promptPreview.text}`,
		details.options.length === 0
			? "This is a free-text question: use AskUserQuestion with an appropriate free-text/Other path and preserve the user's actual answer."
			: `Map these authored options to AskUserQuestion choices (label => exact value): ${details.options.map((option) => `${JSON.stringify(option.label.text)} => ${JSON.stringify(option.value)}`).join(", ")}.`,
		`Allowed response events: ${details.allowedEvents.join(", ")}.`,
		details.outputRequired
			? `Structured output is required. Bounded shape hint: ${JSON.stringify(details.outputHint)}.`
			: undefined,
		"Finish the current safe action first and start no unrelated work.",
		"Then call native AskUserQuestion once for this delivery attempt. If the same gate already has an in-flight question, do not open a concurrent duplicate; after interrupted-session recovery, ask it again. Never infer, fabricate, or supply the answer yourself.",
		`Immediately after the human answers, call hyperchart_respond with runId=${JSON.stringify(details.runId)}, branchId=${JSON.stringify(details.branchId)}, seqId=${details.seqId}, one allowed event, and output when required by the bounded shape hint.`,
		"Do not continue the workflow until hyperchart_respond confirms the durable commit. Repeated delivery of this same (runId, branchId, seqId) is recovery, not a second question.",
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

export function claudeUserInteractionNotification(interaction: OwnedUserInteraction) {
	const details = claudeUserInteractionDetails(interaction);
	return {
		customType: "hyperchart-user-request",
		runId: details.runId,
		branchId: details.branchId,
		seqId: details.seqId,
		content: claudeUserInteractionInstruction(interaction),
		details,
	};
}

/** Emit each prompt as JSON so embedded newlines remain one physical stdout line, then receipt it. */
export async function emitPendingClaudeTerminalNotifications(options: ClaudeMonitorOptions): Promise<number> {
	if (!hasMonitorStorageScope(options)) {
		return withRunStorage(options.storage ?? { kind: "jsonl", rootDir: options.runsRoot, layout: "run-id" }, () =>
			emitPendingClaudeTerminalNotifications(options),
		);
	}
	if (options.sessionId === undefined) {
		return 0;
	}
	const writeLine = options.writeLine ?? writeStdoutLine;
	let delivered = 0;
	for (const pending of await pendingOwnedClaudeTerminalRequests(options)) {
		if (!claimTerminalNotificationReceipt(pending.runId, pending.request.requestId, "claude", options.sessionId)) {
			continue;
		}
		if ((await readDeliverableTerminalNotificationRequest(pending.runId))?.requestId !== pending.request.requestId) {
			continue;
		}
		// Confirm only after stdout accepts the line. A crash between write and confirmation
		// intentionally permits at-least-once redelivery.
		await writeLine(
			serializeMonitorEnvelope({
				customType: "hyperchart-terminal",
				requestId: pending.request.requestId,
				content: `Hyperchart run ${pending.request.payload.runId} (${pending.request.payload.chartId}) reached ${pending.request.payload.outcome}. Open hyperchart_view for full results.`,
				details: {
					requestId: pending.request.requestId,
					runId: pending.request.payload.runId,
					chartId: pending.request.payload.chartId,
					outcome: pending.request.payload.outcome,
				},
			}),
		);
		markTerminalNotificationReceipt(pending.runId, pending.request.requestId, "claude", options.sessionId);
		delivered++;
	}
	return delivered;
}

/** Emit at most the arbiter's one pinned user gate, never a queued branch request. */
export async function emitPendingClaudeUserInteraction(options: ClaudeMonitorOptions): Promise<number> {
	if (!hasMonitorStorageScope(options)) {
		return withRunStorage(options.storage ?? { kind: "jsonl", rootDir: options.runsRoot, layout: "run-id" }, () =>
			emitPendingClaudeUserInteraction(options),
		);
	}
	if (options.sessionId === undefined) {
		return 0;
	}
	const active = await activeOwnedClaudeUserInteraction(options);
	if (active === undefined || active.presentation === "confirmed") {
		return 0;
	}
	const existingClaim = readUserInteractionReceipt(
		active.runId,
		active.request.branchId,
		active.request.seqId,
		"claude",
		options.sessionId,
	);
	// A waited MCP result is already the delivery path into this Claude turn. Do not
	// re-notify it after the normal monitor lease while AskUserQuestion is still open;
	// SessionStart recovery will re-surface it if that turn/session is interrupted.
	if (existingClaim?.state === "claimed" && existingClaim.source === "wait") {
		const leaseUntil = existingClaim.leaseUntil === undefined ? Number.NaN : Date.parse(existingClaim.leaseUntil);
		const fallbackUntil =
			existingClaim.claimedAt === undefined
				? Number.NaN
				: Date.parse(existingClaim.claimedAt) + USER_INTERACTION_WAIT_LEASE_MS;
		if (
			(Number.isFinite(leaseUntil) && Date.now() < leaseUntil) ||
			(!Number.isFinite(leaseUntil) && Number.isFinite(fallbackUntil) && Date.now() < fallbackUntil)
		) {
			return 0;
		}
	}
	// Defense in depth around the shared owner's canonical/session checks.
	const meta = await loadRunMeta(active.runId);
	if (meta.originSessionId !== options.sessionId || canonicalPath(meta.workDir) !== canonicalPath(options.cwd)) {
		return 0;
	}
	if (
		!claimUserInteractionReceipt(
			active.runId,
			active.request.branchId,
			active.request.seqId,
			"claude",
			options.sessionId,
			{ source: "monitor" },
		)
	) {
		return 0;
	}
	// Claim and selection are separate filesystem operations. Re-arbitrate after the
	// exclusive claim so a concurrently-created lower coordinate cannot be presented too.
	const current = await activeOwnedClaudeUserInteraction(options);
	if (current === undefined || interactionKey(current) !== interactionKey(active)) {
		return 0;
	}
	const writeLine = options.writeLine ?? writeStdoutLine;
	let notification: ClaudeMonitorEnvelope;
	try {
		notification = claudeUserInteractionNotification(current);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		notification = {
			customType: "hyperchart-boundary-error",
			content: `Hyperchart cannot safely deliver this user gate through the model boundary. ${reason}`,
			details: { error: "user-gate-summary-unavailable", seqId: current.request.seqId },
		};
	}
	await writeLine(serializeMonitorEnvelope(notification));
	markUserInteractionReceipt(
		current.runId,
		current.request.branchId,
		current.request.seqId,
		"claude",
		options.sessionId,
	);
	return 1;
}

/** Combined persistent-monitor scan for terminal notifications and the one active user gate. */
export async function emitPendingClaudeNotifications(options: ClaudeMonitorOptions): Promise<number> {
	if (!hasMonitorStorageScope(options)) {
		return withRunStorage(options.storage ?? { kind: "jsonl", rootDir: options.runsRoot, layout: "run-id" }, () =>
			emitPendingClaudeNotifications(options),
		);
	}
	return (await emitPendingClaudeTerminalNotifications(options)) + (await emitPendingClaudeUserInteraction(options));
}

type ClaudeMonitorEnvelope = {
	customType: string;
	content: string;
	requestId?: string;
	runId?: string;
	seqId?: number;
	details: Record<string, unknown>;
};

function serializeMonitorEnvelope(value: ClaudeMonitorEnvelope): string {
	return serializeModelEnvelope(
		value,
		({ digest, originalBytes, maxBytes }) =>
			({
				customType: "hyperchart-boundary-error",
				requestId: digest,
				content: `Hyperchart notification exceeded the model boundary (${digest}). Open hyperchart_view.`,
				details: {
					requestId: digest,
					runId: "unavailable",
					chartId: "unavailable",
					outcome: "failed",
					error: "model-envelope-too-large",
					digest,
					originalBytes,
					maxBytes,
				},
			}) as ClaudeMonitorEnvelope,
	);
}

function interactionKey(interaction: OwnedUserInteraction): string {
	return `${interaction.request.runId}\0${interaction.request.branchId}\0${interaction.request.seqId}`;
}

function canonicalPath(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync.native(absolute);
	} catch {
		return absolute;
	}
}

function hasMonitorStorageScope(options: ClaudeMonitorOptions): boolean {
	const active = currentRunStorage();
	if (active === undefined) {
		return false;
	}
	const configured: RunStorage = options.storage ?? { kind: "jsonl", rootDir: options.runsRoot, layout: "run-id" };
	return (
		active.kind === configured.kind &&
		active.layout === configured.layout &&
		resolve(active.rootDir) === resolve(configured.rootDir) &&
		(active.kind !== "postgres" || (configured.kind === "postgres" && active.dsn === configured.dsn))
	);
}
