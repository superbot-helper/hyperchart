import type { Effect, RecordAppend } from "./machine.js";

const MAX_INVOKES_PER_COMMIT = 32;

/** Group only adjacent, already-admitted invocation facts, never completions or other effects. */
export function batchInvocationAppends(
	entries: readonly (Effect | RecordAppend)[],
): readonly (Effect | RecordAppend)[] {
	if (entries.length < 2) return entries;
	const output: (Effect | RecordAppend)[] = [];
	let batch: RecordAppend[] = [];
	const flush = () => {
		if (batch.length === 0) return;
		if (batch.length === 1) {
			output.push(batch[0]!);
		} else {
			output.push({
				kind: "append",
				id: `invoke-batch:${JSON.stringify(batch.map((entry) => entry.id))}`,
				records: batch.flatMap((entry) => entry.records),
			});
		}
		batch = [];
	};
	for (const entry of entries) {
		const record = entry.kind === "append" && entry.records.length === 1 ? entry.records[0] : undefined;
		if (entry.kind === "append" && record?.type === "state_action" && record.kind === "invoke") {
			batch.push(entry);
			if (batch.length === MAX_INVOKES_PER_COMMIT) flush();
		} else {
			flush();
			output.push(entry);
		}
	}
	flush();
	return output;
}
