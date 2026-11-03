import {
	withRunStorage,
	resolveRunPaths,
	type RunStorage,
} from "../../packages/hyperchart/src/runtime/generic/run_paths.js";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	emitPendingClaudeNotifications,
	emitPendingClaudeTerminalNotifications,
	emitPendingClaudeUserInteraction,
	ownedClaudeUserInteractionSummary,
	pendingOwnedClaudeTerminalRequests,
} from "../../packages/claude-hyperchart/src/monitor.js";
import { watchRun } from "../../packages/claude-hyperchart/src/mcp/spawn_runner.js";
import { JsonlLogStore } from "../../packages/hyperchart/src/runtime/generic/log_store.js";
import { patchRunStatus, readRunStatus } from "../../packages/hyperchart/src/runtime/generic/run_status.js";
import {
	archiveTerminalNotificationGeneration,
	claimTerminalNotificationReceipt,
	hasTerminalNotificationReceipt,
	persistTerminalNotificationRequest,
	readTerminalNotificationRequest,
} from "../../packages/hyperchart/src/runtime/generic/terminal_notifications.js";
import {
	claimUserInteractionReceipt,
	hasUserInteractionReceipt,
} from "../../packages/hyperchart/src/runner/user_interactions.js";

const roots: string[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function world(layout: RunStorage["layout"] = "run-id") {
	const root = mkdtempSync(join(tmpdir(), "claude-monitor-"));
	roots.push(root);
	const runsRoot = join(root, "runs");
	const cwd = join(root, "project");
	mkdirSync(runsRoot, { recursive: true });
	mkdirSync(cwd);
	const storage: RunStorage = { kind: "jsonl", rootDir: runsRoot, layout };
	return { root, runsRoot, cwd, storage };
}

async function createRequest(
	storage: RunStorage,
	cwd: string,
	name: string,
	sessionId: string,
	status: "complete" | "failed" | "running" = "complete",
	prompt = "line one\nline two",
) {
	const runId = name;
	const runDir = resolveRunPaths(runId, storage).runDir;
	void new JsonlLogStore(join(runDir, "log.jsonl")).writeRunMeta({
		runId,
		chartPath: join(cwd, "chart.ts"),
		workDir: cwd,
		chartId: "chart",
		createdAt: new Date().toISOString(),
		originSessionId: sessionId,
	});
	await withRunStorage(storage, () =>
		patchRunStatus(runId, { branchIds: ["main"], chartId: "chart", state: "running", heartbeatAt: Date.now() }),
	);
	await withRunStorage(storage, () =>
		persistTerminalNotificationRequest(runId, {
			runId,
			branchId: "main",
			chartId: "chart",
			outcome: "complete",
			prompt,
			artifacts: [],
		}),
	);
	if (status !== "running") {
		await withRunStorage(storage, () => patchRunStatus(runId, { state: status, heartbeatAt: undefined }));
	}
	return runId;
}

describe("Claude terminal monitor", () => {
	it("routes by exact session and workDir, writes one physical line, and receipts once", async () => {
		const { storage, runsRoot, cwd, root } = world();
		const owned = await createRequest(
			storage,
			cwd,
			"owned",
			"session-a",
			"complete",
			`dangerous terminal payload ${"x".repeat(100_000)}`,
		);
		await createRequest(storage, cwd, "foreign-session", "session-b");
		await createRequest(storage, join(root, "other"), "foreign-workdir", "session-a");
		const lines: string[] = [];

		expect(
			await emitPendingClaudeTerminalNotifications({
				storage,
				runsRoot,
				cwd,
				sessionId: "session-a",
				writeLine: (line) => {
					lines.push(line);
				},
			}),
		).toBe(1);
		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toContain("\n");
		const emitted = JSON.parse(lines[0]!);
		expect(emitted).toMatchObject({
			customType: "hyperchart-terminal",
			requestId: emitted.details.requestId,
			content: expect.stringContaining("Open hyperchart_view"),
			details: { runId: "owned", outcome: "complete" },
		});
		expect(JSON.stringify(emitted)).not.toContain("dangerous terminal payload");
		expect(Buffer.byteLength(lines[0]!)).toBeLessThanOrEqual(64 * 1024);
		expect(withRunStorage(storage, () => hasTerminalNotificationReceipt(owned, "claude", "session-a"))).toBe(true);
		expect(
			await emitPendingClaudeTerminalNotifications({
				storage,
				runsRoot,
				cwd,
				sessionId: "session-a",
				writeLine: (line) => {
					lines.push(line);
				},
			}),
		).toBe(0);
	});

	it("bounds overflow through the actual Claude monitor serializer", async () => {
		const { storage, runsRoot, cwd } = world("sha256");
		await createRequest(storage, cwd, "x".repeat(100_000), "session-a", "complete", "prompt");
		const lines: string[] = [];
		expect(
			await emitPendingClaudeTerminalNotifications({
				storage,
				runsRoot,
				cwd,
				sessionId: "session-a",
				writeLine: (line) => {
					lines.push(line);
				},
			}),
		).toBe(1);
		expect(Buffer.byteLength(lines[0]!)).toBeLessThanOrEqual(64 * 1024);
		expect(JSON.parse(lines[0]!)).toMatchObject({
			customType: "hyperchart-boundary-error",
			details: { error: "model-envelope-too-large" },
		});
	});

	it("recovers a pre-delivery crash after the claim lease expires", async () => {
		const { storage, runsRoot, cwd } = world();
		const runId = await createRequest(storage, cwd, "crashed-before-write", "session-a");
		const request = withRunStorage(storage, () => readTerminalNotificationRequest(runId))!;
		expect(
			withRunStorage(storage, () =>
				claimTerminalNotificationReceipt(runId, request.requestId, "claude", "session-a", { now: 1, leaseMs: 1 }),
			),
		).toBe(true);
		expect(withRunStorage(storage, () => hasTerminalNotificationReceipt(runId, "claude", "session-a"))).toBe(false);
		const lines: string[] = [];

		expect(
			await emitPendingClaudeTerminalNotifications({
				storage,
				runsRoot,
				cwd,
				sessionId: "session-a",
				writeLine: (line) => {
					lines.push(line);
				},
			}),
		).toBe(1);
		expect(lines).toHaveLength(1);
		expect(withRunStorage(storage, () => hasTerminalNotificationReceipt(runId, "claude", "session-a"))).toBe(true);
	});

	it("does not confirm a replacement generation when delivery races with resume", async () => {
		const { storage, runsRoot, cwd } = world();
		const runId = await createRequest(storage, cwd, "delivery-race", "session-a");
		await expect(
			emitPendingClaudeTerminalNotifications({
				storage,
				runsRoot,
				cwd,
				sessionId: "session-a",
				writeLine: async () => {
					await withRunStorage(storage, () => patchRunStatus(runId, { state: "starting" }));
					withRunStorage(storage, () => archiveTerminalNotificationGeneration(runId));
					await withRunStorage(storage, () =>
						persistTerminalNotificationRequest(runId, {
							runId: "delivery-race",
							branchId: "main",
							chartId: "chart",
							outcome: "complete",
							prompt: "replacement",
							artifacts: [],
						}),
					);
					await withRunStorage(storage, () => patchRunStatus(runId, { state: "complete" }));
				},
			}),
		).rejects.toThrow(/no longer active/);
		expect(withRunStorage(storage, () => hasTerminalNotificationReceipt(runId, "claude", "session-a"))).toBe(false);

		const lines: string[] = [];
		expect(
			await emitPendingClaudeTerminalNotifications({
				storage,
				runsRoot,
				cwd,
				sessionId: "session-a",
				writeLine: (line) => {
					lines.push(line);
				},
			}),
		).toBe(1);
		expect(lines).toHaveLength(1);
		expect(withRunStorage(storage, () => hasTerminalNotificationReceipt(runId, "claude", "session-a"))).toBe(true);
	});

	it("leaves a failed stdout write recoverable instead of confirming it", async () => {
		const { storage, runsRoot, cwd } = world();
		const runId = await createRequest(storage, cwd, "write-failed", "session-a");
		await expect(
			emitPendingClaudeTerminalNotifications({
				storage,
				runsRoot,
				cwd,
				sessionId: "session-a",
				writeLine: () => {
					throw new Error("stdout closed");
				},
			}),
		).rejects.toThrow("stdout closed");
		expect(withRunStorage(storage, () => hasTerminalNotificationReceipt(runId, "claude", "session-a"))).toBe(false);
	});

	it("waits for status/outcome agreement", async () => {
		const { storage, runsRoot, cwd } = world();
		const runId = await createRequest(storage, cwd, "running", "session-a", "running");
		expect(await pendingOwnedClaudeTerminalRequests({ storage, runsRoot, cwd, sessionId: "session-a" })).toEqual([]);
		await withRunStorage(storage, () => patchRunStatus(runId, { state: "failed" }));
		expect(await pendingOwnedClaudeTerminalRequests({ storage, runsRoot, cwd, sessionId: "session-a" })).toEqual([]);
		await withRunStorage(storage, () => patchRunStatus(runId, { state: "complete" }));
		expect(await pendingOwnedClaudeTerminalRequests({ storage, runsRoot, cwd, sessionId: "session-a" })).toHaveLength(
			1,
		);
	});

	it("the dead-run watcher preserves a request written before the status crash", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(100_000);
		const { storage, runsRoot, cwd } = world();
		const runId = await createRequest(storage, cwd, "request-before-status", "session-a", "running");
		await withRunStorage(storage, () => patchRunStatus(runId, { pid: 999_999_999, heartbeatAt: 1 }));
		const done = withRunStorage(storage, () => watchRun(runId));

		await withRunStorage(storage, () => vi.advanceTimersByTimeAsync(21_000));
		await expect(done).resolves.toMatchObject({ state: "complete", exitCode: 0 });
		expect(await withRunStorage(storage, () => readRunStatus(runId))).toMatchObject({ state: "complete", exitCode: 0 });
	});

	it("keeps scanning for requests created after monitor startup", async () => {
		const { storage, runsRoot, cwd } = world();
		const child = spawn(process.execPath, ["packages/claude-hyperchart/bin/hyperchart-monitor.mjs"], {
			cwd: process.cwd(),
			env: {
				...process.env,
				HYPERCHART_RUNS_ROOT: runsRoot,
				HYPERCHART_MONITOR_INTERVAL_MS: "20",
				CLAUDE_PROJECT_DIR: cwd,
				CLAUDE_CODE_SESSION_ID: "session-a",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		try {
			await new Promise((resolve) => setTimeout(resolve, 60));
			const runId = await createRequest(storage, cwd, "late", "session-a");
			const line = await new Promise<string>((resolve, reject) => {
				let buffer = "";
				const timeout = setTimeout(() => reject(new Error("monitor did not emit a notification")), 3_000);
				child.stdout.setEncoding("utf8");
				child.stdout.on("data", (chunk: string) => {
					buffer += chunk;
					const newline = buffer.indexOf("\n");
					if (newline === -1) {
						return;
					}
					clearTimeout(timeout);
					resolve(buffer.slice(0, newline));
				});
				child.once("exit", (code) => {
					clearTimeout(timeout);
					reject(new Error(`monitor exited early (${code})`));
				});
			});
			expect(JSON.parse(line)).toMatchObject({ details: { runId: "late", outcome: "complete" } });
			await vi.waitFor(() =>
				expect(withRunStorage(storage, () => hasTerminalNotificationReceipt(runId, "claude", "session-a"))).toBe(true),
			);
		} finally {
			child.kill("SIGTERM");
		}
	});

	it("registers an always-on persistent plugin monitor", () => {
		const plugin = JSON.parse(readFileSync("packages/claude-hyperchart/.claude-plugin/plugin.json", "utf8"));
		expect(plugin.experimental.monitors).toEqual([
			expect.objectContaining({ name: "hyperchart-notifications", when: "always" }),
		]);
		const executable = readFileSync("packages/claude-hyperchart/bin/hyperchart-monitor.mjs", "utf8");
		expect(executable).toContain("emitPendingClaudeNotifications(options)");
		expect(executable).toContain("scan();");
		expect(executable).toContain("setInterval(() => void scan(), intervalMs)");
	});
});
