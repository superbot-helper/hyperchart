import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import {
	agent,
	artifact,
	compound,
	emit,
	final,
	failed,
	gate,
	json,
	map,
	normalizeChartConfig,
	parallel,
	resume,
	script,
	t,
	user,
	tsImport,
	z,
} from "../packages/hyperchart/src/index.js";
import {
	arg,
	artifactOf,
	chart,
	event,
	input,
	item,
	joinArtifactOf,
	joinResultOf,
	key,
	result,
	visit,
} from "../packages/hyperchart/src/core/dsl.js";
import { loop, start } from "./helpers/execution.js";
import { BranchExecution } from "../packages/hyperchart/src/execution/branch_execution.js";
import type {
	ActionUID,
	ChartAst,
	DurableLogRecord,
	DurableRecordDraft,
	Effect,
	GuardOutcome,
	MachineEvent,
	StateActionAst,
	StateCst,
	StateId,
} from "../packages/hyperchart/src/index.js";
import { failOnPullEvents, MockRuntime } from "./mock_runtime.js";
import { ChartRuntime } from "../packages/hyperchart/src/runtime/generic/chart_runtime.js";
import { MemoryLogStore } from "../packages/hyperchart/src/runtime/generic/memory_log_store.js";
import { FakeAgentExecutor } from "./fake_agent_executor.js";
import { collectHistoryRecords } from "./helpers/history.js";

function linearAst(): ChartAst {
	const result = normalizeChartConfig(
		chart({
			kind: "chart",
			id: "test-chart",
			initial: "start",
			states: {
				start: {
					kind: "state",
					action: agent("worker"),
					transitions: { DONE: "done" },
				},
				done: final(),
			},
		}),
	);
	if (!result.ok) {
		throw new Error("test chart should be valid");
	}
	return result.ast;
}

function finalAst(): ChartAst {
	const result = normalizeChartConfig(
		chart({
			kind: "chart",
			id: "test-chart",
			initial: "done",
			states: {
				done: final(),
			},
		}),
	);
	if (!result.ok) {
		throw new Error("test chart should be valid");
	}
	return result.ast;
}

function twoStepAst(): ChartAst {
	const result = normalizeChartConfig(
		chart({
			kind: "chart",
			id: "complex-chart",
			initial: "first",
			states: {
				first: {
					kind: "state",
					action: agent("first-worker"),
					transitions: { FIRST_DONE: "second" },
				},
				second: {
					kind: "state",
					action: agent("second-worker"),
					transitions: { SECOND_DONE: "done" },
				},
				done: final(),
			},
		}),
	);
	if (!result.ok) {
		throw new Error("test chart should be valid");
	}
	return result.ast;
}

function semanticDownstreamAst(): ChartAst {
	const result = normalizeChartConfig(
		chart({
			kind: "chart",
			id: "semantic-resume-chart",
			initial: "semantic-gate",
			states: {
				"semantic-gate": {
					kind: "state",
					action: agent("semantic-gate"),
					transitions: { SEMANTIC_PASS: "downstream" },
				},
				downstream: { kind: "state", action: agent("downstream"), transitions: { DOWNSTREAM_DONE: "done" } },
				done: final(),
			},
		}),
	);
	if (!result.ok) {
		throw new Error("test chart should be valid");
	}
	return result.ast;
}

function userAst(): ChartAst {
	const result = normalizeChartConfig(
		chart({
			kind: "chart",
			id: "user-chart",
			initial: "ask",
			states: {
				ask: {
					kind: "state",
					action: user({ prompt: "Approve?", options: ["APPROVED"] }),
					transitions: { APPROVED: "done" },
				},
				done: final(),
			},
		}),
	);
	if (!result.ok) {
		throw new Error("user chart should be valid");
	}
	return result.ast;
}

function inputUserAst(): ChartAst {
	const result = normalizeChartConfig(
		chart({
			kind: "chart",
			id: "input-user-chart",
			initial: "prepare",
			states: {
				prepare: {
					kind: "state",
					action: agent("preparer", { reply: z.object({ batch: z.array(z.string()) }) }),
					transitions: { READY: { target: "ask", input: { context: event() } } },
				},
				ask: {
					kind: "state",
					input: { context: z.object({ batch: z.array(z.string()) }) },
					action: user({ prompt: "Choose?", options: ["CHOSEN"] }),
					transitions: { CHOSEN: "done" },
				},
				done: final(),
			},
		}),
	);
	if (!result.ok) {
		throw new Error("input user chart should be valid");
	}
	return result.ast;
}

function transitionRefAst(): ChartAst {
	const parsed = normalizeChartConfig(
		chart({
			kind: "chart",
			id: "transition-ref-chart",
			initial: "select",
			states: {
				select: {
					kind: "state",
					action: agent("selector", { reply: z.object({ decision: z.object({ hypothesisId: z.string() }) }) }),
					transitions: {
						SELECTED: { target: "score", input: { hypothesisId: result("select", "decision.hypothesisId") } },
					},
				},
				score: {
					kind: "state",
					input: { hypothesisId: z.string() },
					action: agent("scorer", { validation: { guard: tsImport("./checks.js", "ok") } }),
					transitions: { DONE: "done" },
				},
				done: final(),
			},
		}),
	);
	if (!parsed.ok) {
		throw new Error(`transition-ref chart should be valid: ${JSON.stringify(parsed.diagnostics)}`);
	}
	return parsed.ast;
}

function validatedAst(mode?: "nudge" | "restart", budget?: number): ChartAst {
	const result = normalizeChartConfig(
		chart({
			kind: "chart",
			id: "validated-chart",
			initial: "work",
			states: {
				work: {
					kind: "state",
					action: agent("coder", {
						validation: {
							guard: tsImport("./checks.js", "testsPass"),
							...(budget === undefined
								? {}
								: { onFail: mode === "restart" ? { nudge: 0, restart: budget } : { nudge: budget, restart: 0 } }),
						},
					}),
					transitions: { DONE: "done" },
				},
				done: final(),
				failed: failed(),
			},
		}),
	);
	if (!result.ok) {
		throw new Error("test chart should be valid");
	}
	return result.ast;
}

function afterAst(escalated: StateCst = final()): ChartAst {
	const result = normalizeChartConfig(
		chart({
			kind: "chart",
			id: "timed-chart",
			initial: "work",
			states: {
				work: {
					kind: "state",
					action: agent("coder"),
					after: { delayMs: 500, target: "escalated" },
					transitions: { DONE: "done" },
				},
				done: final(),
				escalated,
			},
		}),
	);
	if (!result.ok) {
		throw new Error("test chart should be valid");
	}
	return result.ast;
}

function compoundAst(): ChartAst {
	const result = normalizeChartConfig(
		chart({
			kind: "chart",
			id: "nested-chart",
			initial: "review",
			states: {
				review: compound({
					initial: "analyze",
					onDone: "deploy",
					states: {
						analyze: { kind: "state", action: agent("analyzer"), transitions: { OK: "fix" } },
						fix: { kind: "state", action: agent("fixer"), transitions: { OK: "verified" } },
						verified: final(),
					},
					transitions: { ESCALATE: "escalate" },
				}),
				deploy: final(),
				escalate: final(),
			},
		}),
	);
	if (!result.ok) {
		throw new Error("test chart should be valid");
	}
	return result.ast;
}

function parallelAst(): ChartAst {
	const region = (worker: string) =>
		compound({
			initial: "scan",
			states: {
				scan: { kind: "state" as const, action: agent(worker), transitions: { OK: "ok" } },
				ok: final(),
			},
		});
	const result = normalizeChartConfig(
		chart({
			kind: "chart",
			id: "par-chart",
			initial: "audit",
			states: {
				audit: parallel({
					states: { security: region("security-bot"), perf: region("perf-bot") },
					onDone: "merge",
					transitions: { ESCALATE: "escalate" },
				}),
				merge: final(),
				escalate: final(),
			},
		}),
	);
	if (!result.ok) {
		throw new Error("test chart should be valid");
	}
	return result.ast;
}

function mapAst(concurrency?: number): ChartAst {
	const parsed = normalizeChartConfig(
		chart({
			kind: "chart",
			id: "map-chart",
			initial: "plan",
			states: {
				plan: {
					kind: "state",
					action: agent("planner", {
						reply: z.object({ chapters: z.record(z.string(), z.object({ title: z.string() })) }),
					}),
					transitions: { OK: "chapters" },
				},
				chapters: map({
					over: result("plan", "chapters"),
					...(concurrency === undefined ? {} : { concurrency }),
					initial: "author",
					onDone: "done",
					states: {
						author: {
							kind: "state",
							action: agent("author", { task: t`Write ${key()}: ${item("title")}` }),
							transitions: { OK: "written" },
						},
						written: final(),
					},
					transitions: { ESCALATE: "escalate" },
				}),
				done: final(),
				escalate: final(),
			},
		}),
	);
	if (!parsed.ok) {
		throw new Error(`test chart should be valid: ${JSON.stringify(parsed.diagnostics)}`);
	}
	return parsed.ast;
}

const PLAN_OUTPUT = { chapters: { intro: { title: "Intro" }, body: { title: "Body" } } };

const actionDefinitions = new Map<string, StateActionAst>();
function actionUid(ast: ChartAst, stateId: StateId = "start"): ActionUID {
	const state = ast.states[stateId];
	if (state?.kind !== "state") {
		throw new Error(`state ${stateId} should be actionable`);
	}
	actionDefinitions.set(`${state.action.uid.chart}:${stateId.replace(/#[^.]+/g, "")}`, state.action);
	return state.action.uid;
}

function meta(seqId: number) {
	return { seqId, parentId: null, branchId: "main", timestamp: seqId };
}

function complete(uid: ActionUID, eventType: string, seqId = 1): DurableLogRecord {
	return { type: "state_action", kind: "complete", actionUid: uid, event: { type: eventType }, ...meta(seqId) };
}

function invoke(uid: ActionUID, seqId = 1): DurableLogRecord {
	return {
		type: "state_action",
		kind: "invoke",
		sessionId: "session-id",
		actionUid: uid,
		definition: definitionForUid(uid),
		...meta(seqId),
	};
}

function definitionForUid(uid: ActionUID): StateActionAst {
	const recorded = actionDefinitions.get(`${uid.chart}:${uid.state.replace(/#[^.]+/g, "")}`);
	if (recorded !== undefined) {
		return { ...recorded, uid };
	}
	if (uid.action === "script") {
		return { kind: "script", uid, command: "test", args: [] };
	}
	if (uid.action === "user") {
		return { kind: "user", uid, prompt: { kind: "template", strings: [""], refs: [] }, options: [] };
	}
	return { kind: "agent", uid, name: "test-worker", onFail: { nudge: 2, restart: 1 } };
}

function timerFired(uid: ActionUID, seqId = 1): DurableLogRecord {
	return { type: "state_action", kind: "timer_fired", actionUid: uid, ...meta(seqId) };
}

function validated(uid: ActionUID, eventType: string, outcome: GuardOutcome, seqId = 1): DurableLogRecord {
	return {
		type: "state_action",
		kind: "validated",
		actionUid: uid,
		event: { type: eventType },
		guard: { kind: "tsImport", module: "./checks.js", export: "testsPass" },
		outcome,
		...meta(seqId),
	};
}

let nextAckSeqId = 0;
function durableRecordsAdded(
	records: readonly (DurableLogRecord | DurableRecordDraft)[],
	effectId = "durable-log",
): MachineEvent {
	if (records.some((record) => record.type === "state_action" && record.kind !== "invoke")) {
		const sourceSeqId = Number(effectId.match(/:(\d+)$/)?.[1]);
		if (Number.isSafeInteger(sourceSeqId)) {
			nextAckSeqId = Math.max(nextAckSeqId, sourceSeqId);
		}
	}
	let parentId: number | null = nextAckSeqId === 0 ? null : nextAckSeqId;
	const stamped = records.map((record) => {
		if ("seqId" in record) {
			nextAckSeqId = Math.max(nextAckSeqId, record.seqId);
			parentId = record.seqId;
			return record;
		}
		const durable = {
			...record,
			seqId: ++nextAckSeqId,
			parentId,
			branchId: "main",
			timestamp: Date.now(),
		} as DurableLogRecord;
		parentId = durable.seqId;
		return durable;
	});
	return { kind: "durable_records_added", effectId, records: stamped };
}

describe("execution loop", () => {
	beforeEach(() => {
		nextAckSeqId = 0;
	});
	it("returns immediately when the initial state is final", async () => {
		const runtime = new MockRuntime({ ast: finalAst(), events: failOnPullEvents() });

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(runtime.effectBatches).toEqual([]);
		expect(runtime.calls).toEqual(["loadAst", "loadProjection", "eventsQueue"]);
	});

	it("projects persisted logs before processing runtime events", async () => {
		const ast = linearAst();
		const runtime = new MockRuntime({
			ast,
			logs: [invoke(actionUid(ast), 1), complete(actionUid(ast), "DONE", 2)],
			events: failOnPullEvents(),
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(runtime.effectBatches).toEqual([]);
	});

	it("runs effects for pending action invocations on the synthetic start event", async () => {
		const ast = linearAst();
		const uid = actionUid(ast);
		const runtime = new MockRuntime({ ast, logs: [invoke(uid)], events: [] });

		await expect(loop(runtime)).rejects.toThrow("Event queue closed before reaching a final state");

		expect(runtime.effectBatches).toHaveLength(1);
		expect(runtime.effectBatches[0]).toEqual([
			expect.objectContaining({
				kind: "agent",
				id: "test-chart:start:agent:1:1",
				actionUid: uid,
			}),
		]);
	});

	it("reaches final state through agent DONE event and durable records effect", async () => {
		const ast = linearAst();
		const uid = actionUid(ast);
		const doneEvent = { type: "DONE" };
		const events: MachineEvent[] = [];
		const sequence: string[] = [];
		const runtime = new MockRuntime({
			ast,
			logs: [invoke(uid)],
			events,
			onRunEffects(effects) {
				const [effect] = effects;
				if (effect === undefined) {
					throw new Error("expected effect");
				}

				sequence.push(effect.kind);
				switch (effect.kind) {
					case "agent":
						expect(effect).toEqual(
							expect.objectContaining({
								kind: "agent",
								actionUid: uid,
							}),
						);
						events.push({ kind: "agent", effectId: effect.id, outcome: { kind: "completed", event: doneEvent } });
						break;
					case "durable_records":
						expect(effect.records).toEqual([
							expect.objectContaining({
								type: "state_action",
								kind: "complete",
								actionUid: uid,
								event: doneEvent,
							}),
						]);
						events.push(durableRecordsAdded(effect.records, effect.id));
						break;
					default:
						throw new Error(`unexpected effect kind ${effect.kind}`);
				}
			},
		});

		const state = await loop(runtime);

		expect(sequence).toEqual(["agent", "durable_records"]);
		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(state.projection.pendingActions).toEqual([]);
	});

	it("commits a journal-native user gate and applies its resolved fact directly", async () => {
		const ast = userAst();
		const uid = actionUid(ast, "ask");
		const events: MachineEvent[] = [];
		const gateSeqIds: number[] = [];
		let openedHasInput: boolean | undefined;
		const runtime = new MockRuntime({
			ast,
			logs: [invoke(uid)],
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind !== "durable_records") {
						continue;
					}
					const ack = durableRecordsAdded(effect.records, effect.id);
					if (ack.kind !== "durable_records_added") {
						throw new Error("expected durable ack");
					}
					events.push(ack);
					const opened = ack.records.find((record) => record.type === "user_interaction" && record.kind === "opened");
					if (opened?.type === "user_interaction" && opened.kind === "opened") {
						gateSeqIds.push(opened.seqId);
						openedHasInput = Object.hasOwn(opened, "input");
						events.push(
							durableRecordsAdded(
								[
									{
										type: "user_interaction",
										kind: "resolved",
										gateSeqId: opened.seqId,
										actionUid: opened.actionUid,
										event: { type: "APPROVED" },
									},
								],
								`external:${opened.seqId}`,
							),
						);
					}
				}
			},
		});
		const state = await loop(runtime);
		expect(gateSeqIds).toHaveLength(1);
		expect(gateSeqIds[0]).toBeGreaterThan(0);
		expect(openedHasInput).toBe(false);
		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(runtime.effectBatches.flat().some((effect) => effect.kind === "user")).toBe(false);
		expect(
			runtime.effectBatches
				.flat()
				.some(
					(effect) =>
						effect.kind === "durable_records" &&
						effect.records.some((record) => record.type === "state_action" && record.kind === "complete"),
				),
		).toBe(false);
	});

	it("records the fully resolved state input on a journal-native user gate", async () => {
		const ast = inputUserAst();
		const events: MachineEvent[] = [];
		let openedInput: unknown;
		const runtime = new MockRuntime({
			ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: { kind: "completed", event: { type: "READY", output: { batch: ["alpha", "beta"] } } },
						});
					} else if (effect.kind === "durable_records") {
						const ack = durableRecordsAdded(effect.records, effect.id);
						if (ack.kind !== "durable_records_added") {
							throw new Error("expected durable ack");
						}
						events.push(ack);
						const opened = ack.records.find((record) => record.type === "user_interaction" && record.kind === "opened");
						if (opened?.type === "user_interaction" && opened.kind === "opened") {
							openedInput = opened.input;
							events.push(
								durableRecordsAdded(
									[
										{
											type: "user_interaction",
											kind: "resolved",
											gateSeqId: opened.seqId,
											actionUid: opened.actionUid,
											event: { type: "CHOSEN" },
										},
									],
									`external:${opened.seqId}`,
								),
							);
						}
					}
				}
			},
		});

		const state = await start(runtime);
		expect(openedInput).toEqual({ context: { batch: ["alpha", "beta"] } });
		expect(state.projection.activeLeaves).toEqual(["done"]);
	});

	it("resolves result refs in transition inputs and records state inputs on every action phase", async () => {
		const ast = transitionRefAst();
		const events: MachineEvent[] = [];
		const scoreRecords: Array<Extract<DurableRecordDraft, { type: "state_action" }>> = [];
		const runtime = new MockRuntime({
			ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						events.push(
							effect.actionUid.state === "select"
								? {
										kind: "agent",
										effectId: effect.id,
										outcome: {
											kind: "completed",
											event: { type: "SELECTED", output: { decision: { hypothesisId: "hypothesis-7" } } },
										},
									}
								: { kind: "agent", effectId: effect.id, outcome: { kind: "completed", event: { type: "DONE" } } },
						);
					} else if (effect.kind === "validate") {
						events.push({ kind: "validated", effectId: effect.id, outcome: true });
					} else if (effect.kind === "durable_records") {
						for (const record of effect.records) {
							if (record.type === "state_action" && record.actionUid.state === "score") {
								scoreRecords.push(record);
							}
						}
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await start(runtime);
		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(scoreRecords.map((record) => record.kind)).toEqual(["invoke", "complete", "validated"]);
		for (const record of scoreRecords) {
			expect("input" in record ? record.input : undefined).toEqual({ hypothesisId: "hypothesis-7" });
		}
	});

	it("fails closed when a transition result ref has no completed result", async () => {
		const ast = transitionRefAst();
		const events: MachineEvent[] = [];
		const runtime = new MockRuntime({
			ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: { kind: "completed", event: { type: "SELECTED" } },
						});
					} else if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		await expect(start(runtime)).rejects.toThrow("Transition input in state select: no result for state select");
	});

	it("rejects an unsupported journal-native user event", async () => {
		const ast = userAst();
		const uid = actionUid(ast, "ask");
		const events: MachineEvent[] = [];
		const runtime = new MockRuntime({
			ast,
			logs: [invoke(uid)],
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "durable_records") {
						const ack = durableRecordsAdded(effect.records, effect.id);
						if (ack.kind !== "durable_records_added") {
							throw new Error("expected durable ack");
						}
						events.push(ack);
						const opened = ack.records.find((record) => record.type === "user_interaction" && record.kind === "opened");
						if (opened?.type === "user_interaction" && opened.kind === "opened") {
							events.push(
								durableRecordsAdded(
									[
										{
											type: "user_interaction",
											kind: "resolved",
											gateSeqId: opened.seqId,
											actionUid: opened.actionUid,
											event: { type: "NOPE" },
										},
									],
									"external",
								),
							);
						}
					}
				}
			},
		});
		await expect(loop(runtime)).rejects.toThrow("Event 'NOPE' is not allowed");
	});

	it("runs two agent states in sequence, machine invoking each action itself", async () => {
		const ast = twoStepAst();
		const events: MachineEvent[] = [];
		const sequence: string[] = [];
		const runtime = new MockRuntime({
			ast,
			events,
			onRunEffects(effects) {
				const [effect] = effects;
				if (effect === undefined) {
					throw new Error("expected effect");
				}

				switch (effect.kind) {
					case "agent": {
						sequence.push(`agent:${effect.actionUid.state}`);
						const eventType = effect.actionUid.state === "first" ? "FIRST_DONE" : "SECOND_DONE";
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: { kind: "completed", event: { type: eventType } },
						});
						break;
					}
					case "durable_records": {
						for (const record of effect.records) {
							if (record.type === "state_action") {
								sequence.push(`${record.kind}:${record.actionUid.state}`);
							}
						}
						events.push(durableRecordsAdded(effect.records, effect.id));
						break;
					}
					default:
						throw new Error(`unexpected effect kind ${effect.kind}`);
				}
			},
		});

		const state = await loop(runtime);

		expect(sequence).toEqual([
			"invoke:first",
			"agent:first",
			"complete:first",
			"invoke:second",
			"agent:second",
			"complete:second",
		]);
		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(state.projection.pendingActions).toEqual([]);
	});

	function runValidatedChart(
		outcomes: GuardOutcome[],
		options: { mode?: "nudge" | "restart"; claim?: string; budget?: number } = {},
	) {
		const ast = validatedAst(options.mode, options.budget);
		const uid = actionUid(ast, "work");
		const events: MachineEvent[] = [];
		const validations: Extract<Effect, { kind: "validate" }>[] = [];
		const retries: Extract<Effect, { kind: "agent" }>[] = [];
		const runtime = new MockRuntime({
			ast,
			logs: [invoke(uid)],
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						if (effect.recovery !== undefined) {
							retries.push(effect);
						}
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: { kind: "completed", event: { type: options.claim ?? "DONE" } },
						});
					}
					if (effect.kind === "validate") {
						validations.push(effect);
						const outcome = outcomes.shift();
						if (outcome === undefined) {
							throw new Error("unexpected validate effect");
						}
						events.push({ kind: "validated", effectId: effect.id, outcome });
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});
		return { runtime, validations, retries, run: loop(runtime) };
	}

	it("accepts a completion claim when validation passes", async () => {
		const { validations, retries, run } = runValidatedChart([true]);

		const state = await run;

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(retries).toEqual([]);
		expect(validations).toHaveLength(1);
		expect(validations[0]).toEqual(
			expect.objectContaining({
				kind: "validate",
				guard: { kind: "tsImport", module: "./checks.js", export: "testsPass" },
				event: { type: "DONE" },
			}),
		);
	});

	it("rejects a failed claim with feedback and accepts the retry", async () => {
		const { runtime, retries, run } = runValidatedChart([{ ok: false, reason: "tests are failing" }, true]);

		const state = await run;

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(retries).toHaveLength(1);
		expect(retries[0]).toEqual(
			expect.objectContaining({
				kind: "agent",
				recovery: expect.objectContaining({
					mode: "nudge",
					scope: "validation",
					failure: expect.objectContaining({ message: "tests are failing" }),
				}),
			}),
		);
		// The whole validation history is durable: claim, verdict, retry, verdict.
		const records = runtime.effectBatches
			.flat()
			.flatMap((effect) => (effect.kind === "durable_records" ? [...effect.records] : []));
		expect(records.map((record) => (record.type === "state_action" ? record.kind : record.type))).toEqual([
			"complete",
			"validated",
			"retry",
			"complete",
			"validated",
		]);
	});

	it("carries the chart-declared restart mode in the retry effect", async () => {
		const { retries, run } = runValidatedChart([false, true], { mode: "restart", budget: 1 });

		await run;

		expect(retries).toHaveLength(1);
		expect(retries[0]?.recovery).toMatchObject({ mode: "restart", scope: "validation" });
	});

	it("uses the default nudge → restart → nudge order with durable sessions and counters", async () => {
		const { runtime, retries, run } = runValidatedChart([false, false, false, false, false, false]);

		const state = await run;

		expect(state.projection.failure).toMatchObject({ origin: "work" });
		expect(retries.map((effect) => effect.recovery?.mode)).toEqual(["nudge", "nudge", "restart", "nudge", "nudge"]);
		expect(
			retries.map((effect) => effect.recovery && [effect.recovery.nudgeAttempt, effect.recovery.restartAttempt]),
		).toEqual([
			[1, 0],
			[2, 0],
			[0, 1],
			[1, 1],
			[2, 1],
		]);
		expect(retries[0]?.sessionId).toBe(retries[1]?.sessionId);
		expect(retries[2]?.sessionId).not.toBe(retries[1]?.sessionId);
		expect(retries[3]?.sessionId).toBe(retries[2]?.sessionId);
		const retryRecords = runtime.effectBatches
			.flat()
			.flatMap((effect) =>
				effect.kind === "durable_records"
					? effect.records.filter((record) => record.type === "state_action" && record.kind === "retry")
					: [],
			);
		expect(retryRecords).toHaveLength(5);
	});

	it("exhausts the retry budget into global failure and cancels the agent", async () => {
		// A one-nudge budget retries one rejected round; the second rejection is terminal.
		const { runtime, retries, run } = runValidatedChart([{ ok: false, reason: "no" }, false], { budget: 1 });

		const state = await run;

		expect(state.projection.activeLeaves).toEqual(["work"]);
		expect(state.projection.failure).toMatchObject({
			origin: "work",
			error: "Agent completion was rejected by validation",
		});
		expect(retries).toHaveLength(1);
		expect(retries[0]?.recovery).toMatchObject({ nudgeAttempt: 1 });
		// failure terminalizes immediately and emits only a best-effort runtime cancellation
		expect(runtime.effectBatches.flat().filter((effect) => effect.kind === "cancel")).toHaveLength(1);
	});

	it("lets reserved FAILED bypass validation and enter global fail-fast", async () => {
		const { validations, retries, run } = runValidatedChart([], { claim: "FAILED" });

		const state = await run;

		expect(state.projection.activeLeaves).toEqual(["work"]);
		expect(state.projection.failure).toMatchObject({ origin: "work", error: "Agent emitted FAILED" });
		expect(retries).toEqual([]);
		expect(validations).toEqual([]);
	});

	it("recovers a retryable agent failure through a durable general-scope nudge", async () => {
		const ast = validatedAst();
		const uid = actionUid(ast, "work");
		const events: MachineEvent[] = [];
		let turns = 0;
		const runtime = new MockRuntime({
			ast,
			logs: [invoke(uid)],
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						turns += 1;
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome:
								turns === 1
									? { kind: "failed", failure: { kind: "incomplete", retryable: true, message: "missing finish" } }
									: { kind: "completed", event: { type: "FAILED", error: "stop after proving recovery" } },
						});
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);
		expect(state.projection.failure).toMatchObject({ error: "stop after proving recovery" });
		const recovery = runtime.effectBatches
			.flat()
			.find((effect) => effect.kind === "agent" && effect.recovery !== undefined);
		expect(recovery).toMatchObject({
			kind: "agent",
			recovery: { mode: "nudge", scope: "general", failure: { kind: "incomplete" } },
		});
	});

	it("resumes a durable semantic gate run by invoking only the unresolved downstream action", async () => {
		const ast = semanticDownstreamAst();
		const semanticUid = actionUid(ast, "semantic-gate");
		const downstreamUid = actionUid(ast, "downstream");
		const events: MachineEvent[] = [];
		const agentStates: string[] = [];
		const runtime = new MockRuntime({
			ast,
			logs: [invoke(semanticUid, 1), complete(semanticUid, "SEMANTIC_PASS", 2), invoke(downstreamUid, 3)],
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						agentStates.push(effect.actionUid.state);
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: { kind: "completed", event: { type: "DOWNSTREAM_DONE" } },
						});
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});
		const state = await loop(runtime);
		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(agentStates).toEqual(["downstream"]);
	});

	it("replays stored verdicts without re-running the validator", async () => {
		const ast = validatedAst();
		const uid = actionUid(ast, "work");
		const runtime = new MockRuntime({
			ast,
			logs: [invoke(uid, 1), complete(uid, "DONE", 2), validated(uid, "DONE", true, 3)],
			events: failOnPullEvents(),
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(runtime.effectBatches.flat().filter((effect) => effect.kind === "validate")).toEqual([]);
	});

	it("re-runs the validator when the log ends mid-validation", async () => {
		const ast = validatedAst();
		const uid = actionUid(ast, "work");
		const events: MachineEvent[] = [];
		const runtime = new MockRuntime({
			ast,
			// The claim was recorded but the verdict never landed (crash mid-validation).
			logs: [invoke(uid, 1), complete(uid, "DONE", 2)],
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "validate") {
						events.push({ kind: "validated", effectId: effect.id, outcome: true });
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(runtime.effectBatches.flat().filter((effect) => effect.kind === "validate")).toHaveLength(1);
		// The claiming action itself was not restarted: its claim is being validated, not lost.
		expect(runtime.effectBatches.flat().filter((effect) => effect.kind === "agent")).toEqual([]);
	});

	it("invokes the initial action itself on a fresh log", async () => {
		const ast = linearAst();
		const events: MachineEvent[] = [];
		const runtime = new MockRuntime({
			ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: { kind: "completed", event: { type: "DONE" } },
						});
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["done"]);
		const records = runtime.effectBatches
			.flat()
			.flatMap((effect) => (effect.kind === "durable_records" ? [...effect.records] : []));
		expect(records.map((record) => (record.type === "state_action" ? record.kind : record.type))).toEqual([
			"invoke",
			"complete",
		]);
		const invoke = records[0];
		if (invoke?.type !== "state_action" || invoke.kind !== "invoke") {
			throw new Error("missing invoke record");
		}
		expect(invoke.sessionId).toMatch(/^[0-9a-f-]{36}$/);
		const agent = runtime.effectBatches.flat().find((effect) => effect.kind === "agent");
		expect(agent?.kind === "agent" ? agent.sessionId : undefined).toBe(invoke.sessionId);
	});

	it("throws when the runtime queue closes before a final state is reached", async () => {
		const runtime = new MockRuntime({ ast: linearAst(), events: [] });

		await expect(loop(runtime)).rejects.toThrow("Event queue closed before reaching a final state");
	});

	it("does not dispatch a pending action effect twice", async () => {
		const ast = linearAst();
		const uid = actionUid(ast);
		const sessionRef: DurableLogRecord = { type: "session_ref", index: 0, file: "session.jsonl", ...meta(2) };
		// A neutral event that re-enters createMachineOutput while the action is still pending.
		const events: MachineEvent[] = [durableRecordsAdded([sessionRef], "noop")];
		const runtime = new MockRuntime({ ast, logs: [invoke(uid)], events });

		await expect(loop(runtime)).rejects.toThrow("Event queue closed before reaching a final state");

		const agentEffects = runtime.effectBatches.flat().filter((effect) => effect.kind === "agent");
		expect(agentEffects).toHaveLength(1);
	});

	it("logs the run arguments as the first fact and resolves inputs from facts", async () => {
		const parsed = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "params-chart",
				initial: "plan",
				states: {
					plan: {
						kind: "state",
						action: agent("planner", {
							task: t`Plan a report on ${arg("topic")}.`,
							reply: z.object({ steps: z.array(z.string()) }),
						}),
						transitions: { PLAN_READY: "build" },
					},
					build: {
						kind: "state",
						action: agent("builder", {
							task: t`Build a report on ${arg("topic")} following steps ${json(result("plan", "steps"))}.`,
							artifacts: { report: t`out/${arg("topic")}.html` },
						}),
						transitions: { BUILT: "done" },
					},
					done: final(),
				},
			}),
		);
		if (!parsed.ok) {
			throw new Error("test chart should be valid");
		}
		const ast = parsed.ast;
		const events: MachineEvent[] = [];
		const tasks: Record<string, unknown> = {};
		const outputs: Record<string, unknown> = {};
		const resultShapes: Record<string, unknown> = {};
		const runtime = new MockRuntime({
			ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						tasks[effect.actionUid.state] = effect.task;
						outputs[effect.actionUid.state] = effect.artifacts;
						resultShapes[effect.actionUid.state] = effect.reply;
						const reply =
							effect.actionUid.state === "plan"
								? { type: "PLAN_READY", output: { steps: ["a", "b"] } }
								: { type: "BUILT" };
						events.push({ kind: "agent", effectId: effect.id, outcome: { kind: "completed", event: reply } });
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await start(runtime, { topic: "AI report" });

		expect(state.projection.activeLeaves).toEqual(["done"]);
		// args landed as the very first fact, seeded before the loop even started.
		const records = runtime.effectBatches
			.flat()
			.flatMap((effect) => (effect.kind === "durable_records" ? [...effect.records] : []));
		expect(records[0]).toEqual(expect.objectContaining({ type: "args", args: { topic: "AI report" } }));
		expect(records.filter((record) => record.type === "args")).toHaveLength(1);
		expect(state.projection.results.plan).toEqual({ steps: ["a", "b"] });
		// Templates arrive rendered: strings verbatim, non-strings as JSON — in every templated param.
		expect(tasks.plan).toBe("Plan a report on AI report.");
		expect(tasks.build).toBe('Build a report on AI report following steps ["a","b"].');
		expect(outputs.build).toEqual([{ name: "report", path: "out/AI report.html" }]);
		// The reply channel is a first-class part of the spawn request: the payload shape the
		// runtime should instruct and validate against.
		expect(resultShapes.plan).toMatchObject({
			kind: "jsonSchema",
			schema: { type: "object", required: ["steps"] },
		});
		expect(resultShapes.build).toBeUndefined();
		expect(
			records.find(
				(record) => record.type === "state_action" && record.kind === "invoke" && record.actionUid.state === "plan",
			),
		).not.toHaveProperty("invocation");
	});

	it.each([
		{ name: "without launch args", args: undefined, expected: { topic: "Hyperchart", depth: 2 } },
		{
			name: "with partial launch args",
			args: { topic: "AI", extra: true },
			expected: { topic: "AI", depth: 2, extra: true },
		},
	])("journals declared arg defaults for omitted args when started $name", async ({ args, expected }) => {
		const parsed = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "arg-defaults-chart",
				args: { topic: { default: "Hyperchart" }, depth: { schema: z.number(), default: 2 } },
				initial: "plan",
				states: {
					plan: {
						kind: "state",
						action: agent("planner", { task: t`Plan ${arg("topic")} at depth ${arg("depth")}.` }),
						transitions: { DONE: "done" },
					},
					done: final(),
				},
			}),
		);
		if (!parsed.ok) {
			throw new Error("test chart should be valid");
		}
		const store = new MemoryLogStore();
		const executor = new FakeAgentExecutor({ plan: [{ type: "DONE" }] });
		const runtime = new ChartRuntime({
			ast: parsed.ast,
			branchId: "main",
			logStore: store,
			agentExecutor: executor,
			workDir: tmpdir(),
			chartDir: tmpdir(),
		});
		try {
			const state = await start(runtime, args);

			expect(state.projection.activeLeaves).toEqual(["done"]);
			expect(state.projection.args).toEqual(expected);
			expect(executor.starts.map((effect) => effect.task)).toEqual([
				`Plan ${expected.topic} at depth ${expected.depth}.`,
			]);
			const records = await collectHistoryRecords(store, "main");
			expect(records.filter((record) => record.type === "args")).toEqual([
				expect.objectContaining({ type: "args", args: expected }),
			]);
		} finally {
			await runtime.dispose();
		}
	});

	it("fileOf reads inherit the producer's rendered path and content shape", async () => {
		const shape = z.object({ claims: z.array(z.string()) });
		const parsed = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "files-chart",
				initial: "writer",
				states: {
					writer: {
						kind: "state",
						action: agent("writer", { artifacts: { claims: artifact(t`out/${arg("topic")}.json`, shape) } }),
						transitions: { DONE: "reader" },
					},
					reader: {
						kind: "state",
						action: agent("reader", {
							reads: [artifactOf("writer"), artifactOf("writer", { artifact: "claims", select: "claims.approved" })],
						}),
						transitions: { DONE: "done" },
					},
					done: final(),
				},
			}),
		);
		if (!parsed.ok) {
			throw new Error("test chart should be valid");
		}
		const events: MachineEvent[] = [];
		const outputs: Record<string, unknown> = {};
		const readsSeen: Record<string, unknown> = {};
		const runtime = new MockRuntime({
			ast: parsed.ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						outputs[effect.actionUid.state] = effect.artifacts;
						readsSeen[effect.actionUid.state] = effect.reads;
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: { kind: "completed", event: { type: "DONE" } },
						});
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await start(runtime, { topic: "ai" });

		expect(state.projection.activeLeaves).toEqual(["done"]);
		// The producer was told where to write and what shape; the consumer reads the SAME thing —
		// path re-rendered from the same facts, shape inherited from the declaration.
		const convertedShape = { kind: "jsonSchema", schema: expect.objectContaining({ type: "object" }) };
		expect(outputs.writer).toEqual([
			expect.objectContaining({ name: "claims", path: "out/ai.json", shape: convertedShape }),
		]);
		// a plain read (single artifact resolved by name omission), and a narrowed read of one field
		expect(readsSeen.reader).toEqual([
			expect.objectContaining({ path: "out/ai.json", shape: convertedShape }),
			expect.objectContaining({ path: "out/ai.json", shape: convertedShape, select: "claims.approved" }),
		]);
	});

	it("visit() changes artifact paths only when the state is entered again", async () => {
		const parsed = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "visit-chart",
				initial: "writer",
				states: {
					writer: {
						kind: "state",
						action: agent("writer", { artifacts: { out: artifact(t`out/${visit()}.json`) } }),
						transitions: { DONE: "gate" },
					},
					gate: {
						kind: "state",
						action: agent("gate"),
						transitions: { AGAIN: "writer", PASS: "reader" },
					},
					reader: {
						kind: "state",
						action: agent("reader", { reads: [artifactOf("writer")] }),
						transitions: { OK: "done" },
					},
					done: final(),
				},
			}),
		);
		if (!parsed.ok) {
			throw new Error("test chart should be valid");
		}
		const events: MachineEvent[] = [];
		const writerPaths: string[] = [];
		let readerPath: string | undefined;
		const gateEvents = ["AGAIN", "PASS"];
		const runtime = new MockRuntime({
			ast: parsed.ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent" && effect.actionUid.state === "writer") {
						writerPaths.push(effect.artifacts?.[0]?.path ?? "");
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: { kind: "completed", event: { type: "DONE" } },
						});
					}
					if (effect.kind === "agent" && effect.actionUid.state === "gate") {
						const eventType = gateEvents.shift();
						if (eventType === undefined) {
							throw new Error("unexpected gate run");
						}
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: { kind: "completed", event: { type: eventType } },
						});
					}
					if (effect.kind === "agent" && effect.actionUid.state === "reader") {
						readerPath = effect.reads?.[0]?.path;
						events.push({ kind: "agent", effectId: effect.id, outcome: { kind: "completed", event: { type: "OK" } } });
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(writerPaths).toEqual(["out/1.json", "out/2.json"]);
		expect(readerPath).toBe("out/2.json");
	});

	it("adds a resume request with the current visit effect id on re-entry", async () => {
		const parsed = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "reenter-chart",
				initial: "work",
				states: {
					work: {
						kind: "state",
						input: { feedback: z.string().default("none") },
						action: agent("worker", { reentry: { resume: t`Apply feedback: ${input("feedback")}` } }),
						transitions: { DONE: "gate" },
					},
					gate: {
						kind: "state",
						action: agent("gate", { reply: z.object({ feedback: z.string() }) }),
						transitions: { AGAIN: { target: "work", input: { feedback: event("feedback") } }, PASS: "done" },
					},
					done: final(),
				},
			}),
		);
		if (!parsed.ok) {
			throw new Error("test chart should be valid");
		}
		const events: MachineEvent[] = [];
		const workEffects: Extract<Effect, { kind: "agent" }>[] = [];
		let gateRuns = 0;
		const runtime = new MockRuntime({
			ast: parsed.ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent" && effect.actionUid.state === "work") {
						workEffects.push(effect);
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: { kind: "completed", event: { type: "DONE" } },
						});
					}
					if (effect.kind === "agent" && effect.actionUid.state === "gate") {
						gateRuns += 1;
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: {
								kind: "completed",
								event: gateRuns === 1 ? { type: "AGAIN", output: { feedback: "tighten" } } : { type: "PASS" },
							},
						});
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(workEffects).toHaveLength(2);
		expect(workEffects[0]?.resume).toBeUndefined();
		expect(workEffects[1]?.id).toMatch(/:2:\d+$/);
		expect(workEffects[1]?.resume).toEqual({ message: "Apply feedback: tighten" });
	});

	it("map onReenter resumes matching keys and starts new keys fresh", async () => {
		const parsed = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "map-reenter-chart",
				initial: "items",
				states: {
					items: {
						kind: "map",
						input: { items: z.record(z.string(), z.number()).default({ a: 1 }) },
						over: input("items"),
						onReenter: resume(t`Redo ${key()}: ${item()}`),
						initial: "work",
						states: {
							work: { kind: "state", action: agent("worker"), transitions: { OK: "done" } },
							done: final(),
						},
						onDone: "gate",
					},
					gate: {
						kind: "state",
						action: agent("gate", { reply: z.object({ items: z.record(z.string(), z.number()) }) }),
						transitions: { AGAIN: { target: "items", input: { items: event("items") } }, PASS: "done" },
					},
					done: final(),
				},
			}),
		);
		if (!parsed.ok) {
			throw new Error("test chart should be valid");
		}
		const events: MachineEvent[] = [];
		const workerEffects: Extract<Effect, { kind: "agent" }>[] = [];
		let gateRuns = 0;
		const runtime = new MockRuntime({
			ast: parsed.ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent" && effect.actionUid.state.endsWith(".work")) {
						workerEffects.push(effect);
						events.push({ kind: "agent", effectId: effect.id, outcome: { kind: "completed", event: { type: "OK" } } });
					}
					if (effect.kind === "agent" && effect.actionUid.state === "gate") {
						gateRuns += 1;
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: {
								kind: "completed",
								event: gateRuns === 1 ? { type: "AGAIN", output: { items: { a: 2, b: 3 } } } : { type: "PASS" },
							},
						});
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(workerEffects.map((effect) => [effect.actionUid.state, effect.resume?.message])).toEqual([
			["items#a.work", undefined],
			["items#a.work", "Redo a: 2"],
			["items#b.work", undefined],
		]);
	});

	it("resume requests can carry a replayed session reference", async () => {
		const parsed = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "reenter-session-chart",
				initial: "work",
				states: {
					work: {
						kind: "state",
						action: agent("worker", { reentry: { resume: "Continue from prior context." } }),
						transitions: { DONE: "gate" },
					},
					gate: { kind: "state", action: agent("gate"), transitions: { AGAIN: "work" } },
				},
			}),
		);
		if (!parsed.ok) {
			throw new Error("test chart should be valid");
		}
		const uid = actionUid(parsed.ast, "work");
		const gateUid = actionUid(parsed.ast, "gate");
		const logs: DurableLogRecord[] = [
			invoke(uid, 1),
			complete(uid, "DONE", 2),
			{ type: "session_ref", index: 0, file: "sessions/work.jsonl", actionUid: uid, ...meta(3) },
			invoke(gateUid, 4),
			complete(gateUid, "AGAIN", 5),
			invoke(uid, 6),
		];
		const runtime = new MockRuntime({ ast: parsed.ast, logs, events: [] });

		await expect(loop(runtime)).rejects.toThrow("Event queue closed before reaching a final state");

		const workEffect = runtime.effectBatches
			.flat()
			.find((effect) => effect.kind === "agent" && effect.actionUid.state === "work");
		expect(workEffect).toMatchObject({
			kind: "agent",
			id: "reenter-session-chart:work:agent:2:6",
			resume: { message: "Continue from prior context.", session: "sessions/work.jsonl" },
		});
	});

	it("validation retries keep the same visit() value", async () => {
		const parsed = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "visit-validation-chart",
				initial: "writer",
				states: {
					writer: {
						kind: "state",
						action: agent("writer", {
							artifacts: { out: artifact(t`out/${visit()}.json`) },
							validation: { guard: tsImport("./checks.js", "testsPass"), onFail: { nudge: 0, restart: 1 } },
						}),
						transitions: { DONE: "done" },
					},
					done: final(),
					failed: failed(),
				},
			}),
		);
		if (!parsed.ok) {
			throw new Error("test chart should be valid");
		}
		const events: MachineEvent[] = [];
		const writerPaths: string[] = [];
		const verdicts: GuardOutcome[] = [{ ok: false, reason: "try again" }, true];
		const runtime = new MockRuntime({
			ast: parsed.ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent" && effect.actionUid.state === "writer") {
						writerPaths.push(effect.artifacts?.[0]?.path ?? "");
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: { kind: "completed", event: { type: "DONE" } },
						});
					}
					if (effect.kind === "validate") {
						const outcome = verdicts.shift();
						if (outcome === undefined) {
							throw new Error("unexpected validate effect");
						}
						events.push({ kind: "validated", effectId: effect.id, outcome });
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(writerPaths).toEqual(["out/1.json", "out/1.json"]);
	});

	it("runs a script action as an honest command step", async () => {
		const parsed = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "cmd-chart",
				initial: "plan",
				states: {
					plan: { kind: "state", action: agent("planner"), transitions: { PLAN_READY: "normalize" } },
					normalize: {
						kind: "state",
						action: script("python3", ["bin/normalize.py"], {
							env: { ARTIFACTS_DIR: t`${result("plan", "dir")}`, TOPIC: t`${arg("topic")}` },
							artifacts: { evidence: t`${result("plan", "dir")}/evidence.json` },
						}),
						transitions: { NORMALIZED: "consume" },
					},
					consume: {
						kind: "state",
						// a script consuming another step's artifact: the path arrives as a rendered env var;
						// with select, the runtime resolves the field's VALUE at spawn
						action: script("python3", ["bin/consume.py"], {
							env: {
								EVIDENCE: artifactOf("normalize"),
								THRESHOLD: artifactOf("normalize", { select: "threshold" }),
							},
						}),
						transitions: { CONSUMED: "read" },
					},
					read: {
						kind: "state",
						action: agent("reader", { reads: [artifactOf("normalize")] }),
						transitions: { DONE: "done" },
					},
					done: final(),
				},
			}),
		);
		if (!parsed.ok) {
			throw new Error("test chart should be valid");
		}
		const events: MachineEvent[] = [];
		let scriptEffect: unknown;
		let consumeEffect: unknown;
		let readerReads: unknown;
		const runtime = new MockRuntime({
			ast: parsed.ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						readerReads = effect.reads;
						const reply =
							effect.actionUid.state === "plan"
								? { type: "PLAN_READY", output: { dir: "artifacts" } }
								: { type: "DONE" };
						events.push({ kind: "agent", effectId: effect.id, outcome: { kind: "completed", event: reply } });
					}
					if (effect.kind === "script") {
						if (effect.actionUid.state === "normalize") {
							scriptEffect = effect;
						} else {
							consumeEffect = effect;
						}
						// the runtime ran the process and mapped its outcome to a chart event
						const eventType = effect.actionUid.state === "normalize" ? "NORMALIZED" : "CONSUMED";
						events.push({ kind: "script", effectId: effect.id, event: { type: eventType } });
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await start(runtime, { topic: "AI" });

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(scriptEffect).toMatchObject({
			kind: "script",
			command: "python3",
			args: ["bin/normalize.py"],
			env: { ARTIFACTS_DIR: "artifacts", TOPIC: "AI" },
			artifacts: [{ name: "evidence", path: "artifacts/evidence.json" }],
			events: ["NORMALIZED"],
		});
		const records = runtime.effectBatches
			.flat()
			.flatMap((effect) => (effect.kind === "durable_records" ? [...effect.records] : []));
		expect(
			records.find(
				(record) =>
					record.type === "state_action" && record.kind === "invoke" && record.actionUid.state === "normalize",
			),
		).not.toHaveProperty("invocation");
		// a script consuming that artifact gets the path as env; a selected field arrives as a
		// late-bound read the runtime resolves at spawn
		expect(consumeEffect).toMatchObject({
			env: {
				EVIDENCE: "artifacts/evidence.json",
				THRESHOLD: { path: "artifacts/evidence.json", select: "threshold" },
			},
		});
		// and an agent reads the same artifact through its own channel
		expect(readerReads).toEqual([{ name: "evidence", sourceState: "normalize", path: "artifacts/evidence.json" }]);
	});

	it("rejects a non-primitive interpolation at the effect boundary", async () => {
		const parsed = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "boundary-chart",
				initial: "plan",
				states: {
					plan: { kind: "state", action: agent("planner"), transitions: { PLAN_READY: "build" } },
					build: {
						kind: "state",
						// untyped ref: the object slips past TS but must not slip past the renderer
						action: agent("builder", { task: t`Build from ${result("plan")}` }),
						transitions: { BUILT: "done" },
					},
					done: final(),
				},
			}),
		);
		if (!parsed.ok) {
			throw new Error("test chart should be valid");
		}
		const events: MachineEvent[] = [];
		const runtime = new MockRuntime({
			ast: parsed.ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: { kind: "completed", event: { type: "PLAN_READY", output: { steps: [] } } },
						});
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		await expect(loop(runtime)).rejects.toThrow(
			"result of 'plan' resolved to a non-primitive value; wrap the ref in json()",
		);
	});

	it("start over a non-empty log resumes without reseeding args", async () => {
		const ast = linearAst();
		const events: MachineEvent[] = [];
		const runtime = new MockRuntime({
			ast,
			logs: [invoke(actionUid(ast))],
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: { kind: "completed", event: { type: "DONE" } },
						});
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await start(runtime, { topic: "ignored" });

		expect(state.projection.activeLeaves).toEqual(["done"]);
		const records = runtime.effectBatches
			.flat()
			.flatMap((effect) => (effect.kind === "durable_records" ? [...effect.records] : []));
		expect(records.filter((record) => record.type === "args")).toEqual([]);
	});

	it("resolves the same input after a restart, reading args from the log", async () => {
		const parsed = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "restart-chart",
				initial: "plan",
				states: {
					plan: { kind: "state", action: agent("planner"), transitions: { PLAN_READY: "build" } },
					build: {
						kind: "state",
						action: agent("builder", { task: t`Build ${arg("topic")} from plan ${result("plan")}` }),
						transitions: { BUILT: "done" },
					},
					done: final(),
				},
			}),
		);
		if (!parsed.ok) {
			throw new Error("test chart should be valid");
		}
		const ast = parsed.ast;
		const planUid = actionUid(ast, "plan");
		const buildUid = actionUid(ast, "build");
		// The process died while build's agent was running; note: no loadArgs on this runtime —
		// the args come from the log alone.
		const logs: DurableLogRecord[] = [
			{ type: "args", args: { topic: "AI report" }, ...meta(1) },
			invoke(planUid, 2),
			{
				type: "state_action",
				kind: "complete",
				actionUid: planUid,
				event: { type: "PLAN_READY", output: 42 },
				...meta(3),
			},
			invoke(buildUid, 4),
		];
		const events: MachineEvent[] = [];
		let buildTask: unknown;
		const runtime = new MockRuntime({
			ast,
			logs,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						buildTask = effect.task;
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: { kind: "completed", event: { type: "BUILT" } },
						});
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(buildTask).toBe("Build AI report from plan 42");
	});

	it("throws when the machine reports an error output", async () => {
		const ast = linearAst();
		const events: MachineEvent[] = [
			{
				kind: "agent",
				effectId: "test-chart:start:agent:1:1",
				outcome: { kind: "completed", event: { type: "NOPE" } },
			},
		];
		const runtime = new MockRuntime({ ast, logs: [invoke(actionUid(ast))], events });

		await expect(loop(runtime)).rejects.toThrow("No transition found for event type NOPE");
	});

	it("ignores a completion for an action that is not pending", async () => {
		const ast = linearAst();
		// A parseable effect id that matches no pending action: a completion that lost a race.
		const events: MachineEvent[] = [
			{
				kind: "agent",
				effectId: "test-chart:other:agent:1:7",
				outcome: { kind: "completed", event: { type: "DONE" } },
			},
		];
		const runtime = new MockRuntime({ ast, logs: [invoke(actionUid(ast))], events });

		await expect(loop(runtime)).rejects.toThrow("Event queue closed before reaching a final state");

		expect(runtime.effectBatches.flat().filter((effect) => effect.kind === "durable_records")).toEqual([]);
	});

	it("dispatches a deadline timer alongside the agent effect", async () => {
		const ast = afterAst();
		const uid = actionUid(ast, "work");
		const runtime = new MockRuntime({ ast, logs: [invoke(uid)], events: [] });

		await expect(loop(runtime)).rejects.toThrow("Event queue closed before reaching a final state");

		expect(runtime.effectBatches[0]).toEqual([
			expect.objectContaining({ kind: "agent", actionUid: uid }),
			expect.objectContaining({
				kind: "timer",
				id: "timed-chart:work:agent:1:1",
				actionUid: uid,
				// invoke fact's timestamp (1) + delayMs (500)
				firesAt: 501,
			}),
		]);
	});

	it("records the expiry, cancels the agent and transitions when the timer fires", async () => {
		const ast = afterAst();
		const uid = actionUid(ast, "work");
		const events: MachineEvent[] = [];
		const cancels: Extract<Effect, { kind: "cancel" }>[] = [];
		const runtime = new MockRuntime({
			ast,
			logs: [invoke(uid)],
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					// The agent effect is left hanging: the worker never answers.
					if (effect.kind === "timer") {
						events.push({ kind: "timer", effectId: effect.id });
					}
					if (effect.kind === "cancel") {
						cancels.push(effect);
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["escalated"]);
		expect(cancels).toEqual([expect.objectContaining({ kind: "cancel", actionUid: uid })]);
		const records = runtime.effectBatches
			.flat()
			.flatMap((effect) => (effect.kind === "durable_records" ? [...effect.records] : []));
		expect(records.map((record) => (record.type === "state_action" ? record.kind : record.type))).toEqual([
			"timer_fired",
		]);
	});

	it("ignores a stale timer from an earlier round", async () => {
		const ast = afterAst();
		const uid = actionUid(ast, "work");
		const events: MachineEvent[] = [{ kind: "timer", effectId: "timed-chart:work:agent:1:99" }];
		const runtime = new MockRuntime({
			ast,
			logs: [invoke(uid)],
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: { kind: "completed", event: { type: "DONE" } },
						});
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(runtime.effectBatches.flat().filter((effect) => effect.kind === "cancel")).toEqual([]);
	});

	it("ignores a completion that lost the race to the timer", async () => {
		const ast = afterAst({ kind: "state", action: agent("escalation-handler"), transitions: { HANDLED: "done" } });
		const uid = actionUid(ast, "work");
		const events: MachineEvent[] = [];
		let workEffectId = "";
		const runtime = new MockRuntime({
			ast,
			logs: [invoke(uid)],
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent" && effect.actionUid.state === "work") {
						// The worker hangs; remember its id to complete it too late.
						workEffectId = effect.id;
					}
					if (effect.kind === "agent" && effect.actionUid.state === "escalated") {
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: { kind: "completed", event: { type: "HANDLED" } },
						});
					}
					if (effect.kind === "timer") {
						events.push({ kind: "timer", effectId: effect.id });
					}
					if (effect.kind === "cancel") {
						// The killed worker manages to report a completion after losing the race.
						events.push({
							kind: "agent",
							effectId: workEffectId,
							outcome: { kind: "completed", event: { type: "DONE" } },
						});
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["done"]);
		const records = runtime.effectBatches
			.flat()
			.flatMap((effect) => (effect.kind === "durable_records" ? [...effect.records] : []));
		// The worker's late DONE left no trace: only the expiry and the escalation run are logged.
		expect(
			records.map((record) =>
				record.type === "state_action" ? `${record.kind}:${record.actionUid.state}` : record.type,
			),
		).toEqual(["timer_fired:work", "invoke:escalated", "complete:escalated"]);
	});

	it("ignores late duplicate user replies after the timer wins", async () => {
		const parsed = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "timed-user-chart",
				initial: "work",
				states: {
					work: {
						kind: "state",
						action: user({ prompt: "Approve?", options: ["APPROVED"] }),
						after: { delayMs: 500, target: "escalated" },
						transitions: { APPROVED: "done" },
					},
					escalated: { kind: "state", action: agent("escalation-handler"), transitions: { HANDLED: "done" } },
					done: final(),
				},
			}),
		);
		if (!parsed.ok) {
			throw new Error("timed user chart should be valid");
		}
		const ast = parsed.ast;
		const uid = actionUid(ast, "work");
		const events: MachineEvent[] = [];
		const runtime = new MockRuntime({
			ast,
			logs: [invoke(uid)],
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent" && effect.actionUid.state === "escalated") {
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: { kind: "completed", event: { type: "HANDLED" } },
						});
					}
					if (effect.kind === "timer") {
						events.push({ kind: "timer", effectId: effect.id });
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);
		expect(state.projection.activeLeaves).toEqual(["done"]);
		const records = runtime.effectBatches
			.flat()
			.flatMap((effect) => (effect.kind === "durable_records" ? [...effect.records] : []));
		expect(
			records.map((record) =>
				record.type === "state_action" ? `${record.kind}:${record.actionUid.state}` : record.type,
			),
		).toEqual(["user_interaction", "timer_fired:work", "invoke:escalated", "complete:escalated"]);
	});

	it("replays a timer expiry without waiting", async () => {
		const ast = afterAst();
		const uid = actionUid(ast, "work");
		const runtime = new MockRuntime({
			ast,
			logs: [invoke(uid, 1), timerFired(uid, 2)],
			events: failOnPullEvents(),
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["escalated"]);
		expect(runtime.effectBatches).toEqual([]);
	});

	it("drills down to the initial leaf and completes the compound through onDone", async () => {
		const ast = compoundAst();
		const events: MachineEvent[] = [];
		const sequence: string[] = [];
		const runtime = new MockRuntime({
			ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						sequence.push(`agent:${effect.actionUid.state}`);
						events.push({ kind: "agent", effectId: effect.id, outcome: { kind: "completed", event: { type: "OK" } } });
					}
					if (effect.kind === "durable_records") {
						for (const record of effect.records) {
							if (record.type === "state_action") {
								sequence.push(`${record.kind}:${record.actionUid.state}`);
							}
						}
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);

		// fix's OK lands on the nested final `verified`; the projection immediately exits the
		// compound through onDone — nothing extra is logged, no state is visited in between.
		expect(state.projection.activeLeaves).toEqual(["deploy"]);
		expect(sequence).toEqual([
			"invoke:review.analyze",
			"agent:review.analyze",
			"complete:review.analyze",
			"invoke:review.fix",
			"agent:review.fix",
			"complete:review.fix",
		]);
	});

	it("tells the agent which completion events the machine will accept", async () => {
		const ast = compoundAst();
		const runtime = new MockRuntime({ ast, logs: [invoke(actionUid(ast, "review.analyze"))], events: [] });

		await expect(loop(runtime)).rejects.toThrow("Event queue closed before reaching a final state");

		const [agentEffect] = runtime.effectBatches.flat().filter((effect) => effect.kind === "agent");
		// Reserved FAILED is runtime-only and is never advertised as an authored route.
		expect(agentEffect?.events).toEqual(["OK", "ESCALATE"]);
	});

	it("bubbles an unhandled event to the ancestor's handler", async () => {
		const ast = compoundAst();
		const events: MachineEvent[] = [];
		const runtime = new MockRuntime({
			ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						// analyze has no local route; the compound catches this domain event.
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: { kind: "completed", event: { type: "ESCALATE" } },
						});
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["escalate"]);
	});

	it("replays a hierarchical log without re-running agents", async () => {
		const ast = compoundAst();
		const analyze = actionUid(ast, "review.analyze");
		const fix = actionUid(ast, "review.fix");
		const runtime = new MockRuntime({
			ast,
			logs: [invoke(analyze, 1), complete(analyze, "OK", 2), invoke(fix, 3), complete(fix, "OK", 4)],
			events: failOnPullEvents(),
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["deploy"]);
		expect(runtime.effectBatches).toEqual([]);
	});

	it("runs all parallel regions concurrently and joins through onDone", async () => {
		const ast = parallelAst();
		const events: MachineEvent[] = [];
		const invoked: string[] = [];
		const runtime = new MockRuntime({
			ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						invoked.push(effect.actionUid.state);
						events.push({ kind: "agent", effectId: effect.id, outcome: { kind: "completed", event: { type: "OK" } } });
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["merge"]);
		expect(invoked.sort()).toEqual(["audit.perf.scan", "audit.security.scan"]);
		expect(state.projection.pendingActions).toEqual([]);
	});

	it("aborts all regions and cancels their agents when an event exits the parallel", async () => {
		const ast = parallelAst();
		const events: MachineEvent[] = [];
		const cancels: Extract<Effect, { kind: "cancel" }>[] = [];
		const runtime = new MockRuntime({
			ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent" && effect.actionUid.state === "audit.security.scan") {
						// security raises a domain abort; perf's agent keeps hanging and must be killed.
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: { kind: "completed", event: { type: "ESCALATE" } },
						});
					}
					if (effect.kind === "cancel") {
						cancels.push(effect);
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["escalate"]);
		expect(cancels).toEqual([
			expect.objectContaining({ kind: "cancel", actionUid: actionUid(ast, "audit.perf.scan") }),
		]);
	});

	it("replays a parallel log without re-running agents", async () => {
		const ast = parallelAst();
		const security = actionUid(ast, "audit.security.scan");
		const perf = actionUid(ast, "audit.perf.scan");
		const runtime = new MockRuntime({
			ast,
			// Region facts interleave in log order; the join fires when the last one lands.
			logs: [invoke(security, 1), invoke(perf, 2), complete(perf, "OK", 3), complete(security, "OK", 4)],
			events: failOnPullEvents(),
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["merge"]);
		expect(runtime.effectBatches).toEqual([]);
	});

	it("does not race validation against the deadline", async () => {
		const result = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "timed-chart",
				initial: "work",
				states: {
					work: {
						kind: "state",
						action: agent("coder", { validation: { guard: tsImport("./checks.js", "testsPass") } }),
						after: { delayMs: 500, target: "escalated" },
						transitions: { DONE: "done" },
					},
					done: final(),
					escalated: final(),
				},
			}),
		);
		if (!result.ok) {
			throw new Error("test chart should be valid");
		}
		const ast = result.ast;
		const uid = actionUid(ast, "work");
		const events: MachineEvent[] = [];
		const runtime = new MockRuntime({
			ast,
			logs: [invoke(uid)],
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: { kind: "completed", event: { type: "DONE" } },
						});
					}
					if (effect.kind === "validate") {
						events.push({ kind: "validated", effectId: effect.id, outcome: true });
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["done"]);
		// One timer for the running phase; validation is not raced against the clock.
		expect(runtime.effectBatches.flat().filter((effect) => effect.kind === "timer")).toHaveLength(1);
	});

	it("spawns an instance per key, pins the items and joins through onDone", async () => {
		const ast = mapAst();
		const events: MachineEvent[] = [];
		const tasks: string[] = [];
		const runtime = new MockRuntime({
			ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent" && effect.actionUid.state === "plan") {
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: { kind: "completed", event: { type: "OK", output: PLAN_OUTPUT } },
						});
					}
					if (effect.kind === "agent" && effect.actionUid.state !== "plan") {
						tasks.push(effect.task ?? "");
						events.push({ kind: "agent", effectId: effect.id, outcome: { kind: "completed", event: { type: "OK" } } });
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(tasks.sort()).toEqual(["Write body: Body", "Write intro: Intro"]);
		expect(state.projection.spawns.chapters).toEqual(PLAN_OUTPUT.chapters);
		const spawned = (await runtime.loadLogs()).find((record) => record.type === "spawned");
		expect(spawned).toMatchObject({ path: "chapters", instances: PLAN_OUTPUT.chapters });
	});

	it("gates instance starts by the map's concurrency", async () => {
		const ast = mapAst(1);
		const events: MachineEvent[] = [];
		const batches: string[][] = [];
		const runtime = new MockRuntime({
			ast,
			events,
			onRunEffects(effects) {
				const instances = effects
					.filter((effect): effect is Extract<Effect, { kind: "agent" }> => effect.kind === "agent")
					.map((effect) => effect.actionUid.state)
					.filter((state) => state.includes("#"));
				if (instances.length > 0) {
					batches.push(instances);
				}
				for (const effect of effects) {
					if (effect.kind === "agent") {
						const output = effect.actionUid.state === "plan" ? { output: PLAN_OUTPUT } : {};
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: { kind: "completed", event: { type: "OK", ...output } },
						});
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["done"]);
		// One instance at a time, in canonical spawn-key order — the second starts only
		// after the first completes.
		expect(batches).toEqual([["chapters#body.author"], ["chapters#intro.author"]]);
	});

	it("aborts all instances and cancels their agents when an event exits the map", async () => {
		const ast = mapAst();
		const events: MachineEvent[] = [];
		const cancels: string[] = [];
		const runtime = new MockRuntime({
			ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent" && effect.actionUid.state === "plan") {
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: { kind: "completed", event: { type: "OK", output: PLAN_OUTPUT } },
						});
					}
					if (effect.kind === "agent" && effect.actionUid.state === "chapters#intro.author") {
						// intro raises a domain abort; body's agent keeps hanging and must be killed.
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: { kind: "completed", event: { type: "ESCALATE" } },
						});
					}
					if (effect.kind === "cancel" && effect.actionUid !== undefined) {
						cancels.push(effect.actionUid.state);
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["escalate"]);
		expect(cancels).toEqual(["chapters#body.author"]);
	});

	it("fans instance artifacts back in: files for agent reads, a JSON path array for script env", async () => {
		const parsed = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "join-chart",
				initial: "plan",
				states: {
					plan: {
						kind: "state",
						action: agent("planner"),
						transitions: { OK: "chapters" },
					},
					chapters: map({
						over: result("plan", "chapters"),
						initial: "author",
						onDone: "gather",
						states: {
							author: {
								kind: "state",
								action: agent("author", {
									artifacts: { chapter: artifact(t`out/${key()}.json`, z.object({ prose: z.string() })) },
								}),
								transitions: { OK: "written" },
							},
							written: final(),
						},
					}),
					gather: {
						kind: "state",
						action: agent("editor", { reads: [joinArtifactOf("chapters.author")] }),
						transitions: { OK: "pack" },
					},
					pack: {
						kind: "state",
						action: script("tar", [], { env: { FILES: joinArtifactOf("chapters.author") } }),
						transitions: { OK: "done" },
					},
					done: final(),
				},
			}),
		);
		if (!parsed.ok) {
			throw new Error(`test chart should be valid: ${JSON.stringify(parsed.diagnostics)}`);
		}
		const ast = parsed.ast;
		const events: MachineEvent[] = [];
		let reads: readonly { path: string }[] = [];
		let files = "";
		const runtime = new MockRuntime({
			ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent" && effect.actionUid.state === "plan") {
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: { kind: "completed", event: { type: "OK", output: { chapters: PLAN_OUTPUT.chapters } } },
						});
					} else if (effect.kind === "agent") {
						if (effect.actionUid.state === "gather") {
							reads = effect.reads ?? [];
						}
						events.push({ kind: "agent", effectId: effect.id, outcome: { kind: "completed", event: { type: "OK" } } });
					}
					if (effect.kind === "script") {
						files = typeof effect.env?.FILES === "string" ? effect.env.FILES : "";
						events.push({ kind: "script", effectId: effect.id, event: { type: "OK" } });
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["done"]);
		// One artifact per spawned instance, in replay-stable canonical key order.
		expect(reads.map((read) => read.path)).toEqual(["out/body.json", "out/intro.json"]);
		expect(files).toBe(JSON.stringify(["out/body.json", "out/intro.json"]));
	});

	it("fans mapped action results into one JSON script environment value", async () => {
		const parsed = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "join-result-chart",
				initial: "plan",
				states: {
					plan: {
						kind: "state",
						action: agent("planner", { reply: z.object({ chapters: z.record(z.string(), z.string()) }) }),
						transitions: { OK: "samples" },
					},
					samples: map({
						over: result("plan", "chapters"),
						initial: "sample",
						onDone: "aggregate",
						states: {
							sample: {
								kind: "state",
								action: agent("sampler", { reply: z.object({ belief: z.string() }) }),
								transitions: { OK: "done" },
							},
							done: final(),
						},
					}),
					aggregate: {
						kind: "state",
						action: script("aggregate", [], {
							env: { BELIEFS: joinResultOf("samples.sample", { path: "belief" }) },
						}),
						transitions: { OK: "done" },
					},
					done: final(),
				},
			}),
		);
		if (!parsed.ok) {
			throw new Error(`test chart should be valid: ${JSON.stringify(parsed.diagnostics)}`);
		}
		const events: MachineEvent[] = [];
		let beliefs = "";
		const runtime = new MockRuntime({
			ast: parsed.ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						const output =
							effect.actionUid.state === "plan"
								? {
										chapters: {
											"9007199254740993": "large-second",
											"9007199254740992": "large-first",
											z: "last",
											a: "first",
										},
									}
								: {
										belief: effect.actionUid.state.includes("#9007199254740992")
											? "large-first"
											: effect.actionUid.state.includes("#9007199254740993")
												? "large-second"
												: effect.actionUid.state.includes("#a")
													? "first"
													: "last",
									};
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: { kind: "completed", event: { type: "OK", output } },
						});
					}
					if (effect.kind === "script") {
						beliefs = typeof effect.env?.BELIEFS === "string" ? effect.env.BELIEFS : "";
						events.push({ kind: "script", effectId: effect.id, event: { type: "OK" } });
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);
		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(beliefs).toBe(JSON.stringify(["large-first", "large-second", "first", "last"]));

		// PostgreSQL JSONB canonicalizes object keys. Re-enter immediately before
		// aggregation with that decoded key order and verify the joined value is
		// identical to the live execution.
		const liveLogs = await runtime.loadLogs();
		const aggregateInvoke = liveLogs.findIndex(
			(record) => record.type === "state_action" && record.kind === "invoke" && record.actionUid.state === "aggregate",
		);
		expect(aggregateInvoke).toBeGreaterThan(0);
		const persistedPrefix = liveLogs.slice(0, aggregateInvoke).map((record) =>
			record.type === "spawned"
				? {
						...record,
						instances: Object.fromEntries(
							Object.entries(record.instances).sort(([left], [right]) => left.localeCompare(right)),
						),
					}
				: record,
		);
		const replayEvents: MachineEvent[] = [];
		let replayedBeliefs = "";
		const replay = new MockRuntime({
			ast: parsed.ast,
			logs: persistedPrefix,
			events: replayEvents,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "script") {
						replayedBeliefs = typeof effect.env?.BELIEFS === "string" ? effect.env.BELIEFS : "";
						replayEvents.push({ kind: "script", effectId: effect.id, event: { type: "OK" } });
					}
					if (effect.kind === "durable_records") {
						replayEvents.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});
		await loop(replay);
		expect(replayedBeliefs).toBe(beliefs);
	});

	it("joins nested-map artifacts within the current outer-map instance", async () => {
		const parsed = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "nested-join-chart",
				initial: "plan",
				states: {
					plan: {
						kind: "state",
						action: agent("planner"),
						transitions: { OK: "sections" },
					},
					sections: map({
						over: result("plan", "sections"),
						initial: "items",
						onDone: "done",
						states: {
							items: map({
								over: item("items"),
								initial: "produce",
								onDone: "gather",
								states: {
									produce: {
										kind: "state",
										action: agent("producer", {
											artifacts: {
												output: artifact(t`out/${key()}.json`),
											},
										}),
										transitions: { OK: "written" },
									},
									written: final(),
								},
							}),
							gather: {
								kind: "state",
								action: script("gather", [], {
									env: { FILES: joinArtifactOf("sections.items.produce") },
								}),
								transitions: { OK: "finished" },
							},
							finished: final(),
						},
					}),
					done: final(),
				},
			}),
		);
		if (!parsed.ok) {
			throw new Error(`test chart should be valid: ${JSON.stringify(parsed.diagnostics)}`);
		}
		const ast = parsed.ast;
		const events: MachineEvent[] = [];
		const joined = new Map<string, string>();
		const runtime = new MockRuntime({
			ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent" && effect.actionUid.state === "plan") {
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: {
								kind: "completed",
								event: {
									type: "OK",
									output: {
										sections: {
											a: { items: { x: {}, y: {} } },
											b: { items: { z: {} } },
										},
									},
								},
							},
						});
					} else if (effect.kind === "agent") {
						events.push({ kind: "agent", effectId: effect.id, outcome: { kind: "completed", event: { type: "OK" } } });
					}
					if (effect.kind === "script") {
						joined.set(effect.actionUid.state, typeof effect.env?.FILES === "string" ? effect.env.FILES : "");
						events.push({ kind: "script", effectId: effect.id, event: { type: "OK" } });
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(joined.get("sections#a.gather")).toBe(JSON.stringify(["out/x.json", "out/y.json"]));
		expect(joined.get("sections#b.gather")).toBe(JSON.stringify(["out/z.json"]));
	});

	it("replays a map log without re-running agents", async () => {
		const ast = mapAst();
		const planUid = actionUid(ast, "plan");
		const instanceUid = (key: string) => ({ ...actionUid(ast, "chapters.author"), state: `chapters#${key}.author` });
		const logs: DurableLogRecord[] = [
			invoke(planUid, 1),
			{
				type: "state_action",
				kind: "complete",
				actionUid: planUid,
				event: { type: "OK", output: PLAN_OUTPUT },
				...meta(2),
			},
			{ type: "spawned", path: "chapters", instances: PLAN_OUTPUT.chapters, ...meta(3) },
			invoke(instanceUid("intro"), 4),
			invoke(instanceUid("body"), 5),
			complete(instanceUid("intro"), "OK", 6),
			complete(instanceUid("body"), "OK", 7),
		];
		const runtime = new MockRuntime({ ast, logs, events: failOnPullEvents() });

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(state.projection.spawns.chapters).toEqual(PLAN_OUTPUT.chapters);
	});

	it("atomically appends ordered emits after an accepted completion, including self result()", async () => {
		const parsed = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "emit-chart",
				initial: "work",
				states: {
					work: {
						kind: "state",
						action: agent("worker", { reply: z.object({ id: z.string() }) }),
						emit: [
							emit({ event: "work.completed", payload: { id: result("work", "id") } }),
							emit({ event: "audit.recorded", payload: { order: 2 } }),
						],
						transitions: { OK: "done" },
					},
					done: final(),
				},
			}),
		);
		if (!parsed.ok) {
			throw new Error(JSON.stringify(parsed.diagnostics));
		}
		const events: MachineEvent[] = [];
		const completionBatches: (readonly DurableRecordDraft[])[] = [];
		const runtime = new MockRuntime({
			ast: parsed.ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: { kind: "completed", event: { type: "OK", output: { id: "result-7" } } },
						});
					}
					if (effect.kind === "durable_records") {
						if (effect.records.some((record) => record.type === "state_action" && record.kind === "complete")) {
							completionBatches.push(effect.records);
						}
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		const state = await loop(runtime);

		expect(state.projection.activeLeaves).toEqual(["done"]);
		expect(completionBatches).toHaveLength(1);
		expect(completionBatches[0]).toEqual([
			expect.objectContaining({
				type: "state_action",
				kind: "complete",
				event: { type: "OK", output: { id: "result-7" } },
			}),
			expect.objectContaining({ type: "emit", event: "work.completed", payload: { id: "result-7" } }),
			expect.objectContaining({ type: "emit", event: "audit.recorded", payload: { order: 2 } }),
		]);
	});

	it("emits atomically with a positive validation verdict", async () => {
		const parsed = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "validated-emit-chart",
				initial: "work",
				states: {
					work: {
						kind: "state",
						action: agent("worker", { validation: { guard: tsImport("./guard.js", "accept") } }),
						emit: [emit({ event: "validated", payload: { id: result("work", "id") } })],
						transitions: { OK: "done" },
					},
					done: final(),
				},
			}),
		);
		if (!parsed.ok) {
			throw new Error(JSON.stringify(parsed.diagnostics));
		}
		const events: MachineEvent[] = [];
		const verdictBatches: (readonly DurableRecordDraft[])[] = [];
		const runtime = new MockRuntime({
			ast: parsed.ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: { kind: "completed", event: { type: "OK", output: { id: "v-1" } } },
						});
					}
					if (effect.kind === "validate") {
						events.push({ kind: "validated", effectId: effect.id, outcome: true });
					}
					if (effect.kind === "durable_records") {
						if (effect.records.some((record) => record.type === "state_action" && record.kind === "validated")) {
							verdictBatches.push(effect.records);
						}
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		await loop(runtime);
		expect(verdictBatches).toHaveLength(1);
		expect(verdictBatches[0]).toEqual([
			expect.objectContaining({ type: "state_action", kind: "validated", outcome: true }),
			expect.objectContaining({ type: "emit", event: "validated", payload: { id: "v-1" } }),
		]);
	});

	it("does not emit for rejected validation claims", async () => {
		const parsed = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "rejected-emit-chart",
				initial: "work",
				states: {
					work: {
						kind: "state",
						action: agent("worker", { validation: { guard: tsImport("./guard.js", "reject") } }),
						emit: [emit({ event: "must.not.happen", payload: {} })],
						transitions: { OK: "done" },
					},
					done: final(),
				},
			}),
		);
		if (!parsed.ok) {
			throw new Error(JSON.stringify(parsed.diagnostics));
		}
		const events: MachineEvent[] = [];
		const runtime = new MockRuntime({
			ast: parsed.ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						events.push({ kind: "agent", effectId: effect.id, outcome: { kind: "completed", event: { type: "OK" } } });
					}
					if (effect.kind === "validate") {
						events.push({ kind: "validated", effectId: effect.id, outcome: { ok: false, reason: "not accepted" } });
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		await loop(runtime);
		expect((await runtime.loadLogs()).filter((record) => record.type === "emit")).toEqual([]);
	});

	it("does not emit for invalid completion events", async () => {
		const parsed = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "invalid-event-emit-chart",
				initial: "work",
				states: {
					work: {
						kind: "state",
						action: agent("worker"),
						emit: [emit({ event: "must.not.happen", payload: {} })],
						transitions: { OK: "done" },
					},
					done: final(),
				},
			}),
		);
		if (!parsed.ok) {
			throw new Error(JSON.stringify(parsed.diagnostics));
		}
		const events: MachineEvent[] = [];
		const runtime = new MockRuntime({
			ast: parsed.ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: { kind: "completed", event: { type: "NOPE" } },
						});
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		await expect(loop(runtime)).rejects.toThrow("No transition found for event type NOPE");
		expect((await runtime.loadLogs()).filter((record) => record.type === "emit")).toEqual([]);
	});

	it("does not emit for failed action outcomes", async () => {
		const parsed = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "failed-emit-chart",
				initial: "work",
				states: {
					work: {
						kind: "state",
						action: agent("worker"),
						emit: [emit({ event: "must.not.happen", payload: {} })],
						transitions: { OK: "done" },
					},
					done: final(),
				},
			}),
		);
		if (!parsed.ok) {
			throw new Error(JSON.stringify(parsed.diagnostics));
		}
		const events: MachineEvent[] = [];
		const runtime = new MockRuntime({
			ast: parsed.ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "agent") {
						events.push({
							kind: "agent",
							effectId: effect.id,
							outcome: { kind: "failed", failure: { kind: "explicit", retryable: false, message: "boom" } },
						});
					}
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		await loop(runtime);
		expect((await runtime.loadLogs()).filter((record) => record.type === "emit")).toEqual([]);
	});

	it("opens gates durably without dispatching an executor effect", async () => {
		const parsed = normalizeChartConfig(
			chart({
				kind: "chart",
				id: "gate-chart",
				initial: "wait",
				states: {
					wait: {
						kind: "state",
						action: gate({ event: "approval.requested", payload: { requestId: "r-1" } }),
						emit: [emit({ event: "approval.resolved", payload: { answer: result("wait", "answer") } })],
						transitions: { APPROVED: "done" },
					},
					done: final(),
				},
			}),
		);
		if (!parsed.ok) {
			throw new Error(JSON.stringify(parsed.diagnostics));
		}
		const events: MachineEvent[] = [];
		const runtime = new MockRuntime({
			ast: parsed.ast,
			events,
			onRunEffects(effects) {
				for (const effect of effects) {
					if (effect.kind === "durable_records") {
						events.push(durableRecordsAdded(effect.records, effect.id));
					}
				}
			},
		});

		await expect(loop(runtime)).rejects.toThrow("Event queue closed before reaching a final state");
		const waiting = await runtime.loadProjection();
		const records = await runtime.loadLogs();
		const opened = records.find((record) => record.type === "gate" && record.kind === "opened");
		expect(opened).toMatchObject({
			type: "gate",
			kind: "opened",
			event: "approval.requested",
			payload: { requestId: "r-1" },
		});
		expect(runtime.effectBatches.flat().some((effect) => effect.kind === "gate")).toBe(false);
		if (opened?.type !== "gate" || opened.kind !== "opened") {
			throw new Error("gate should be open");
		}

		const execution = BranchExecution.fromProjection(parsed.ast, "main", waiting);
		const drafts = await execution.prepareUserInteraction(opened, { type: "APPROVED", output: { answer: "yes" } });
		expect(drafts).toEqual([
			expect.objectContaining({ type: "gate", kind: "resolved", gateSeqId: opened.seqId }),
			expect.objectContaining({ type: "emit", event: "approval.resolved", payload: { answer: "yes" } }),
		]);
	});
});
