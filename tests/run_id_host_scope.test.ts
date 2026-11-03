import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initializeRun, saveRunMeta } from "../packages/hyperchart/src/runtime/generic/run_dir.js";
import { withRunStorage, type RunStorage } from "../packages/hyperchart/src/runtime/generic/run_paths.js";
import {
	claimUserInteractionReceipt,
	markUserInteractionReceipt,
	readUserInteractionReceipt,
	releaseActiveUserInteraction,
} from "../packages/hyperchart/src/runner/user_interactions.js";
import { patchRunStatus } from "../packages/hyperchart/src/runtime/generic/run_status.js";
import {
	persistTerminalNotificationRequest,
	hasTerminalNotificationReceipt,
} from "../packages/hyperchart/src/runtime/generic/terminal_notifications.js";
import * as monitor from "../packages/claude-hyperchart/src/monitor.js";
import { createHyperchartMcpTools } from "../packages/claude-hyperchart/src/mcp/tools.js";

const roots: string[] = [];
function root() {
	const root = mkdtempSync(join(tmpdir(), "run-id-host-scope-"));
	roots.push(root);
	return root;
}
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

it.each([
	"run-id",
	"sha256",
] as const)("releaseActiveUserInteraction removes the unchanged ID's claim and confirmation in %s scope only", (layout) => {
	const home = root();
	const storage: RunStorage = { kind: "jsonl", rootDir: join(home, "owner"), layout };
	const foreign: RunStorage = { ...storage, rootDir: join(home, "foreign") };
	const runId = layout === "sha256" ? "autodiscovery:release/opaque" : "release:opaque";
	const owner = { runsRoot: storage.rootDir, host: "pi", sessionId: "session", workDir: home };
	const coordinate = { runId, branchId: "main", seqId: 9 };
	const read = () => readUserInteractionReceipt(runId, "main", 9, "pi", "session");
	for (const scope of [storage, foreign]) {
		withRunStorage(scope, () => {
			expect(claimUserInteractionReceipt(runId, "main", 9, "pi", "session")).toBe(true);
			markUserInteractionReceipt(runId, "main", 9, "pi", "session");
			expect(read()?.state).toBe("confirmed");
		});
	}
	withRunStorage(foreign, () =>
		expect(() => releaseActiveUserInteraction(owner, coordinate)).toThrow("outside the configured runs root"),
	);
	withRunStorage(storage, () => {
		releaseActiveUserInteraction(owner, coordinate);
		expect(read()).toBeUndefined();
	});
	expect(withRunStorage(foreign, read)?.state).toBe("confirmed");
});

it("Claude monitor uses explicit runsRoot under conflicting ambient storage and receipts only that root", async () => {
	const home = root();
	const a: RunStorage = { kind: "jsonl", rootDir: join(home, "a"), layout: "run-id" };
	const b: RunStorage = { kind: "jsonl", rootDir: join(home, "b"), layout: "sha256" };
	const runId = "same-id";
	for (const storage of [a, b]) {
		await withRunStorage(storage, async () => {
			await initializeRun(runId);
			await saveRunMeta(runId, {
				chartPath: join(home, "chart.ts"),
				chartId: "chart",
				workDir: home,
				originSessionId: "session",
				createdAt: new Date().toISOString(),
			});
			await patchRunStatus(runId, { chartId: "chart", branchIds: ["main"], state: "running" });
			await persistTerminalNotificationRequest(runId, {
				runId,
				branchId: "main",
				chartId: "chart",
				outcome: "complete",
				prompt: storage.rootDir,
				artifacts: [],
			});
			await patchRunStatus(runId, { state: "complete" });
		});
	}
	const lines: string[] = [];
	const options = {
		runsRoot: a.rootDir,
		cwd: home,
		sessionId: "session",
		writeLine: (line: string) => {
			lines.push(line);
		},
	};
	const aRequest = (await monitor.pendingOwnedClaudeTerminalRequests(options))[0]!;
	await withRunStorage(b, async () => {
		expect(await monitor.pendingOwnedClaudeTerminalRequests(options)).toEqual([aRequest]);
		expect(await monitor.emitPendingClaudeTerminalNotifications(options)).toBe(1);
	});
	expect(lines).toHaveLength(1);
	expect(withRunStorage(a, () => hasTerminalNotificationReceipt(runId, "claude", "session"))).toBe(true);
	expect(withRunStorage(b, () => hasTerminalNotificationReceipt(runId, "claude", "session"))).toBe(false);
});

it("Claude MCP intentionally supplies its hashed storage to monitor scans", async () => {
	const home = root();
	const storage: RunStorage = { kind: "jsonl", rootDir: join(home, "runs"), layout: "sha256" };
	const runId = "autodiscovery:mcp/scope";
	const chartPath = join(home, "chart.mjs");
	writeFileSync(chartPath, 'export default {kind:"chart",id:"scope",initial:"done",states:{done:{kind:"final"}}};');
	await withRunStorage(storage, async () => {
		await initializeRun(runId);
		await saveRunMeta(runId, {
			chartPath,
			chartId: "scope",
			workDir: home,
			originSessionId: "session",
			createdAt: new Date().toISOString(),
		});
	});
	const scan = vi.spyOn(monitor, "ownedClaudeUserInteractionSummary");
	const tools = createHyperchartMcpTools({ cwd: home, storage, sessionId: "session" });
	const inspect = tools.find((tool) => tool.name === "hyperchart_run_inspect")!;
	const result = await inspect.handler({ runId, branchId: "main" });
	expect(result).not.toHaveProperty("isError", true);
	expect(scan).toHaveBeenCalledWith(expect.objectContaining({ storage, runsRoot: storage.rootDir }));
});
