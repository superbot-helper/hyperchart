import { describe, expect, it } from "vitest";
import { templatePath } from "../packages/hyperchart/src/core/paths.js";

// Independent reference for the original per-segment identity rules.
function reference(path: string): string {
	return path.split(".").map((segment) => {
		const base = segment.split("#")[0]!.replace(/~[1-9][0-9]*$/, "");
		return /^\$worker-[0-9]+$/.test(base) ? "$worker" : base;
	}).join(".");
}

describe("bounded template path memoization", () => {
	it("preserves nested map, actor generation, and pool worker identities", () => {
		const paths = ["plain.state", "outer#a.inner#b.work", "actor~12.$worker-9~2.work#item", "$worker-0.done", "actor~0.work", "actor~01.work", "outer#~12.worker", "has$worker-3.done", "", "a#b#c.d"];
		for (let repeat = 0; repeat < 2; repeat++) {
			for (const path of paths) expect(templatePath(path)).toBe(reference(path));
		}
	});

	it("remains correct after high-cardinality keys evict cached paths", () => {
		const first = "outer#first.actor~2.$worker-1.done";
		expect(templatePath(first)).toBe(reference(first));
		for (let index = 0; index < 10_000; index++) {
			const path = `outer#${index}.actor~${index + 1}.$worker-${index}.work`;
			expect(templatePath(path)).toBe(reference(path));
		}
		expect(templatePath(first)).toBe(reference(first));
	});
});
