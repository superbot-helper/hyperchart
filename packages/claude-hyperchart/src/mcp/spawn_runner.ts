import { openRunLogStore, resolveRunPaths } from "@surprisal/hyperchart/runtime";
import { closeSync, existsSync, openSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { recoverStaleRunTerminalNotification } from "@surprisal/hyperchart/runtime";
import type { HyperchartRunnerConfig } from "@surprisal/hyperchart/runner";
import { isRunLive, isTerminalRunState, type HyperchartRunStatus } from "@surprisal/hyperchart/sessions";

function runnerEntry(): string {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		// Source module (jiti/tests): src/mcp -> src/claude. Built module: dist/mcp -> src/claude (the
		// .mjs shim ships in the tarball's src tree and loads TypeScript through jiti).
		resolve(moduleDir, "../claude/hyperchart_runner.mjs"),
		resolve(moduleDir, "../../src/claude/hyperchart_runner.mjs"),
	];
	const found = candidates.find((candidate) => existsSync(candidate));
	if (found === undefined) {
		throw new Error(`Claude hyperchart runner shim not found near ${moduleDir}`);
	}
	return found;
}

/** Spawns the detached runner process for a prepared run directory and returns its pid. */
export function spawnDetachedRunner(config: HyperchartRunnerConfig): number {
	const configPath = resolve(resolveRunPaths(config.runId, config.storage).runDir, "runner.config.json");
	writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	const stdoutFd = openSync(resolve(resolveRunPaths(config.runId, config.storage).runDir, "runner.stdout.log"), "a");
	const stderrFd = openSync(resolve(resolveRunPaths(config.runId, config.storage).runDir, "runner.stderr.log"), "a");
	try {
		const child = spawn(process.execPath, [runnerEntry(), configPath], {
			cwd: config.workDir,
			detached: true,
			stdio: ["ignore", stdoutFd, stderrFd],
			env: process.env,
		});
		child.unref();
		if (child.pid === undefined) {
			throw new Error("hyperchart runner did not produce a pid");
		}
		return child.pid;
	} finally {
		closeSync(stdoutFd);
		closeSync(stderrFd);
	}
}

/** Resolves when the run reaches terminal status, recovering a dead runner through the durable outbox helper. */
export async function watchRun(runId: string): Promise<HyperchartRunStatus> {
	const store = await openRunLogStore(runId, { access: "read" });
	try {
		for (;;) {
			// Armed before reading so a terminal write landing mid-read wakes this at once;
			// the one-second fallback covers lost notifications.
			const wait = store.watchRunChange(["status"], { timeoutMs: 1_000 });
			const status = await store.readRunStatus();
			if (status !== undefined) {
				if (isTerminalRunState(status.state)) {
					wait.cancel();
					return status;
				}
				if (!isRunLive(status) && Date.now() - status.updatedAt > 20_000) {
					await recoverStaleRunTerminalNotification(runId);
					const recovered = await store.readRunStatus();
					if (recovered !== undefined && isTerminalRunState(recovered.state)) {
						wait.cancel();
						return recovered;
					}
				}
			}
			await wait.changed;
		}
	} finally {
		await store.close();
	}
}
