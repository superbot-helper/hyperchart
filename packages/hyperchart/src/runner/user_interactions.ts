import { StaleUserInteractionError } from "../execution/user_interaction.js";
import { assertRunId, currentRunStorage, resolveRunPaths } from "../runtime/generic/run_paths.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseChartModuleSync } from "../core/inspect.js";
import type { BranchId, ResolvedGateLog, UserInteractionOpenedLog } from "../core/durable_events.js";
import type { ActionUID, ChartEvent, SchemaAst } from "../core/types.js";
import { listRunIds, loadRunMeta, type RunMeta } from "../runtime/generic/run_dir.js";
import { openRunLogStore } from "../runtime/generic/log_store_factory.js";
import { BranchHeadMovedError, collectBranches } from "../runtime/generic/log_store.js";
import { BranchExecution } from "../execution/branch_execution.js";
import { requestLiveRunnerUserResponse, RunnerControlUnavailableError } from "../runtime/generic/runner_control.js";
import { isRunLive, readRunStatus } from "../runtime/generic/run_status.js";

/** Presentation-only directory. Semantic requests and answers live exclusively in the journal. */
export const USER_INTERACTIONS_DIR = "user-interactions";
export const USER_INTERACTION_ARBITER_DIR = ".user-interaction-arbiter";
export const USER_INTERACTION_CLAIM_LEASE_MS = 30_000;
export const USER_INTERACTION_WAIT_LEASE_MS = 5 * 60_000;

const MAX_SCAN_CHART_CACHE_ENTRIES = 64;
type ParsedChartModule = Extract<ReturnType<typeof parseChartModuleSync>, { ok: true }>;
const scanChartCache = new Map<string, { sourceHash: string; parsed: ParsedChartModule }>();
// Run metadata becomes immutable after its initial durable write. Interaction
// coordinators scan the shared runs root frequently, so retain successful reads
// and coalesce concurrent scans instead of reconnecting to Postgres per run.
const scanRunMetaCache = new Map<string, Promise<RunMeta>>();

function loadRunMetaForOwnedScan(runId: string): Promise<RunMeta> {
	const key = JSON.stringify([currentRunStorage(), runId]);
	const cached = scanRunMetaCache.get(key);
	if (cached !== undefined) {
		return cached;
	}
	const pending = loadRunMeta(runId);
	scanRunMetaCache.set(key, pending);
	void pending.catch(() => {
		if (scanRunMetaCache.get(key) === pending) {
			scanRunMetaCache.delete(key);
		}
	});
	return pending;
}

export type UserInteractionCoordinate = Readonly<{ runId: string; branchId: BranchId; seqId: number }>;
export type UserInteractionRequest = Readonly<{
	version: 2;
	runId: string;
	branchId: BranchId;
	seqId: number;
	actionUid: ActionUID;
	prompt: string;
	options: readonly string[];
	events: readonly string[];
	reply?: SchemaAst;
	createdAt: string;
}>;
export type UserInteractionResponse = Readonly<{
	version: 2;
	runId: string;
	branchId: BranchId;
	seqId: number;
	event: ChartEvent;
	createdAt: string;
}>;
export type UserInteractionReceipt = Readonly<{
	version: 2;
	runId: string;
	branchId: BranchId;
	seqId: number;
	host: string;
	sessionId: string;
	state: "claimed" | "confirmed";
	source?: string;
	claimedAt?: string;
	leaseUntil?: string;
	deliveredAt?: string;
}>;
export type UserInteractionOwner = Readonly<{ runsRoot: string; host: string; sessionId: string; workDir: string }>;
export type OwnedUserInteraction = Readonly<{
	runId: string;
	request: UserInteractionRequest;
	presentation: "pending" | "claimed" | "confirmed";
	presentationOrder?: bigint;
}>;
export type UserInteractionArbiterRecord = Readonly<{
	version: 2;
	host: string;
	sessionId: string;
	workDir: string;
	runId: string;
	branchId: BranchId;
	seqId: number;
	pinnedAt: string;
}>;
export type PersistUserInteractionResponseOptions = Readonly<{
	runId: string;
	branchId: BranchId;
	seqId: number;
	event: ChartEvent;
	owner?: UserInteractionOwner;
}>;

export function userInteractionDir(runId: string, branchId: BranchId, seqId: number): string {
	assertBranchId(branchId);
	assertSeqId(seqId);
	return join(resolveRunPaths(runId).runDir, USER_INTERACTIONS_DIR, branchId, String(seqId));
}

export function userInteractionReceiptPath(
	runId: string,
	branchId: BranchId,
	seqId: number,
	host: string,
	sessionId: string,
): string {
	const key = createHash("sha256").update(`${host}\0${sessionId}`).digest("hex");
	return join(userInteractionDir(runId, branchId, seqId), "receipts", `${key}.claim.json`);
}
function confirmationPath(runId: string, branchId: BranchId, seqId: number, host: string, sessionId: string): string {
	return userInteractionReceiptPath(runId, branchId, seqId, host, sessionId).replace(
		/\.claim\.json$/,
		".confirmed.json",
	);
}

export function claimUserInteractionReceipt(
	runId: string,
	branchId: BranchId,
	seqId: number,
	host: string,
	sessionId: string,
	options: { now?: number; leaseMs?: number; source?: string } = {},
): boolean {
	const confirmed = readConfirmedReceipt(runId, branchId, seqId, host, sessionId);
	if (confirmed !== undefined) {
		writePublicationMarker(confirmationPath(runId, branchId, seqId, host, sessionId));
		return false;
	}
	const path = userInteractionReceiptPath(runId, branchId, seqId, host, sessionId);
	const existing = readReceipt(path);
	const now = options.now ?? Date.now();
	if (existing?.state === "claimed") {
		const until = existing.leaseUntil === undefined ? Number.NaN : Date.parse(existing.leaseUntil);
		if (Number.isFinite(until) && now < until) {
			writePublicationMarker(path);
			return false;
		}
		rmSync(path, { force: true });
		rmSync(`${path}.published`, { force: true });
	}
	const claim: UserInteractionReceipt = {
		version: 2,
		runId: runId,
		branchId,
		seqId,
		host,
		sessionId,
		state: "claimed",
		...(options.source === undefined ? {} : { source: options.source }),
		claimedAt: new Date(now).toISOString(),
		leaseUntil: new Date(now + (options.leaseMs ?? USER_INTERACTION_CLAIM_LEASE_MS)).toISOString(),
	};
	mkdirSync(join(userInteractionDir(runId, branchId, seqId), "receipts"), { recursive: true });
	try {
		writeJsonExclusive(path, claim);
		writePublicationMarker(path);
		return true;
	} catch (error) {
		if (isNodeError(error) && error.code === "EEXIST") {
			return false;
		}
		throw error;
	}
}

export function markUserInteractionReceipt(
	runId: string,
	branchId: BranchId,
	seqId: number,
	host: string,
	sessionId: string,
): UserInteractionReceipt {
	const existing = readConfirmedReceipt(runId, branchId, seqId, host, sessionId);
	if (existing !== undefined) {
		return existing;
	}
	const receipt: UserInteractionReceipt = {
		version: 2,
		runId: runId,
		branchId,
		seqId,
		host,
		sessionId,
		state: "confirmed",
		deliveredAt: new Date().toISOString(),
	};
	const path = confirmationPath(runId, branchId, seqId, host, sessionId);
	mkdirSync(join(userInteractionDir(runId, branchId, seqId), "receipts"), { recursive: true });
	try {
		writeJsonExclusive(path, receipt);
	} catch (error) {
		if (!isNodeError(error) || error.code !== "EEXIST") {
			throw error;
		}
		const raced = readConfirmedReceipt(runId, branchId, seqId, host, sessionId);
		if (raced === undefined) {
			throw error;
		}
		return raced;
	}
	writePublicationMarker(path);
	return receipt;
}

export function hasUserInteractionReceipt(
	runId: string,
	branchId: BranchId,
	seqId: number,
	host: string,
	sessionId: string,
): boolean {
	return readConfirmedReceipt(runId, branchId, seqId, host, sessionId) !== undefined;
}
export function readUserInteractionReceipt(
	runId: string,
	branchId: BranchId,
	seqId: number,
	host: string,
	sessionId: string,
): UserInteractionReceipt | undefined {
	return (
		readConfirmedReceipt(runId, branchId, seqId, host, sessionId) ??
		readReceipt(userInteractionReceiptPath(runId, branchId, seqId, host, sessionId))
	);
}
export function removeUserInteractionReceipt(
	runId: string,
	branchId: BranchId,
	seqId: number,
	host: string,
	sessionId: string,
): void {
	for (const path of [
		userInteractionReceiptPath(runId, branchId, seqId, host, sessionId),
		confirmationPath(runId, branchId, seqId, host, sessionId),
	]) {
		rmSync(path, { force: true });
		rmSync(`${path}.published`, { force: true });
	}
}
export function releaseActiveUserInteraction(owner: UserInteractionOwner, coordinate: UserInteractionCoordinate): void {
	if (canonicalPath(resolveRunPaths(coordinate.runId).storage.rootDir) !== canonicalPath(owner.runsRoot)) {
		throw new Error(`Run '${coordinate.runId}' is outside the configured runs root`);
	}
	removeUserInteractionReceipt(coordinate.runId, coordinate.branchId, coordinate.seqId, owner.host, owner.sessionId);
}

function parseChartForInteractionScan(chartPath: string, exportName?: string): ParsedChartModule {
	const absolutePath = resolve(chartPath);
	const cacheKey = `${absolutePath}\0${exportName ?? "default"}`;
	const sourceHash = createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
	const cached = scanChartCache.get(cacheKey);
	if (cached?.sourceHash === sourceHash) {
		// Refresh insertion order so the bounded map behaves as an LRU cache.
		scanChartCache.delete(cacheKey);
		scanChartCache.set(cacheKey, cached);
		return cached.parsed;
	}
	const parsed = parseChartModuleSync(absolutePath, exportName === undefined ? {} : { exportName });
	if (!parsed.ok) {
		throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
	}
	if (!scanChartCache.has(cacheKey) && scanChartCache.size >= MAX_SCAN_CHART_CACHE_ENTRIES) {
		const oldest = scanChartCache.keys().next().value;
		if (oldest !== undefined) {
			scanChartCache.delete(oldest);
		}
	}
	scanChartCache.set(cacheKey, { sourceHash, parsed });
	return parsed;
}

export async function scanOpenUserInteractions(runId: string, branchId?: BranchId): Promise<UserInteractionRequest[]> {
	return scanOpenUserInteractionsWithMeta(runId, await loadRunMeta(runId), branchId);
}

async function scanOpenUserInteractionsWithMeta(
	runId: string,
	meta: RunMeta,
	branchId?: BranchId,
): Promise<UserInteractionRequest[]> {
	const parsed = parseChartForInteractionScan(meta.chartPath, meta.exportName);
	const store = await openRunLogStore(runId, { access: "read", ...(branchId === undefined ? {} : { branchId }) });
	try {
		const branches = await collectBranches(store);
		const branchIds = branchId === undefined ? branches.map((branch) => branch.branchId) : [branchId];
		const result: UserInteractionRequest[] = [];
		for (const selected of branchIds) {
			if (!branches.some((branch) => branch.branchId === selected)) {
				continue;
			}
			const semantic = await BranchExecution.restore({
				ast: parsed.ast,
				branchId: selected,
				store: store.forBranch(selected),
				saveCheckpoint: "never",
			});
			for (const gate of semantic.openUserInteractions()) {
				// File-backed arbitration is exclusively for human user() requests.
				if (gate.type === "user_interaction") {
					result.push(requestFromOpened(runId, selected, gate));
				}
			}
		}
		return result.sort(compareCoordinates);
	} finally {
		await store.close();
	}
}

export async function scanOwnedOpenUserInteractions(ownerInput: UserInteractionOwner): Promise<OwnedUserInteraction[]> {
	const owner = normalizeOwner(ownerInput);
	const result: OwnedUserInteraction[] = [];
	for (const runId of await listRunIds()) {
		try {
			const meta = await loadRunMetaForOwnedScan(runId);
			await assertUserInteractionOwner(owner, runId, meta);
			for (const request of await scanOpenUserInteractionsWithMeta(runId, meta)) {
				const receipt = receiptState(runId, request, owner.host, owner.sessionId);
				result.push({
					runId,
					request,
					presentation: receipt.presentation,
					...(receipt.order === undefined ? {} : { presentationOrder: receipt.order }),
				});
			}
		} catch {
			/* isolate malformed/foreign runs */
		}
	}
	return result.sort((left, right) => compareCoordinates(left.request, right.request));
}
export async function acquireActiveUserInteraction(
	owner: UserInteractionOwner,
): Promise<OwnedUserInteraction | undefined> {
	return selectActiveUserInteraction(await scanOwnedOpenUserInteractions(owner));
}
export const readActiveUserInteraction = acquireActiveUserInteraction;

export async function validateAndPersistUserInteractionResponse(
	options: PersistUserInteractionResponseOptions,
): Promise<{ response: UserInteractionResponse; idempotent: boolean }> {
	assertRunCoordinate(options.runId, options.branchId, options.seqId);
	if (options.owner !== undefined) {
		await assertUserInteractionOwner(options.owner, options.runId);
	}
	const status = await readRunStatus(options.runId);
	if (isRunLive(status)) {
		if (status?.attemptId === undefined) {
			throw new Error(`Live run '${options.runId}' has no runner attempt identity`);
		}
		try {
			const committed = await requestLiveRunnerUserResponse(options.runId, {
				attemptId: status.attemptId,
				branchId: options.branchId,
				gateSeqId: options.seqId,
				event: options.event,
			});
			return {
				response: responseFromResolved(options.runId, options.branchId, committed.record),
				idempotent: committed.idempotent,
			};
		} catch (error) {
			// A runner may die after the liveness check. Only then may this API become the
			// temporary sole writer and retry the same idempotent journal operation offline.
			if (!(error instanceof RunnerControlUnavailableError) || isRunLive(await readRunStatus(options.runId))) {
				throw error;
			}
		}
	}
	return commitOfflineUserInteractionResponse(options);
}

async function commitOfflineUserInteractionResponse(
	options: PersistUserInteractionResponseOptions,
): Promise<{ response: UserInteractionResponse; idempotent: boolean }> {
	const meta = await loadRunMeta(options.runId);
	const parsed = parseChartModuleSync(
		meta.chartPath,
		meta.exportName === undefined ? {} : { exportName: meta.exportName },
	);
	if (!parsed.ok) {
		throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
	}
	let store = await openRunLogStore(options.runId, { access: "writer", branchId: options.branchId });
	try {
		for (let attempt = 0; attempt < 3; attempt++) {
			const snapshot = await store.captureSnapshot(options.branchId);
			const existing = await store.findUserInteractionResponse({
				headSeqId: snapshot.headSeqId,
				gateSeqId: options.seqId,
			});
			if (existing !== undefined) {
				if (!isDeepStrictEqual(existing.event, options.event)) {
					throw new Error(`Conflicting response for user interaction ${options.seqId}`);
				}
				return { response: responseFromResolved(options.runId, options.branchId, existing), idempotent: true };
			}
			const gate = await store.getRecord(options.seqId);
			if (
				(gate?.type !== "user_interaction" && gate?.type !== "gate") ||
				gate.kind !== "opened" ||
				!(await store.containsInHistory({ headSeqId: snapshot.headSeqId, seqId: options.seqId }))
			) {
				throw new StaleUserInteractionError(options.branchId, options.seqId);
			}
			const semantic = await BranchExecution.restore({
				ast: parsed.ast,
				branchId: options.branchId,
				store,
				saveCheckpoint: "never",
				snapshot,
			});
			const drafts = await semantic.prepareUserInteraction(gate, options.event, parsed.schemaRegistry);
			try {
				const records = await store.appendDraftsAtHead(
					{ expectedHeadSeqId: snapshot.headSeqId, drafts },
					semantic.prepareStampedCommit,
				);
				const record = records[0] as ResolvedGateLog;
				return { response: responseFromResolved(options.runId, options.branchId, record), idempotent: false };
			} catch (error) {
				const retryable =
					error instanceof BranchHeadMovedError ||
					(error instanceof Error && error.message.includes("Stale Hyperchart journal writer"));
				if (!retryable || attempt === 2) {
					throw error;
				}
				if (error.message.includes("Stale Hyperchart journal writer")) {
					await store.close();
					store = await openRunLogStore(options.runId, { access: "writer", branchId: options.branchId });
				}
			}
		}
		throw new Error("Unreachable offline user response retry state");
	} finally {
		await store.close();
	}
}

export async function readUserInteractionResponse(
	runId: string,
	branchId: BranchId,
	seqId: number,
): Promise<UserInteractionResponse | undefined> {
	const store = await openRunLogStore(runId, { access: "read", branchId });
	try {
		const snapshot = await store.captureSnapshot(branchId);
		const record = await store.findUserInteractionResponse({ headSeqId: snapshot.headSeqId, gateSeqId: seqId });
		return record === undefined ? undefined : responseFromResolved(runId, branchId, record);
	} finally {
		await store.close();
	}
}

export function userInteractionArbiterPath(owner: UserInteractionOwner): string {
	const normalized = normalizeOwner(owner);
	const key = createHash("sha256")
		.update(`${normalized.host}\0${normalized.sessionId}\0${normalized.workDir}`)
		.digest("hex");
	return join(normalized.runsRoot, USER_INTERACTION_ARBITER_DIR, `${key}.json`);
}

function requestFromOpened(
	runId: string,
	branchId: BranchId,
	opened: UserInteractionOpenedLog,
): UserInteractionRequest {
	return {
		version: 2,
		runId,
		branchId,
		seqId: opened.seqId,
		actionUid: opened.actionUid,
		prompt: opened.prompt,
		options: opened.options,
		events: opened.events,
		...(opened.reply === undefined ? {} : { reply: opened.reply }),
		createdAt: new Date(opened.timestamp).toISOString(),
	};
}
function responseFromResolved(runId: string, branchId: BranchId, resolved: ResolvedGateLog): UserInteractionResponse {
	return {
		version: 2,
		runId,
		branchId,
		seqId: resolved.gateSeqId,
		event: resolved.event,
		createdAt: new Date(resolved.timestamp).toISOString(),
	};
}
function selectActiveUserInteraction(candidates: OwnedUserInteraction[]): OwnedUserInteraction | undefined {
	for (const presentation of ["confirmed", "claimed"] as const) {
		const selected = candidates
			.filter((candidate) => candidate.presentation === presentation)
			.sort(comparePresentationOrder)[0];
		if (selected !== undefined) {
			return selected;
		}
	}
	return candidates[0];
}
function comparePresentationOrder(left: OwnedUserInteraction, right: OwnedUserInteraction): number {
	if (left.presentationOrder !== undefined && right.presentationOrder !== undefined) {
		if (left.presentationOrder < right.presentationOrder) {
			return -1;
		}
		if (left.presentationOrder > right.presentationOrder) {
			return 1;
		}
	}
	return compareCoordinates(left.request, right.request);
}
function compareCoordinates(left: UserInteractionCoordinate, right: UserInteractionCoordinate): number {
	return (
		left.runId.localeCompare(right.runId) || left.branchId.localeCompare(right.branchId) || left.seqId - right.seqId
	);
}
function receiptState(
	runId: string,
	request: UserInteractionRequest,
	host: string,
	sessionId: string,
): { presentation: OwnedUserInteraction["presentation"]; order?: bigint } {
	const confirmed = confirmationPath(runId, request.branchId, request.seqId, host, sessionId);
	if (readConfirmedReceipt(runId, request.branchId, request.seqId, host, sessionId) !== undefined) {
		const order = publicationOrder(confirmed);
		return { presentation: "confirmed", ...(order === undefined ? {} : { order }) };
	}
	const claim = userInteractionReceiptPath(runId, request.branchId, request.seqId, host, sessionId);
	if (readReceipt(claim)?.state === "claimed") {
		const order = publicationOrder(claim);
		return { presentation: "claimed", ...(order === undefined ? {} : { order }) };
	}
	return { presentation: "pending" };
}
function readConfirmedReceipt(
	runId: string,
	branchId: BranchId,
	seqId: number,
	host: string,
	sessionId: string,
): UserInteractionReceipt | undefined {
	const value = readReceipt(confirmationPath(runId, branchId, seqId, host, sessionId));
	return value?.state === "confirmed" ? value : undefined;
}
function readReceipt(path: string): UserInteractionReceipt | undefined {
	if (!existsSync(path)) {
		return undefined;
	}
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as UserInteractionReceipt;
		return value.version === 2 && (value.state === "claimed" || value.state === "confirmed") ? value : undefined;
	} catch {
		return undefined;
	}
}
function publicationOrder(path: string): bigint | undefined {
	try {
		return statSync(`${path}.published`, { bigint: true }).ctimeNs;
	} catch {
		return undefined;
	}
}
function writePublicationMarker(path: string): void {
	try {
		writeFileSync(`${path}.published`, "", { flag: "wx" });
	} catch {}
}
function writeJsonExclusive(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
	try {
		linkSync(temp, path);
	} finally {
		rmSync(temp, { force: true });
	}
}
async function assertUserInteractionOwner(
	ownerInput: UserInteractionOwner,
	runId: string,
	knownMeta?: RunMeta,
): Promise<void> {
	const owner = normalizeOwner(ownerInput);
	if (canonicalPath(resolveRunPaths(runId).storage.rootDir) !== canonicalPath(owner.runsRoot)) {
		throw new Error(`Run '${runId}' is outside the configured runs root`);
	}
	const meta = knownMeta ?? (await loadRunMeta(runId));
	if (meta.originSessionId !== owner.sessionId) {
		throw new Error(`Run '${runId}' is not owned by this session`);
	}
	if (canonicalPath(meta.workDir) !== owner.workDir) {
		throw new Error(`Run '${runId}' belongs to another working directory`);
	}
}
function normalizeOwner(owner: UserInteractionOwner) {
	return {
		runsRoot: canonicalPath(owner.runsRoot),
		host: owner.host,
		sessionId: owner.sessionId,
		workDir: canonicalPath(owner.workDir),
	};
}
function canonicalPath(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync.native(absolute);
	} catch {
		return absolute;
	}
}
function assertRunCoordinate(runId: string, branchId: BranchId, seqId: number): void {
	assertBranchId(branchId);
	assertSeqId(seqId);
	assertRunId(runId);
}
function assertBranchId(value: string): void {
	if (value.length === 0 || value.length > 128 || /[\0/\\]/.test(value)) {
		throw new Error("branchId is invalid");
	}
}
function assertSeqId(value: number): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error("seqId must be a positive safe integer");
	}
}
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
