import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fromStrictValue, toStrictJsonSchema } from "../packages/hyperchart/src/core/strict_schema.js";
import type { JsonSchema } from "../packages/hyperchart/src/core/types.js";

const Statement = z.string().trim().min(1);
const Plan = z.object({ objective: z.string(), steps: z.string(), deliverables: z.string() });
const Core = z.object({
	title: z.string().min(1).max(72),
	hypothesis: Statement,
	experimentPlan: Plan,
});
const Departure = z
	.strictObject({
		entity: Statement,
		basis: z.discriminatedUnion("source", [
			z.strictObject({ source: z.literal("inspection"), observation: Statement }),
			z.strictObject({ source: z.literal("parent"), hypothesisId: z.string().min(1), entity: Statement }),
		]),
	})
	.refine(({ entity, basis }) => basis.source !== "parent" || entity === basis.entity);
const Batch = z.object({
	candidates: z.array(
		z.discriminatedUnion("kind", [
			Core.extend({ kind: z.literal("discovery").default("discovery") }),
			Core.extend({ kind: z.literal("normality"), normality: z.strictObject({ population: Statement }) }),
			Core.extend({ kind: z.literal("departure"), departure: Departure }),
		]),
	),
});

const STRICT_KEYWORDS = new Set([
	"type",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"anyOf",
	"enum",
	"description",
	"pattern",
	"format",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
]);

// Every node uses only strict keywords, and every object is closed with all properties required.
function strictViolations(node: unknown, path = "$"): string[] {
	if (node === null || typeof node !== "object") {
		return [];
	}
	const schema = node as JsonSchema;
	const violations = Object.keys(schema)
		.filter((key) => !STRICT_KEYWORDS.has(key))
		.map((key) => `${path}: ${key}`);
	if (schema.type === "object") {
		const keys = Object.keys((schema.properties as object | undefined) ?? {});
		if (schema.additionalProperties !== false) {
			violations.push(`${path}: open object`);
		}
		if (JSON.stringify(schema.required) !== JSON.stringify(keys)) {
			violations.push(`${path}: not all properties required`);
		}
	}
	for (const [key, value] of Object.entries((schema.properties as object | undefined) ?? {})) {
		violations.push(...strictViolations(value, `${path}.${key}`));
	}
	for (const [index, variant] of ((schema.anyOf as unknown[] | undefined) ?? []).entries()) {
		violations.push(...strictViolations(variant, `${path}|${index}`));
	}
	return [...violations, ...strictViolations(schema.items, `${path}[]`)];
}

describe("toStrictJsonSchema", () => {
	it("turns a nested discriminated-union batch into the strict subset", () => {
		const strict = toStrictJsonSchema(Batch);
		expect(strictViolations(strict)).toEqual([]);
		const candidates = (strict.properties as Record<string, JsonSchema>).candidates as JsonSchema;
		const variants = (candidates.items as JsonSchema).anyOf as JsonSchema[];
		expect(variants.map((variant) => (variant.properties as Record<string, JsonSchema>).kind)).toEqual([
			{ type: "string", enum: ["discovery"] },
			{ type: "string", enum: ["normality"] },
			{ type: "string", enum: ["departure"] },
		]);
	});

	it("leaves the authored Zod schema and its plain JSON Schema unchanged", () => {
		const before = JSON.stringify(z.toJSONSchema(Batch));
		toStrictJsonSchema(Batch);
		expect(JSON.stringify(z.toJSONSchema(Batch))).toBe(before);
	});

	it("requires optional properties as nullable and keeps nullable ones as they are", () => {
		const strict = toStrictJsonSchema(
			z.object({
				note: z.string().optional(),
				plan: Plan.optional(),
				score: z.number().nullable(),
			}),
		);
		expect(strictViolations(strict)).toEqual([]);
		expect(strict.properties).toEqual({
			note: { anyOf: [{ type: "string" }, { type: "null" }] },
			plan: {
				anyOf: [
					{
						type: "object",
						properties: { objective: { type: "string" }, steps: { type: "string" }, deliverables: { type: "string" } },
						required: ["objective", "steps", "deliverables"],
						additionalProperties: false,
					},
					{ type: "null" },
				],
			},
			score: { type: ["number", "null"] },
		});
	});
});

describe("fromStrictValue", () => {
	const Schema = z.object({
		items: z.array(
			z.discriminatedUnion("kind", [
				z.object({ kind: z.literal("a"), note: z.string().optional() }),
				z.object({ kind: z.literal("b"), score: z.number().nullable(), plan: Plan.optional() }),
			]),
		),
	});
	const original = z.toJSONSchema(Schema) as JsonSchema;

	it("drops nulls written for optional properties so the original schema accepts the value", () => {
		const strictReply = {
			items: [
				{ kind: "a", note: null },
				{ kind: "b", score: null, plan: null },
			],
		};
		expect(Schema.safeParse(strictReply).success).toBe(false);
		const restored = fromStrictValue(strictReply, original);
		expect(restored).toEqual({ items: [{ kind: "a" }, { kind: "b", score: null }] });
		expect(Schema.safeParse(restored).success).toBe(true);
	});

	it("returns values that need no restoration unchanged", () => {
		const reply = {
			items: [
				{ kind: "a", note: "kept" },
				{ kind: "b", score: 1 },
			],
		};
		expect(fromStrictValue(reply, original)).toEqual(reply);
	});
});
