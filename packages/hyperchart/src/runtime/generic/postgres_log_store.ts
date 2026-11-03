import { isDeepStrictEqual } from "node:util";
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
import {
	BranchHeadMovedError,
	DEFAULT_BRANCH_ID,
	HISTORY_READ_ITEMS,
	assertDurableRecordDraft,
	cloneOpaqueCheckpoint,
	cursorAtItems,
	decodeBranchListCursor,
	encodeBranchListCursor,
	findUserInteractionResponseInAncestry,
	historyChunkFromItems,
	historyItemsForSubject,
	type ActorGenerationHistoryItem,
	type ActorMessageHistoryItem,
	type BranchListChunk,
	type BranchListCursor,
	type HistoryChunk,
	type HistoryCursor,
	type HistorySnapshot,
	type HistorySubject,
	type MapVisitHistoryItem,
	type AppendAtHeadInput,
	type BranchMoveResult,
	type BranchMutationOptions,
	type CheckpointQuery,
	type PrepareStampedCommit,
	type RunLogStore,
	type RunMeta,
	type StateVisitHistoryItem,
	type OpaqueCheckpointEnvelope,
	registerReplayPageReader,
} from "./log_store.js";
import type { StatePath } from "../../core/types.js";
import {
	applyRunStatusPatch,
	normalizeRunStatus,
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

export const JOURNAL_TABLE = "hyperchart_journal";
export const JOURNAL_CHANNEL = "hyperchart_journal";
export const RUN_META_TABLE = "hyperchart_run_meta";
export const CHECKPOINT_TABLE = "hyperchart_checkpoint";
export const RUN_STATUS_TABLE = "hyperchart_run_status";
export const RUN_STATUS_CHANNEL = "hyperchart_run_status";
export const CONTROL_TABLE = "hyperchart_control";
export const CONTROL_CHANNEL = "hyperchart_control";
const JOURNAL_DDL = `CREATE TABLE IF NOT EXISTS ${JOURNAL_TABLE} (
  run_id text NOT NULL,
  seq bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('record', 'branch_create', 'branch_move')),
  branch_id text NOT NULL,
  parent_id bigint,
  head_seq_id bigint,
  record_type text,
  payload jsonb,
  metadata jsonb,
  committed_at_ms bigint NOT NULL,
  PRIMARY KEY (run_id, seq),
  CHECK (seq > 0),
  CHECK (
    (kind = 'record' AND seq > 0 AND head_seq_id IS NULL
      AND record_type IS NOT NULL AND payload IS NOT NULL AND metadata IS NULL)
    OR
    (kind = 'branch_create' AND parent_id IS NULL
      AND record_type IS NULL AND payload IS NULL)
    OR
    (kind = 'branch_move' AND parent_id IS NULL
      AND record_type IS NULL AND payload IS NULL AND metadata IS NULL)
  )
)`;
const RUN_META_DDL = `CREATE TABLE IF NOT EXISTS ${RUN_META_TABLE} (
  run_id text PRIMARY KEY,
  chart_path text,
  export_name text,
  work_dir text,
  chart_id text,
  created_at text,
  origin_session_id text,
  next_seq bigint NOT NULL DEFAULT 1,
  CHECK (
    (chart_path IS NULL AND export_name IS NULL AND work_dir IS NULL
      AND chart_id IS NULL AND created_at IS NULL AND origin_session_id IS NULL)
    OR
    (chart_path IS NOT NULL AND work_dir IS NOT NULL
      AND chart_id IS NOT NULL AND created_at IS NOT NULL)
  )
)`;
const CHECKPOINT_DDL = `CREATE TABLE IF NOT EXISTS ${CHECKPOINT_TABLE} (
  run_id text NOT NULL,
  checkpoint_id text NOT NULL,
  head_seq_id bigint,
  selector_key text NOT NULL,
  blob jsonb NOT NULL,
  created_at_ms bigint NOT NULL,
  PRIMARY KEY (run_id, checkpoint_id),
  FOREIGN KEY (run_id, head_seq_id) REFERENCES ${JOURNAL_TABLE}(run_id, seq)
)`;
/** Operational runner status: one row per run, outside the journal writer claim. */
const RUN_STATUS_DDL = `CREATE TABLE IF NOT EXISTS ${RUN_STATUS_TABLE} (
  run_id text PRIMARY KEY,
  chart_id text NOT NULL,
  state text NOT NULL,
  branch_ids jsonb NOT NULL,
  attempt_id text,
  pid integer,
  started_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  heartbeat_at bigint,
  exit_code integer,
  error text,
  replay_warnings jsonb
)`;
/** Runner control mailbox: requests and results share one table, keyed by role and id. */
const CONTROL_DDL = `CREATE TABLE IF NOT EXISTS ${CONTROL_TABLE} (
  run_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('request', 'result')),
  id text NOT NULL,
  attempt_id text NOT NULL,
  payload jsonb NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (run_id, role, id)
)`;
const CHECKPOINT_IDENTITY_DDL = `CREATE UNIQUE INDEX IF NOT EXISTS hyperchart_checkpoint_identity_idx
  ON ${CHECKPOINT_TABLE}(run_id, COALESCE(head_seq_id, -1), selector_key)`;
const JOURNAL_PARENT_INDEX_DDL = `CREATE INDEX IF NOT EXISTS hyperchart_journal_parent_idx
  ON ${JOURNAL_TABLE}(run_id, parent_id) WHERE kind = 'record'`;
const JOURNAL_BRANCH_INDEX_DDL = `CREATE INDEX IF NOT EXISTS hyperchart_journal_branch_latest_idx
  ON ${JOURNAL_TABLE}(run_id, branch_id, seq DESC)`;
const JOURNAL_BRANCH_CREATE_INDEX_DDL = `CREATE INDEX IF NOT EXISTS hyperchart_journal_branch_create_idx
  ON ${JOURNAL_TABLE}(run_id, branch_id, seq) WHERE kind = 'branch_create'`;

export type PostgresLogAccess = "writer" | "read";
export type OpenPostgresLogStoreOptions = Readonly<{
	dsn: string;
	runId: string;
	branchId?: BranchId;
	onWarn?: (message: string) => void;
	access?: PostgresLogAccess;
}>;
export type PgQueryResult = { rows: Record<string, unknown>[] };
export type PgClientLike = {
	connect(): Promise<void>;
	query(text: string, values?: readonly unknown[]): Promise<PgQueryResult>;
	end(): Promise<void>;
	on(event: "error", listener: (error: Error) => void): unknown;
};

export type PostgresJournalRow = {
	seq: string | number;
	kind: "record" | "branch_create" | "branch_move";
	branch_id: string;
	parent_id: string | number | null;
	head_seq_id: string | number | null;
	record_type: string | null;
	payload: unknown;
	metadata: unknown;
	committed_at_ms: string | number;
};

/** Bounded physical journal page, independent of branch ancestry. */
export type PostgresJournalPageInput = Readonly<{
	runId: string;
	afterSeq: number;
	/** 1..500, default 500. */
	limit?: number;
}>;

/** Read committed entries in global per-run sequence order, including branch mutations. */
export async function readPostgresJournalPage(
	db: Pick<PgClientLike, "query">,
	input: PostgresJournalPageInput,
): Promise<readonly StorageEntry[]> {
	const limit = input.limit ?? 500;
	if (!Number.isSafeInteger(input.afterSeq) || input.afterSeq < 0) {
		throw new Error("Journal afterSeq must be a nonnegative safe integer");
	}
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
		throw new Error("Journal page limit must be an integer between 1 and 500");
	}
	const { rows } = await db.query(
		`SELECT seq, kind, branch_id, parent_id, head_seq_id,
          record_type, payload, metadata, committed_at_ms
     FROM ${JOURNAL_TABLE}
    WHERE run_id = $1 AND seq > $2
    ORDER BY seq LIMIT $3`,
		[input.runId, input.afterSeq, limit],
	);
	let expected = input.afterSeq + 1;
	return rows.map((row) => {
		const entry = decodePostgresJournalRow(row as PostgresJournalRow);
		if (entry.seqId !== expected) {
			throw new Error(
				`Hyperchart journal '${input.runId}' has a sequence gap: expected ${expected}, got ${entry.seqId}`,
			);
		}
		expected += 1;
		return entry;
	});
}

/** Decode a trusted journal row, for callers that join it to application-owned tables. */
export function decodePostgresJournalRow(row: PostgresJournalRow): StorageEntry {
	switch (row.kind) {
		case "record":
			return decodeRecordRow(row);
		case "branch_create":
			return {
				kind: "branch",
				op: "create",
				seqId: journalNumber(row.seq),
				branchId: row.branch_id,
				headSeqId: row.head_seq_id === null ? null : journalNumber(row.head_seq_id),
				committedAt: journalNumber(row.committed_at_ms),
				...(row.metadata === null ? {} : { metadata: row.metadata as BranchMetadata }),
			};
		case "branch_move":
			return {
				kind: "branch",
				op: "move",
				seqId: journalNumber(row.seq),
				branchId: row.branch_id,
				headSeqId: row.head_seq_id === null ? null : journalNumber(row.head_seq_id),
				committedAt: journalNumber(row.committed_at_ms),
			};
		default: {
			const unexpected: never = row.kind;
			throw new Error(`Unknown journal row kind: ${String(unexpected)}`);
		}
	}
}

function journalNumber(value: string | number): number {
	const number = pgNumber(value);
	if (!Number.isSafeInteger(number)) {
		throw new Error("Journal coordinate is not a safe integer");
	}
	return number;
}

type SharedPgJournal = {
	client: PgClientLike;
	/** Return the connection: a pooled read client goes back to its pool, a writer client ends. */
	release: (destroy?: boolean) => Promise<void>;
	dsn: string;
	onWarn: (message: string) => void;
	runId: string;
	access: PostgresLogAccess;
	/** Writer-only durable allocation head, loaded under the advisory lock. */
	nextSeq?: number;
	writeChain: Promise<void>;
	closed: boolean;
	poisoned: boolean;
};

export type SqlCommitTransaction = Readonly<{
	query(text: string, values?: readonly unknown[]): Promise<PgQueryResult>;
}>;
export type SqlCommitParticipant<T> = (tx: SqlCommitTransaction) => Promise<T>;
export type PostgresRunTransaction = SqlCommitTransaction &
	Readonly<{
		appendDrafts(
			branchId: BranchId,
			drafts: readonly DurableRecordDraft[],
			prepare?: PrepareStampedCommit,
		): Promise<readonly DurableLogRecord[]>;
		appendDraftsAtHead(
			branchId: BranchId,
			input: AppendAtHeadInput,
			prepare?: PrepareStampedCommit,
		): Promise<readonly DurableLogRecord[]>;
		createBranch(
			branchId: BranchId,
			headSeqId: number,
			metadata?: BranchMetadata,
			options?: BranchMutationOptions,
		): Promise<BranchHead>;
		moveBranch(
			branchId: BranchId,
			headSeqId: number | null,
			options?: BranchMutationOptions,
		): Promise<BranchMoveResult>;
		storeCheckpoint(checkpoint: OpaqueCheckpointEnvelope): Promise<void>;
	}>;
export type PostgresForkAndAppendInput = Readonly<{
	sourceBranchId: BranchId;
	newBranchId: BranchId;
	fromSeqId: number;
	appendBranchId: BranchId;
	metadata?: BranchMetadata;
	checkpoint?: OpaqueCheckpointEnvelope;
	append: AppendAtHeadInput;
	prepare?: PrepareStampedCommit;
}>;
export interface SqlTransactionalRunLogStore extends RunLogStore {
	appendDraftsAtHeadWithParticipant<T>(
		branchId: BranchId,
		input: AppendAtHeadInput,
		prepare: PrepareStampedCommit | undefined,
		participate: SqlCommitParticipant<T>,
	): Promise<{ records: readonly DurableLogRecord[]; participant: T }>;
	forkAndAppend<T>(
		input: PostgresForkAndAppendInput,
		participate: SqlCommitParticipant<T>,
	): Promise<{ branch: BranchHead; records: readonly DurableLogRecord[]; participant: T }>;
}

export class PostgresLogStore implements RunLogStore {
	readonly canStoreCheckpoints: boolean;
	private constructor(
		private readonly journal: SharedPgJournal,
		readonly branchId: BranchId,
	) {
		this.canStoreCheckpoints = journal.access === "writer";
		registerReplayPageReader(this, (input) =>
			readForwardReplayPageDirect(journal.client, journal.runId, input, journal.access),
		);
	}

	static async open(options: OpenPostgresLogStoreOptions): Promise<PostgresLogStore> {
		const access = options.access ?? "read";
		const branchId = options.branchId ?? DEFAULT_BRANCH_ID;
		const onWarn = options.onWarn ?? (() => {});
		const { client, release } = await acquirePgClient(options.dsn, access, onWarn);
		try {
			if (access === "writer") {
				await ensureSchema(client);
				const locked = await client.query(
					"SELECT pg_try_advisory_lock(hashtextextended('hyperchart:run:' || $1, 0)) AS locked",
					[options.runId],
				);
				if (locked.rows[0]?.locked !== true) {
					throw new Error(
						`Another live writer holds Hyperchart run '${options.runId}' in Postgres; stop it before writing`,
					);
				}
				// The writer lock makes the run-meta row stable for this store's
				// lifetime. Load its allocation head once; each append advances it in
				// the same SQL statement that inserts the corresponding journal rows.
				const allocation = await client.query(
					`WITH created AS (
					   INSERT INTO ${RUN_META_TABLE} (run_id) VALUES ($1)
					   ON CONFLICT (run_id) DO NOTHING
					   RETURNING next_seq
					 )
					 SELECT next_seq FROM created
					 UNION ALL
					 SELECT next_seq FROM ${RUN_META_TABLE} WHERE run_id = $1
					 LIMIT 1`,
					[options.runId],
				);
				const nextSeq = pgNumber(allocation.rows[0]?.next_seq);
				return new PostgresLogStore(
					{
						client,
						release,
						dsn: options.dsn,
						onWarn,
						runId: options.runId,
						access,
						nextSeq,
						writeChain: Promise.resolve(),
						closed: false,
						poisoned: false,
					},
					branchId,
				);
			}
			return new PostgresLogStore(
				{
					client,
					release,
					dsn: options.dsn,
					onWarn,
					runId: options.runId,
					access,
					writeChain: Promise.resolve(),
					closed: false,
					poisoned: false,
				},
				branchId,
			);
		} catch (error) {
			await release(true).catch(() => {});
			throw error;
		}
	}

	forBranch(branchId: BranchId): PostgresLogStore {
		return new PostgresLogStore(this.journal, branchId);
	}

	async captureSnapshot(branchId: BranchId): Promise<HistorySnapshot> {
		const branch = await this.getBranch(branchId);
		return { branchId, headSeqId: branch.headSeqId };
	}
	async listBranches(cursor?: BranchListCursor): Promise<BranchListChunk> {
		await this.awaitReadable();
		return listBranchesDirect(this.journal.client, this.journal.runId, this.journal.access, cursor);
	}
	async getBranch(branchId: BranchId): Promise<BranchHead> {
		await this.awaitReadable();
		return requireBranch(
			await findBranchDirect(this.journal.client, this.journal.runId, branchId, this.journal.access),
			branchId,
		);
	}
	async getRecord(seqId: number): Promise<DurableLogRecord | undefined> {
		await this.awaitReadable();
		return findRecordDirect(this.journal.client, this.journal.runId, seqId, this.journal.access);
	}
	async containsInHistory(input: { headSeqId: number | null; seqId: number }): Promise<boolean> {
		await this.awaitReadable();
		return containsInHistoryDirect(
			this.journal.client,
			this.journal.runId,
			input.headSeqId,
			input.seqId,
			this.journal.access,
		);
	}
	async readRecords(input: {
		snapshot: HistorySnapshot;
		cursor?: HistoryCursor;
	}): Promise<HistoryChunk<DurableLogRecord>> {
		return this.readSubject(input.snapshot, { kind: "records" }, input.cursor) as Promise<
			HistoryChunk<DurableLogRecord>
		>;
	}
	async readStateVisits(input: {
		snapshot: HistorySnapshot;
		state: StatePath;
		cursor?: HistoryCursor;
	}): Promise<HistoryChunk<StateVisitHistoryItem>> {
		return this.readSubject(input.snapshot, { kind: "state-visits", state: input.state }, input.cursor) as Promise<
			HistoryChunk<StateVisitHistoryItem>
		>;
	}
	async readMapVisits(input: {
		snapshot: HistorySnapshot;
		mapPath: StatePath;
		cursor?: HistoryCursor;
	}): Promise<HistoryChunk<MapVisitHistoryItem>> {
		return this.readSubject(input.snapshot, { kind: "map-visits", mapPath: input.mapPath }, input.cursor) as Promise<
			HistoryChunk<MapVisitHistoryItem>
		>;
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
		) as Promise<HistoryChunk<ActorGenerationHistoryItem>>;
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
		) as Promise<HistoryChunk<ActorMessageHistoryItem>>;
	}
	async cursorAt(input: {
		snapshot: HistorySnapshot;
		subject: HistorySubject;
		seqId: number;
	}): Promise<HistoryCursor | undefined> {
		const ancestry = await this.ancestryForSnapshot(input.snapshot);
		return cursorAtItems(input.snapshot, input.subject, historyItemsForSubject(ancestry, input.subject), input.seqId);
	}
	async findUserInteractionResponse(input: {
		headSeqId: number | null;
		gateSeqId: number;
	}): Promise<ResolvedGateLog | undefined> {
		await this.awaitReadable();
		const ancestry = await materializeHistoryToHeadDirect(
			this.journal.client,
			this.journal.runId,
			input.headSeqId,
			this.journal.access,
		);
		return findUserInteractionResponseInAncestry(ancestry, input.gateSeqId);
	}
	async countRecords(): Promise<number> {
		await this.awaitReadable();
		return countRecordsDirect(this.journal.client, this.journal.runId, this.journal.access);
	}
	async loadExactCheckpoint(input: CheckpointQuery): Promise<OpaqueCheckpointEnvelope | undefined> {
		await this.awaitReadable();
		const rows = await queryRows(
			this.journal.client,
			this.journal.access,
			`SELECT checkpoint_id, head_seq_id, selector_key, blob, created_at_ms
			   FROM ${CHECKPOINT_TABLE}
			  WHERE run_id = $1 AND head_seq_id IS NOT DISTINCT FROM $2
			    AND selector_key = $3
			  ORDER BY created_at_ms DESC LIMIT 1`,
			[this.journal.runId, input.targetHeadSeqId, input.selectorKey],
		);
		return rows[0] === undefined ? undefined : decodeCheckpointRow(rows[0]);
	}
	async findNearestCheckpoint(input: CheckpointQuery): Promise<OpaqueCheckpointEnvelope | undefined> {
		await this.awaitReadable();
		const rows = await queryRows(
			this.journal.client,
			this.journal.access,
			`WITH RECURSIVE ancestry AS (
			   SELECT seq, parent_id, 0 AS depth FROM ${JOURNAL_TABLE}
			    WHERE run_id = $1 AND seq = $2 AND kind = 'record'
			   UNION ALL
			   SELECT parent.seq, parent.parent_id, child.depth + 1
			     FROM ancestry child JOIN ${JOURNAL_TABLE} parent
			       ON parent.run_id = $1 AND parent.seq = child.parent_id AND parent.kind = 'record'
			 )
			 SELECT checkpoint_id, head_seq_id, selector_key, blob, created_at_ms
			   FROM ${CHECKPOINT_TABLE} checkpoint
			   LEFT JOIN ancestry ON ancestry.seq = checkpoint.head_seq_id
			  WHERE checkpoint.run_id = $1 AND checkpoint.selector_key = $3
			    AND (checkpoint.head_seq_id IS NULL OR ancestry.seq IS NOT NULL)
			  ORDER BY COALESCE(ancestry.depth, 2147483647), checkpoint.created_at_ms DESC LIMIT 1`,
			[this.journal.runId, input.targetHeadSeqId, input.selectorKey],
		);
		return rows[0] === undefined ? undefined : decodeCheckpointRow(rows[0]);
	}
	discardCheckpoint(checkpointId: string): Promise<void> {
		return this.transaction(async (tx) => {
			await tx.query(`DELETE FROM ${CHECKPOINT_TABLE} WHERE run_id = $1 AND checkpoint_id = $2`, [
				this.journal.runId,
				checkpointId,
			]);
		});
	}
	async storeCheckpoint(checkpoint: OpaqueCheckpointEnvelope): Promise<void> {
		const cloned = cloneOpaqueCheckpoint(checkpoint);
		return this.transaction((tx) => tx.storeCheckpoint(cloned));
	}

	private async readSubject(
		snapshot: HistorySnapshot,
		subject: HistorySubject,
		cursor?: HistoryCursor,
	): Promise<
		HistoryChunk<
			| DurableLogRecord
			| StateVisitHistoryItem
			| MapVisitHistoryItem
			| ActorGenerationHistoryItem
			| ActorMessageHistoryItem
		>
	> {
		const ancestry = await this.ancestryForSnapshot(snapshot);
		return historyChunkFromItems(snapshot, subject, historyItemsForSubject(ancestry, subject), cursor);
	}
	private async ancestryForSnapshot(snapshot: HistorySnapshot): Promise<readonly DurableLogRecord[]> {
		await this.awaitReadable();
		await requireSnapshotBranchDirect(this.journal.client, this.journal.runId, snapshot, this.journal.access);
		return materializeHistoryToHeadDirect(
			this.journal.client,
			this.journal.runId,
			snapshot.headSeqId,
			this.journal.access,
		);
	}

	async readRunMeta(): Promise<RunMeta | undefined> {
		await this.awaitReadable();
		try {
			const result = await this.journal.client.query(
				`SELECT chart_path, export_name, work_dir, chart_id, created_at, origin_session_id FROM ${RUN_META_TABLE} WHERE run_id = $1`,
				[this.journal.runId],
			);
			return result.rows[0] === undefined || result.rows[0].chart_path === null
				? undefined
				: decodeRunMeta(result.rows[0]);
		} catch (error) {
			if (isUndefinedTable(error)) {
				return undefined;
			}
			throw error;
		}
	}
	writeRunMeta(meta: RunMeta): Promise<void> {
		return this.enqueueWrite(async () => {
			const { client, runId } = this.journal;
			try {
				await client.query("BEGIN");
				await client.query(
					`INSERT INTO ${RUN_META_TABLE} (run_id, chart_path, export_name, work_dir, chart_id, created_at, origin_session_id)
					 VALUES ($1, $2, $3, $4, $5, $6, $7)
					 ON CONFLICT (run_id) DO UPDATE SET
					   chart_path = EXCLUDED.chart_path,
					   export_name = EXCLUDED.export_name,
					   work_dir = EXCLUDED.work_dir,
					   chart_id = EXCLUDED.chart_id,
					   created_at = EXCLUDED.created_at,
					   origin_session_id = EXCLUDED.origin_session_id
					 WHERE ${RUN_META_TABLE}.chart_path IS NULL`,
					[
						runId,
						meta.chartPath,
						meta.exportName ?? null,
						meta.workDir,
						meta.chartId,
						meta.createdAt,
						meta.originSessionId ?? null,
					],
				);
				const stored = await this.readRunMetaDirect();
				const { runId: metadataRunId, ...fields } = meta;
				if (
					(metadataRunId !== undefined && metadataRunId !== runId) ||
					stored === undefined ||
					!isDeepStrictEqual(stored, fields)
				) {
					throw new Error(`Conflicting metadata for Hyperchart run '${runId}'`);
				}
				await client.query("COMMIT");
			} catch (error) {
				await client.query("ROLLBACK").catch(() => {});
				throw error;
			}
		});
	}
	async readRunStatus(): Promise<HyperchartRunStatus | undefined> {
		await this.awaitReadable();
		try {
			return await readRunStatusDirect(this.journal.client, this.journal.runId);
		} catch (error) {
			if (isUndefinedTable(error)) {
				return undefined;
			}
			throw error;
		}
	}
	/**
	 * Status is operational, not journal truth: read-access handles may patch it and
	 * a poisoned journal must still record its terminal outcome. The patch is still
	 * chained behind journal transactions because it shares their connection.
	 */
	patchRunStatus(patch: RunStatusPatch): Promise<HyperchartRunStatus> {
		if (this.journal.closed) {
			return Promise.reject(new Error("Postgres Hyperchart journal is closed"));
		}
		const { client, runId } = this.journal;
		const task = async (): Promise<HyperchartRunStatus> => {
			const attempt = async (): Promise<HyperchartRunStatus> => {
				try {
					await client.query("BEGIN");
					const previous = await readRunStatusDirect(client, runId, { forUpdate: true });
					const next = applyRunStatusPatch(runId, previous, patch);
					await client.query(
						`INSERT INTO ${RUN_STATUS_TABLE} (run_id, chart_id, state, branch_ids, attempt_id, pid, started_at, updated_at, heartbeat_at, exit_code, error, replay_warnings)
						 VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
						 ON CONFLICT (run_id) DO UPDATE SET
						   chart_id = EXCLUDED.chart_id,
						   state = EXCLUDED.state,
						   branch_ids = EXCLUDED.branch_ids,
						   attempt_id = EXCLUDED.attempt_id,
						   pid = EXCLUDED.pid,
						   started_at = EXCLUDED.started_at,
						   updated_at = EXCLUDED.updated_at,
						   heartbeat_at = EXCLUDED.heartbeat_at,
						   exit_code = EXCLUDED.exit_code,
						   error = EXCLUDED.error,
						   replay_warnings = EXCLUDED.replay_warnings`,
						[
							runId,
							next.chartId,
							next.state,
							JSON.stringify(next.branchIds),
							next.attemptId ?? null,
							next.pid ?? null,
							next.startedAt,
							next.updatedAt,
							next.heartbeatAt ?? null,
							next.exitCode ?? null,
							next.error ?? null,
							next.replayWarnings === undefined ? null : JSON.stringify(next.replayWarnings),
						],
					);
					await client.query("SELECT pg_notify($1, $2)", [RUN_STATUS_CHANNEL, runId]);
					await client.query("COMMIT");
					return next;
				} catch (error) {
					await client.query("ROLLBACK").catch(() => {
						// A connection stuck inside a transaction must never return to the pool.
						this.journal.poisoned = true;
					});
					throw error;
				}
			};
			try {
				return await attempt();
			} catch (error) {
				// Read-access handles never create the schema up front; a host may publish
				// "starting" before any writer has touched this database.
				if (!isUndefinedTable(error)) {
					throw error;
				}
				await ensureSchema(client);
				return await attempt();
			}
		};
		const result = this.journal.writeChain.then(task);
		this.journal.writeChain = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	publishControlRequest(request: RunnerControlRequest): Promise<void> {
		return this.controlWrite(async (client, runId) => {
			const inserted = await client.query(
				`INSERT INTO ${CONTROL_TABLE} (run_id, role, id, attempt_id, payload, created_at)
				 VALUES ($1, 'request', $2, $3, $4::jsonb, $5)
				 ON CONFLICT DO NOTHING RETURNING id`,
				[runId, request.id, request.attemptId, JSON.stringify(request), request.createdAt],
			);
			if (inserted.rows.length !== 1) {
				throw new Error(`Control request '${request.id}' already exists for Hyperchart run '${runId}'`);
			}
			await client.query("SELECT pg_notify($1, $2)", [CONTROL_CHANNEL, runId]);
		});
	}
	async listControlRequests(): Promise<readonly RunnerControlRequest[]> {
		await this.awaitReadable();
		const { client, runId } = this.journal;
		let rows: Record<string, unknown>[];
		try {
			rows = (
				await client.query(
					`SELECT id, payload FROM ${CONTROL_TABLE} WHERE run_id = $1 AND role = 'request' ORDER BY created_at, id`,
					[runId],
				)
			).rows;
		} catch (error) {
			if (isUndefinedTable(error)) {
				return [];
			}
			throw error;
		}
		const requests: RunnerControlRequest[] = [];
		for (const row of rows) {
			const request = parseControlRequest(row.payload);
			if (request === undefined) {
				await this.discardControlRequest(row.id as string);
				continue;
			}
			requests.push(request);
		}
		return requests;
	}
	discardControlRequest(requestId: string): Promise<void> {
		return this.controlWrite(async (client, runId) => {
			await client.query(`DELETE FROM ${CONTROL_TABLE} WHERE run_id = $1 AND role = 'request' AND id = $2`, [
				runId,
				requestId,
			]);
		});
	}
	publishControlResult(result: RunnerControlResult): Promise<boolean> {
		return this.controlWrite(async (client, runId) => {
			const inserted = await client.query(
				`INSERT INTO ${CONTROL_TABLE} (run_id, role, id, attempt_id, payload, created_at)
				 VALUES ($1, 'result', $2, $3, $4::jsonb, $5)
				 ON CONFLICT DO NOTHING RETURNING id`,
				[runId, result.requestId, result.attemptId, JSON.stringify(result), result.completedAt],
			);
			if (inserted.rows.length !== 1) {
				return false;
			}
			await client.query("SELECT pg_notify($1, $2)", [CONTROL_CHANNEL, runId]);
			return true;
		});
	}
	async readControlResult(requestId: string): Promise<RunnerControlResult | undefined> {
		await this.awaitReadable();
		try {
			const result = await this.journal.client.query(
				`SELECT payload FROM ${CONTROL_TABLE} WHERE run_id = $1 AND role = 'result' AND id = $2`,
				[this.journal.runId, requestId],
			);
			return parseControlResult(result.rows[0]?.payload);
		} catch (error) {
			if (isUndefinedTable(error)) {
				return undefined;
			}
			throw error;
		}
	}
	discardControlResult(requestId: string): Promise<void> {
		return this.controlWrite(async (client, runId) => {
			await client.query(`DELETE FROM ${CONTROL_TABLE} WHERE run_id = $1 AND role = 'result' AND id = $2`, [
				runId,
				requestId,
			]);
		});
	}
	watchRunChange(topics: readonly RunChangeTopic[], options: WaitForRunChangeOptions): RunChangeWait {
		const channels = topics.map((topic) => (topic === "status" ? RUN_STATUS_CHANNEL : CONTROL_CHANNEL));
		return watchNotification(this.journal.dsn, this.journal.onWarn, this.journal.runId, channels, options);
	}
	/**
	 * Control rows are operational like status: read-access handles write them, the
	 * schema is created lazily, and each statement is chained behind journal
	 * transactions because it shares their connection.
	 */
	private controlWrite<T>(task: (client: PgClientLike, runId: string) => Promise<T>): Promise<T> {
		if (this.journal.closed) {
			return Promise.reject(new Error("Postgres Hyperchart journal is closed"));
		}
		const { client, runId } = this.journal;
		const run = async (): Promise<T> => {
			try {
				return await task(client, runId);
			} catch (error) {
				if (!isUndefinedTable(error)) {
					throw error;
				}
				await ensureSchema(client);
				return await task(client, runId);
			}
		};
		const result = this.journal.writeChain.then(run);
		this.journal.writeChain = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	deleteRunData(): Promise<void> {
		return this.enqueueWrite(async () => {
			const { client, runId } = this.journal;
			try {
				await client.query("BEGIN");
				await client.query(`DELETE FROM ${CHECKPOINT_TABLE} WHERE run_id = $1`, [runId]);
				await client.query(`DELETE FROM ${CONTROL_TABLE} WHERE run_id = $1`, [runId]);
				await client.query(`DELETE FROM ${RUN_STATUS_TABLE} WHERE run_id = $1`, [runId]);
				await client.query(`DELETE FROM ${RUN_META_TABLE} WHERE run_id = $1`, [runId]);
				await client.query(`DELETE FROM ${JOURNAL_TABLE} WHERE run_id = $1`, [runId]);
				await client.query("COMMIT");
			} catch (error) {
				await client.query("ROLLBACK").catch(() => {});
				throw error;
			}
		});
	}
	private async readRunMetaDirect(): Promise<RunMeta | undefined> {
		const result = await this.journal.client.query(
			`SELECT chart_path, export_name, work_dir, chart_id, created_at, origin_session_id FROM ${RUN_META_TABLE} WHERE run_id = $1`,
			[this.journal.runId],
		);
		return result.rows[0] === undefined || result.rows[0].chart_path === null
			? undefined
			: decodeRunMeta(result.rows[0]);
	}

	async initializeRootBranch(
		metadata: BranchMetadata = { name: this.branchId },
		options?: BranchMutationOptions,
	): Promise<BranchHead> {
		const checkpoint = options?.checkpoint === undefined ? undefined : cloneOpaqueCheckpoint(options.checkpoint);
		return this.transaction(async (tx) => {
			const impl = tx as TransactionImpl;
			if (await impl.hasAnyEntry()) {
				throw new Error("Cannot initialize a non-empty Hyperchart journal");
			}
			const branch = await impl.createRootBranch(this.branchId, metadata);
			if (checkpoint !== undefined) {
				await tx.storeCheckpoint(checkpoint);
			}
			return branch;
		});
	}
	appendDrafts(
		drafts: readonly DurableRecordDraft[],
		prepare?: PrepareStampedCommit,
	): Promise<readonly DurableLogRecord[]> {
		if (drafts.length === 0) {
			return Promise.resolve([]);
		}
		return this.transaction((tx) => tx.appendDrafts(this.branchId, drafts, prepare));
	}
	appendDraftsAtHead(input: AppendAtHeadInput, prepare?: PrepareStampedCommit): Promise<readonly DurableLogRecord[]> {
		if (input.drafts.length === 0) {
			return Promise.resolve([]);
		}
		return this.transaction((tx) => tx.appendDraftsAtHead(this.branchId, input, prepare));
	}
	async createBranch(
		branchId: BranchId,
		headSeqId: number,
		metadata?: BranchMetadata,
		options?: BranchMutationOptions,
	): Promise<BranchHead> {
		const checkpoint = options?.checkpoint === undefined ? undefined : cloneOpaqueCheckpoint(options.checkpoint);
		return this.transaction((tx) =>
			tx.createBranch(branchId, headSeqId, metadata, checkpoint === undefined ? undefined : { checkpoint }),
		);
	}
	async moveBranch(
		branchId: BranchId,
		headSeqId: number | null,
		options?: BranchMutationOptions,
	): Promise<BranchMoveResult> {
		const checkpoint = options?.checkpoint === undefined ? undefined : cloneOpaqueCheckpoint(options.checkpoint);
		return this.transaction((tx) =>
			tx.moveBranch(branchId, headSeqId, checkpoint === undefined ? undefined : { checkpoint }),
		);
	}

	/** Managed transaction: journal mutations and host-domain SQL share one client and commit. */
	transaction<T>(task: (tx: PostgresRunTransaction) => Promise<T>): Promise<T> {
		return this.enqueueWrite(async () => {
			const { client, runId } = this.journal;
			let commitAttempted = false;
			try {
				await client.query("BEGIN");
				const tx = new TransactionImpl(client, runId, this.journal.nextSeq);
				const result = await task(tx);
				commitAttempted = true;
				await client.query("COMMIT");
				this.journal.nextSeq = tx.confirmCommitted();
				return result;
			} catch (error) {
				if (!commitAttempted) {
					await client.query("ROLLBACK").catch(() => {});
				} else {
					this.journal.poisoned = true;
					await this.journal.release(true).catch(() => {});
				}
				throw normalizeUnique(error, runId);
			}
		});
	}

	appendDraftsAtHeadWithParticipant<T>(
		branchId: BranchId,
		input: AppendAtHeadInput,
		prepare: PrepareStampedCommit | undefined,
		participate: SqlCommitParticipant<T>,
	): Promise<{ records: readonly DurableLogRecord[]; participant: T }> {
		return this.transaction(async (tx) => ({
			records: await tx.appendDraftsAtHead(branchId, input, prepare),
			participant: await participate(restrictTransaction(tx)),
		}));
	}
	async forkAndAppend<T>(
		input: PostgresForkAndAppendInput,
		participate: SqlCommitParticipant<T>,
	): Promise<{ branch: BranchHead; records: readonly DurableLogRecord[]; participant: T }> {
		const checkpoint = input.checkpoint === undefined ? undefined : cloneOpaqueCheckpoint(input.checkpoint);
		if (input.appendBranchId !== input.sourceBranchId && input.appendBranchId !== input.newBranchId) {
			return Promise.reject(new Error("appendBranchId must be the source branch or the newly created branch"));
		}
		return this.transaction(async (tx) => {
			const impl = tx as TransactionImpl;
			if (!(await impl.containsInBranchHistory(input.sourceBranchId, input.fromSeqId))) {
				throw new Error(`Fork point ${input.fromSeqId} is not in source branch '${input.sourceBranchId}' ancestry`);
			}
			const branch = await impl.ensureExactBranch(input.newBranchId, input.fromSeqId, input.metadata);
			if (checkpoint !== undefined) {
				await tx.storeCheckpoint(checkpoint);
			}
			const records = await tx.appendDraftsAtHead(input.appendBranchId, input.append, input.prepare);
			const participant = await participate(restrictTransaction(tx));
			return { branch, records, participant };
		});
	}

	async close(): Promise<void> {
		if (this.journal.closed) {
			return;
		}
		this.journal.closed = true;
		await this.journal.writeChain.catch(() => {});
		await this.journal.release(this.journal.poisoned).catch(() => {});
	}
	private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
		if (this.journal.access !== "writer") {
			return Promise.reject(new Error(`Hyperchart run '${this.journal.runId}' was opened read-only`));
		}
		if (this.journal.closed) {
			return Promise.reject(new Error("Postgres Hyperchart journal is closed"));
		}
		if (this.journal.poisoned) {
			return Promise.reject(new Error("Postgres Hyperchart journal is unusable after an uncertain commit"));
		}
		const result = this.journal.writeChain.then(task);
		this.journal.writeChain = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
	private async awaitReadable(): Promise<void> {
		if (this.journal.closed) {
			throw new Error("Postgres Hyperchart journal is closed");
		}
		if (this.journal.poisoned) {
			throw new Error("Postgres Hyperchart journal is unusable after an uncertain commit");
		}
		await this.journal.writeChain;
	}
}

class TransactionImpl implements PostgresRunTransaction {
	private readonly confirmations: Array<() => void> = [];
	private nextSeq: number;
	constructor(
		readonly client: PgClientLike,
		readonly runId: string,
		nextSeq: number | undefined,
	) {
		if (nextSeq === undefined) {
			throw new Error(`Missing sequence allocation head for writable Hyperchart run '${runId}'`);
		}
		this.nextSeq = nextSeq;
	}
	confirmCommitted(): number {
		for (const confirm of this.confirmations) {
			confirm();
		}
		return this.nextSeq;
	}
	query(text: string, values?: readonly unknown[]): Promise<PgQueryResult> {
		return this.client.query(text, values);
	}
	async hasAnyEntry(): Promise<boolean> {
		const result = await this.client.query(
			`SELECT EXISTS (SELECT 1 FROM ${JOURNAL_TABLE} WHERE run_id = $1) AS present`,
			[this.runId],
		);
		return result.rows[0]?.present === true;
	}
	async createRootBranch(branchId: BranchId, metadata: BranchMetadata): Promise<BranchHead> {
		const committedAt = Date.now();
		await this.commitEntries([
			{
				kind: "branch",
				op: "create",
				seqId: await this.allocateOne(),
				branchId,
				headSeqId: null,
				metadata,
				committedAt,
			},
		]);
		return { branchId, headSeqId: null, createdAt: committedAt, metadata };
	}
	async appendDrafts(
		branchId: BranchId,
		drafts: readonly DurableRecordDraft[],
		prepare?: PrepareStampedCommit,
	): Promise<readonly DurableLogRecord[]> {
		return this.appendStamped(branchId, drafts, prepare);
	}
	async appendDraftsAtHead(
		branchId: BranchId,
		input: AppendAtHeadInput,
		prepare?: PrepareStampedCommit,
	): Promise<readonly DurableLogRecord[]> {
		const branch = requireBranch(await findBranchDirect(this.client, this.runId, branchId, "writer"), branchId);
		if (branch.headSeqId !== input.expectedHeadSeqId) {
			throw new BranchHeadMovedError(branchId, input.expectedHeadSeqId, branch.headSeqId);
		}
		return this.appendStamped(branchId, input.drafts, prepare, branch);
	}
	private async appendStamped(
		branchId: BranchId,
		drafts: readonly DurableRecordDraft[],
		prepare?: PrepareStampedCommit,
		knownBranch?: BranchHead,
	): Promise<readonly DurableLogRecord[]> {
		if (drafts.length === 0) {
			return [];
		}
		const branch =
			knownBranch ?? requireBranch(await findBranchDirect(this.client, this.runId, branchId, "writer"), branchId);
		let seqId = await this.allocate(drafts.length);
		let parentId = branch.headSeqId;
		const now = Date.now();
		const records = drafts.map((draft) => {
			assertDurableRecordDraft(draft);
			const record = { ...draft, seqId: seqId++, parentId, branchId, timestamp: now } as DurableLogRecord;
			parentId = record.seqId;
			return record;
		});
		const prepared = prepare?.(records);
		const checkpoints = (prepared?.checkpoints ?? []).map(cloneOpaqueCheckpoint);
		await this.commitEntries(records);
		for (const checkpoint of checkpoints) {
			await this.storeCheckpoint(checkpoint);
		}
		if (prepared !== undefined) {
			this.confirmations.push(prepared.committed);
		}
		return records;
	}
	async createBranch(
		branchId: BranchId,
		headSeqId: number,
		metadata?: BranchMetadata,
		options?: BranchMutationOptions,
	): Promise<BranchHead> {
		if ((await findBranchDirect(this.client, this.runId, branchId, "writer")) !== undefined) {
			throw new Error(`Hyperchart branch '${branchId}' already exists`);
		}
		if ((await findRecordDirect(this.client, this.runId, headSeqId, "writer")) === undefined) {
			throw new Error(`No durable log record with seqId ${headSeqId}`);
		}
		const checkpoint = options?.checkpoint === undefined ? undefined : cloneOpaqueCheckpoint(options.checkpoint);
		const committedAt = Date.now();
		await this.commitEntries([
			{
				kind: "branch",
				op: "create",
				seqId: await this.allocateOne(),
				branchId,
				headSeqId,
				...(metadata === undefined ? {} : { metadata }),
				committedAt,
			},
		]);
		if (checkpoint !== undefined) {
			await this.storeCheckpoint(checkpoint);
		}
		return { branchId, headSeqId, createdAt: committedAt, ...(metadata === undefined ? {} : { metadata }) };
	}
	async ensureExactBranch(branchId: BranchId, headSeqId: number, metadata?: BranchMetadata): Promise<BranchHead> {
		const existing = await findBranchDirect(this.client, this.runId, branchId, "writer");
		if (existing === undefined) {
			return this.createBranch(branchId, headSeqId, metadata);
		}
		if (
			!(await containsInBranchHistoryDirect(this.client, this.runId, branchId, headSeqId, "writer")) ||
			!isDeepStrictEqual(existing.metadata, metadata)
		) {
			throw new Error(`Conflicting retry for Hyperchart branch '${branchId}'`);
		}
		return existing;
	}
	async moveBranch(
		branchId: BranchId,
		headSeqId: number | null,
		options?: BranchMutationOptions,
	): Promise<BranchMoveResult> {
		const checkpoint = options?.checkpoint === undefined ? undefined : cloneOpaqueCheckpoint(options.checkpoint);
		// Sequence allocation is the per-run serialization boundary. Read the old
		// head and record count only after holding it so the acknowledgement names
		// the exact durable state immediately preceding this move.
		const moveSeqId = await this.allocateOne();
		const branch = requireBranch(await findBranchDirect(this.client, this.runId, branchId, "writer"), branchId);
		if (headSeqId !== null && (await findRecordDirect(this.client, this.runId, headSeqId, "writer")) === undefined) {
			throw new Error(`No durable log record with seqId ${headSeqId}`);
		}
		const preservedRecords = await countRecordsDirect(this.client, this.runId, "writer");
		await this.commitEntries([
			{ kind: "branch", op: "move", seqId: moveSeqId, branchId, headSeqId, committedAt: Date.now() },
		]);
		if (checkpoint !== undefined) {
			await this.storeCheckpoint(checkpoint);
		}
		return { ...branch, headSeqId, moveSeqId, previousHeadSeqId: branch.headSeqId, preservedRecords };
	}
	containsInBranchHistory(branchId: BranchId, seqId: number): Promise<boolean> {
		return containsInBranchHistoryDirect(this.client, this.runId, branchId, seqId, "writer");
	}
	storeCheckpoint(checkpoint: OpaqueCheckpointEnvelope): Promise<void> {
		return saveCheckpointDirect(this.client, this.runId, cloneOpaqueCheckpoint(checkpoint));
	}
	private async allocateOne(): Promise<number> {
		return this.allocate(1);
	}
	private async allocate(count: number): Promise<number> {
		if (!Number.isSafeInteger(count) || count <= 0) {
			throw new Error(`Invalid Hyperchart sequence allocation size ${count}`);
		}
		const firstSeq = this.nextSeq;
		const nextSeq = firstSeq + count;
		if (!Number.isSafeInteger(nextSeq)) {
			throw new Error(`Hyperchart sequence allocation exceeds the safe integer range for run '${this.runId}'`);
		}
		this.nextSeq = nextSeq;
		return firstSeq;
	}
	private async commitEntries(entries: readonly StorageEntry[]): Promise<void> {
		if (entries.length === 0) {
			return;
		}
		const values: unknown[] = [this.runId];
		const rows = entries.map((entry, index) => {
			const parameter = 2 + index * 9;
			if (isDurableRecordEntry(entry)) {
				const { seqId, parentId, branchId, type, ...payload } = entry;
				values.push(seqId, "record", branchId, parentId, null, type, JSON.stringify(payload), null, payload.timestamp);
			} else {
				values.push(
					entry.seqId,
					entry.op === "create" ? "branch_create" : "branch_move",
					entry.branchId,
					null,
					entry.headSeqId,
					null,
					null,
					entry.op === "create" && entry.metadata !== undefined ? JSON.stringify(entry.metadata) : null,
					entry.committedAt,
				);
			}
			return `($1, $${parameter}, $${parameter + 1}, $${parameter + 2}, $${parameter + 3}, $${parameter + 4}, $${parameter + 5}, $${parameter + 6}::jsonb, $${parameter + 7}::jsonb, $${parameter + 8})`;
		});
		const firstSeq = entries[0]!.seqId;
		const nextSeq = entries.at(-1)!.seqId + 1;
		const expectedSeqParameter = values.length + 1;
		const nextSeqParameter = values.length + 2;
		const notifyChannelParameter = values.length + 3;
		const notifyPayloadParameter = values.length + 4;
		values.push(firstSeq, nextSeq, JOURNAL_CHANNEL, `${this.runId}:${entries.at(-1)!.seqId}`);
		const result = await this.client.query(
			`WITH allocation AS (
			   UPDATE ${RUN_META_TABLE}
			      SET next_seq = $${nextSeqParameter}
			    WHERE run_id = $1 AND next_seq = $${expectedSeqParameter}
			    RETURNING run_id
			 ), inserted AS (
			   INSERT INTO ${JOURNAL_TABLE}
			     (run_id, seq, kind, branch_id, parent_id, head_seq_id, record_type, payload, metadata, committed_at_ms)
			   SELECT input.run_id,
			          input.seq::bigint,
			          input.kind,
			          input.branch_id,
			          input.parent_id::bigint,
			          input.head_seq_id::bigint,
			          input.record_type,
			          input.payload::jsonb,
			          input.metadata::jsonb,
			          input.committed_at_ms::bigint
			     FROM (VALUES ${rows.join(", ")}) AS input
			       (run_id, seq, kind, branch_id, parent_id, head_seq_id, record_type, payload, metadata, committed_at_ms)
			     JOIN allocation USING (run_id)
			   RETURNING seq
			 )
			 SELECT pg_notify($${notifyChannelParameter}, $${notifyPayloadParameter})
			   FROM inserted
			  LIMIT 1`,
			values,
		);
		if (result.rows.length !== 1) {
			throw new Error(`Hyperchart sequence allocation head changed unexpectedly for run '${this.runId}'`);
		}
	}
}

type PgPoolClientLike = PgClientLike & { release(destroy?: boolean | Error): void };
type PgPoolLike = {
	connect(): Promise<PgPoolClientLike>;
	on(event: "error", listener: (error: Error) => void): unknown;
};
type PgModule = {
	Client: new (config: { connectionString: string }) => PgClientLike;
	Pool: new (config: {
		connectionString: string;
		max: number;
		idleTimeoutMillis: number;
		allowExitOnIdle: boolean;
	}) => PgPoolLike;
};

async function loadPg(): Promise<PgModule> {
	try {
		return (await import("pg")) as unknown as PgModule;
	} catch {
		throw new Error(
			"Postgres Hyperchart log storage requires the optional 'pg' package; install it to use HYPERCHART_PG_DSN",
		);
	}
}

/**
 * Read handles are opened and closed constantly: every host status read, poll tick,
 * TUI refresh, and Inspector request. They hold no session state (no advisory lock,
 * no LISTEN), so they share one pool per DSN and only pay a connection handshake when
 * the pool is cold. Idle pooled connections never keep the process alive.
 */
const readPools = new Map<string, PgPoolLike>();

/**
 * One LISTEN connection per DSN per process, created on the first waiter and
 * ended shortly after the last one leaves. Notifications are wake-up hints keyed
 * by run id; waiters always re-read state and always have a fallback timeout, so a
 * dropped connection costs latency, never correctness.
 */
type PgNotification = { channel: string; payload?: string | undefined };
type PgListenClientLike = PgClientLike & {
	on(event: "notification", listener: (message: PgNotification) => void): unknown;
};
type Listener = {
	client: Promise<PgListenClientLike>;
	waiters: Set<(channel: string, runId: string) => void>;
	idleTimer: NodeJS.Timeout | undefined;
	broken: boolean;
};
const listeners = new Map<string, Listener>();
const LISTENER_IDLE_MS = 10_000;
const LISTEN_CHANNELS = [RUN_STATUS_CHANNEL, CONTROL_CHANNEL];

function listenerFor(dsn: string, onWarn: (message: string) => void): Listener {
	const existing = listeners.get(dsn);
	if (existing !== undefined && !existing.broken) {
		return existing;
	}
	const listener: Listener = {
		client: undefined as unknown as Promise<PgListenClientLike>,
		waiters: new Set(),
		idleTimer: undefined,
		broken: false,
	};
	listener.client = (async () => {
		const pg = await loadPg();
		const client = new pg.Client({ connectionString: dsn }) as PgListenClientLike;
		client.on("error", (error) => {
			onWarn(`Hyperchart Postgres listener error: ${error.message}`);
			listener.broken = true;
			if (listeners.get(dsn) === listener) {
				listeners.delete(dsn);
			}
			client.end().catch(() => {});
		});
		client.on("notification", (message) => {
			if (message.payload === undefined) {
				return;
			}
			for (const waiter of listener.waiters) {
				waiter(message.channel, message.payload);
			}
		});
		await client.connect();
		for (const channel of LISTEN_CHANNELS) {
			await client.query(`LISTEN ${channel}`);
		}
		return client;
	})();
	listener.client.catch(() => {
		listener.broken = true;
		if (listeners.get(dsn) === listener) {
			listeners.delete(dsn);
		}
	});
	listeners.set(dsn, listener);
	return listener;
}

function releaseListener(dsn: string, listener: Listener): void {
	if (listener.waiters.size > 0 || listener.idleTimer !== undefined) {
		return;
	}
	listener.idleTimer = setTimeout(() => {
		listener.idleTimer = undefined;
		if (listener.waiters.size > 0) {
			return;
		}
		if (listeners.get(dsn) === listener) {
			listeners.delete(dsn);
		}
		listener.broken = true;
		listener.client.then((client) => client.end()).catch(() => {});
	}, LISTENER_IDLE_MS);
	listener.idleTimer.unref();
}

function watchNotification(
	dsn: string,
	onWarn: (message: string) => void,
	runId: string,
	channels: readonly string[],
	options: WaitForRunChangeOptions,
): RunChangeWait {
	let cancel: () => void = () => {};
	const changed = new Promise<void>((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(options.signal.reason);
			return;
		}
		const listener = listenerFor(dsn, onWarn);
		if (listener.idleTimer !== undefined) {
			clearTimeout(listener.idleTimer);
			listener.idleTimer = undefined;
		}
		const finish = () => {
			clearTimeout(timer);
			listener.waiters.delete(waiter);
			options.signal?.removeEventListener("abort", onAbort);
			releaseListener(dsn, listener);
		};
		const waiter = (channel: string, notifiedRunId: string) => {
			if (notifiedRunId === runId && channels.includes(channel)) {
				finish();
				resolve();
			}
		};
		const onAbort = () => {
			finish();
			reject(options.signal?.reason);
		};
		const timer = setTimeout(() => {
			finish();
			resolve();
		}, options.timeoutMs);
		if (options.persistent !== true) {
			timer.unref();
		}
		cancel = () => {
			finish();
			resolve();
		};
		listener.waiters.add(waiter);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		// A listener that cannot connect leaves the fallback timeout in charge.
		listener.client.catch(() => {});
	});
	return { changed, cancel: () => cancel() };
}
const READ_POOL_MAX = 8;
const READ_POOL_IDLE_MS = 10_000;

async function readPool(dsn: string, onWarn: (message: string) => void): Promise<PgPoolLike> {
	const existing = readPools.get(dsn);
	if (existing !== undefined) {
		return existing;
	}
	const pg = await loadPg();
	const pool = new pg.Pool({
		connectionString: dsn,
		max: READ_POOL_MAX,
		idleTimeoutMillis: READ_POOL_IDLE_MS,
		allowExitOnIdle: true,
	});
	pool.on("error", (error) => onWarn(`Hyperchart Postgres read pool error: ${error.message}`));
	readPools.set(dsn, pool);
	return pool;
}

/**
 * A writer needs its own session: the run advisory lock and the allocation head
 * live for the connection's lifetime, so it is ended on close. A reader borrows a
 * pooled connection and returns it, destroying it only when it may be mid-transaction.
 */
async function acquirePgClient(
	dsn: string,
	access: PostgresLogAccess,
	onWarn: (message: string) => void,
): Promise<{ client: PgClientLike; release: (destroy?: boolean) => Promise<void> }> {
	if (access === "writer") {
		const pg = await loadPg();
		const client = new pg.Client({ connectionString: dsn });
		client.on("error", (error) => onWarn(`Hyperchart Postgres journal connection error: ${error.message}`));
		await client.connect();
		return { client, release: () => client.end() };
	}
	const client = await (await readPool(dsn, onWarn)).connect();
	let released = false;
	return {
		client,
		release: async (destroy = false) => {
			if (released) {
				return;
			}
			released = true;
			client.release(destroy);
		},
	};
}
/**
 * Creates the journal, run-meta, and checkpoint tables and their indexes.
 * `IF NOT EXISTS` does not serialize concurrent creators, so writers opening
 * stores together on an empty database take one transaction-scoped advisory
 * lock and create the schema one after another.
 */
async function ensureSchema(client: PgClientLike): Promise<void> {
	await client.query("BEGIN");
	try {
		await client.query("SELECT pg_advisory_xact_lock(hashtextextended('hyperchart:schema', 0))");
		for (const ddl of [
			JOURNAL_DDL,
			JOURNAL_PARENT_INDEX_DDL,
			JOURNAL_BRANCH_INDEX_DDL,
			JOURNAL_BRANCH_CREATE_INDEX_DDL,
			RUN_META_DDL,
			CHECKPOINT_DDL,
			CHECKPOINT_IDENTITY_DDL,
			RUN_STATUS_DDL,
			CONTROL_DDL,
		]) {
			await client.query(ddl);
		}
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK").catch(() => {});
		throw error;
	}
}

async function listBranchesDirect(
	client: PgClientLike,
	runId: string,
	access: PostgresLogAccess,
	cursor?: BranchListCursor,
): Promise<BranchListChunk> {
	const decoded = cursor === undefined ? undefined : decodeBranchListCursor(cursor);
	const values: unknown[] = [runId];
	const boundary = decoded === undefined ? "" : "AND (seq, branch_id) > ($2, $3)";
	if (decoded !== undefined) {
		values.push(decoded.createdSeqId, decoded.branchId);
	}
	const [rows, totals] = await Promise.all([
		queryRows(
			client,
			access,
			`WITH creates AS (
			   SELECT seq AS created_seq_id, branch_id, metadata, committed_at_ms
			     FROM ${JOURNAL_TABLE}
			    WHERE run_id = $1 AND kind = 'branch_create' ${boundary}
			    ORDER BY seq, branch_id LIMIT ${HISTORY_READ_ITEMS + 1}
			 )
			 SELECT creates.created_seq_id, creates.branch_id,
			        CASE WHEN latest.kind = 'record' THEN latest.seq ELSE latest.head_seq_id END AS current_head_seq_id,
			        creates.metadata, creates.committed_at_ms
			   FROM creates
			   CROSS JOIN LATERAL (
			     SELECT kind, seq, head_seq_id
			       FROM ${JOURNAL_TABLE}
			      WHERE run_id = $1 AND branch_id = creates.branch_id
			      ORDER BY seq DESC LIMIT 1
			   ) latest
			  ORDER BY creates.created_seq_id, creates.branch_id`,
			values,
		),
		queryRows(
			client,
			access,
			`SELECT COUNT(*) AS count FROM ${JOURNAL_TABLE} WHERE run_id=$1 AND kind='branch_create'`,
			[runId],
		),
	]);
	const page = rows.slice(0, HISTORY_READ_ITEMS);
	const last = page.at(-1);
	return {
		items: page.map(decodeBranchRow),
		totalCount: totals[0] === undefined ? 0 : pgNumber(totals[0].count),
		...(rows.length > page.length && last !== undefined
			? { next: encodeBranchListCursor(pgNumber(last.created_seq_id), last.branch_id as BranchId) }
			: {}),
	};
}
async function findBranchDirect(
	client: PgClientLike,
	runId: string,
	branchId: BranchId,
	access: PostgresLogAccess,
): Promise<BranchHead | undefined> {
	const rows = await queryRows(
		client,
		access,
		`WITH created AS (
		   SELECT branch_id, metadata, committed_at_ms
		     FROM ${JOURNAL_TABLE}
		    WHERE run_id = $1 AND branch_id = $2 AND kind = 'branch_create'
		    ORDER BY seq LIMIT 1
		 ), latest AS (
		   SELECT kind, seq, head_seq_id
		     FROM ${JOURNAL_TABLE}
		    WHERE run_id = $1 AND branch_id = $2
		    ORDER BY seq DESC LIMIT 1
		 )
		 SELECT created.branch_id,
		        CASE WHEN latest.kind = 'record' THEN latest.seq ELSE latest.head_seq_id END AS current_head_seq_id,
		        created.metadata, created.committed_at_ms
		   FROM created CROSS JOIN latest`,
		[runId, branchId],
	);
	return rows[0] === undefined ? undefined : decodeBranchRow(rows[0]);
}
async function findRecordDirect(
	client: PgClientLike,
	runId: string,
	seqId: number,
	access: PostgresLogAccess,
): Promise<DurableLogRecord | undefined> {
	const rows = await queryRows(
		client,
		access,
		`SELECT seq, kind, branch_id, parent_id, head_seq_id, record_type, payload, metadata, committed_at_ms FROM ${JOURNAL_TABLE} WHERE run_id = $1 AND seq = $2 AND kind = 'record'`,
		[runId, seqId],
	);
	return rows[0] === undefined ? undefined : decodeRecordRow(rows[0] as PostgresJournalRow);
}
async function materializeHistoryToHeadDirect(
	client: PgClientLike,
	runId: string,
	headSeqId: number | null,
	access: PostgresLogAccess,
): Promise<DurableLogRecord[]> {
	if (headSeqId === null) {
		return [];
	}
	const rows = await queryRows(
		client,
		access,
		`WITH RECURSIVE ancestry AS (
		   SELECT seq, kind, branch_id, parent_id, head_seq_id, record_type, payload, metadata, committed_at_ms, 0 AS depth
		     FROM ${JOURNAL_TABLE}
		    WHERE run_id = $1 AND seq = $2 AND kind = 'record'
		   UNION ALL
		   SELECT parent.seq, parent.kind, parent.branch_id, parent.parent_id, parent.head_seq_id,
		          parent.record_type, parent.payload, parent.metadata, parent.committed_at_ms, child.depth + 1
		     FROM ancestry child
		     JOIN ${JOURNAL_TABLE} parent ON parent.run_id = $1 AND parent.seq = child.parent_id
		    WHERE parent.kind = 'record'
		 )
		 SELECT seq, kind, branch_id, parent_id, head_seq_id, record_type, payload, metadata, committed_at_ms
		   FROM ancestry ORDER BY depth DESC`,
		[runId, headSeqId],
	);
	if (rows.length === 0) {
		throw new Error(`No durable log record with seqId ${headSeqId}`);
	}
	return rows.map((row) => decodeRecordRow(row as PostgresJournalRow));
}
async function readForwardReplayPageDirect(
	client: PgClientLike,
	runId: string,
	input: { targetHeadSeqId: number | null; afterSeqId: number | null },
	access: PostgresLogAccess,
): Promise<{ records: readonly DurableLogRecord[]; nextAfterSeqId?: number }> {
	if (input.targetHeadSeqId === null) {
		return { records: [] };
	}
	const rows = await queryRows(
		client,
		access,
		`WITH RECURSIVE ancestry AS (
		   SELECT seq, kind, branch_id, parent_id, head_seq_id, record_type, payload, metadata, committed_at_ms
		     FROM ${JOURNAL_TABLE} WHERE run_id = $1 AND seq = $2 AND kind = 'record'
		   UNION ALL
		   SELECT parent.seq, parent.kind, parent.branch_id, parent.parent_id, parent.head_seq_id,
		          parent.record_type, parent.payload, parent.metadata, parent.committed_at_ms
		     FROM ancestry child
		     JOIN ${JOURNAL_TABLE} parent ON parent.run_id = $1 AND parent.seq = child.parent_id
		    WHERE parent.kind = 'record'
		 )
		 SELECT seq, kind, branch_id, parent_id, head_seq_id, record_type, payload, metadata, committed_at_ms
		   FROM ancestry
		  WHERE ($3::bigint IS NULL OR seq > $3)
		  ORDER BY seq ASC LIMIT 501`,
		[runId, input.targetHeadSeqId, input.afterSeqId],
	);
	if (
		rows.length === 0 &&
		input.afterSeqId === null &&
		(await findRecordDirect(client, runId, input.targetHeadSeqId, access)) === undefined
	) {
		throw new Error(`No durable log record with seqId ${input.targetHeadSeqId}`);
	}
	const page = rows.slice(0, 500).map((row) => decodeRecordRow(row as PostgresJournalRow));
	return { records: page, ...(rows.length > 500 ? { nextAfterSeqId: page.at(-1)!.seqId } : {}) };
}

async function requireSnapshotBranchDirect(
	client: PgClientLike,
	runId: string,
	snapshot: HistorySnapshot,
	access: PostgresLogAccess,
): Promise<void> {
	if ((await findBranchDirect(client, runId, snapshot.branchId, access)) === undefined) {
		throw new Error(`Unknown Hyperchart branch '${snapshot.branchId}'`);
	}
	if (
		snapshot.headSeqId !== null &&
		(await findRecordDirect(client, runId, snapshot.headSeqId, access)) === undefined
	) {
		throw new Error(`No durable log record with seqId ${snapshot.headSeqId}`);
	}
}
async function containsInBranchHistoryDirect(
	client: PgClientLike,
	runId: string,
	branchId: BranchId,
	seqId: number,
	access: PostgresLogAccess,
): Promise<boolean> {
	const branch = await findBranchDirect(client, runId, branchId, access);
	if (branch === undefined) {
		if (!(await hasAnyEntryDirect(client, runId, access))) {
			return false;
		}
		throw new Error(`Unknown Hyperchart branch '${branchId}'`);
	}
	return containsInHistoryDirect(client, runId, branch.headSeqId, seqId, access);
}
async function containsInHistoryDirect(
	client: PgClientLike,
	runId: string,
	headSeqId: number | null,
	seqId: number,
	access: PostgresLogAccess,
): Promise<boolean> {
	if (headSeqId === null) {
		return false;
	}
	const rows = await queryRows(
		client,
		access,
		`WITH RECURSIVE ancestry AS (
		   SELECT seq, parent_id FROM ${JOURNAL_TABLE} WHERE run_id = $1 AND seq = $2 AND kind = 'record'
		   UNION ALL
		   SELECT parent.seq, parent.parent_id
		     FROM ancestry child JOIN ${JOURNAL_TABLE} parent ON parent.run_id = $1 AND parent.seq = child.parent_id
		    WHERE parent.kind = 'record'
		 ) SELECT EXISTS (SELECT 1 FROM ancestry WHERE seq = $3) AS present`,
		[runId, headSeqId, seqId],
	);
	return rows[0]?.present === true;
}
async function hasAnyEntryDirect(client: PgClientLike, runId: string, access: PostgresLogAccess): Promise<boolean> {
	const rows = await queryRows(
		client,
		access,
		`SELECT EXISTS (SELECT 1 FROM ${JOURNAL_TABLE} WHERE run_id = $1) AS present`,
		[runId],
	);
	return rows[0]?.present === true;
}
async function countRecordsDirect(client: PgClientLike, runId: string, access: PostgresLogAccess): Promise<number> {
	const rows = await queryRows(
		client,
		access,
		`SELECT COUNT(*) AS count FROM ${JOURNAL_TABLE} WHERE run_id = $1 AND kind = 'record'`,
		[runId],
	);
	return rows.length === 0 ? 0 : pgNumber(rows[0]?.count);
}
async function saveCheckpointDirect(
	client: PgClientLike,
	runId: string,
	checkpoint: OpaqueCheckpointEnvelope,
): Promise<void> {
	if (
		checkpoint.checkpointId.length === 0 ||
		checkpoint.selectorKey.length === 0 ||
		!Number.isSafeInteger(checkpoint.createdAt)
	) {
		throw new Error("Invalid opaque Hyperchart checkpoint coordinates");
	}
	await client.query(
		`INSERT INTO ${CHECKPOINT_TABLE}
		   (run_id, checkpoint_id, head_seq_id, selector_key, blob, created_at_ms)
		 VALUES ($1, $2, $3, $4, $5::jsonb, $6)
		 ON CONFLICT DO NOTHING`,
		[
			runId,
			checkpoint.checkpointId,
			checkpoint.headSeqId,
			checkpoint.selectorKey,
			JSON.stringify(checkpoint.blob),
			checkpoint.createdAt,
		],
	);
}
function decodeCheckpointRow(row: Record<string, unknown>): OpaqueCheckpointEnvelope {
	return {
		checkpointId: row.checkpoint_id as string,
		headSeqId: row.head_seq_id === null ? null : pgNumber(row.head_seq_id),
		selectorKey: row.selector_key as string,
		blob: row.blob,
		createdAt: pgNumber(row.created_at_ms),
	};
}
async function queryRows(
	client: PgClientLike,
	access: PostgresLogAccess,
	text: string,
	values: readonly unknown[],
): Promise<Record<string, unknown>[]> {
	try {
		return (await client.query(text, values)).rows;
	} catch (error) {
		if (access === "read" && isUndefinedTable(error)) {
			return [];
		}
		throw error;
	}
}
function decodeRecordRow(row: PostgresJournalRow): DurableLogRecord {
	return {
		...(row.payload as Record<string, unknown>),
		type: row.record_type!,
		seqId: journalNumber(row.seq),
		parentId: row.parent_id === null ? null : journalNumber(row.parent_id),
		branchId: row.branch_id,
	} as unknown as DurableLogRecord;
}
function decodeBranchRow(row: Record<string, unknown>): BranchHead {
	const metadata = row.metadata === null || row.metadata === undefined ? undefined : (row.metadata as BranchMetadata);
	return {
		branchId: row.branch_id as string,
		headSeqId: row.current_head_seq_id === null ? null : pgNumber(row.current_head_seq_id),
		createdAt: pgNumber(row.committed_at_ms),
		...(metadata === undefined ? {} : { metadata }),
	};
}
function requireBranch(branch: BranchHead | undefined, branchId: BranchId): BranchHead {
	if (branch === undefined) {
		throw new Error(`Unknown Hyperchart branch '${branchId}'`);
	}
	return branch;
}
async function readRunStatusDirect(
	client: PgClientLike,
	runId: string,
	options: { forUpdate?: boolean } = {},
): Promise<HyperchartRunStatus | undefined> {
	const result = await client.query(
		`SELECT chart_id, state, branch_ids, attempt_id, pid, started_at, updated_at, heartbeat_at, exit_code, error, replay_warnings
		 FROM ${RUN_STATUS_TABLE} WHERE run_id = $1${options.forUpdate === true ? " FOR UPDATE" : ""}`,
		[runId],
	);
	const row = result.rows[0];
	if (row === undefined) {
		return undefined;
	}
	const optionalNumber = (value: unknown) => (value === null || value === undefined ? undefined : pgNumber(value));
	const optionalString = (value: unknown) => (value === null || value === undefined ? undefined : (value as string));
	return normalizeRunStatus(
		{
			version: 2,
			runId,
			chartId: row.chart_id,
			state: row.state,
			branchIds: row.branch_ids,
			attemptId: optionalString(row.attempt_id),
			pid: optionalNumber(row.pid),
			startedAt: pgNumber(row.started_at),
			updatedAt: pgNumber(row.updated_at),
			heartbeatAt: optionalNumber(row.heartbeat_at),
			exitCode: optionalNumber(row.exit_code),
			error: optionalString(row.error),
			replayWarnings: row.replay_warnings ?? undefined,
		},
		runId,
	);
}

function decodeRunMeta(row: Record<string, unknown>): RunMeta {
	const exportName =
		row.export_name === null || row.export_name === undefined ? undefined : (row.export_name as string);
	const originSessionId =
		row.origin_session_id === null || row.origin_session_id === undefined
			? undefined
			: (row.origin_session_id as string);
	return {
		chartPath: row.chart_path as string,
		...(exportName === undefined ? {} : { exportName }),
		workDir: row.work_dir as string,
		chartId: row.chart_id as string,
		createdAt: row.created_at as string,
		...(originSessionId === undefined ? {} : { originSessionId }),
	};
}
function pgNumber(value: unknown): number {
	return typeof value === "number" ? value : Number(value);
}
function restrictTransaction(tx: PostgresRunTransaction): SqlCommitTransaction {
	return { query: (text, values) => tx.query(text, values) };
}
export function supportsSqlTransactions(store: RunLogStore): store is SqlTransactionalRunLogStore {
	return store instanceof PostgresLogStore;
}
function normalizeUnique(error: unknown, runId: string): unknown {
	return pgErrorCode(error) === "23505" && pgErrorConstraint(error) === "hyperchart_journal_pkey"
		? new Error(`Stale Hyperchart journal writer for run '${runId}'; retry the serialized transaction`)
		: error;
}
function pgErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}
function pgErrorConstraint(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "constraint" in error && typeof error.constraint === "string"
		? error.constraint
		: undefined;
}
function isUndefinedTable(error: unknown): boolean {
	return pgErrorCode(error) === "42P01";
}
