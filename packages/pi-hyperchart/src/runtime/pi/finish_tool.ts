import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import type { AgentEffect } from "@surprisal/hyperchart/internal/core/machine";
import type { SchemaRegistryLike as SchemaRegistry } from "@surprisal/hyperchart/internal/core/schema_registry";
import {
	buildFinishSchema,
	finishableEvents,
	validateFinishParams,
	type CompletionSink,
	type FinishParams,
} from "@surprisal/hyperchart/runtime";

export { finishableEvents, validateFinishParams };
export type { CompletionSink };

/**
 * With `strict`, the parameters are the strict-mode schema, so Pi's own argument check accepts
 * the nulls a provider writes for optional properties; the request still needs `strict: true`
 * on the function for the provider to constrain decoding (see strict_finish.ts).
 */
export function createFinishTool(
	effect: AgentEffect,
	sink: CompletionSink,
	registry?: SchemaRegistry,
	options: { strict?: boolean } = {},
): ToolDefinition {
	return defineTool({
		name: "finish",
		label: "Finish",
		description: "Call exactly once when the task is complete. This ends the assignment.",
		promptSnippet: "Finish the hyperchart assignment with a typed completion event",
		parameters: Type.Unsafe(buildFinishSchema(effect, options) as TSchema),
		async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
			const result = await validateFinishParams(effect, params as FinishParams, registry);
			if (!result.ok) {
				return toolError(result.errors.join("\n"));
			}
			if (sink.captured !== undefined) {
				return toolError("finish has already been called for this assignment");
			}
			sink.captured = result.event;
			return {
				content: [{ type: "text", text: "Recorded. You may stop now." }],
				details: result.event,
				terminate: true,
			};
		},
	}) as ToolDefinition;
}

function toolError(message: string): AgentToolResult<unknown> & { isError: true } {
	return {
		content: [{ type: "text", text: message }],
		details: { error: message },
		isError: true,
	};
}
