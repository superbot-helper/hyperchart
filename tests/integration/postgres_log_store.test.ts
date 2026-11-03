import {
	withRunStorage,
	resolveRunPaths,
	type RunStorage,
} from "../../packages/hyperchart/src/runtime/generic/run_paths.js";
import { collectHistoryRecords } from "../helpers/history.js";
import {
	commitUserInteractionResponse,
	prepareUserInteractionCommit,
	type PreparedTestUserInteraction,
} from "../helpers/user_interaction_commit.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
	normalizeChartConfig,
	type ChartAst,
	type ChartCst,
	type DurableRecordDraft,
} from "../../packages/hyperchart/src/index.js";
import { chart, final, user } from "../../packages/hyperchart/src/core/dsl.js";
import {
	HISTORY_READ_ITEMS,
	HistoryCursorError,
	openExecutionReplay,
} from "../../packages/hyperchart/src/runtime/generic/log_store.js";
import {
	JOURNAL_CHANNEL,
	JOURNAL_TABLE,
	PostgresLogStore,
	readPostgresJournalPage,
	CHECKPOINT_TABLE,
	RUN_META_TABLE,
	RUN_STATUS_TABLE,
	CONTROL_TABLE,
} from "../../packages/hyperchart/src/runtime/generic/postgres_log_store.js";
import {
	CONTROL_VERSION,
	type RunnerControlRequest,
} from "../../packages/hyperchart/src/runtime/generic/runner_control_model.js";
import { openRunLogStore } from "../../packages/hyperchart/src/runtime/generic/log_store_factory.js";
import {
	deleteRunStorage,
	initializeRun,
	loadRunMeta,
	saveRunMeta,
} from "../../packages/hyperchart/src/runtime/generic/run_dir.js";
import { patchRunStatus, readRunStatus } from "../../packages/hyperchart/src/runtime/generic/run_status.js";
import { createPiHyperchartHost } from "../../packages/pi-hyperchart/src/runtime/pi/host_adapter.js";
import {
	loadBranchProjection,
	projectionContractForAst,
} from "../../packages/hyperchart/src/execution/projection_restore.js";

const dsn = process.env.HYPERCHART_PG_DSN;
const describePg = dsn === undefined ? describe.skip : describe;

const openStores: PostgresLogStore[] = [];
const usedRunIds: string[] = [];

async function openWriter(runId: string): Promise<PostgresLogStore> {
	const store = await PostgresLogStore.open({ dsn: dsn as string, runId, access: "writer" });
	openStores.push(store);
	return store;
}

async function openReader(runId: string): Promise<PostgresLogStore> {
	const store = await PostgresLogStore.open({ dsn: dsn as string, runId });
	openStores.push(store);
	return store;
}

function newRunId(): string {
	const runId = `test-${randomUUID()}`;
	usedRunIds.push(runId);
	return runId;
}

function argsDraft(args: Readonly<Record<string, unknown>> = { topic: "test" }): DurableRecordDraft {
	return { type: "args", args };
}

function invokeDraft(): DurableRecordDraft {
	const actionUid = { chart: "chart", state: "work", action: "agent" };
	return {
		type: "state_action",
		kind: "invoke",
		sessionId: "session-id",
		actionUid,
		definition: { kind: "agent", uid: actionUid, name: "worker", onFail: { nudge: 2, restart: 1 } },
	};
}

function userAst(): ChartAst {
	const config: ChartCst = chart({
		kind: "chart",
		id: "postgres-user",
		initial: "ask",
		states: {
			ask: {
				kind: "state",
				action: user({ prompt: "Select", options: ["SELECTED"] }),
				transitions: { SELECTED: "done" },
			},
			done: final(),
		},
	});
	const result = normalizeChartConfig(config);
	if (!result.ok) {
		throw new Error(JSON.stringify(result.diagnostics));
	}
	return result.ast;
}

async function appendOpenGate(store: PostgresLogStore, ast: ChartAst): Promise<number> {
	const state = ast.states.ask;
	if (state?.kind !== "state" || state.action.kind !== "user") {
		throw new Error("invalid user chart fixture");
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
	const [opened] = await store.appendDrafts([
		{
			type: "user_interaction",
			kind: "opened",
			actionUid: state.action.uid,
			phaseSeqId: invoke!.seqId,
			prompt: "Select",
			options: ["SELECTED"],
			events: ["SELECTED"],
		},
	]);
	return opened!.seqId;
}

async function journalStats(store: PostgresLogStore, runId: string): Promise<{ count: number; maxSeq: number }> {
	const result = await store.transaction((tx) =>
		tx.query(
			`SELECT COUNT(*)::int AS count, COALESCE(MAX(seq), 0)::int AS max_seq FROM ${JOURNAL_TABLE} WHERE run_id = $1`,
			[runId],
		),
	);
	return { count: Number(result.rows[0]?.count), maxSeq: Number(result.rows[0]?.max_seq) };
}

async function forkAndCommitUserInteraction<T>(
	store: PostgresLogStore,
	input: {
		sourceBranchId: string;
		newBranchId: string;
		fromSeqId: number;
		responseBranchId: string;
		metadata?: import("../../packages/hyperchart/src/core/durable_events.js").BranchMetadata;
		checkpoint?: import("../../packages/hyperchart/src/runtime/generic/log_store.js").OpaqueCheckpointEnvelope;
		preparedResponse: PreparedTestUserInteraction;
	},
	participate: import("../../packages/hyperchart/src/runtime/generic/postgres_log_store.js").SqlCommitParticipant<T>,
) {
	const prepared = input.preparedResponse;
	const committed = await store.forkAndAppend(
		{
			sourceBranchId: input.sourceBranchId,
			newBranchId: input.newBranchId,
			fromSeqId: input.fromSeqId,
			appendBranchId: input.responseBranchId,
			...(input.metadata === undefined ? {} : { metadata: input.metadata }),
			...(input.checkpoint === undefined ? {} : { checkpoint: input.checkpoint }),
			append: {
				expectedHeadSeqId: prepared.expectedHeadSeqId,
				drafts: prepared.existing === undefined ? prepared.drafts : [],
			},
			...(prepared.existing === undefined ? { prepare: prepared.semantic.prepareStampedCommit } : {}),
		},
		participate,
	);
	const response =
		prepared.existing === undefined
			? {
					record: committed
						.records[0] as import("../../packages/hyperchart/src/runtime/generic/log_store.js").UserInteractionResponseCommit["record"],
					idempotent: false,
				}
			: { record: prepared.existing, idempotent: true };
	return { branch: committed.branch, response, participant: committed.participant };
}

async function ensureClaimTable(store: PostgresLogStore): Promise<void> {
	await store.transaction(async (tx) => {
		await tx.query(`CREATE TABLE IF NOT EXISTS hyperchart_test_claims (
		  run_id text NOT NULL,
		  candidate integer NOT NULL,
		  branch_id text NOT NULL,
		  PRIMARY KEY (run_id, candidate)
		)`);
	});
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(openStores.splice(0).map((store) => store.close().catch(() => {})));
});

afterAll(async () => {
	if (dsn === undefined || usedRunIds.length === 0) {
		return;
	}
	const { Client } = await import("pg");
	const client = new Client({ connectionString: dsn });
	await client.connect();
	await client.query(`DELETE FROM ${CHECKPOINT_TABLE} WHERE run_id = ANY($1)`, [usedRunIds]).catch(() => {});
	await client.query(`DELETE FROM ${JOURNAL_TABLE} WHERE run_id = ANY($1)`, [usedRunIds]).catch(() => {});
	await client.query(`DELETE FROM ${RUN_META_TABLE} WHERE run_id = ANY($1)`, [usedRunIds]).catch(() => {});
	await client.query(`DELETE FROM ${RUN_STATUS_TABLE} WHERE run_id = ANY($1)`, [usedRunIds]).catch(() => {});
	await client.query(`DELETE FROM ${CONTROL_TABLE} WHERE run_id = ANY($1)`, [usedRunIds]).catch(() => {});
	await client.query("DELETE FROM hyperchart_test_claims WHERE run_id = ANY($1)", [usedRunIds]).catch(() => {});
	await client.end();
});

describePg("PostgresLogStore", () => {
	it("carries runner control through hyperchart_control and wakes waiters by NOTIFY", async () => {
		const runId = newRunId();
		const host = await openReader(runId);
		const runner = await openReader(runId);
		const request: RunnerControlRequest = {
			version: CONTROL_VERSION,
			kind: "move_branch",
			id: "req-1",
			attemptId: "attempt-a",
			branchId: "main",
			targetHeadSeqId: null,
			createdAt: 1,
		};
		// The runner parks on a long fallback; only the NOTIFY from the host's publish can wake it early.
		const runnerWoken = runner.watchRunChange(["control"], { timeoutMs: 20_000 }).changed.then(() => Date.now());
		await new Promise((resolve) => setTimeout(resolve, 100));
		const published = Date.now();
		await host.publishControlRequest(request);
		expect((await runnerWoken) - published).toBeLessThan(5_000);
		await expect(host.publishControlRequest(request)).rejects.toThrow(/already exists/);
		expect(await runner.listControlRequests()).toEqual([request]);

		const hostWoken = host.watchRunChange(["control", "status"], { timeoutMs: 20_000 }).changed.then(() => Date.now());
		await new Promise((resolve) => setTimeout(resolve, 100));
		const result = {
			version: CONTROL_VERSION,
			kind: "move_branch",
			requestId: "req-1",
			attemptId: "attempt-a",
			ok: true,
			moveSeqId: 3,
			previousHeadSeqId: 2,
			preservedRecords: 1,
			completedAt: 2,
		} as const;
		const resultPublished = Date.now();
		expect(await runner.publishControlResult(result)).toBe(true);
		expect(await runner.publishControlResult({ ...result, moveSeqId: 9 })).toBe(false);
		expect((await hostWoken) - resultPublished).toBeLessThan(5_000);
		expect(await host.readControlResult("req-1")).toMatchObject({ ok: true, moveSeqId: 3 });

		const statusWoken = host.watchRunChange(["status"], { timeoutMs: 20_000 }).changed.then(() => Date.now());
		await new Promise((resolve) => setTimeout(resolve, 100));
		const patched = Date.now();
		await runner.patchRunStatus({ chartId: "chart", state: "running", branchIds: ["main"] });
		expect((await statusWoken) - patched).toBeLessThan(5_000);

		await runner.discardControlRequest("req-1");
		await host.discardControlResult("req-1");
		expect(await runner.listControlRequests()).toEqual([]);
		expect(await host.readControlResult("req-1")).toBeUndefined();
	});

	it("keeps operational run status in hyperchart_run_status outside the writer claim", async () => {
		const runId = newRunId();
		const storage: RunStorage = { kind: "postgres", dsn: dsn as string, rootDir: tmpdir(), layout: "sha256" };
		const runDir = resolveRunPaths(runId, storage).runDir;
		// A host publishes "starting" through a read handle before any writer touched this run.
		const reader = await openReader(runId);
		expect(await reader.readRunStatus()).toBeUndefined();
		const starting = await reader.patchRunStatus({
			chartId: "status-chart",
			state: "starting",
			branchIds: ["main"],
			attemptId: "attempt-a",
			heartbeatAt: 100,
		});
		expect(starting).toMatchObject({ version: 2, runId, state: "starting", attemptId: "attempt-a" });

		// The live writer holds the journal claim; the host still patches status concurrently.
		const writer = await openWriter(runId);
		await writer.initializeRootBranch();
		await writer.patchRunStatus({ state: "running", pid: process.pid, heartbeatAt: Date.now() });
		await reader.patchRunStatus({ state: "stopping" });
		const stopping = await withRunStorage(storage, () => readRunStatus(runId));
		expect(stopping).toMatchObject({
			state: "stopping",
			chartId: "status-chart",
			branchIds: ["main"],
			attemptId: "attempt-a",
			pid: process.pid,
			startedAt: starting.startedAt,
		});

		// A key present in the patch wins even when undefined; replay warnings round-trip as JSON.
		await writer.patchRunStatus({
			state: "failed",
			branchIds: [],
			pid: undefined,
			heartbeatAt: undefined,
			exitCode: 1,
			error: "boom",
			replayWarnings: ["stale"],
		});
		const failed = await reader.readRunStatus();
		expect(failed).toMatchObject({
			state: "failed",
			branchIds: [],
			exitCode: 1,
			error: "boom",
			replayWarnings: ["stale"],
		});
		expect(failed?.pid).toBeUndefined();
		expect(failed?.heartbeatAt).toBeUndefined();
		expect(existsSync(join(runDir, "status.json"))).toBe(false);

		await writer.deleteRunData();
		expect(await reader.readRunStatus()).toBeUndefined();
	});

	it("pages the physical journal across branches and retains moves", async () => {
		const runId = newRunId();
		const store = await openWriter(runId);
		await store.initializeRootBranch();
		const [args] = await store.appendDrafts([argsDraft()]);
		await store.createBranch("fork", args!.seqId);
		const [invoked] = await store.forBranch("fork").appendDrafts([invokeDraft()]);
		await store.moveBranch("fork", args!.seqId);
		const { Client } = await import("pg");
		const client = new Client({ connectionString: dsn });
		await client.connect();
		try {
			const first = await readPostgresJournalPage(client, { runId, afterSeq: 0, limit: 3 });
			const second = await readPostgresJournalPage(client, { runId, afterSeq: first.at(-1)!.seqId, limit: 3 });
			expect(first.map((entry) => entry.seqId)).toEqual([1, 2, 3]);
			expect(second).toEqual([
				invoked,
				expect.objectContaining({ kind: "branch", op: "move", branchId: "fork", headSeqId: args!.seqId }),
			]);
			expect(await readPostgresJournalPage(client, { runId, afterSeq: second.at(-1)!.seqId })).toEqual([]);
		} finally {
			await client.end();
		}
	});

	it("honors an explicit durable run id distinct from the directory basename", async () => {
		const runId = newRunId();
		const storage: RunStorage = { kind: "postgres", dsn: dsn as string, rootDir: tmpdir(), layout: "sha256" };
		expect(resolveRunPaths(runId, storage).runDir).not.toBe(join(tmpdir(), runId));
		const store = await openRunLogStore(runId, {
			storage,
			access: "writer",
		});
		try {
			await store.initializeRootBranch();
			await store.appendDrafts([argsDraft()]);
			expect(await (await openReader(runId)).countRecords()).toBe(1);
		} finally {
			await store.close();
		}
	});

	it("stores run metadata in PostgreSQL without requiring meta.json", async () => {
		const runId = newRunId();
		const storage: RunStorage = { kind: "postgres", dsn: dsn as string, rootDir: tmpdir(), layout: "sha256" };
		const runDir = resolveRunPaths(runId, storage).runDir;
		await mkdir(runDir, { recursive: true });
		await withRunStorage(storage, () => initializeRun(runId));
		const meta = {
			chartPath: join(runDir, "workflow.chart.ts"),
			workDir: runDir,
			chartId: "postgres-meta",
			createdAt: new Date().toISOString(),
			originSessionId: "session-meta",
		};
		try {
			await withRunStorage(storage, () => saveRunMeta(runId, meta));
			expect(existsSync(join(runDir, "meta.json"))).toBe(false);
			expect(await withRunStorage(storage, () => loadRunMeta(runId))).toEqual({ ...meta, runId });
			await withRunStorage(storage, () => deleteRunStorage(runId));
			await expect(withRunStorage(storage, () => loadRunMeta(runId))).rejects.toMatchObject({ code: "ENOENT" });
			expect(await (await openReader(runId)).listBranches()).toEqual({ items: [], totalCount: 0 });
		} finally {
			await rm(runDir, { recursive: true, force: true });
		}
	});

	it("discovers a PostgreSQL-backed run without meta.json through the Pi host", async () => {
		const runId = newRunId();
		const root = join(tmpdir(), `postgres-meta-host-${randomUUID()}`);
		const agentDir = join(root, "agent");
		const workDir = join(root, "project");
		const storage: RunStorage = {
			kind: "postgres",
			dsn: dsn as string,
			rootDir: join(agentDir, "hypercharts", "runs"),
			layout: "sha256",
		};
		const runDir = resolveRunPaths(runId, storage).runDir;
		const chartPath = join(workDir, "postgres-meta.chart.ts");
		await mkdir(workDir, { recursive: true });
		await writeFile(
			chartPath,
			`import { chart, final } from "@surprisal/hyperchart";\nexport default chart({ kind: "chart", id: "postgres-meta-host", initial: "done", states: { done: final() } });\n`,
		);
		try {
			await withRunStorage(storage, () => initializeRun(runId));
			await withRunStorage(storage, () =>
				saveRunMeta(runId, {
					chartPath,
					workDir,
					chartId: "postgres-meta-host",
					createdAt: new Date().toISOString(),
					originSessionId: "session-host",
				}),
			);
			await withRunStorage(storage, () =>
				patchRunStatus(runId, { chartId: "postgres-meta-host", state: "stopped", branchIds: ["main"] }),
			);
			expect(existsSync(join(runDir, "meta.json"))).toBe(false);
			const snapshot = await createPiHyperchartHost({ agentDir, storage }).readSessionSnapshot(workDir);
			expect(snapshot.runs).toEqual([
				expect.objectContaining({
					runId,
					chartName: "postgres-meta-host",
					cwd: workDir,
					originSessionId: "session-host",
				}),
			]);
		} finally {
			await withRunStorage(storage, () => deleteRunStorage(runId)).catch(() => {});
			await rm(root, { recursive: true, force: true });
		}
	});

	it("loads metadata without hydrating or validating the PostgreSQL journal", async () => {
		const runId = newRunId();
		const storage: RunStorage = { kind: "postgres", dsn: dsn as string, rootDir: tmpdir(), layout: "sha256" };
		const runDir = resolveRunPaths(runId, storage).runDir;
		await mkdir(runDir, { recursive: true });
		const meta = {
			chartPath: join(runDir, "chart.ts"),
			workDir: runDir,
			chartId: "metadata-only",
			createdAt: new Date().toISOString(),
		};
		try {
			await withRunStorage(storage, () => initializeRun(runId));
			const writer = await openWriter(runId);
			await writer.appendDrafts([argsDraft()]);
			await writer.close();
			await withRunStorage(storage, () => saveRunMeta(runId, meta));
			const { Client } = await import("pg");
			const client = new Client({ connectionString: dsn });
			await client.connect();
			await client.query(`DELETE FROM ${JOURNAL_TABLE} WHERE run_id = $1 AND seq = 1`, [runId]);
			await client.end();
			expect(await withRunStorage(storage, () => loadRunMeta(runId))).toEqual({ ...meta, runId });
		} finally {
			await withRunStorage(storage, () => deleteRunStorage(runId)).catch(() => {});
			await rm(runDir, { recursive: true, force: true });
		}
	});

	it("rejects conflicting PostgreSQL metadata for the same run id", async () => {
		const runId = newRunId();
		const storage: RunStorage = { kind: "postgres", dsn: dsn as string, rootDir: tmpdir(), layout: "sha256" };
		const runDir = resolveRunPaths(runId, storage).runDir;
		await mkdir(runDir, { recursive: true });
		const meta = {
			chartPath: join(runDir, "one.chart.ts"),
			workDir: runDir,
			chartId: "one",
			createdAt: new Date().toISOString(),
		};
		try {
			await withRunStorage(storage, () => saveRunMeta(runId, meta));
			await expect(withRunStorage(storage, () => saveRunMeta(runId, { ...meta, chartId: "two" }))).rejects.toThrow(
				/Conflicting metadata/,
			);
		} finally {
			await rm(runDir, { recursive: true, force: true });
		}
	});

	it("rejects append before explicit root-branch initialization", async () => {
		const store = await openWriter(newRunId());
		await expect(store.appendDrafts([argsDraft()])).rejects.toThrow(/Unknown Hyperchart branch 'main'/);
	});

	it("atomically commits records as independent universal-sequence rows", async () => {
		const runId = newRunId();
		const store = await openWriter(runId);
		await store.initializeRootBranch();
		const records = await store.appendDrafts([argsDraft(), invokeDraft()]);

		expect((await store.getBranch("main")).headSeqId).toBe(3);
		expect((await journalStats(store, runId)).maxSeq + 1).toBe(4);
		expect(await collectHistoryRecords(store, "main")).toEqual(records);
		const relational = await store.transaction((tx) =>
			tx.query(
				`SELECT seq, kind, branch_id, parent_id, head_seq_id,
			        record_type, payload, metadata
			   FROM ${JOURNAL_TABLE}
			  WHERE run_id = $1
			  ORDER BY seq`,
				[runId],
			),
		);
		expect(relational.rows).toEqual([
			{
				seq: "1",
				kind: "branch_create",
				branch_id: "main",
				parent_id: null,
				head_seq_id: null,
				record_type: null,
				payload: null,
				metadata: { name: "main" },
			},
			{
				seq: "2",
				kind: "record",
				branch_id: "main",
				parent_id: null,
				head_seq_id: null,
				record_type: "args",
				payload: { args: { topic: "test" }, timestamp: records[0]?.timestamp },
				metadata: null,
			},
			{
				seq: "3",
				kind: "record",
				branch_id: "main",
				parent_id: "2",
				head_seq_id: null,
				record_type: "state_action",
				payload: expect.objectContaining({ kind: "invoke", sessionId: "session-id", timestamp: records[1]?.timestamp }),
				metadata: null,
			},
		]);
		const columns = await store.transaction((tx) =>
			tx.query(
				`SELECT column_name FROM information_schema.columns
			  WHERE table_schema = 'public' AND table_name = $1
			  ORDER BY ordinal_position`,
				[JOURNAL_TABLE],
			),
		);
		expect(columns.rows.map((row) => row.column_name)).toEqual([
			"run_id",
			"seq",
			"kind",
			"branch_id",
			"parent_id",
			"head_seq_id",
			"record_type",
			"payload",
			"metadata",
			"committed_at_ms",
		]);
	});

	it("persists nearest compatible checkpoints and restores a bounded replay tail", async () => {
		const runId = newRunId();
		const store = await openWriter(runId);
		await store.initializeRootBranch();
		const chartAst = userAst();
		const contract = projectionContractForAst(chartAst);
		const prefix = await store.appendDrafts(
			Array.from({ length: 520 }, (_, index) => ({ type: "args", args: { index } })),
		);
		const cold = await loadBranchProjection({ ast: chartAst, branchId: "main", store, contract });
		expect(cold.replayedRecords).toBe(520);
		expect(cold.replayBatches).toBe(2);
		await store.createBranch("fork", prefix.at(-1)!.seqId);
		const fork = store.forBranch("fork");
		await fork.appendDrafts(Array.from({ length: 31 }, (_, index) => ({ type: "args", args: { index: 520 + index } })));
		const restored = await loadBranchProjection({ ast: chartAst, branchId: "fork", store: fork, contract });
		expect(restored.checkpointHeadSeqId).toBe(prefix.at(-1)!.seqId);
		expect(restored.replayedRecords).toBe(31);
		const rows = await store.transaction((tx) =>
			tx.query(`SELECT head_seq_id, selector_key FROM ${CHECKPOINT_TABLE} WHERE run_id = $1 ORDER BY created_at_ms`, [
				runId,
			]),
		);
		// Ordinary warm-tail restore preserves the 512-record cadence instead of eagerly caching the fork tip.
		expect(rows.rows).toHaveLength(1);
		expect(rows.rows.every((row) => row.selector_key === contract.selectorKey)).toBe(true);
	});

	it("falls back from malformed, non-ancestral, and incompatible PostgreSQL checkpoints", async () => {
		const runId = newRunId();
		const store = await openWriter(runId);
		await store.initializeRootBranch();
		const chartAst = userAst();
		const contract = projectionContractForAst(chartAst);
		const records = await store.appendDrafts([argsDraft({ index: 1 }), argsDraft({ index: 2 })]);
		await store.createBranch("sibling", records[0]!.seqId);
		const [siblingHead] = await store.forBranch("sibling").appendDrafts([argsDraft({ sibling: true })]);
		await store.storeCheckpoint({
			checkpointId: "sibling-only",
			headSeqId: siblingHead!.seqId,
			selectorKey: contract.selectorKey,
			blob: {
				schemaVersion: 1,
				projectorVersion: contract.projectorVersion,
				astDigest: contract.astDigest,
				projection: {},
			},
			createdAt: 1,
		});
		expect(
			await store.findNearestCheckpoint({ targetHeadSeqId: records.at(-1)!.seqId, selectorKey: contract.selectorKey }),
		).toBeUndefined();
		await store.storeCheckpoint({
			checkpointId: "incompatible",
			headSeqId: records.at(-1)!.seqId,
			selectorKey: `wrong:${contract.selectorKey}`,
			blob: {},
			createdAt: 2,
		});
		await store.storeCheckpoint({
			checkpointId: "malformed",
			headSeqId: records.at(-1)!.seqId,
			selectorKey: contract.selectorKey,
			blob: {
				schemaVersion: 1,
				projectorVersion: contract.projectorVersion,
				astDigest: contract.astDigest,
				projection: { seqId: records.at(-1)!.seqId, pendingActions: [{}] },
			},
			createdAt: 3,
		});
		const cold = await loadBranchProjection({ ast: chartAst, branchId: "main", store, contract });
		expect(cold.replayedRecords).toBe(2);
		expect(cold.projection.args).toEqual({ index: 2 });
		const warm = await loadBranchProjection({ ast: chartAst, branchId: "main", store, contract });
		expect(warm.replayedRecords).toBe(0);
		const rows = await store.transaction((tx) =>
			tx.query(`SELECT checkpoint_id FROM ${CHECKPOINT_TABLE} WHERE run_id = $1 ORDER BY checkpoint_id`, [runId]),
		);
		expect(rows.rows.map((row) => row.checkpoint_id)).not.toContain("malformed");
		expect(rows.rows.map((row) => row.checkpoint_id)).toContain("incompatible");
	});

	it("rolls back branch create and move when their prepared checkpoint cannot persist", async () => {
		const runId = newRunId();
		const store = await openWriter(runId);
		await store.initializeRootBranch();
		const records = await store.appendDrafts([argsDraft({ index: 1 }), argsDraft({ index: 2 })]);
		const invalid = {
			checkpointId: "invalid-json",
			headSeqId: records[0]!.seqId,
			selectorKey: "invalid",
			blob: { value: 1n },
			createdAt: Date.now(),
		};
		await expect(
			store.createBranch("rolled-back-fork", records[0]!.seqId, undefined, { checkpoint: invalid }),
		).rejects.toThrow();
		await expect(store.getBranch("rolled-back-fork")).rejects.toThrow(/Unknown/);
		await store.createBranch("movable", records.at(-1)!.seqId);
		await expect(store.moveBranch("movable", records[0]!.seqId, { checkpoint: invalid })).rejects.toThrow();
		expect((await store.getBranch("movable")).headSeqId).toBe(records.at(-1)!.seqId);
	});

	it("rejects non-cloneable root/create/move/fork checkpoints before PostgreSQL mutation", async () => {
		const rootStore = await openWriter(newRunId());
		const invalidAt = (headSeqId: number | null) => ({
			checkpointId: `invalid-${headSeqId ?? "root"}`,
			headSeqId,
			selectorKey: "opaque:test",
			blob: { fn: () => undefined },
			createdAt: 1,
		});
		await expect(rootStore.initializeRootBranch(undefined, { checkpoint: invalidAt(null) })).rejects.toThrow();
		expect((await rootStore.listBranches()).items).toEqual([]);
		await rootStore.initializeRootBranch();
		const records = await rootStore.appendDrafts([argsDraft({ first: true }), argsDraft({ second: true })]);
		await expect(
			rootStore.createBranch("invalid-create", records[0]!.seqId, undefined, {
				checkpoint: invalidAt(records[0]!.seqId),
			}),
		).rejects.toThrow();
		expect((await rootStore.listBranches()).items.some((branch) => branch.branchId === "invalid-create")).toBe(false);
		await rootStore.createBranch("movable-clone", records.at(-1)!.seqId);
		await expect(
			rootStore.moveBranch("movable-clone", records[0]!.seqId, { checkpoint: invalidAt(records[0]!.seqId) }),
		).rejects.toThrow();
		expect((await rootStore.getBranch("movable-clone")).headSeqId).toBe(records.at(-1)!.seqId);
		let participated = 0;
		await expect(
			rootStore.forkAndAppend(
				{
					sourceBranchId: "main",
					newBranchId: "invalid-fork-clone",
					fromSeqId: records[0]!.seqId,
					appendBranchId: "invalid-fork-clone",
					checkpoint: invalidAt(records[0]!.seqId),
					append: { expectedHeadSeqId: records[0]!.seqId, drafts: [] },
				},
				async () => ++participated,
			),
		).rejects.toThrow();
		expect(participated).toBe(0);
		expect((await rootStore.listBranches()).items.some((branch) => branch.branchId === "invalid-fork-clone")).toBe(
			false,
		);
	});

	it("atomically rolls back a cadence append when checkpoint preparation fails", async () => {
		const runId = newRunId();
		const store = await openWriter(runId);
		await store.initializeRootBranch();
		await expect(
			store.appendDrafts([argsDraft({ atomic: true })], () => {
				throw new Error("checkpoint prepare failed");
			}),
		).rejects.toThrow(/checkpoint prepare failed/);
		expect(await store.countRecords()).toBe(0);
	});

	it("rejects non-cloneable opaque callback envelopes before PostgreSQL journal mutation", async () => {
		const store = await openWriter(newRunId());
		await store.initializeRootBranch();
		await expect(
			store.appendDrafts([argsDraft({ atomic: true })], (records) => ({
				checkpoints: [
					{
						checkpointId: "noncloneable",
						headSeqId: records[0]!.seqId,
						selectorKey: "opaque:test",
						blob: { fn: () => undefined },
						createdAt: 1,
					},
				],
				committed: () => {
					throw new Error("must not confirm");
				},
			})),
		).rejects.toThrow();
		expect(await store.countRecords()).toBe(0);
	});

	it("rolls back checkpoint and journal rows together in a managed transaction", async () => {
		const runId = newRunId();
		const store = await openWriter(runId);
		await store.initializeRootBranch();
		const chartAst = userAst();
		const contract = projectionContractForAst(chartAst);
		await expect(
			store.transaction(async (tx) => {
				const [record] = await tx.appendDrafts("main", [argsDraft({ rolledBack: true })]);
				await tx.storeCheckpoint({
					checkpointId: "rolled-back",
					headSeqId: record!.seqId,
					selectorKey: contract.selectorKey,
					blob: {
						schemaVersion: 1,
						projectorVersion: contract.projectorVersion,
						astDigest: contract.astDigest,
						projection: {},
					},
					createdAt: Date.now(),
				});
				throw new Error("rollback checkpoint");
			}),
		).rejects.toThrow(/rollback checkpoint/);
		expect(await store.countRecords()).toBe(0);
		const rows = await store.transaction((tx) =>
			tx.query(`SELECT COUNT(*)::int AS count FROM ${CHECKPOINT_TABLE} WHERE run_id = $1`, [runId]),
		);
		expect(Number(rows.rows[0]?.count)).toBe(0);
	});

	it("opens and appends without selecting the whole journal", async () => {
		const runId = newRunId();
		const seed = await openWriter(runId);
		await seed.initializeRootBranch();
		for (let index = 0; index < 20; index++) {
			await seed.appendDrafts([argsDraft({ index })]);
		}
		await seed.close();

		const { Client } = await import("pg");
		const originalQuery = Client.prototype.query;
		const queries: string[] = [];
		vi.spyOn(Client.prototype, "query").mockImplementation(function (
			this: InstanceType<typeof Client>,
			...args: unknown[]
		) {
			const query = args[0];
			queries.push(
				typeof query === "string"
					? query
					: typeof query === "object" && query !== null && "text" in query
						? String(query.text)
						: "",
			);
			return Reflect.apply(originalQuery, this, args) as never;
		} as typeof originalQuery);

		const writer = await openWriter(runId);
		const [record] = await writer.appendDrafts([argsDraft({ final: true })]);
		expect(record?.seqId).toBe(22);
		const normalized = queries.map((query) => query.replace(/\s+/g, " ").trim().toLowerCase());
		expect(normalized.some((query) => query.includes("max(seq)"))).toBe(false);
		expect(
			normalized.some(
				(query) =>
					query.includes("with allocation as") &&
					query.includes("update hyperchart_run_meta") &&
					query.includes("insert into hyperchart_journal") &&
					query.includes("pg_notify"),
			),
		).toBe(true);
		expect(normalized.some((query) => query.includes("record_type, payload") && query.includes("order by seq"))).toBe(
			false,
		);
	});

	it("reloads identical targeted views after reopening the run", async () => {
		const runId = newRunId();
		const writer = await openWriter(runId);
		await writer.initializeRootBranch();
		await writer.appendDrafts([argsDraft(), invokeDraft()]);
		await writer.createBranch("experiment", 2, { reason: "sibling", sourceBranchId: "main", sourceSeqId: 2 });
		const before = {
			branches: await writer.listBranches(),
			main: await collectHistoryRecords(writer, "main"),
			experiment: await collectHistoryRecords(writer, "experiment"),
			count: await writer.countRecords(),
		};
		await writer.close();

		const reopened = await openReader(runId);
		expect(await reopened.listBranches()).toEqual(before.branches);
		expect(await collectHistoryRecords(reopened, "main")).toEqual(before.main);
		expect(await collectHistoryRecords(reopened, "experiment")).toEqual(before.experiment);
		expect(await reopened.countRecords()).toBe(before.count);
		expect((await reopened.getBranch("experiment")).headSeqId).toBe(2);
	});

	it("shares one journal across branch handles", async () => {
		const store = await openWriter(newRunId());
		await store.initializeRootBranch();
		await store.appendDrafts([argsDraft()]);
		await store.createBranch("experiment", 2);

		const experiment = store.forBranch("experiment");
		const forked = await experiment.appendDrafts([invokeDraft()]);

		expect(forked[0]?.parentId).toBe(2);
		expect((await store.getBranch("experiment")).headSeqId).toBe(4);
		expect((await store.getBranch("main")).headSeqId).toBe(2);
		expect(await collectHistoryRecords(experiment, "experiment")).toHaveLength(2);
	});

	it("moves a named head without deleting records", async () => {
		const runId = newRunId();
		const store = await openWriter(runId);
		await store.initializeRootBranch();
		await store.appendDrafts([argsDraft(), invokeDraft()]);
		const moved = await store.moveBranch("main", 2);

		expect(moved).toMatchObject({ moveSeqId: 4, previousHeadSeqId: 3, headSeqId: 2, preservedRecords: 2 });
		expect((await store.getBranch("main")).headSeqId).toBe(2);
		expect(await store.countRecords()).toBe(2);
		expect((await journalStats(store, runId)).maxSeq + 1).toBe(5);
	});

	it("rejects a second live writer for the same run", async () => {
		const runId = newRunId();
		const first = await openWriter(runId);
		await first.initializeRootBranch();
		await expect(PostgresLogStore.open({ dsn: dsn as string, runId, access: "writer" })).rejects.toThrow(
			/Another live writer/,
		);
	});

	it("rolls journal writes back with host-domain SQL failure", async () => {
		const store = await openWriter(newRunId());
		await store.initializeRootBranch();
		await expect(
			store.transaction(async (tx) => {
				await tx.appendDrafts("main", [argsDraft()]);
				await tx.query("SELECT * FROM hyperchart_table_that_does_not_exist");
			}),
		).rejects.toBeDefined();
		expect(await store.countRecords()).toBe(0);
		const [record] = await store.appendDrafts([argsDraft()]);
		expect(record?.seqId).toBe(2);
	});

	it("atomically commits a fork, response, and participating SQL", async () => {
		const runId = newRunId();
		const store = await openWriter(runId);
		await store.initializeRootBranch();
		await ensureClaimTable(store);
		const ast = userAst();
		const gateSeqId = await appendOpenGate(store, ast);
		const prepared = await prepareUserInteractionCommit(
			store,
			ast,
			gateSeqId,
			{ type: "SELECTED" },
			{ branchId: "experiment", snapshot: { branchId: "experiment", headSeqId: gateSeqId } },
		);

		const committed = await forkAndCommitUserInteraction(
			store,
			{
				sourceBranchId: "main",
				newBranchId: "experiment",
				fromSeqId: gateSeqId,
				responseBranchId: "experiment",
				metadata: { name: "experiment", sourceBranchId: "main", sourceSeqId: gateSeqId },
				preparedResponse: prepared,
			},
			async (tx) => {
				await tx.query("INSERT INTO hyperchart_test_claims (run_id, candidate, branch_id) VALUES ($1, $2, $3)", [
					runId,
					1,
					"experiment",
				]);
				return "claimed";
			},
		);

		expect(committed.participant).toBe("claimed");
		expect(committed.response.idempotent).toBe(false);
		expect((await store.getBranch("experiment")).headSeqId).toBe(committed.response.record.seqId);
		expect((await collectHistoryRecords(store, "experiment")).at(-1)).toEqual(committed.response.record);
		expect(await store.findUserInteractionResponse({ headSeqId: committed.response.record.seqId, gateSeqId })).toEqual(
			committed.response.record,
		);
		const claims = await store.transaction((tx) =>
			tx.query("SELECT branch_id FROM hyperchart_test_claims WHERE run_id = $1 AND candidate = 1", [runId]),
		);
		expect(claims.rows).toEqual([{ branch_id: "experiment" }]);

		const retryPrepared = await prepareUserInteractionCommit(
			store,
			ast,
			gateSeqId,
			{ type: "SELECTED" },
			{ branchId: "experiment" },
		);
		const retried = await forkAndCommitUserInteraction(
			store,
			{
				sourceBranchId: "main",
				newBranchId: "experiment",
				fromSeqId: gateSeqId,
				responseBranchId: "experiment",
				metadata: { name: "experiment", sourceBranchId: "main", sourceSeqId: gateSeqId },
				preparedResponse: retryPrepared,
			},
			async (tx) => {
				await tx.query(
					"INSERT INTO hyperchart_test_claims (run_id, candidate, branch_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
					[runId, 1, "experiment"],
				);
				return "existing";
			},
		);
		expect(retried.response.idempotent).toBe(true);
		expect(retried.branch.branchId).toBe("experiment");
	});

	it("forks atomically from a historical gate after the source branch advances", async () => {
		const runId = newRunId();
		const store = await openWriter(runId);
		await store.initializeRootBranch();
		await ensureClaimTable(store);
		const ast = userAst();
		const gateSeqId = await appendOpenGate(store, ast);
		await commitUserInteractionResponse(store, ast, gateSeqId, { type: "SELECTED" });
		expect((await store.getBranch("main")).headSeqId).not.toBe(gateSeqId);

		const prepared = await prepareUserInteractionCommit(
			store,
			ast,
			gateSeqId,
			{ type: "SELECTED" },
			{ branchId: "historical-fork", snapshot: { branchId: "historical-fork", headSeqId: gateSeqId } },
		);
		const committed = await forkAndCommitUserInteraction(
			store,
			{
				sourceBranchId: "main",
				newBranchId: "historical-fork",
				fromSeqId: gateSeqId,
				responseBranchId: "historical-fork",
				preparedResponse: prepared,
			},
			(tx) =>
				tx.query("INSERT INTO hyperchart_test_claims (run_id, candidate, branch_id) VALUES ($1, $2, $3)", [
					runId,
					9,
					"historical-fork",
				]),
		);

		expect(committed.branch.branchId).toBe("historical-fork");
		expect((await collectHistoryRecords(store, "historical-fork")).at(-1)).toEqual(committed.response.record);
	});

	it("rejects a fork point outside the selected source ancestry", async () => {
		const store = await openWriter(newRunId());
		await store.initializeRootBranch();
		const ast = userAst();
		const gateSeqId = await appendOpenGate(store, ast);
		const prepared = await prepareUserInteractionCommit(
			store,
			ast,
			gateSeqId,
			{ type: "SELECTED" },
			{ branchId: "invalid-fork", snapshot: { branchId: "invalid-fork", headSeqId: gateSeqId } },
		);
		await expect(
			forkAndCommitUserInteraction(
				store,
				{
					sourceBranchId: "main",
					newBranchId: "invalid-fork",
					fromSeqId: gateSeqId + 1000,
					responseBranchId: "invalid-fork",
					preparedResponse: prepared,
				},
				async () => undefined,
			),
		).rejects.toThrow(/not in source branch 'main' ancestry/);
	});

	it("rolls back fork and response when participating SQL fails", async () => {
		const runId = newRunId();
		const store = await openWriter(runId);
		await store.initializeRootBranch();
		await ensureClaimTable(store);
		const ast = userAst();
		const gateSeqId = await appendOpenGate(store, ast);
		const before = (await journalStats(store, runId)).count;
		const prepared = await prepareUserInteractionCommit(
			store,
			ast,
			gateSeqId,
			{ type: "SELECTED" },
			{ branchId: "rolled-back", snapshot: { branchId: "rolled-back", headSeqId: gateSeqId } },
		);

		await expect(
			forkAndCommitUserInteraction(
				store,
				{
					sourceBranchId: "main",
					newBranchId: "rolled-back",
					fromSeqId: gateSeqId,
					responseBranchId: "rolled-back",
					preparedResponse: prepared,
				},
				async (tx) => {
					await tx.query("INSERT INTO hyperchart_test_claims (run_id, candidate, branch_id) VALUES ($1, $2, $3)", [
						runId,
						2,
						"rolled-back",
					]);
					throw new Error("participant failed");
				},
			),
		).rejects.toThrow("participant failed");

		expect((await store.listBranches()).items.some((branch) => branch.branchId === "rolled-back")).toBe(false);
		expect((await journalStats(store, runId)).count).toBe(before);
		const claims = await store.transaction((tx) =>
			tx.query("SELECT branch_id FROM hyperchart_test_claims WHERE run_id = $1 AND candidate = 2", [runId]),
		);
		expect(claims.rows).toEqual([]);
	});

	it("preserves host uniqueness errors and rolls back their fork", async () => {
		const runId = newRunId();
		const store = await openWriter(runId);
		await store.initializeRootBranch();
		await ensureClaimTable(store);
		const ast = userAst();
		const gateSeqId = await appendOpenGate(store, ast);
		await store.transaction((tx) =>
			tx.query("INSERT INTO hyperchart_test_claims (run_id, candidate, branch_id) VALUES ($1, $2, $3)", [
				runId,
				3,
				"winner",
			]),
		);
		const prepared = await prepareUserInteractionCommit(
			store,
			ast,
			gateSeqId,
			{ type: "SELECTED" },
			{ branchId: "loser", snapshot: { branchId: "loser", headSeqId: gateSeqId } },
		);

		let failure: unknown;
		try {
			await forkAndCommitUserInteraction(
				store,
				{
					sourceBranchId: "main",
					newBranchId: "loser",
					fromSeqId: gateSeqId,
					responseBranchId: "loser",
					preparedResponse: prepared,
				},
				(tx) =>
					tx.query("INSERT INTO hyperchart_test_claims (run_id, candidate, branch_id) VALUES ($1, $2, $3)", [
						runId,
						3,
						"loser",
					]),
			);
		} catch (error) {
			failure = error;
		}
		expect(failure).toMatchObject({ code: "23505", constraint: "hyperchart_test_claims_pkey" });
		expect(String(failure)).not.toContain("Stale Hyperchart journal writer");
		expect((await store.listBranches()).items.some((branch) => branch.branchId === "loser")).toBe(false);
	});

	it("rejects a composite response branch unrelated to source or new fork", async () => {
		const store = await openWriter(newRunId());
		await store.initializeRootBranch();
		await expect(
			store.forkAndAppend(
				{
					sourceBranchId: "main",
					newBranchId: "experiment",
					fromSeqId: 1,
					appendBranchId: "unrelated",
					append: { expectedHeadSeqId: null, drafts: [] },
				},
				async () => undefined,
			),
		).rejects.toThrow(/source branch or the newly created branch/);
	});

	it("rejects writes through a read-only handle", async () => {
		const runId = newRunId();
		const writer = await openWriter(runId);
		await writer.initializeRootBranch();
		await writer.close();

		const reader = await openReader(runId);
		await expect(reader.appendDrafts([argsDraft()])).rejects.toThrow(/opened read-only/);
	});

	it("treats a missing journal as an empty read-only run", async () => {
		const reader = await openReader(newRunId());
		expect(await reader.listBranches()).toEqual({ items: [], totalCount: 0 });
		expect(await reader.countRecords()).toBe(0);
	});

	it("trusts targeted reads without globally validating the journal", async () => {
		const runId = newRunId();
		const writer = await openWriter(runId);
		await writer.initializeRootBranch();
		await writer.appendDrafts([argsDraft(), invokeDraft()]);
		await writer.close();

		const { Client } = await import("pg");
		const client = new Client({ connectionString: dsn });
		await client.connect();
		// Drop the branch-create entry so the surviving record appends to an unknown branch.
		await client.query(`DELETE FROM ${JOURNAL_TABLE} WHERE run_id = $1 AND seq = 1`, [runId]);
		await client.end();

		const reader = await openReader(runId);
		expect(await reader.getRecord(2)).toMatchObject({ seqId: 2, type: "args" });
	});

	it("serves snapshot-pinned older/newer history chunks and deep-link cursors", async () => {
		const store = await openWriter(newRunId());
		await store.initializeRootBranch();
		const records = await store.appendDrafts(Array.from({ length: 230 }, () => invokeDraft()));
		const snapshot = await store.captureSnapshot("main");
		const first = await store.readStateVisits({ snapshot, state: "work" });
		expect(first.items).toHaveLength(HISTORY_READ_ITEMS);
		expect(first.items.map((item) => item.seqId)).toEqual(
			records
				.slice(-100)
				.reverse()
				.map((record) => record.seqId),
		);
		const second = await store.readStateVisits({ snapshot, state: "work", cursor: first.older! });
		expect(second.items).toHaveLength(100);
		expect(second.newer).toBeTypeOf("string");
		expect(
			(await store.readStateVisits({ snapshot, state: "work", cursor: second.newer! })).items.map((item) => item.seqId),
		).toEqual(first.items.map((item) => item.seqId));
		const target = records[109]!.seqId;
		const cursor = await store.cursorAt({ snapshot, subject: { kind: "state-visits", state: "work" }, seqId: target });
		expect((await store.readStateVisits({ snapshot, state: "work", cursor: cursor! })).items[0]?.seqId).toBe(target);
		await expect(store.readRecords({ snapshot, cursor: cursor! })).rejects.toBeInstanceOf(HistoryCursorError);
		await store.appendDrafts([invokeDraft()]);
		expect((await store.readStateVisits({ snapshot, state: "work" })).items.map((item) => item.seqId)).toEqual(
			first.items.map((item) => item.seqId),
		);
		await expect(
			store.readStateVisits({ snapshot: await store.captureSnapshot("main"), state: "work", cursor: cursor! }),
		).rejects.toBeInstanceOf(HistoryCursorError);
	});

	it("paginates branch heads by creation coordinate under read committed semantics", async () => {
		const store = await openWriter(newRunId());
		await store.initializeRootBranch();
		const [root] = await store.appendDrafts([argsDraft()]);
		for (let index = 0; index < 105; index++) {
			await store.createBranch(`branch-${index.toString().padStart(3, "0")}`, root!.seqId);
		}
		const first = await store.listBranches();
		expect(first.items).toHaveLength(100);
		expect(first.totalCount).toBe(106);
		expect(first.next).toBeTypeOf("string");
		await store.createBranch("late-branch", root!.seqId);
		const second = await store.listBranches(first.next);
		expect(second.items).toHaveLength(7);
		expect(second.totalCount).toBe(107);
		expect(second.next).toBeUndefined();
		expect(new Set([...first.items, ...second.items].map((branch) => branch.branchId)).size).toBe(107);
	});

	it("streams private projection replay oldest-first with 500-record batches", async () => {
		const store = await openWriter(newRunId());
		await store.initializeRootBranch();
		const records = await store.appendDrafts(Array.from({ length: 1_201 }, () => invokeDraft()));
		const batches: number[][] = [];
		for await (const batch of openExecutionReplay(store, {
			targetHeadSeqId: records.at(-1)!.seqId,
			afterSeqId: null,
		})) {
			batches.push(batch.map((record) => record.seqId));
		}
		expect(batches.map((batch) => batch.length)).toEqual([500, 500, 201]);
		expect(batches.flat()).toEqual(records.map((record) => record.seqId));
	});

	it("keeps arbitrary-parent divergent snapshots independent", async () => {
		const store = await openWriter(newRunId());
		await store.initializeRootBranch();
		const [root] = await store.appendDrafts([argsDraft()]);
		await store.createBranch("experiment", root!.seqId);
		const main = await store.appendDrafts(Array.from({ length: 120 }, () => invokeDraft()));
		const experiment = await store
			.forBranch("experiment")
			.appendDrafts(Array.from({ length: 120 }, () => invokeDraft()));
		const mainSnapshot = await store.captureSnapshot("main");
		const experimentSnapshot = await store.captureSnapshot("experiment");
		await store.moveBranch("main", root!.seqId);
		expect(
			(await store.readStateVisits({ snapshot: mainSnapshot, state: "work" })).items.map((item) => item.seqId),
		).toEqual(
			main
				.slice(-100)
				.reverse()
				.map((record) => record.seqId),
		);
		expect(
			(await store.readStateVisits({ snapshot: experimentSnapshot, state: "work" })).items.map((item) => item.seqId),
		).toEqual(
			experiment
				.slice(-100)
				.reverse()
				.map((record) => record.seqId),
		);
		expect(await store.containsInHistory({ headSeqId: mainSnapshot.headSeqId, seqId: experiment[0]!.seqId })).toBe(
			false,
		);
	});

	it("publishes the existing PostgreSQL commit notification without using it as a runtime subscription", async () => {
		const runId = newRunId();
		const { Client } = await import("pg");
		const listener = new Client({ connectionString: dsn });
		await listener.connect();
		const received: string[] = [];
		listener.on("notification", (message: { channel: string; payload?: string | undefined }) => {
			if (message.channel === JOURNAL_CHANNEL && message.payload?.startsWith(`${runId}:`)) {
				received.push(message.payload);
			}
		});
		await listener.query(`LISTEN ${JOURNAL_CHANNEL}`);
		const writer = await openWriter(runId);
		await writer.initializeRootBranch();
		await writer.appendDrafts([argsDraft()]);
		await new Promise((resolve) => setTimeout(resolve, 250));
		await listener.end();
		expect(received).toEqual([`${runId}:1`, `${runId}:2`]);
	});
});

describePg("PostgresLogStore schema creation", () => {
	it("creates the schema once when writers open stores together on an empty database", async () => {
		const pg = (await import("pg")).default;
		const admin = new pg.Client({ connectionString: dsn as string });
		await admin.connect();
		const database = `hyperchart_schema_${randomUUID().replaceAll("-", "")}`;
		await admin.query(`CREATE DATABASE ${database}`);
		const url = new URL(dsn as string);
		url.pathname = `/${database}`;
		const stores: PostgresLogStore[] = [];
		try {
			const opened = await Promise.allSettled(
				Array.from({ length: 8 }, (_, index) =>
					PostgresLogStore.open({ dsn: url.toString(), runId: `schema-race-${index}`, access: "writer" }),
				),
			);
			for (const result of opened) {
				if (result.status === "fulfilled") {
					stores.push(result.value);
				}
			}
			expect(opened.filter((result) => result.status === "rejected")).toEqual([]);
		} finally {
			await Promise.all(stores.map((store) => store.close()));
			await admin.query(`DROP DATABASE ${database}`);
			await admin.end();
		}
	});
});
