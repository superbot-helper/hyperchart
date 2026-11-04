import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "../../packages/hyperchart/src/index.js";
import type { AgentEffect, AgentOutcome } from "../../packages/hyperchart/src/core/machine.js";
import { actionUidKey } from "../../packages/hyperchart/src/core/action_uid.js";
import type { AgentActionAst, ChartEvent, JsonSchema, SchemaAst } from "../../packages/hyperchart/src/core/types.js";
import {
	createAgentDefaultsResolver,
	loadAgentDefinition,
	resolvePiSubagentDefinitionDirs,
} from "../../packages/pi-hyperchart/src/runtime/pi/agent_definitions.js";
import { createFinishTool, type CompletionSink } from "../../packages/pi-hyperchart/src/runtime/pi/finish_tool.js";
import {
	buildNudgePrompt,
	buildRecoveryPrompt,
	buildTaskPrompt,
} from "../../packages/hyperchart/src/runtime/generic/agent_prompts.js";
import {
	actionSessionDir,
	branchSessionSegment,
	evaluateAgentTurn,
} from "../../packages/hyperchart/src/runtime/generic/executor_helpers.js";
import {
	buildSessionPlan,
	findCapturedFinish,
	lastAssistantError,
	PiAgentExecutor,
	validateDeclaredReadPaths,
	shouldRecoverRestoredFinish,
} from "../../packages/pi-hyperchart/src/runtime/pi/pi_agent_executor.js";

const tempDirs: string[] = [];
const chartEvent = (outcome: AgentOutcome): ChartEvent =>
	outcome.kind === "completed" ? outcome.event : { type: "FAILED", error: outcome.failure.message };

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "hyperchart-pi-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function schema(value: z.ZodType): SchemaAst {
	return { kind: "jsonSchema", schema: z.toJSONSchema(value) as JsonSchema };
}

function effect(overrides: Partial<AgentEffect> = {}, actionOverrides: Partial<AgentActionAst> = {}): AgentEffect {
	const actionUid = { chart: "chart", state: "work", action: "worker" };
	return {
		kind: "agent",
		id: "chart:work:worker:1:1",
		actionUid,
		action: { kind: "agent", uid: actionUid, name: "worker", onFail: { nudge: 2, restart: 1 }, ...actionOverrides },
		events: ["DONE", "FAILED"],
		reply: schema(z.object({ value: z.number() })),
		...overrides,
		sessionId: overrides.sessionId ?? "session-id",
	};
}

describe("branch-scoped action sessions", () => {
	it("separates identical action visits by branch", async () => {
		const dir = await makeTempDir();
		const sessionsDir = join(dir, "sessions");
		const target = effect();
		const main = actionSessionDir(sessionsDir, "main", target);
		const experiment = actionSessionDir(sessionsDir, "experiment", target);
		expect(main).not.toBe(experiment);
		expect(main).toContain(join("sessions", branchSessionSegment("main")));
		expect(experiment).toContain(join("sessions", branchSessionSegment("experiment")));
	});

	it("keeps branch ids with colliding sanitized forms in distinct directories", async () => {
		const dir = await makeTempDir();
		const target = effect();
		const colon = actionSessionDir(join(dir, "sessions"), "review:a", target);
		const question = actionSessionDir(join(dir, "sessions"), "review?a", target);
		expect(branchSessionSegment("review:a")).not.toBe(branchSessionSegment("review?a"));
		expect(colon).not.toBe(question);
	});
});

describe("PiAgentExecutor live delivery", () => {
	it("delivers steering only to the exact durable invocation", async () => {
		const dir = await makeTempDir();
		const target = effect({ id: "chart:work:worker:2:2" });
		const executor = new PiAgentExecutor({
			workDir: dir,
			agentDir: dir,
			definitionDirs: [dir],
			sessionsDir: join(dir, "sessions"),
			branchId: "main",
			modelRuntime: {} as never,
		});
		const steered: string[] = [];
		const internal = executor as unknown as {
			live: Map<string, { session: { steer(message: string): Promise<void> }; effect: AgentEffect }>;
		};
		internal.live.set(actionUidKey(target.actionUid), {
			session: {
				steer: async (message) => {
					steered.push(message);
				},
			},
			effect: target,
		});

		expect(await executor.steer(actionUidKey(target.actionUid), 1, "stale visit")).toBe(false);
		expect(await executor.steer(actionUidKey(target.actionUid), 2, "current visit")).toBe(true);
		expect(steered).toEqual(["current visit"]);
	});
});

describe("PiAgentExecutor provider durability", () => {
	it("fails closed before completion when the external session drain fails", async () => {
		const dir = await makeTempDir();
		const executor = new PiAgentExecutor({
			workDir: dir,
			agentDir: dir,
			definitionDirs: [dir],
			sessionsDir: join(dir, "sessions"),
			branchId: "main",
			modelRuntime: {} as never,
		});
		const invocation = effect();
		const key = actionUidKey(invocation.actionUid);
		const session = { prompt: vi.fn(async () => undefined) };
		const emit = vi.fn();
		const internal = executor as unknown as {
			generations: { next(key: string): number };
			sessionHandles: WeakMap<object, { drain(): Promise<void> }>;
			promptAndAccept(
				key: string,
				generation: number,
				emit: (event: ChartEvent) => void,
				live: object,
				prompt: string,
			): Promise<void>;
		};
		const generation = internal.generations.next(key);
		internal.sessionHandles.set(session, {
			drain: async () => {
				throw new Error("postgres unavailable");
			},
		});

		await expect(
			internal.promptAndAccept(
				key,
				generation,
				emit,
				{
					session,
					effect: invocation,
					sink: { captured: { type: "DONE" } },
					generation,
				},
				"work",
			),
		).rejects.toThrow("postgres unavailable");
		expect(emit).not.toHaveBeenCalled();
	});
});

describe("PiAgentExecutor cancellation", () => {
	it("waits for delayed session construction and cleans up the late session during disposal", async () => {
		const dir = await makeTempDir();
		const definitions = join(dir, "agents");
		const sessionsDir = join(dir, "sessions");
		await mkdir(definitions, { recursive: true });
		await mkdir(sessionsDir, { recursive: true });
		await writeFile(join(definitions, "worker.md"), "---\ndescription: worker\n---\nworker\n", "utf8");
		const executor = new PiAgentExecutor({
			workDir: dir,
			agentDir: dir,
			definitionDirs: [definitions],
			sessionsDir,
			branchId: "main",
			modelRuntime: {} as never,
		});
		let releaseConstruction!: () => void;
		const constructionGate = new Promise<void>((resolve) => {
			releaseConstruction = resolve;
		});
		let constructionStarted = false;
		let aborts = 0;
		let disposals = 0;
		let prompts = 0;
		const lateSession = {
			extensionRunner: { emit: async () => undefined },
			abort: async () => {
				aborts++;
			},
			dispose: () => {
				disposals++;
			},
			prompt: async () => {
				prompts++;
			},
		};
		const internal = executor as unknown as {
			createSession: (...args: unknown[]) => Promise<unknown>;
			live: Map<string, unknown>;
			runs: Map<string, unknown>;
			cancellations: Map<string, unknown>;
		};
		internal.createSession = async () => {
			constructionStarted = true;
			await constructionGate;
			return lateSession;
		};
		const emitted: ChartEvent[] = [];
		executor.start(effect(), (outcome) => emitted.push(chartEvent(outcome)));
		await expect.poll(() => constructionStarted).toBe(true);

		const disposal = executor.dispose();
		expect(executor.dispose()).toBe(disposal);
		let settled = false;
		void disposal.then(() => {
			settled = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(settled).toBe(false);

		releaseConstruction();
		await expect(disposal).resolves.toBeUndefined();
		expect({ aborts, disposals, prompts }).toEqual({ aborts: 1, disposals: 1, prompts: 0 });
		expect(emitted).toEqual([]);
		expect(internal.live.size).toBe(0);
		expect(internal.runs.size).toBe(0);
		expect(internal.cancellations.size).toBe(0);

		const afterDispose: ChartEvent[] = [];
		executor.start(effect(), (outcome) => afterDispose.push(chartEvent(outcome)));
		expect(afterDispose).toEqual([{ type: "FAILED", error: "Pi agent executor is disposed" }]);
	});

	it("shares repeated cancellation and resolves only after asynchronous abort", async () => {
		const dir = await makeTempDir();
		let finishAbort!: () => void;
		const abort = new Promise<void>((resolve) => {
			finishAbort = resolve;
		});
		let disposed = false;
		const target = effect();
		const sessionsDir = join(dir, "sessions");
		await mkdir(sessionsDir, { recursive: true });
		const executor = new PiAgentExecutor({
			workDir: dir,
			agentDir: dir,
			definitionDirs: [dir],
			sessionsDir,
			branchId: "main",
			modelRuntime: {} as never,
		});
		const internal = executor as unknown as {
			generations: { next(key: string): number };
			live: Map<
				string,
				{
					session: { extensionRunner: { emit(): Promise<void> }; abort(): Promise<void>; dispose(): void };
					effect: AgentEffect;
					sink: CompletionSink;
					generation: number;
				}
			>;
		};
		const key = actionUidKey(target.actionUid);
		const generation = internal.generations.next(key);
		internal.live.set(key, {
			session: {
				extensionRunner: { emit: async () => undefined },
				abort: () => abort,
				dispose: () => {
					disposed = true;
				},
			},
			effect: target,
			sink: { captured: undefined },
			generation,
		});

		const first = executor.cancel(target.actionUid);
		expect(executor.cancel(target.actionUid)).toBe(first);
		let quiesced = false;
		void first.then(() => {
			quiesced = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(quiesced).toBe(false);
		finishAbort();
		await expect(first).resolves.toBeUndefined();
		expect(disposed).toBe(true);
	});
});

describe("agent definitions", () => {
	it("loads markdown frontmatter with project-over-global priority", async () => {
		const project = await makeTempDir();
		const global = await makeTempDir();
		await writeFile(
			join(global, "worker.md"),
			"---\ndescription: global\ntools: read, bash\nmodel: openai/gpt-4\nthinking: high\n---\nGlobal prompt\n",
			"utf8",
		);
		await writeFile(
			join(project, "worker.md"),
			"---\ndescription: project\ntools:\n  - grep\nsystemPromptMode: append\nunknown: ignored\n---\nProject prompt\n",
			"utf8",
		);

		const definition = loadAgentDefinition("worker", [project, global]);

		expect(definition).toEqual({
			name: "worker",
			description: "project",
			systemPrompt: "Project prompt",
			tools: ["grep"],
			systemPromptMode: "append",
		});
	});

	it("parses role and toolset from frontmatter alongside their fallbacks", async () => {
		const dir = await makeTempDir();
		await writeFile(
			join(dir, "critic.md"),
			"---\ndescription: critic\nrole: reviewer\ntoolset: reading\nmodel: anthropic/claude\ntools: read, grep\n---\nCritic prompt\n",
			"utf8",
		);

		expect(loadAgentDefinition("critic", [dir])).toMatchObject({
			role: "reviewer",
			toolset: "reading",
			model: "anthropic/claude",
			tools: ["read", "grep"],
		});
	});

	it("resolves symbolic role and toolset for static Pi inspection", async () => {
		const project = await makeTempDir();
		const agentDir = await makeTempDir();
		const chartDir = join(project, ".pi", "hypercharts", "review");
		await mkdir(join(chartDir, "agents"), { recursive: true });
		await writeFile(
			join(chartDir, "agents", "critic.md"),
			"---\nrole: reviewer\ntoolset: reading\nmodel: anthropic/fallback\ntools: bash\n---\nCritic prompt\n",
			"utf8",
		);
		await mkdir(join(project, ".hypercharts"), { recursive: true });
		await writeFile(
			join(project, ".hypercharts", "settings.json"),
			JSON.stringify({
				roles: { reviewer: "shared/fallback" },
				toolsets: { reading: ["read"] },
				pi: {
					roles: { reviewer: "anthropic/claude-opus" },
					toolsets: { reading: ["read", "grep"] },
				},
			}),
			"utf8",
		);

		const defaults = createAgentDefaultsResolver(project, agentDir, join(chartDir, "chart.ts"))("critic");

		expect(defaults).toMatchObject({
			role: "reviewer",
			model: "anthropic/fallback",
			resolvedModel: "anthropic/claude-opus",
			toolset: "reading",
			tools: ["bash"],
			resolvedTools: ["read", "grep", "finish"],
		});
	});

	it("resolves pi-subagents style project, user and package agent directories", async () => {
		const project = await makeTempDir();
		const agentDir = await makeTempDir();
		const packageRoot = join(agentDir, "npm", "node_modules", "agent-pack");
		const chartDir = join(project, ".pi", "hypercharts", "review");
		await mkdir(join(chartDir, "agents"), { recursive: true });
		await mkdir(join(project, ".pi", "agents"), { recursive: true });
		await mkdir(join(agentDir, "agents"), { recursive: true });
		await mkdir(join(packageRoot, "agents"), { recursive: true });
		await writeFile(
			join(project, ".pi", "agents", "project-worker.md"),
			"---\nname: worker\ndescription: project\n---\nProject prompt\n",
			"utf8",
		);
		await writeFile(join(chartDir, "agents", "worker.md"), "---\ndescription: bundle\n---\nBundle prompt\n", "utf8");
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:agent-pack"] }), "utf8");
		await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "agent-pack" }), "utf8");
		await writeFile(
			join(packageRoot, "agents", "critic.md"),
			"---\nname: critic\npackage: qa-pack\ndescription: critic\ntools: read, grep\n---\nCritic prompt\n",
			"utf8",
		);

		const dirs = resolvePiSubagentDefinitionDirs(join(project, "nested"), agentDir, join(chartDir, "chart.ts"));

		expect(dirs[0]).toBe(join(chartDir, "agents"));
		expect(dirs).toContain(join(agentDir, "agents"));
		expect(dirs).toContain(join(packageRoot, "agents"));
		expect(loadAgentDefinition("worker", dirs).systemPrompt).toBe("Bundle prompt");
		expect(loadAgentDefinition("qa-pack.critic", dirs)).toMatchObject({
			name: "qa-pack.critic",
			tools: ["read", "grep"],
		});
	});
});

describe("finish tool", () => {
	it("captures a valid typed completion with a non-oneOf schema", async () => {
		const currentEffect = effect();
		const sink: CompletionSink = { captured: undefined };
		const tool = createFinishTool(currentEffect, sink);

		expect(tool.parameters).toMatchObject({
			type: "object",
			properties: {
				event: { enum: ["DONE"] },
				output: { type: "object" },
			},
		});
		expect("oneOf" in tool.parameters).toBe(false);

		const result = await tool.execute(
			"call",
			{ event: "DONE", output: { value: 3 } },
			undefined,
			undefined,
			{} as never,
		);

		expect(result.terminate).toBe(true);
		expect(sink.captured).toEqual({ type: "DONE", output: { value: 3 } });
	});

	it("rejects invalid output, FAILED, and double calls by throwing", async () => {
		const currentEffect = effect();
		const sink: CompletionSink = { captured: undefined };
		const tool = createFinishTool(currentEffect, sink);
		const call = (params: unknown) => tool.execute("call", params as never, undefined, undefined, {} as never);

		await expect(call({ event: "DONE", output: { value: "bad" } })).rejects.toThrow("output");
		expect(sink.captured).toBeUndefined();
		await expect(call({ event: "FAILED", output: { value: 1 } })).rejects.toThrow("FAILED is reserved");
		expect(sink.captured).toBeUndefined();

		await call({ event: "DONE", output: { value: 1 } });
		await expect(call({ event: "DONE", output: { value: 2 } })).rejects.toThrow("already been called");
		expect(sink.captured).toEqual({ type: "DONE", output: { value: 1 } });
	});
});

describe("pi executor helpers", () => {
	it("builds session plan from action overrides before definition defaults", () => {
		const definition = {
			name: "worker",
			systemPrompt: "prompt",
			tools: ["read"],
			model: "anthropic/claude",
			thinking: "low" as const,
			systemPromptMode: "append" as const,
		};
		const plan = buildSessionPlan(definition, effect({}, { model: "openai/gpt", thinking: "high", tools: ["bash"] }), {
			defaultModel: "fallback/model",
		});

		expect(plan).toEqual({
			modelRef: "openai/gpt",
			thinkingLevel: "high",
			tools: ["bash", "finish"],
			promptMode: "append",
		});
	});

	it("resolves a definition toolset through the toolsets map", () => {
		const definition = {
			name: "critic",
			systemPrompt: "prompt",
			toolset: "reading",
			tools: ["bash"],
		};
		const options = { toolsets: { reading: ["read", "grep"] } };

		// A configured toolset wins over the definition's own tools; action tools win over both.
		expect(buildSessionPlan(definition, effect(), options).tools).toEqual(["read", "grep", "finish"]);
		expect(buildSessionPlan(definition, effect({}, { tools: ["edit"] }), options).tools).toEqual(["edit", "finish"]);
		// An unconfigured toolset falls through to the definition tools.
		expect(buildSessionPlan(definition, effect(), { toolsets: { other: ["fetch"] } }).tools).toEqual([
			"bash",
			"finish",
		]);
	});

	it("resolves a definition role through the model roles map", () => {
		const definition = {
			name: "critic",
			systemPrompt: "prompt",
			role: "reviewer",
			model: "anthropic/fallback",
		};
		const options = { defaultModel: "fallback/model", modelRoles: { reviewer: "anthropic/claude-opus" } };

		// A configured role wins over the definition's own model; an action model wins over both.
		expect(buildSessionPlan(definition, effect(), options).modelRef).toBe("anthropic/claude-opus");
		expect(buildSessionPlan(definition, effect({}, { model: "openai/gpt" }), options).modelRef).toBe("openai/gpt");
		// An unconfigured role falls through to the definition model.
		expect(buildSessionPlan(definition, effect(), { modelRoles: { other: "x/y" } }).modelRef).toBe(
			"anthropic/fallback",
		);
	});

	it("fails loudly when a declared role or toolset is unconfigured and has no fallback", () => {
		const roleOnly = { name: "critic", systemPrompt: "prompt", role: "reviewer" };
		const toolsetOnly = { name: "critic", systemPrompt: "prompt", toolset: "reading" };

		expect(() => buildSessionPlan(roleOnly, effect(), { defaultModel: "fallback/model" })).toThrow(
			"declares model role 'reviewer' which is not configured",
		);
		expect(() => buildSessionPlan(toolsetOnly, effect(), {})).toThrow(
			"declares toolset 'reading' which is not configured",
		);
		// An explicit chart-level override sidesteps the unconfigured name entirely.
		expect(buildSessionPlan(roleOnly, effect({}, { model: "openai/gpt" }), {}).modelRef).toBe("openai/gpt");
		expect(buildSessionPlan(toolsetOnly, effect({}, { tools: ["edit"] }), {}).tools).toEqual(["edit", "finish"]);
	});

	it.each([
		["fresh", { forceNewSession: false }],
		["restored", { forceNewSession: false, resumePrompt: "continue", resumeSessionFile: "/tmp/restored.jsonl" }],
		["rejected", { forceNewSession: false, resumePrompt: "fix the rejection", rejectReason: "invalid artifact" }],
	] as const)("rejects URL reads before the %s session branch", async (_name, runOptions) => {
		const dir = await makeTempDir();
		const definitions = join(dir, "agents");
		await mkdir(definitions, { recursive: true });
		await writeFile(join(definitions, "worker.md"), "---\ndescription: worker\n---\nworker\n", "utf8");
		const sessionsDir = join(dir, "sessions");
		await mkdir(sessionsDir, { recursive: true });
		const executor = new PiAgentExecutor({
			workDir: dir,
			agentDir: dir,
			definitionDirs: [definitions],
			sessionsDir,
			branchId: "main",
			modelRuntime: {} as never,
		});
		const internal = executor as unknown as {
			run(
				effect: AgentEffect,
				emit: (outcome: AgentOutcome) => void,
				options: typeof runOptions,
				generation: number,
			): Promise<void>;
			generations: { next(key: string): number };
		};
		const generation = internal.generations.next(actionUidKey(effect().actionUid));
		await expect(
			internal.run(
				effect({ reads: [{ path: "https://example.com/data.json" }] }),
				() => undefined,
				runOptions,
				generation,
			),
		).rejects.toThrow("not a local artifact");
		expect(() => validateDeclaredReadPaths([{ path: "https://example.com/data.json" }])).toThrow(
			"not a local artifact",
		);
	});

	it("does not recover stale id-free finish calls for a newer rejected phase", async () => {
		const messages = [
			{ role: "user", content: "old phase" },
			{
				role: "assistant",
				content: [
					{ type: "toolCall", name: "finish", id: "old-id-free", arguments: { event: "DONE", output: { value: 1 } } },
				],
			},
			{ role: "toolResult", toolName: "finish", toolCallId: "old-id-free", isError: false },
		];
		expect(await findCapturedFinish(messages, effect({ id: "chart:work:worker:1:3" }))).toEqual({
			type: "DONE",
			output: { value: 1 },
		});
		expect(shouldRecoverRestoredFinish({})).toBe(true);
		expect(shouldRecoverRestoredFinish({ resumePrompt: "fix the rejection" })).toBe(false);
	});

	it("builds a corrective nudge when the model writes textual tool-call syntax", () => {
		const prompt = buildNudgePrompt(effect(), "read<arg_key>path</arg_key><arg_value>context.json</arg_value>");

		expect(prompt).toContain("actual tool-calling interface");
		expect(prompt).toContain("Plain text like `read<arg_key>...`");
		expect(prompt).toContain("## Completion");
		expect(prompt).not.toContain("invocationId");
	});

	it("pins the exact declared artifact path in validation recovery prompts", () => {
		const invocation = effect({
			artifacts: [{ name: "research", path: "artifacts/research/deep/take/research-3.json" }],
			recovery: {
				mode: "nudge",
				scope: "validation",
				nudgeAttempt: 1,
				restartAttempt: 0,
				failure: { kind: "validation", message: "source cap exceeded" },
			},
		});
		const prompt = `${buildRecoveryPrompt(invocation)}\n${buildTaskPrompt(invocation, [])}`;
		expect(prompt).toContain("source cap exceeded");
		expect(prompt).toContain("artifacts/research/deep/take/research-3.json");
		expect(prompt).toContain("do not increment, rename, or version it yourself");
	});

	it("builds task prompts with selected reads, deliverables and completion contract", () => {
		const prompt = buildTaskPrompt(
			effect({
				task: "Do the work.",
				reads: [{ path: "facts.json", select: "facts", shape: schema(z.object({ facts: z.array(z.string()) })) }],
				artifacts: [{ path: "out.json", shape: schema(z.object({ ok: z.boolean() })) }],
			}),
			[{ artifact: { path: "facts.json", select: "facts" }, value: ["a"] }],
		);

		expect(prompt).toContain("Do the work.");
		expect(prompt).toContain("## Files to read first");
		expect(prompt).toContain("facts (from facts.json)");
		expect(prompt).toContain("## Deliverables");
		expect(prompt).toContain("## Completion");
		expect(prompt).not.toContain("invocationId");
	});

	it("extracts only the latest assistant turn's provider error", () => {
		expect(
			lastAssistantError([{ role: "assistant", stopReason: "error", errorMessage: "402: Insufficient Balance" }]),
		).toBe("402: Insufficient Balance");
		expect(
			lastAssistantError([
				{ role: "assistant", stopReason: "error", errorMessage: "old error" },
				{ role: "user", content: "retry" },
				{ role: "assistant", stopReason: "stop", content: [] },
			]),
		).toBeUndefined();
	});

	it("classifies unknown provider errors as fail-fast after one turn", async () => {
		const outcome = await evaluateAgentTurn({
			effect: effect(),
			sink: { captured: undefined },
			isCancelled: () => false,
			lastAssistantText: () => undefined,
			lastAssistantError: () => "402: Insufficient Balance",
			checkArtifacts: async () => [],
		});

		expect(outcome).toEqual({
			kind: "failed",
			failure: { kind: "provider", retryable: false, message: "402: Insufficient Balance" },
		});
	});

	it("classifies transient capacity failure for durable generic recovery", async () => {
		const message = 'HTTP 402: {"metadata":{"reason":"in_flight_budget_exhausted"},"headers":{"Retry-After":"120"}}';
		const outcome = await evaluateAgentTurn({
			effect: effect(),
			sink: { captured: undefined },
			isCancelled: () => false,
			lastAssistantText: () => undefined,
			lastAssistantError: () => message,
			checkArtifacts: async () => [],
		});
		expect(outcome).toEqual({ kind: "failed", failure: { kind: "provider", retryable: true, message } });
	});

	it("finds a successful finish call after the last user message in restored messages", async () => {
		const currentEffect = effect();
		const messages = [
			{ role: "user", content: "old" },
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "old",
						name: "finish",
						arguments: { event: "DONE", output: { value: 1 } },
					},
				],
			},
			{ role: "toolResult", toolCallId: "old", toolName: "finish", isError: false },
			{ role: "user", content: "new" },
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "new",
						name: "finish",
						arguments: { event: "DONE", output: { value: 2 } },
					},
				],
			},
			{ role: "toolResult", toolCallId: "new", toolName: "finish", isError: false },
		];

		expect(await findCapturedFinish(messages, currentEffect)).toEqual({ type: "DONE", output: { value: 2 } });
	});
});
