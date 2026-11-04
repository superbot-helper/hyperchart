import {
	type AgentSession,
	defineTool,
	type AgentToolResult,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
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
		// Rejections throw: Pi marks a tool result as an error only when execute throws.
		async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
			const result = await validateFinishParams(effect, params as FinishParams, registry);
			if (!result.ok) {
				throw new Error(result.errors.join("\n"));
			}
			if (sink.captured !== undefined) {
				throw new Error("finish has already been called for this assignment");
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

type StopAfterTurn = NonNullable<AgentSession["agent"]["shouldStopAfterTurn"]>;

/**
 * Ends the turn after a rejected `finish`, whether Pi's argument check or validateFinishParams
 * rejected it, so each rejection is a failed turn that spends the action's recovery budget.
 */
export function stopAfterRejectedFinish(sink: CompletionSink): StopAfterTurn {
	return ({ toolResults }) => {
		const rejected = toolResults.find((result) => result.toolName === "finish" && result.isError);
		if (rejected === undefined) {
			return false;
		}
		sink.rejection = rejected.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		return true;
	};
}
