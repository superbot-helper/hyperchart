import type { InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * Marks the `finish` function strict in the provider request so a provider with strict tool
 * calls constrains its arguments to the finish schema while decoding. Pi cannot do this itself:
 * its strict conversion rejects unions of objects, which reply schemas use. The finish tool is
 * created with the strict-mode schema already (createFinishTool with `strict`); this only sets
 * the flag, and leaves every other tool and non-OpenAI payload shapes unchanged.
 */
export function strictFinishExtension(): InlineExtension {
	return {
		name: "hyperchart-strict-finish",
		hidden: true,
		factory: (pi) => {
			pi.on("before_provider_request", (event) => markFinishStrict(event.payload));
		},
	};
}

/** Returns the payload with `finish` marked strict, or undefined when it has no such tool. */
export function markFinishStrict(payload: unknown): unknown {
	if (!isRecord(payload) || !Array.isArray(payload.tools)) {
		return undefined;
	}
	let marked = false;
	const tools = payload.tools.map((tool: unknown) => {
		if (!isRecord(tool) || tool.type !== "function") {
			return tool;
		}
		// Chat Completions nests the function; the Responses API keeps it flat.
		if (isRecord(tool.function) && tool.function.name === "finish") {
			marked = true;
			return { ...tool, function: { ...tool.function, strict: true } };
		}
		if (tool.name === "finish") {
			marked = true;
			return { ...tool, strict: true };
		}
		return tool;
	});
	return marked ? { ...payload, tools } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
