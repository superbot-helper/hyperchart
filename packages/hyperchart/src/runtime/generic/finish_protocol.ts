import type { ChartEvent } from "../../core/types.js";
import type { AgentEffect } from "../../core/machine.js";
import type { SchemaRegistryLike as SchemaRegistry } from "../../core/schema_registry.js";
import { fromStrictValue, toStrictJsonSchema } from "../../core/strict_schema.js";
import { checkSchemaAsync } from "./schema.js";

/**
 * The host-agnostic half of the `finish` tool contract. Each host wraps this in
 * its own tool-definition mechanism; validation, the JSON parameter schema, and
 * the captured-completion sink are shared so completion semantics cannot drift
 * between hosts.
 */
export type CompletionSink = {
	captured: ChartEvent | undefined;
	/** Why `finish` was rejected when a host ends the turn on a rejected finish call. */
	rejection?: string;
};

export type FinishParams = { event?: unknown; output?: unknown };

export function finishableEvents(effect: AgentEffect): string[] {
	return effect.events.filter((event) => event !== "FAILED");
}

export async function validateFinishParams(
	effect: AgentEffect,
	params: FinishParams,
	registry?: SchemaRegistry,
): Promise<{ ok: true; event: ChartEvent } | { ok: false; errors: string[] }> {
	const errors = validateFinishBasics(effect, params);
	let output = params.output;
	if (effect.reply !== undefined) {
		if (!("output" in params)) {
			errors.push("output is required for this completion event");
		} else {
			// A strict finish schema makes optional properties nullable; a null there is never valid
			// for the reply schema, so it is read as the property being absent.
			output = fromStrictValue(params.output, effect.reply.schema);
			const check = await checkSchemaAsync(effect.reply, output, registry);
			if (!check.ok) {
				errors.push(...check.errors.map((message) => `output ${message}`));
			}
		}
	}
	return errors.length > 0
		? { ok: false, errors }
		: {
				ok: true,
				event: { type: params.event as string, ...(output === undefined ? {} : { output }) },
			};
}

function validateFinishBasics(effect: AgentEffect, params: FinishParams): string[] {
	const errors: string[] = [];
	const unexpected = Object.keys(params).filter((key) => key !== "event" && key !== "output");
	if (unexpected.length > 0) {
		errors.push(`unexpected finish field(s): ${unexpected.join(", ")}`);
	}
	if (typeof params.event !== "string") {
		errors.push("event must be a string");
		return errors;
	}
	const allowedEvents = finishableEvents(effect);
	if (params.event === "FAILED") {
		errors.push("FAILED is reserved for runtime failures and cannot be returned by an agent");
	} else if (!allowedEvents.includes(params.event)) {
		errors.push(`event '${params.event}' is not allowed; expected one of ${allowedEvents.join(", ")}`);
	}
	return errors;
}

/**
 * The `finish` parameter schema. With `strict`, the reply schema is converted to the subset that
 * strict tool-call modes accept; {@link validateFinishParams} still checks the original schema.
 */
export function buildFinishSchema(effect: AgentEffect, options: { strict?: boolean } = {}): Record<string, unknown> {
	const events = finishableEvents(effect);
	const reply = effect.reply?.schema;
	return {
		type: "object",
		properties: {
			event: { type: "string", enum: events },
			...(reply === undefined ? {} : { output: options.strict === true ? toStrictJsonSchema(reply) : reply }),
		},
		required: effect.reply === undefined ? ["event"] : ["event", "output"],
		additionalProperties: false,
	};
}
