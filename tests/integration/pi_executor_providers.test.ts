import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentEffect, AgentOutcome } from "../../packages/hyperchart/src/core/machine.js";
import {
	PiAgentExecutor,
	type PiExtensionPolicy,
} from "../../packages/pi-hyperchart/src/runtime/pi/pi_agent_executor.js";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(registration: "config" | "native" | "invalid", extensionPolicy: PiExtensionPolicy = "ambient") {
	const root = await mkdtemp(join(tmpdir(), "hyperchart-provider-"));
	roots.push(root);
	await mkdir(join(root, "extensions"));
	await mkdir(join(root, "sessions"));
	await writeFile(join(root, "worker.md"), "---\ndescription: provider fixture\n---\nCall finish.\n");
	const model = {
		id: "extension-only",
		name: "Extension only",
		provider: "fixture-provider",
		api: "openai-completions",
		baseUrl: "https://fixture.invalid/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32000,
		maxTokens: 1000,
	};
	let source: string;
	switch (registration) {
		case "config":
			source = `pi.registerProvider("fixture-provider", { api: "openai-completions", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-key", models: [${JSON.stringify(model)}] });`;
			break;
		case "native":
			source = `pi.registerProvider({ id: "fixture-provider", name: "Fixture", auth: {}, getModels: () => [${JSON.stringify(model)}], stream() { throw new Error("Network forbidden"); }, streamSimple() { throw new Error("Network forbidden"); } });`;
			break;
		case "invalid":
			source = 'pi.registerProvider("fixture-provider", { models: [{ id: "broken", name: "Broken" }] });';
			break;
	}
	await writeFile(
		join(root, "extensions", "provider.ts"),
		`export default async function(pi) { await Promise.resolve(); ${source} }`,
	);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(root, "auth.json"),
		modelsPath: join(root, "models.json"),
		modelsStorePath: join(root, "models-store.json"),
		allowModelNetwork: false,
	});
	expect(modelRuntime.getModel("fixture-provider", "extension-only")).toBeUndefined();
	const executor = new PiAgentExecutor({
		workDir: root,
		agentDir: root,
		definitionDirs: [root],
		sessionsDir: join(root, "sessions"),
		branchId: "main",
		modelRuntime,
		extensionPolicy,
	});
	const actionUid = { chart: "providers", state: "work", action: "worker" };
	const effect: AgentEffect = {
		kind: "agent",
		id: "providers:work:worker:1:1",
		actionUid,
		action: {
			kind: "agent",
			uid: actionUid,
			name: "worker",
			model: "fixture-provider/extension-only",
			tools: ["finish"],
			onFail: { nudge: 0, restart: 0 },
		},
		events: ["DONE", "FAILED"],
		sessionId: "provider-session",
	};
	const prompt = vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(async function (this: AgentSession) {
		// Keep real SDK resource loading, provider binding, model selection and tool
		// construction; substitute only the model turn with its requested finish call.
		expect(this.model?.provider).toBe("fixture-provider");
		expect(this.model?.id).toBe("extension-only");
		expect(this.sessionManager.getEntries().filter((entry) => entry.type === "model_change")).toEqual([
			expect.objectContaining({ provider: "fixture-provider", modelId: "extension-only" }),
		]);
		const finish = this.agent.state.tools.find((tool) => tool.name === "finish");
		if (finish === undefined) {
			throw new Error("Missing finish tool");
		}
		await finish.execute("finish-call", { event: "DONE" });
	});
	return { executor, effect, prompt };
}

for (const registration of ["config", "native"] as const) {
	it(`resolves an extension-only ${registration} provider before constructing the SDK session`, async () => {
		const f = await fixture(registration);
		try {
			const outcome = await new Promise<AgentOutcome>((resolve) => f.executor.start(f.effect, resolve));
			expect(outcome).toMatchObject({ kind: "completed", event: { type: "DONE" } });
			expect(f.prompt).toHaveBeenCalledTimes(1);
		} finally {
			await f.executor.dispose();
		}
	});
}

it("isolated workers do not load ambient providers or silently substitute another model", async () => {
	const f = await fixture("config", "isolated");
	try {
		const outcome = await new Promise<AgentOutcome>((resolve) => f.executor.start(f.effect, resolve));
		expect(outcome).toMatchObject({
			kind: "failed",
			failure: { message: expect.stringContaining("Model 'fixture-provider/extension-only' was not found") },
		});
		expect(f.prompt).not.toHaveBeenCalled();
	} finally {
		await f.executor.dispose();
	}
});

it("reports provider registration diagnostics instead of hiding them as a missing model", async () => {
	const f = await fixture("invalid");
	try {
		const outcome = await new Promise<AgentOutcome>((resolve) => f.executor.start(f.effect, resolve));
		expect(outcome).toMatchObject({ kind: "failed", failure: { message: expect.stringContaining("Extension") } });
		expect(f.prompt).not.toHaveBeenCalled();
	} finally {
		await f.executor.dispose();
	}
});
