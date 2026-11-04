import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentEffect, AgentOutcome } from "../../packages/hyperchart/src/core/machine.js";
import type { JsonSchema } from "../../packages/hyperchart/src/core/types.js";
import { z } from "../../packages/hyperchart/src/index.js";
import {
	PiAgentExecutor,
	type PiExtensionPolicy,
} from "../../packages/pi-hyperchart/src/runtime/pi/pi_agent_executor.js";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const Reply = z.object({
	items: z.array(
		z.discriminatedUnion("kind", [
			z.object({ kind: z.literal("a"), note: z.string().optional() }),
			z.object({ kind: z.literal("b"), score: z.number() }),
		]),
	),
});

// Runs one real invocation through Pi's openai-completions provider and returns the request
// body it sent; the HTTP call itself is answered with an error.
async function sentRequest(strictFinish: boolean, extensionPolicy: PiExtensionPolicy) {
	const root = await mkdtemp(join(tmpdir(), "hyperchart-strict-finish-"));
	roots.push(root);
	await mkdir(join(root, "sessions"));
	await writeFile(join(root, "worker.md"), "---\ndescription: strict finish fixture\n---\nCall finish.\n");
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
	const bodies: Record<string, unknown>[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
		bodies.push(JSON.parse(String(init?.body)));
		return new Response(JSON.stringify({ error: { message: "fixture stop" } }), { status: 400 });
	});
	const executor = new PiAgentExecutor({
		workDir: root,
		agentDir: root,
		definitionDirs: [root],
		sessionsDir: join(root, "sessions"),
		branchId: "main",
		modelRuntime,
		extensionPolicy,
		resolveSessionOverrides: async () => ({ strictFinish }),
	});
	const actionUid = { chart: "strict", state: "work", action: "worker" };
	const effect: AgentEffect = {
		kind: "agent",
		id: "strict:work:worker:1:1",
		actionUid,
		action: {
			kind: "agent",
			uid: actionUid,
			name: "worker",
			model: "fixture/model",
			tools: ["read", "finish"],
			onFail: { nudge: 0, restart: 0 },
		},
		events: ["DONE", "FAILED"],
		sessionId: "strict-session",
		reply: { kind: "jsonSchema", schema: z.toJSONSchema(Reply) as JsonSchema },
	};
	try {
		await new Promise<AgentOutcome>((resolve) => executor.start(effect, resolve));
	} finally {
		await executor.dispose();
	}
	expect(bodies.length).toBeGreaterThan(0);
	return bodies[0] as { tools: { function: { name: string; strict?: boolean; parameters: unknown } }[] };
}

function sentFunction(body: Awaited<ReturnType<typeof sentRequest>>, name: string) {
	const tool = body.tools.find((candidate) => candidate.function.name === name);
	if (tool === undefined) {
		throw new Error(`Request has no ${name} tool`);
	}
	return tool.function;
}

for (const extensionPolicy of ["ambient", "isolated"] as const) {
	it(`sends a strict finish with the strict-mode schema (${extensionPolicy})`, async () => {
		const body = await sentRequest(true, extensionPolicy);
		const finish = sentFunction(body, "finish");
		expect(finish.strict).toBe(true);
		const sent = JSON.stringify(finish.parameters);
		expect(sent).toContain('"anyOf"');
		expect(sent).not.toMatch(/"(oneOf|const|\$schema)"/);
		expect(sentFunction(body, "read").strict).not.toBe(true);
	});
}

it("leaves finish non-strict and its reply schema unchanged by default", async () => {
	const finish = sentFunction(await sentRequest(false, "isolated"), "finish");
	expect(finish.strict).not.toBe(true);
	expect(JSON.stringify(finish.parameters)).toContain('"oneOf"');
});
