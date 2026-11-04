import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentEffect, AgentOutcome } from "../../packages/hyperchart/src/core/machine.js";
import type { JsonSchema } from "../../packages/hyperchart/src/core/types.js";
import { z } from "../../packages/hyperchart/src/index.js";
import { PiAgentExecutor } from "../../packages/pi-hyperchart/src/runtime/pi/pi_agent_executor.js";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const Reply = z.object({ title: z.string().max(5) });

// One streamed Chat Completions turn whose only tool call is `finish` with these arguments.
function finishCallStream(args: unknown): Response {
	const chunks = [
		{
			choices: [
				{
					index: 0,
					delta: {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: "call-1",
								type: "function",
								function: { name: "finish", arguments: JSON.stringify(args) },
							},
						],
					},
				},
			],
		},
		{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
	];
	const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
	return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

// Runs one invocation whose model keeps answering with the same `finish` call.
async function rejectedFinish(args: unknown, strictFinish: boolean) {
	const root = await mkdtemp(join(tmpdir(), "hyperchart-finish-rejection-"));
	roots.push(root);
	await mkdir(join(root, "sessions"));
	await writeFile(join(root, "worker.md"), "---\ndescription: finish rejection fixture\n---\nCall finish.\n");
	await writeFile(
		join(root, "models.json"),
		JSON.stringify({
			providers: {
				fixture: {
					api: "openai-completions",
					baseUrl: "https://fixture.invalid/v1",
					apiKey: "fixture-key",
					models: [{ id: "model", name: "Model", contextWindow: 32000, maxTokens: 1000 }],
				},
			},
		}),
	);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(root, "auth.json"),
		modelsPath: join(root, "models.json"),
		modelsStorePath: join(root, "models-store.json"),
		allowModelNetwork: false,
	});
	const requests: ReturnType<typeof vi.spyOn> = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
		// Bounded so a turn that does not stop fails the test instead of looping.
		requests.mock.calls.length > 5 ? new Response("{}", { status: 400 }) : finishCallStream(args),
	);
	const executor = new PiAgentExecutor({
		workDir: root,
		agentDir: root,
		definitionDirs: [root],
		sessionsDir: join(root, "sessions"),
		branchId: "main",
		modelRuntime,
		extensionPolicy: "isolated",
		resolveSessionOverrides: async () => ({ strictFinish }),
	});
	const actionUid = { chart: "rejection", state: "work", action: "worker" };
	const effect: AgentEffect = {
		kind: "agent",
		id: "rejection:work:worker:1:1",
		actionUid,
		action: {
			kind: "agent",
			uid: actionUid,
			name: "worker",
			model: "fixture/model",
			tools: ["finish"],
			onFail: { nudge: 2, restart: 1 },
		},
		events: ["DONE", "FAILED"],
		sessionId: "rejection-session",
		reply: { kind: "jsonSchema", schema: z.toJSONSchema(Reply) as JsonSchema },
	};
	try {
		const outcome = await new Promise<AgentOutcome>((resolve) => executor.start(effect, resolve));
		return { outcome, modelCalls: requests.mock.calls.length };
	} finally {
		await executor.dispose();
	}
}

it("ends the turn on a finish rejected by Pi's argument check", async () => {
	const { outcome, modelCalls } = await rejectedFinish({ event: "NOT_AN_EVENT", output: { title: "ok" } }, false);
	expect(modelCalls).toBe(1);
	expect(outcome).toMatchObject({
		kind: "failed",
		failure: { kind: "validation", retryable: true, message: expect.stringContaining("finish was rejected") },
	});
});

it("ends the turn on a finish rejected by the reply schema after strict decoding", async () => {
	// The strict schema drops maxLength, so only validateFinishParams rejects this title.
	const { outcome, modelCalls } = await rejectedFinish({ event: "DONE", output: { title: "far too long" } }, true);
	expect(modelCalls).toBe(1);
	expect(outcome).toMatchObject({
		kind: "failed",
		failure: { kind: "validation", retryable: true, message: expect.stringContaining("title") },
	});
});

it("still completes on an accepted finish", async () => {
	const { outcome, modelCalls } = await rejectedFinish({ event: "DONE", output: { title: "ok" } }, true);
	expect(modelCalls).toBe(1);
	expect(outcome).toMatchObject({ kind: "completed", event: { type: "DONE", output: { title: "ok" } } });
});
