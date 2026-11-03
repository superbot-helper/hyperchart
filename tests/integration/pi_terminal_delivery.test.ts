import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { register } from "../../packages/pi-hyperchart/extensions/hyperchart.js";
import { deleteRunStorage, type RunMeta } from "../../packages/hyperchart/src/runtime/generic/run_dir.js";
import {
	resolveRunPaths,
	withRunStorage,
	type RunStorage,
} from "../../packages/hyperchart/src/runtime/generic/run_paths.js";
import { patchRunStatus } from "../../packages/hyperchart/src/runtime/generic/run_status.js";
import {
	hasTerminalNotificationReceipt,
	persistTerminalNotificationRequest,
} from "../../packages/hyperchart/src/runtime/generic/terminal_notifications.js";

// Replace only metadata transport and process spawning. Exercise the real Pi
// registration, storage scope, watcher, notification outbox and receipt protocol.
const metadata = vi.hoisted(() => new Map<string, RunMeta>());
vi.mock("../../packages/hyperchart/src/runtime/generic/run_dir.js", async (original) => ({
	...(await original<typeof import("../../packages/hyperchart/src/runtime/generic/run_dir.js")>()),
	createRun: async () => "terminal-test",
	loadRunMeta: async (id: string) => {
		const meta = metadata.get(id);
		if (meta === undefined) {
			throw new Error(`Missing metadata: ${id}`);
		}
		return meta;
	},
	loadRunMetaIfPresent: async (id: string) => metadata.get(id),
	saveRunMeta: async (id: string, meta: RunMeta) => {
		metadata.set(id, meta);
	},
	listRunIds: async () => [...metadata.keys()],
}));
vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	spawn: vi.fn(() => ({ pid: 800091, unref() {} })),
}));

type Tool = {
	execute(
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		update: () => void,
		ctx: ExtensionCommandContext,
	): Promise<unknown>;
};
type Hook = (event: { reason?: string }, ctx: ExtensionCommandContext) => Promise<void>;
// PostgreSQL-backed runs keep operational status in hyperchart_run_status, so those
// cases need a real database; they are reported as skipped without HYPERCHART_PG_DSN.
const dsn = process.env.HYPERCHART_PG_DSN;
const itPg = dsn === undefined ? it.skip : it;
const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	metadata.clear();
	for (const cleanup of cleanups.splice(0)) {
		await cleanup().catch(() => {});
	}
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function fixture(kind: RunStorage["kind"]) {
	const root = mkdtempSync(join(tmpdir(), "pi-terminal-delivery-"));
	roots.push(root);
	const storage: RunStorage =
		kind === "jsonl"
			? { kind, rootDir: join(root, "runs"), layout: "sha256" }
			: { kind, rootDir: join(root, "runs"), layout: "sha256", dsn: dsn as string };
	const chartPath = join(root, "chart.mjs");
	writeFileSync(
		chartPath,
		'export default {kind:"chart",id:"terminal-test",initial:"done",states:{done:{kind:"final"}}};',
	);
	const runId = "terminal-test";
	if (kind === "postgres") {
		cleanups.push(() => withRunStorage(storage, () => deleteRunStorage(runId)));
	}
	metadata.set(runId, {
		chartPath,
		chartId: "terminal-test",
		workDir: root,
		originSessionId: "owner",
		createdAt: new Date().toISOString(),
	});
	withRunStorage(storage, () => mkdirSync(resolveRunPaths(runId).runDir, { recursive: true }));
	let tool!: Tool;
	const hooks = new Map<string, Hook>();
	const sendMessage = vi.fn();
	const ctx = {
		cwd: root,
		mode: "rpc",
		sessionManager: { getSessionId: () => "owner", getEntries: () => [] },
		ui: { notify: vi.fn(), setWidget: vi.fn(), setStatus: vi.fn() },
	} as unknown as ExtensionCommandContext;
	register(
		{
			registerCommand() {},
			registerTool(value: Tool) {
				tool = value;
			},
			on(name: string, hook: Hook) {
				hooks.set(name, hook);
			},
			events: { on() {}, emit() {} },
			sendMessage,
		} as unknown as ExtensionAPI,
		{ storage, transcriptReaderForRun: () => async () => [] },
	);
	const scoped = <T>(fn: () => T) => withRunStorage(storage, fn);
	return {
		runId,
		chartPath,
		ctx,
		sendMessage,
		scoped,
		hook: (name: string) => {
			const hook = hooks.get(name);
			if (hook === undefined) {
				throw new Error(`Missing hook: ${name}`);
			}
			return hook({}, ctx);
		},
		execute: (params: Record<string, unknown>) =>
			tool.execute("test", params, new AbortController().signal, () => {}, ctx),
		finish: () =>
			scoped(async () => {
				await persistTerminalNotificationRequest(runId, {
					runId,
					branchId: "main",
					chartId: "terminal-test",
					outcome: "failed",
					prompt: "launch failed",
					artifacts: [],
					error: "launch failed",
				});
				await patchRunStatus(runId, {
					chartId: "terminal-test",
					state: "failed",
					branchIds: [],
					error: "launch failed",
				});
			}),
		receipted: () => scoped(() => hasTerminalNotificationReceipt(runId, "pi", "owner")),
	};
}

for (const kind of ["jsonl", "postgres"] as const) {
	for (const mode of ["fresh", "attach"] as const) {
		for (const sendFails of [false, true]) {
			(kind === "postgres" ? itPg : it)(
				`${kind} ${mode}: completion ${sendFails ? "contains delivery failure and retries" : "delivers and cleans up"}`,
				async () => {
					const f = fixture(kind);
					await f.hook("session_start");
					vi.useFakeTimers();
					vi.spyOn(process, "kill").mockReturnValue(true);
					const errors = vi.spyOn(console, "error").mockImplementation(() => {});
					if (mode === "attach") {
						await f.scoped(() =>
							patchRunStatus(f.runId, {
								chartId: "terminal-test",
								state: "running",
								branchIds: ["main"],
								pid: 800091,
								heartbeatAt: Date.now(),
							}),
						);
					}
					await f.execute({
						action: "run",
						...(mode === "attach" ? { runId: f.runId, branchId: "main" } : { chartPath: f.chartPath }),
					});
					if (sendFails) {
						f.sendMessage.mockImplementationOnce(() => {
							throw new Error("send failed");
						});
					}
					await f.finish();
					await vi.advanceTimersByTimeAsync(1000);
					// PostgreSQL status reads are real I/O behind the faked watcher tick.
					await vi.waitFor(() => expect(f.sendMessage).toHaveBeenCalledTimes(1));
					expect(f.ctx.ui.setWidget).toHaveBeenCalledWith(`hyperchart:${f.runId}`, undefined);
					expect(f.receipted()).toBe(!sendFails);
					if (sendFails) {
						expect(errors).toHaveBeenCalledWith(
							expect.stringContaining("background completion failed"),
							expect.objectContaining({ message: "send failed" }),
						);
						await f.hook("agent_settled");
						expect(f.sendMessage).toHaveBeenCalledTimes(2);
						expect(f.receipted()).toBe(true);
					} else {
						expect(errors).not.toHaveBeenCalled();
					}
					await f.hook("agent_settled");
					expect(f.sendMessage).toHaveBeenCalledTimes(sendFails ? 2 : 1);
					await f.hook("session_shutdown");
				},
			);
		}
	}
}

itPg("PostgreSQL wait returns terminal status without invoking JSONL gate ownership", async () => {
	const f = fixture("postgres");
	await f.hook("session_start");
	vi.useFakeTimers();
	const pending = f.execute({ action: "run", chartPath: f.chartPath, wait: true });
	// The asynchronous preflight must finish before the watcher can be ticked.
	await vi.waitFor(() =>
		expect(f.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Started hyperchart run"), "info"),
	);
	await f.finish();
	await vi.advanceTimersByTimeAsync(1000);
	await expect(pending).resolves.toMatchObject({ details: { boundary: "terminal", status: { state: "failed" } } });
	expect(f.sendMessage).not.toHaveBeenCalled();
	await f.hook("session_shutdown");
});
