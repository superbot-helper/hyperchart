import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentEffect } from "../packages/hyperchart/src/core/machine.js";
import type { JsonSchema } from "../packages/hyperchart/src/core/types.js";
import { buildFinishSchema, validateFinishParams } from "../packages/hyperchart/src/runtime/generic/finish_protocol.js";
import { markFinishStrict } from "../packages/pi-hyperchart/src/runtime/pi/strict_finish.js";

const Reply = z.object({
	items: z.array(
		z.discriminatedUnion("kind", [
			z.object({ kind: z.literal("a"), title: z.string().max(5), note: z.string().optional() }),
			z.object({ kind: z.literal("b"), score: z.number() }),
		]),
	),
});

function effect(): AgentEffect {
	const actionUid = { chart: "chart", state: "work", action: "worker" };
	return {
		kind: "agent",
		id: "chart:work:worker:1:1",
		actionUid,
		action: { kind: "agent", uid: actionUid, name: "worker", onFail: { nudge: 0, restart: 0 } },
		events: ["DONE", "FAILED"],
		sessionId: "session-id",
		reply: { kind: "jsonSchema", schema: z.toJSONSchema(Reply) as JsonSchema },
	};
}

function output(schema: Record<string, unknown>): JsonSchema {
	return (schema.properties as Record<string, JsonSchema>).output as JsonSchema;
}

describe("strict finish schema", () => {
	it("uses the reply schema unchanged unless strict is requested", () => {
		expect(output(buildFinishSchema(effect()))).toEqual(effect().reply?.schema);
		const strict = output(buildFinishSchema(effect(), { strict: true }));
		const items = (strict.properties as Record<string, JsonSchema>).items as JsonSchema;
		expect(items.items).toMatchObject({ anyOf: [expect.any(Object), expect.any(Object)] });
		expect(JSON.stringify(strict)).not.toMatch(/"(oneOf|const|maxLength|\$schema)"/);
	});

	it("reads strict-mode nulls as absent optional properties and still checks the reply schema", async () => {
		const accepted = await validateFinishParams(effect(), {
			event: "DONE",
			output: { items: [{ kind: "a", title: "short", note: null }] },
		});
		expect(accepted).toEqual({ ok: true, event: { type: "DONE", output: { items: [{ kind: "a", title: "short" }] } } });

		// maxLength is dropped from the strict schema, so only validation can catch it.
		const rejected = await validateFinishParams(effect(), {
			event: "DONE",
			output: { items: [{ kind: "a", title: "far too long", note: null }] },
		});
		expect(rejected.ok).toBe(false);
	});
});

describe("markFinishStrict", () => {
	const parameters = { type: "object" };

	it("marks only finish strict in Chat Completions and Responses payloads", () => {
		const chat = {
			model: "m",
			tools: [
				{ type: "function", function: { name: "read", parameters, strict: true } },
				{ type: "function", function: { name: "datacode", parameters, strict: false } },
				{ type: "function", function: { name: "finish", parameters, strict: false } },
			],
		};
		expect(markFinishStrict(chat)).toEqual({
			model: "m",
			tools: [
				chat.tools[0],
				chat.tools[1],
				{ type: "function", function: { name: "finish", parameters, strict: true } },
			],
		});
		expect(chat.tools[2]?.function.strict).toBe(false);

		const responses = { tools: [{ type: "function", name: "finish", parameters }] };
		expect(markFinishStrict(responses)).toEqual({
			tools: [{ type: "function", name: "finish", parameters, strict: true }],
		});
	});

	it("leaves payloads without a finish function unchanged", () => {
		expect(markFinishStrict({ tools: [{ type: "function", function: { name: "read", parameters } }] })).toBeUndefined();
		expect(markFinishStrict({ messages: [] })).toBeUndefined();
		expect(markFinishStrict("payload")).toBeUndefined();
	});
});
