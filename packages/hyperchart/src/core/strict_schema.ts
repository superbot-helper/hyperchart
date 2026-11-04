import type { JsonSchema } from "./types.js";

// Keywords that strict constrained-decoding modes (OpenAI, DeepSeek) reject or ignore. The
// constraints they carry are still enforced by validating the completion against the original
// schema.
const UNSUPPORTED_KEYWORDS = ["$schema", "minLength", "maxLength", "minItems", "maxItems", "default"] as const;

/**
 * Converts a chart's JSON Schema (the Zod conversion stored in the AST) into the subset accepted
 * by strict tool-call modes: every object property is required, optional properties become
 * nullable, `oneOf` becomes `anyOf`, `const` becomes a one-value `enum`, and unsupported
 * keywords are dropped. The input is not modified. Optional values the model returns as `null`
 * are restored by {@link fromStrictValue}.
 */
export function toStrictJsonSchema(schema: JsonSchema): JsonSchema {
	const node: JsonSchema = { ...schema };
	if (node.oneOf !== undefined) {
		node.anyOf = node.oneOf;
		delete node.oneOf;
	}
	if ("const" in node) {
		node.enum = [node.const];
		delete node.const;
	}
	for (const keyword of UNSUPPORTED_KEYWORDS) {
		delete node[keyword];
	}
	if (Array.isArray(node.anyOf)) {
		node.anyOf = (node.anyOf as JsonSchema[]).map(toStrictJsonSchema);
	}
	if (isSchema(node.items)) {
		node.items = toStrictJsonSchema(node.items);
	}
	const properties = node.properties as Record<string, JsonSchema> | undefined;
	if (properties !== undefined) {
		const required = new Set((node.required as string[] | undefined) ?? []);
		node.properties = Object.fromEntries(
			Object.entries(properties).map(([key, property]) => {
				const strict = toStrictJsonSchema(property);
				return [key, required.has(key) || allowsNull(strict) ? strict : nullable(strict)];
			}),
		);
		node.required = Object.keys(properties);
	}
	return node;
}

function isSchema(value: unknown): value is JsonSchema {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function allowsNull(node: JsonSchema): boolean {
	const types = Array.isArray(node.type) ? node.type : [node.type];
	if (types.includes("null")) {
		return true;
	}
	const variants = (node.anyOf ?? node.oneOf) as JsonSchema[] | undefined;
	return variants?.some(allowsNull) ?? false;
}

function nullable(node: JsonSchema): JsonSchema {
	return { anyOf: [node, { type: "null" }] };
}

/**
 * Removes the `null`s that {@link toStrictJsonSchema} lets the model write for optional
 * properties, guided by the original (non-strict) JSON Schema, so the value can be validated
 * against the original contract.
 */
export function fromStrictValue(value: unknown, schema: JsonSchema): unknown {
	if (Array.isArray(value)) {
		return isSchema(schema.items) ? value.map((item) => fromStrictValue(item, schema.items as JsonSchema)) : value;
	}
	if (value === null || typeof value !== "object") {
		return value;
	}
	const variants = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;
	if (variants !== undefined) {
		const variant = variants.find((candidate) => matchesDiscriminators(value, candidate));
		return variant === undefined ? value : fromStrictValue(value, variant);
	}
	const properties = schema.properties as Record<string, JsonSchema> | undefined;
	if (properties === undefined) {
		return value;
	}
	const required = new Set((schema.required as string[] | undefined) ?? []);
	const restored: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		const property = properties[key];
		if (property === undefined) {
			restored[key] = item;
		} else if (item !== null) {
			restored[key] = fromStrictValue(item, property);
		} else if (required.has(key) || allowsNull(property)) {
			restored[key] = item;
		}
	}
	return restored;
}

// An object variant matches when every property it pins with `const` has that value.
function matchesDiscriminators(value: object, variant: JsonSchema): boolean {
	const properties = variant.properties as Record<string, JsonSchema> | undefined;
	if (variant.type !== "object" || properties === undefined) {
		return false;
	}
	return Object.entries(properties).every(
		([key, property]) => !("const" in property) || (value as Record<string, unknown>)[key] === property.const,
	);
}
