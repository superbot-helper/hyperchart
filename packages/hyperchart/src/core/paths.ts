import type { ActionUID, ChartAst, StateAst, StateId, StatePath } from "./types.js";

// Instance-aware path arithmetic. A path segment may carry an instance key after "#"
// ("research#official.scout"): the NODE data always lives at the template path
// ("research.scout"), while identity — activeLeaves, ActionUID.state, effect ids — keeps the
// instance path. All node lookups and parent/sibling walks in the projection and the machine go
// through these helpers, so template charts and their instances share one code path.

/** Canonical across in-memory records and JSONB replay; array indices remain numeric. */
export function canonicalMapKeys(instances: object): string[] {
	return Object.keys(instances).sort((left, right) => {
		const leftIsIndex = /^(0|[1-9]\d*)$/.test(left);
		const rightIsIndex = /^(0|[1-9]\d*)$/.test(right);
		if (leftIsIndex && rightIsIndex) {
			// Comparing canonical decimal strings avoids Number precision loss for
			// arbitrary-length map keys while retaining numeric ordering.
			return left.length - right.length || (left < right ? -1 : left > right ? 1 : 0);
		}
		if (leftIsIndex) {
			return -1;
		}
		if (rightIsIndex) {
			return 1;
		}
		return left < right ? -1 : left > right ? 1 : 0;
	});
}

// The template path of a possibly-instanced path: map "#key" and actor "~generation"
// suffixes are stripped per segment. Generation 1 deliberately has no suffix for stable paths.
// Pure string results only: no AST or run state is retained. The bound prevents
// unbounded map keys and actor generations from accumulating across long runs.
const TEMPLATE_PATH_CACHE_LIMIT = 4096;
const templatePaths = new Map<StatePath, StatePath>();

export function templatePath(path: StatePath): StatePath {
	if (!path.includes("#") && !path.includes("~") && !path.includes("$worker-")) {
		return path;
	}
	const cached = templatePaths.get(path);
	if (cached !== undefined) {
		return cached;
	}
	const template = path
		.split(".")
		.map((segment) => {
			const hash = segment.indexOf("#");
			const withoutMap = hash === -1 ? segment : segment.slice(0, hash);
			const withoutGeneration = withoutMap.replace(/~[1-9][0-9]*$/, "");
			return /^\$worker-[0-9]+$/.test(withoutGeneration) ? "$worker" : withoutGeneration;
		})
		.join(".");
	if (templatePaths.size === TEMPLATE_PATH_CACHE_LIMIT) {
		const oldest = templatePaths.keys().next();
		if (!oldest.done) {
			templatePaths.delete(oldest.value);
		}
	}
	templatePaths.set(path, template);
	return template;
}

export function nodeAt(ast: ChartAst, path: StatePath): StateAst | undefined {
	return ast.states[templatePath(path)];
}

// The containing path — pure string arithmetic, so "research#k.scout" parents to "research#k"
// (the node.parent link would lose the instance key).
export function parentPath(path: StatePath): StatePath | undefined {
	const dot = path.lastIndexOf(".");
	return dot === -1 ? undefined : path.slice(0, dot);
}

export function childPath(parent: StatePath, id: StateId): StatePath {
	return `${parent}.${id}`;
}

// A sibling at the same level as `path`, preserving the instance prefix.
export function siblingPath(path: StatePath, target: StateId): StatePath {
	const parent = parentPath(path);
	return parent === undefined ? target : childPath(parent, target);
}

// Is `path` the scope itself or anywhere under it — including its instances ("#").
export function underScope(path: StatePath, scope: StatePath): boolean {
	return path === scope || path.startsWith(`${scope}.`) || path.startsWith(`${scope}#`);
}

// The instance key of the LAST segment, if any: "chapters#k" → "k", "chapters" → undefined.
export function lastSegmentKey(path: StatePath): string | undefined {
	const hash = path.lastIndexOf("#");
	return hash > path.lastIndexOf(".") ? path.slice(hash + 1) : undefined;
}

// The path with the last segment's instance key stripped: "outer#a.chapters#k" → "outer#a.chapters".
export function stripLastKey(path: StatePath): StatePath {
	const hash = path.lastIndexOf("#");
	return hash > path.lastIndexOf(".") ? path.slice(0, hash) : path;
}

// Re-scope an absolute template path into the caller's instance: for caller
// "chapters#k.author" the ref "chapters.plan" resolves to "chapters#k.plan" — a lookup inside an
// instance sees its own siblings, not another instance's. Outside the shared prefix the path is
// returned as written.
export function instancePathFor(ref: StatePath, caller: StatePath): StatePath {
	if (!caller.includes("#")) {
		return ref;
	}
	const callerSegments = caller.split(".");
	return ref
		.split(".")
		.map((segment, index) => {
			const callerSegment = callerSegments[index];
			return callerSegment !== undefined && templatePath(callerSegment) === segment ? callerSegment : segment;
		})
		.join(".");
}

// Does a (possibly instance-scoped) uid match the action uid declared in the chart, which always
// carries the template path.
export function matchesDeclaredUid(actual: ActionUID, declared: ActionUID): boolean {
	return (
		actual.chart === declared.chart &&
		templatePath(actual.state) === declared.state &&
		actual.action === declared.action
	);
}

// The nearest enclosing instance, scanning right to left: for "outer#a.chapters#k.author" that is
// the map container "outer#a.chapters" and the key "k". This is the scope key()/item() resolve
// in; a ref naming its map passes the map's template path as `container` to pick a specific
// enclosing instance instead of the innermost one.
export function nearestInstance(
	path: StatePath,
	container?: StatePath,
): { container: StatePath; key: string } | undefined {
	const segments = path.split(".");
	for (let index = segments.length - 1; index >= 0; index--) {
		const segment = segments[index] ?? "";
		const hash = segment.indexOf("#");
		if (hash === -1) {
			continue;
		}
		const instance = [...segments.slice(0, index), segment.slice(0, hash)].join(".");
		if (container === undefined || templatePath(instance) === container) {
			return { container: instance, key: segment.slice(hash + 1) };
		}
	}
	return undefined;
}
