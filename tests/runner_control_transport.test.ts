import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JSONL_CHANGE_FALLBACK_MS, JsonlLogStore } from "../packages/hyperchart/src/runtime/generic/log_store.js";
import {
	CONTROL_VERSION,
	type RunnerControlRequest,
} from "../packages/hyperchart/src/runtime/generic/runner_control_model.js";

const tempDirs: string[] = [];
afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function store(): Promise<JsonlLogStore> {
	const dir = await mkdtemp(join(tmpdir(), "hyperchart-control-"));
	tempDirs.push(dir);
	return new JsonlLogStore(join(dir, "run", "log.jsonl"), "main", "run");
}

function request(id: string, attemptId = "attempt-a", createdAt = 1): RunnerControlRequest {
	return {
		version: CONTROL_VERSION,
		kind: "move_branch",
		id,
		attemptId,
		branchId: "main",
		targetHeadSeqId: null,
		createdAt,
	};
}

describe("JSONL runner control transport", () => {
	it("publishes requests once, lists them in order, and never replaces a result", async () => {
		const s = await store();
		await s.publishControlRequest(request("b", "attempt-a", 2));
		await s.publishControlRequest(request("a", "attempt-a", 1));
		await expect(s.publishControlRequest(request("a"))).rejects.toMatchObject({ code: "EEXIST" });
		expect((await s.listControlRequests()).map((entry) => entry.id)).toEqual(["a", "b"]);

		const result = {
			version: CONTROL_VERSION,
			kind: "move_branch",
			requestId: "a",
			attemptId: "attempt-a",
			ok: true,
			moveSeqId: 3,
			previousHeadSeqId: 2,
			preservedRecords: 1,
			completedAt: 5,
		} as const;
		expect(await s.publishControlResult(result)).toBe(true);
		expect(await s.publishControlResult({ ...result, moveSeqId: 9 })).toBe(false);
		expect(await s.readControlResult("a")).toMatchObject({ ok: true, moveSeqId: 3 });

		await s.discardControlRequest("a");
		await s.discardControlResult("a");
		expect((await s.listControlRequests()).map((entry) => entry.id)).toEqual(["b"]);
		expect(await s.readControlResult("a")).toBeUndefined();

		await s.deleteRunData();
		expect(await s.listControlRequests()).toEqual([]);
	});

	it("re-checks on a short local interval regardless of the caller's fallback, and honours cancel", async () => {
		const s = await store();
		const started = Date.now();
		await s.watchRunChange(["control", "status"], { timeoutMs: 60_000 }).changed;
		const elapsed = Date.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(JSONL_CHANGE_FALLBACK_MS - 10);
		expect(elapsed).toBeLessThan(JSONL_CHANGE_FALLBACK_MS * 10);

		const wait = s.watchRunChange(["status"], { timeoutMs: 60_000 });
		wait.cancel();
		await expect(timed(wait.changed, 1_000)).resolves.toBe("woken");
	});

	it("caps the interval by a shorter caller timeout and rejects on abort", async () => {
		const s = await store();
		const started = Date.now();
		await s.watchRunChange(["control"], { timeoutMs: 20 }).changed;
		expect(Date.now() - started).toBeLessThan(JSONL_CHANGE_FALLBACK_MS);

		const controller = new AbortController();
		const waiting = s.watchRunChange(["status"], { timeoutMs: 10_000, signal: controller.signal }).changed;
		controller.abort(new Error("stop"));
		await expect(waiting).rejects.toThrow("stop");
	});
});

function timed(promise: Promise<void>, ms: number): Promise<"woken" | "fallback"> {
	return Promise.race([
		promise.then(() => "woken" as const),
		new Promise<"fallback">((resolve) => setTimeout(() => resolve("fallback"), ms)),
	]);
}
