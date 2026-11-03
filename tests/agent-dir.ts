import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Run as a Pi process launched as `pi <launchArgs>`: the extension reads its launch options from process.argv. */
export async function withLaunchArgs<T>(launchArgs: string[], run: () => Promise<T>): Promise<T> {
	const previousArgv = process.argv;
	process.argv = [previousArgv[0]!, "pi", ...launchArgs];
	try {
		return await run();
	} finally {
		process.argv = previousArgv;
	}
}

/** Run with a throwaway Pi agent directory and project cwd, so session files never touch the real ones. */
export async function withTemporaryAgentDir<T>(run: (cwd: string) => Promise<T>): Promise<T> {
	const agentDirectory = mkdtempSync(join(tmpdir(), "pi-user-agents-agent-dir-"));
	const cwd = mkdtempSync(join(tmpdir(), "pi-user-agents-project-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	try {
		return await run(cwd);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDirectory, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
}
