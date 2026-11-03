import {
	withRunStorage,
	resolveRunPaths,
	type RunStorage,
} from "../../packages/hyperchart/src/runtime/generic/run_paths.js";
import { collectHistoryRecords } from "../helpers/history.js";
import { commitUserInteractionResponse } from "../helpers/user_interaction_commit.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseChartModuleSync } from "../../packages/hyperchart/src/core/inspect.js";
import { createBranchProjection, projectBranch } from "../../packages/hyperchart/src/core/projection.js";
import type { ChartAst } from "../../packages/hyperchart/src/core/types.js";
import { JsonlLogStore } from "../../packages/hyperchart/src/runtime/generic/log_store.js";
import { MemoryLogStore } from "../../packages/hyperchart/src/runtime/generic/memory_log_store.js";
import { StaleUserInteractionError } from "../../packages/hyperchart/src/execution/user_interaction.js";
import { saveRunMeta } from "../../packages/hyperchart/src/runtime/generic/run_dir.js";
import { patchRunStatus } from "../../packages/hyperchart/src/runtime/generic/run_status.js";
import { watchRunnerUserResponses } from "../../packages/hyperchart/src/runtime/generic/runner_control.js";
import {
	acquireActiveUserInteraction,
	claimUserInteractionReceipt,
	hasUserInteractionReceipt,
	markUserInteractionReceipt,
	readUserInteractionResponse,
	scanOpenUserInteractions,
	scanOwnedOpenUserInteractions,
	userInteractionDir,
	validateAndPersistUserInteractionResponse,
	type UserInteractionOwner,
} from "../../packages/hyperchart/src/runner/user_interactions.js";

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

async function fixture(reply = false, loadCounterKey?: string) {
	const root = mkdtempSync(join(tmpdir(), "hyperchart-journal-input-"));
	roots.push(root);
	const runsRoot = join(root, "runs"),
		workDir = join(root, "project"),
		chartPath = join(workDir, "chart.ts");
	const runId = "run-a";
	const storage: RunStorage = { kind: "jsonl", rootDir: runsRoot, layout: "sha256" };
	const runDir = resolveRunPaths(runId, storage).runDir;
	mkdirSync(runsRoot);
	mkdirSync(workDir);
	writeFileSync(
		chartPath,
		`
		import { chart, final, user } from "@surprisal/hyperchart";
		${loadCounterKey === undefined ? "" : `(globalThis as any)[${JSON.stringify(loadCounterKey)}] = ((globalThis as any)[${JSON.stringify(loadCounterKey)}] ?? 0) + 1;`}
		export default chart({ id: "chart", initial: "ask", states: {
			ask: { kind: "state", action: user({ prompt: "Approve?", options: ["APPROVED"] }), transitions: { APPROVED: "done" } },
			done: final(),
		} });
	`,
	);
	const parsed = parseChartModuleSync(chartPath);
	if (!parsed.ok) {
		throw new Error(parsed.diagnostics.map((d) => d.message).join("\n"));
	}
	await withRunStorage(storage, () =>
		saveRunMeta(runId, {
			chartPath,
			workDir,
			chartId: "chart",
			createdAt: new Date().toISOString(),
			originSessionId: "session-a",
		}),
	);
	const store = new JsonlLogStore(join(runDir, "log.jsonl"));
	await store.initializeRootBranch();
	const state = parsed.ast.states.ask;
	if (state?.kind !== "state" || state.action.kind !== "user") {
		throw new Error("bad fixture");
	}
	await store.appendDrafts([{ type: "args", args: {} }]);
	const [invoke] = await store.appendDrafts([
		{
			type: "state_action",
			kind: "invoke",
			sessionId: "session-id",
			actionUid: state.action.uid,
			definition: state.action,
		},
	]);
	const replySchema = reply
		? {
				kind: "jsonSchema" as const,
				schema: {
					type: "object",
					properties: { note: { type: "string" } },
					required: ["note"],
					additionalProperties: false,
				},
			}
		: undefined;
	const [opened] = await store.appendDrafts([
		{
			type: "user_interaction",
			kind: "opened",
			actionUid: state.action.uid,
			phaseSeqId: invoke!.seqId,
			prompt: "Approve?",
			options: ["APPROVED"],
			events: ["APPROVED"],
			...(replySchema === undefined ? {} : { reply: replySchema }),
		},
	]);
	return {
		root,
		runId,
		storage,
		runsRoot,
		workDir,
		runDir,
		chartPath,
		ast: parsed.ast,
		store,
		gateSeqId: opened!.seqId,
	};
}
function owner(runsRoot: string, workDir: string): UserInteractionOwner {
	return { runsRoot, workDir, sessionId: "session-a", host: "test" };
}

async function gateFixture() {
	const root = mkdtempSync(join(tmpdir(), "hyperchart-host-gate-"));
	roots.push(root);
	const runsRoot = join(root, "runs");
	const workDir = join(root, "project");
	const chartPath = join(workDir, "chart.ts");
	const runId = "run-gate";
	const storage: RunStorage = { kind: "jsonl", rootDir: runsRoot, layout: "sha256" };
	const runDir = resolveRunPaths(runId, storage).runDir;
	mkdirSync(runsRoot);
	mkdirSync(workDir);
	writeFileSync(
		chartPath,
		`
		import { chart, final, gate } from "@surprisal/hyperchart";
		export default chart({ id: "gate-chart", initial: "wait", states: {
			wait: { kind: "state", action: gate({ event: "approval.requested", payload: { id: "r-1" } }), transitions: { APPROVED: "done" } },
			done: final(),
		} });
	`,
	);
	const parsed = parseChartModuleSync(chartPath);
	if (!parsed.ok) {
		throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
	}
	await withRunStorage(storage, () =>
		saveRunMeta(runId, {
			chartPath,
			workDir,
			chartId: "gate-chart",
			createdAt: new Date().toISOString(),
			originSessionId: "session-a",
		}),
	);
	const store = new JsonlLogStore(join(runDir, "log.jsonl"));
	await store.initializeRootBranch();
	const state = parsed.ast.states.wait;
	if (state?.kind !== "state" || state.action.kind !== "gate") {
		throw new Error("bad gate fixture");
	}
	const [invoke] = await store.appendDrafts([
		{
			type: "state_action",
			kind: "invoke",
			sessionId: "gate-session",
			actionUid: state.action.uid,
			definition: state.action,
		},
	]);
	const [opened] = await store.appendDrafts([
		{
			type: "gate",
			kind: "opened",
			actionUid: state.action.uid,
			phaseSeqId: invoke!.seqId,
			event: state.action.event,
			payload: { id: "r-1" },
		},
	]);
	return { runId, storage, store, ast: parsed.ast, invokeSeqId: invoke!.seqId, gateSeqId: opened!.seqId };
}

describe("journal-native user interactions", () => {
	it("derives an open rendered gate from selected journal ancestry without request.json", async () => {
		const f = await fixture();
		const requests = await withRunStorage(f.storage, () => scanOpenUserInteractions(f.runId, "main"));
		expect(requests).toEqual([
			expect.objectContaining({
				version: 2,
				runId: "run-a",
				branchId: "main",
				seqId: f.gateSeqId,
				prompt: "Approve?",
				events: ["APPROVED"],
			}),
		]);
		const projection = projectBranch(
			createBranchProjection(f.ast),
			f.ast,
			await collectHistoryRecords(f.store, "main"),
		);
		expect(Object.keys(projection.openUserInteractions)).toEqual([String(f.gateSeqId)]);
		expect(
			existsSync(
				join(
					withRunStorage(f.storage, () => userInteractionDir(f.runId, "main", f.gateSeqId)),
					"request.json",
				),
			),
		).toBe(false);
	});

	it("keeps host gates out of human interaction scans while allowing commit through the shared API", async () => {
		const f = await gateFixture();
		expect(await withRunStorage(f.storage, () => scanOpenUserInteractions(f.runId, "main"))).toEqual([]);
		const committed = await commitUserInteractionResponse(f.store, f.ast, f.gateSeqId, {
			type: "APPROVED",
			output: { source: "host" },
		});
		expect(committed).toMatchObject({
			idempotent: false,
			record: { type: "gate", kind: "resolved", gateSeqId: f.gateSeqId, event: { type: "APPROVED" } },
		});
		expect(
			await f.store.findUserInteractionResponse({
				headSeqId: (await f.store.captureSnapshot("main")).headSeqId,
				gateSeqId: f.gateSeqId,
			}),
		).toEqual(committed.record);
		expect(
			await commitUserInteractionResponse(f.store, f.ast, f.gateSeqId, {
				type: "APPROVED",
				output: { source: "host" },
			}),
		).toMatchObject({ idempotent: true, record: { type: "gate", gateSeqId: f.gateSeqId } });
		await expect(
			commitUserInteractionResponse(f.store, f.ast, f.gateSeqId, {
				type: "APPROVED",
				output: { source: "different-host" },
			}),
		).rejects.toThrow("Conflicting response");

		await f.store.moveBranch("main", f.invokeSeqId);
		await expect(
			commitUserInteractionResponse(f.store, f.ast, f.gateSeqId, {
				type: "APPROVED",
				output: { source: "host" },
			}),
		).rejects.toBeInstanceOf(StaleUserInteractionError);
	});

	it("reuses a parsed chart across interaction scans and invalidates it when source changes", async () => {
		const counterKey = `__hyperchart_scan_loads_${Date.now()}_${Math.random()}`;
		const state = globalThis as Record<string, unknown>;
		try {
			const f = await fixture(false, counterKey);
			expect(state[counterKey]).toBe(1);
			await withRunStorage(f.storage, () => scanOpenUserInteractions(f.runId, "main"));
			expect(state[counterKey]).toBe(2);
			await withRunStorage(f.storage, () => scanOpenUserInteractions(f.runId, "main"));
			expect(state[counterKey]).toBe(2);
			writeFileSync(f.chartPath, `${readFileSync(f.chartPath, "utf8")}\n// invalidate scan cache\n`);
			await withRunStorage(f.storage, () => scanOpenUserInteractions(f.runId, "main"));
			expect(state[counterKey]).toBe(3);
		} finally {
			delete state[counterKey];
		}
	});

	it("commits one resolved journal fact, retries identically, and conflicts divergently", async () => {
		const f = await fixture();
		const input = {
			runId: f.runId,
			branchId: "main",
			seqId: f.gateSeqId,
			event: { type: "APPROVED" },
			owner: owner(f.runsRoot, f.workDir),
		} as const;
		expect((await withRunStorage(f.storage, () => validateAndPersistUserInteractionResponse(input))).idempotent).toBe(
			false,
		);
		expect((await withRunStorage(f.storage, () => validateAndPersistUserInteractionResponse(input))).idempotent).toBe(
			true,
		);
		await expect(
			withRunStorage(f.storage, () =>
				validateAndPersistUserInteractionResponse({ ...input, event: { type: "APPROVED", output: "different" } }),
			),
		).rejects.toThrow(/Conflicting response/);
		expect(
			(await withRunStorage(f.storage, () => readUserInteractionResponse(f.runId, "main", f.gateSeqId)))?.event,
		).toEqual({ type: "APPROVED" });
		const refreshed = new JsonlLogStore(join(f.runDir, "log.jsonl"));
		const projection = projectBranch(
			createBranchProjection(f.ast),
			f.ast,
			await collectHistoryRecords(refreshed, "main"),
		);
		expect(projection.openUserInteractions).toEqual({});
		expect(
			existsSync(
				join(
					withRunStorage(f.storage, () => userInteractionDir(f.runId, "main", f.gateSeqId)),
					"resolution.json",
				),
			),
		).toBe(false);
	});

	it("reopens and reclassifies an identical stopped-JSONL head race", async () => {
		const f = await fixture();
		const original = JsonlLogStore.prototype.appendDraftsAtHead;
		let raced = false;
		vi.spyOn(JsonlLogStore.prototype, "appendDraftsAtHead").mockImplementation(async function (
			this: JsonlLogStore,
			input,
			prepare,
		) {
			if (!raced) {
				raced = true;
				await f.store.appendDrafts(input.drafts);
			}
			return original.call(this, input, prepare);
		});
		const result = await withRunStorage(f.storage, () =>
			validateAndPersistUserInteractionResponse({
				runId: f.runId,
				branchId: "main",
				seqId: f.gateSeqId,
				event: { type: "APPROVED" },
				owner: owner(f.runsRoot, f.workDir),
			}),
		);
		expect(result.idempotent).toBe(true);
	});

	it("reclassifies a divergent stopped-JSONL head race without a second append", async () => {
		const f = await fixture();
		const state = f.ast.states.ask;
		if (state?.kind !== "state" || state.action.kind !== "user") {
			throw new Error("bad fixture");
		}
		const original = JsonlLogStore.prototype.appendDraftsAtHead;
		let raced = false;
		vi.spyOn(JsonlLogStore.prototype, "appendDraftsAtHead").mockImplementation(async function (
			this: JsonlLogStore,
			input,
			prepare,
		) {
			if (!raced) {
				raced = true;
				await f.store.appendDrafts([
					{
						type: "user_interaction",
						kind: "resolved",
						gateSeqId: f.gateSeqId,
						actionUid: state.action.uid,
						event: { type: "APPROVED", output: "winner" },
					},
				]);
			}
			return original.call(this, input, prepare);
		});
		await expect(
			withRunStorage(f.storage, () =>
				validateAndPersistUserInteractionResponse({
					runId: f.runId,
					branchId: "main",
					seqId: f.gateSeqId,
					event: { type: "APPROVED", output: "loser" },
					owner: owner(f.runsRoot, f.workDir),
				}),
			),
		).rejects.toThrow(/Conflicting response/);
	});

	it("reclassifies a gate closed by a stopped-JSONL head race", async () => {
		const f = await fixture();
		const original = JsonlLogStore.prototype.appendDraftsAtHead;
		let raced = false;
		vi.spyOn(JsonlLogStore.prototype, "appendDraftsAtHead").mockImplementation(async function (
			this: JsonlLogStore,
			input,
			prepare,
		) {
			if (!raced) {
				raced = true;
				await f.store.appendDrafts([{ type: "failure_intent", origin: "ask", error: "closed" }]);
			}
			return original.call(this, input, prepare);
		});
		await expect(
			withRunStorage(f.storage, () =>
				validateAndPersistUserInteractionResponse({
					runId: f.runId,
					branchId: "main",
					seqId: f.gateSeqId,
					event: { type: "APPROVED" },
					owner: owner(f.runsRoot, f.workDir),
				}),
			),
		).rejects.toThrow(/stale or closed/);
	});

	it("routes a live response through the owning runner control API", async () => {
		const f = await fixture();
		const attemptId = "attempt-live";
		await withRunStorage(f.storage, () =>
			patchRunStatus(f.runId, {
				chartId: "chart",
				state: "running",
				branchIds: ["main"],
				attemptId,
				pid: process.pid,
				heartbeatAt: Date.now(),
			}),
		);
		const stop = withRunStorage(f.storage, () =>
			watchRunnerUserResponses(f.runId, attemptId, (request) =>
				commitUserInteractionResponse(f.store, f.ast, request.gateSeqId, request.event),
			),
		);
		try {
			const committed = await withRunStorage(f.storage, () =>
				validateAndPersistUserInteractionResponse({
					runId: f.runId,
					branchId: "main",
					seqId: f.gateSeqId,
					event: { type: "APPROVED" },
					owner: owner(f.runsRoot, f.workDir),
				}),
			);
			expect(committed.idempotent).toBe(false);
			expect(
				(await withRunStorage(f.storage, () => readUserInteractionResponse(f.runId, "main", f.gateSeqId)))?.event,
			).toEqual({ type: "APPROVED" });
		} finally {
			stop();
		}
	});

	it("validates reply schema before append", async () => {
		const f = await fixture(true);
		const base = { runId: f.runId, branchId: "main", seqId: f.gateSeqId, owner: owner(f.runsRoot, f.workDir) } as const;
		await expect(
			withRunStorage(f.storage, () =>
				validateAndPersistUserInteractionResponse({ ...base, event: { type: "APPROVED", output: { note: 1 } } }),
			),
		).rejects.toThrow(/reply schema/);
		expect(
			(
				await withRunStorage(f.storage, () =>
					validateAndPersistUserInteractionResponse({ ...base, event: { type: "APPROVED", output: { note: "ok" } } }),
				)
			).idempotent,
		).toBe(false);
	});

	it("allows offline response and treats timeout as a closed gate", async () => {
		const f = await fixture();
		await f.store.appendDrafts([{ type: "failure_intent", origin: "ask", error: "closed" }]);
		await expect(commitUserInteractionResponse(f.store, f.ast, f.gateSeqId, { type: "APPROVED" })).rejects.toThrow(
			/stale or closed/,
		);
	});

	it("uses only selected ancestry for idempotency after rewind", async () => {
		const f = await fixture();
		await commitUserInteractionResponse(f.store, f.ast, f.gateSeqId, { type: "APPROVED" });
		await f.store.moveBranch("main", f.gateSeqId);
		const second = await commitUserInteractionResponse(f.store, f.ast, f.gateSeqId, {
			type: "APPROVED",
			output: "alternate",
		});
		expect(second.idempotent).toBe(false);
		expect(second.record.parentId).toBe(f.gateSeqId);
	});

	it("serializes concurrent in-process memory responses to one winner", async () => {
		const f = await fixture();
		const memory = new MemoryLogStore();
		const state = f.ast.states.ask;
		if (state?.kind !== "state" || state.action.kind !== "user") {
			throw new Error("bad fixture");
		}
		const [invoke] = await memory.appendDrafts([
			{
				type: "state_action",
				kind: "invoke",
				sessionId: "session-id",
				actionUid: state.action.uid,
				definition: state.action,
			},
		]);
		const [opened] = await memory.appendDrafts([
			{
				type: "user_interaction",
				kind: "opened",
				actionUid: state.action.uid,
				phaseSeqId: invoke!.seqId,
				prompt: "Approve?",
				options: ["APPROVED"],
				events: ["APPROVED"],
			},
		]);
		const mem = await Promise.allSettled([
			commitUserInteractionResponse(memory, f.ast, opened!.seqId, { type: "APPROVED", output: "left" }),
			commitUserInteractionResponse(memory, f.ast, opened!.seqId, { type: "APPROVED", output: "right" }),
		]);
		expect(mem.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
	});

	it("does not expose gates after durable failure", async () => {
		const f = await fixture();
		await f.store.appendDrafts([{ type: "failure_intent", origin: "ask", error: "failed" }]);
		expect(await withRunStorage(f.storage, () => scanOpenUserInteractions(f.runId, "main"))).toEqual([]);
	});

	it("keeps presentation receipts as sidecars without changing semantic openness", async () => {
		const f = await fixture();
		const owned = owner(f.runsRoot, f.workDir);
		const active = await withRunStorage(f.storage, () => acquireActiveUserInteraction(owned));
		expect(active?.request.seqId).toBe(f.gateSeqId);
		expect(
			withRunStorage(f.storage, () => claimUserInteractionReceipt(f.runId, "main", f.gateSeqId, "test", "session-a")),
		).toBe(true);
		withRunStorage(f.storage, () => markUserInteractionReceipt(f.runId, "main", f.gateSeqId, "test", "session-a"));
		expect(
			withRunStorage(f.storage, () => hasUserInteractionReceipt(f.runId, "main", f.gateSeqId, "test", "session-a")),
		).toBe(true);
		const scanned = await withRunStorage(f.storage, () => scanOwnedOpenUserInteractions(owned));
		expect(scanned[0]?.presentation).toBe("confirmed");
	});
});
