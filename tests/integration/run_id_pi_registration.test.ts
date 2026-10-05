import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { register } from "../../packages/pi-hyperchart/extensions/hyperchart.js";
import { initializeRun, saveRunMeta } from "../../packages/hyperchart/src/runtime/generic/run_dir.js";
import { withRunStorage, type RunStorage } from "../../packages/hyperchart/src/runtime/generic/run_paths.js";
import { patchRunStatus, readRunStatus } from "../../packages/hyperchart/src/runtime/generic/run_status.js";

const inspected = vi.hoisted(() => [] as string[]);
vi.mock("../../packages/hyperchart/src/inspect/inspector_server.js", async (original) => ({
	...(await original<typeof import("../../packages/hyperchart/src/inspect/inspector_server.js")>()),
	openRunInspector: vi.fn(async (options) => {
		// Exercise the real production projection with the command's selected AST;
		// replace only browser/server transport, never manufacture a semantic model.
		inspected.push((await options.loadRun("main")).chartName);
		return { url: "http://fixture.invalid" };
	}),
}));

type Tool = {
	parameters: { properties: Record<string, { description?: string }> };
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		update: () => void,
		ctx: ExtensionCommandContext,
	) => Promise<unknown>;
};
type Command = {
	handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
	getArgumentCompletions(prefix: string): Array<{ value: string }> | null;
};
const roots: string[] = [];
const fixtures: Array<{ storage: RunStorage; runId: string }> = [];
afterEach(async () => {
	for (const f of fixtures.splice(0)) {
		withRunStorage(f.storage, () => patchRunStatus(f.runId, { state: "stopped" }));
	}
	if (vi.isFakeTimers()) {
		await vi.advanceTimersByTimeAsync(2000);
	}
	vi.useRealTimers();
	vi.restoreAllMocks();
	inspected.length = 0;
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function host(storage: RunStorage, cwd: string) {
	let tool!: Tool;
	let command!: Command;
	const hooks = new Map<string, (event: unknown, ctx: ExtensionCommandContext) => Promise<void>>();
	const ctx = {
		cwd,
		mode: "tui",
		sessionManager: { getSessionId: () => "session" },
		ui: { notify: vi.fn(), setWidget: vi.fn(), setStatus: vi.fn(), confirm: async () => true },
	} as unknown as ExtensionCommandContext;
	register(
		{
			registerCommand(_name: string, value: Command) {
				command = value;
			},
			registerTool(value: Tool & { name: string }) {
				if (value.name === "hyperchart") {
					tool = value;
				}
			},
			on(name: string, handler: (event: unknown, ctx: ExtensionCommandContext) => Promise<void>) {
				hooks.set(name, handler);
			},
			events: { on() {}, emit() {} },
		} as unknown as ExtensionAPI,
		{ storage, transcriptReaderForRun: () => async () => [] },
	);
	return {
		command,
		tool,
		ctx,
		hooks,
		execute: (params: Record<string, unknown>) =>
			tool.execute("test", params, new AbortController().signal, () => {}, ctx),
	};
}
async function fixture(label: string, layout: RunStorage["layout"] = "run-id") {
	const root = mkdtempSync(join(tmpdir(), "run-id-registration-"));
	roots.push(root);
	const storage: RunStorage = { kind: "jsonl", rootDir: join(root, "runs"), layout };
	const runId = "same-id";
	const chartPath = join(root, "chart.mjs");
	writeFileSync(
		chartPath,
		`export default {kind:"chart",id:${JSON.stringify(label)},initial:"done",states:{done:{kind:"final"}}};`,
	);
	await withRunStorage(storage, async () => {
		await initializeRun(runId);
		await saveRunMeta(runId, {
			chartPath,
			chartId: label,
			workDir: root,
			originSessionId: "session",
			createdAt: new Date().toISOString(),
		});
	});
	const result = { root, storage, runId, chartPath };
	fixtures.push(result);
	return result;
}
function live(f: Awaited<ReturnType<typeof fixture>>, pid: number) {
	withRunStorage(f.storage, () =>
		patchRunStatus(f.runId, { chartId: "test", branchIds: ["main"], state: "running", pid, heartbeatAt: Date.now() }),
	);
}
function signals(entries: Array<{ fixture: Awaited<ReturnType<typeof fixture>>; pid: number }>) {
	const alive = new Set(entries.map(({ pid }) => pid));
	return vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
		if (signal === 0 && alive.has(pid)) {
			return true;
		}
		const target = entries.find((entry) => entry.pid === pid);
		if (signal === "SIGTERM" && target !== undefined) {
			alive.delete(pid);
			withRunStorage(target.fixture.storage, () => patchRunStatus(target.fixture.runId, { state: "stopped" }));
			return true;
		}
		throw Object.assign(new Error("fixture process absent"), { code: "ESRCH" });
	});
}
const flush = async () => {
	for (let i = 0; i < 30; i++) {
		await Promise.resolve();
	}
};

it("same-ID Pi registrations isolate view AST, stop wait and completion cleanup", async () => {
	const a = await fixture("scope-a");
	const b = await fixture("scope-b", "sha256");
	vi.useFakeTimers();
	const kill = signals([
		{ fixture: a, pid: 800001 },
		{ fixture: b, pid: 800002 },
	]);
	live(a, 800001);
	live(b, 800002);
	const ah = host(a.storage, a.root);
	const bh = host(b.storage, b.root);
	await ah.execute({ action: "run", runId: a.runId, branchId: "main", wait: false });
	await bh.execute({ action: "run", runId: b.runId, branchId: "main", wait: false });
	await ah.command.handler(`view ${a.runId}`, ah.ctx);
	await bh.command.handler(`view ${b.runId}`, bh.ctx);
	expect(inspected).toEqual(["scope-a", "scope-b"]);
	let aStopped = false;
	const stopA = ah.execute({ action: "stop", runId: a.runId }).then(() => {
		aStopped = true;
	});
	await flush();
	await vi.advanceTimersByTimeAsync(1000);
	expect(aStopped).toBe(true);
	await stopA;
	expect(kill).not.toHaveBeenCalledWith(800002, "SIGTERM");
	expect(withRunStorage(b.storage, () => readRunStatus(b.runId)?.state)).toBe("running");
	// A's completion must not erase B's active entry: B still waits for its own
	// watch boundary instead of returning immediately after the signal.
	let bStopped = false;
	const stopB = bh.execute({ action: "stop", runId: b.runId }).then(() => {
		bStopped = true;
	});
	await flush();
	expect(bStopped).toBe(false);
	await vi.advanceTimersByTimeAsync(1000);
	expect(bStopped).toBe(true);
	await stopB;
});

it("a stale Pi completion cannot remove a newer same-registration generation or its widget", async () => {
	const f = await fixture("generation");
	vi.useFakeTimers();
	signals([{ fixture: f, pid: 800003 }]);
	live(f, 800003);
	const h = host(f.storage, f.root);
	await h.execute({ action: "run", runId: f.runId, branchId: "main", wait: false });
	await vi.advanceTimersByTimeAsync(500);
	await h.execute({ action: "run", runId: f.runId, branchId: "main", wait: false });
	vi.mocked(h.ctx.ui.setWidget).mockClear();
	withRunStorage(f.storage, () => patchRunStatus(f.runId, { state: "stopped" }));
	await vi.advanceTimersByTimeAsync(500); // only the older watcher finishes
	live(f, 800003);
	expect(h.ctx.ui.setWidget).not.toHaveBeenCalledWith(`hyperchart:${f.runId}`, undefined);
	let stopped = false;
	const stopping = h.execute({ action: "stop", runId: f.runId }).then(() => {
		stopped = true;
	});
	await flush();
	expect(stopped).toBe(false);
	await vi.advanceTimersByTimeAsync(500);
	expect(stopped).toBe(true);
	await stopping;
});

it("stopped-owned IDs autocomplete from authoritative metadata, excluding foreign workdirs and storage", async () => {
	const a = await fixture("completion-a", "sha256");
	const b = await fixture("completion-b");
	await withRunStorage(a.storage, async () => {
		for (const [runId, workDir] of [
			["owned-stopped", a.root],
			["foreign-workdir", b.root],
		]) {
			await initializeRun(runId!);
			await saveRunMeta(runId!, {
				chartPath: a.chartPath,
				chartId: "completion",
				workDir: workDir!,
				createdAt: new Date().toISOString(),
			});
			patchRunStatus(runId!, { state: "stopped" });
		}
	});
	await withRunStorage(b.storage, async () => {
		await initializeRun("foreign-storage");
		await saveRunMeta("foreign-storage", {
			chartPath: b.chartPath,
			chartId: "foreign",
			workDir: a.root,
			createdAt: new Date().toISOString(),
		});
	});
	const h = host(a.storage, a.root);
	await h.hooks.get("session_start")!({ reason: "startup" }, h.ctx);
	for (const prefix of ["resume ", "restart ", "delete ", "view "]) {
		const values = h.command.getArgumentCompletions(prefix)?.map(({ value }) => value) ?? [];
		expect(values).toContain(`${prefix}owned-stopped`);
		expect(values.some((value) => value.includes("foreign"))).toBe(false);
	}
	await h.command.handler("delete owned-stopped", h.ctx);
	expect(
		h.command.getArgumentCompletions("resume ")?.some(({ value }) => value.includes("owned-stopped")) ?? false,
	).toBe(false);
	expect(h.tool.parameters.properties.runId?.description).toContain("respond requires");
	expect(h.tool.parameters.properties.runId?.description).not.toContain("not accepted");
	await expect(h.execute({ action: "respond", branchId: "main", seqId: 9, event: "SELECTED" })).rejects.toThrow(
		"respond requires runId",
	);
	await expect(h.execute({ action: "respond", runId: a.runId, seqId: 9, event: "SELECTED" })).rejects.toThrow(
		"respond requires branchId",
	);
	await h.hooks.get("session_shutdown")!({}, h.ctx);
});

for (const attached of [true, false]) {
	it(`stop settles after runner death without a final status write (attached=${attached})`, async () => {
		const f = await fixture("interrupted-stop");
		vi.useFakeTimers();
		let alive = true;
		vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
			if (signal === "SIGTERM") {
				alive = false; // No final status write: interrupted runner cleanup.
				return true;
			}
			if (alive) {
				return true;
			}
			throw Object.assign(new Error("runner absent"), { code: "ESRCH" });
		});
		live(f, 800099);
		const h = host(f.storage, f.root);
		if (attached) {
			await h.execute({ action: "run", runId: f.runId, branchId: "main" });
		}
		let settled = false;
		const stopped = h.execute({ action: "stop", runId: f.runId }).then(() => {
			settled = true;
		});
		await flush();
		await vi.advanceTimersByTimeAsync(1000);
		expect(settled).toBe(true);
		await stopped;
		expect(withRunStorage(f.storage, () => readRunStatus(f.runId))).toMatchObject({
			state: "stopped",
			branchIds: [],
			error: expect.stringContaining("cleanup could not be confirmed"),
		});
		expect(withRunStorage(f.storage, () => readRunStatus(f.runId)?.exitCode)).toBeUndefined();
	});
}

it("stop keeps waiting while a stopping runner is still alive", async () => {
	const f = await fixture("slow-stop");
	vi.useFakeTimers();
	let alive = true;
	vi.spyOn(process, "kill").mockImplementation(() => {
		if (alive) {
			return true;
		}
		throw Object.assign(new Error("runner absent"), { code: "ESRCH" });
	});
	live(f, 800098);
	const h = host(f.storage, f.root);
	await h.execute({ action: "run", runId: f.runId, branchId: "main" });
	let settled = false;
	const stopped = h.execute({ action: "stop", runId: f.runId }).then(() => {
		settled = true;
	});
	await flush();
	await vi.advanceTimersByTimeAsync(25000);
	expect(settled).toBe(false);
	expect(withRunStorage(f.storage, () => readRunStatus(f.runId)?.state)).toBe("stopping");
	alive = false;
	await vi.advanceTimersByTimeAsync(1000);
	expect(settled).toBe(true);
	await stopped;
});
