import { spyOn } from "bun:test";
import * as childProcess from "node:child_process";

export type FakeTmuxOptions = {
	/** The calling pane's size as `display-message` reports it. */
	size: { width: number; height: number };
	/** The pane id `split-window -P -F '#{pane_id}'` prints. */
	paneId: string;
	/** Fail `split-window` with this stderr text. */
	splitStderr?: string;
};

/** Stand in for the tmux CLI at the process boundary; records every argv it receives. */
export function fakeTmux(options: FakeTmuxOptions): { calls: string[][]; restore(): void } {
	const calls: string[][] = [];
	const respond = (args: string[]): { stdout: string; stderr: string; failed: boolean } => {
		if (args[0] === "display-message")
			return { stdout: `${options.size.width} ${options.size.height}\n`, stderr: "", failed: false };
		if (args[0] === "split-window")
			return options.splitStderr === undefined
				? { stdout: `${options.paneId}\n`, stderr: "", failed: false }
				: { stdout: "", stderr: options.splitStderr, failed: true };
		throw new Error(`fakeTmux: unexpected command ${args[0]}`);
	};
	const spy = spyOn(childProcess, "execFile").mockImplementation(((
		file: string,
		args: string[],
		callback: (error: Error | null, stdout: string, stderr: string) => void,
	) => {
		if (file !== "tmux") throw new Error(`fakeTmux: unexpected executable ${file}`);
		calls.push(args);
		const { stdout, stderr, failed } = respond(args);
		callback(failed ? Object.assign(new Error("Command failed: tmux"), { code: 1 }) : null, stdout, stderr);
		return {} as childProcess.ChildProcess;
	}) as typeof childProcess.execFile);
	return { calls, restore: () => spy.mockRestore() };
}

/** Run with TMUX and TMUX_PANE set as tmux sets them for a process in one of its panes. */
export async function insideFakeTmuxPane<T>(paneId: string, run: () => Promise<T>): Promise<T> {
	const previous = { tmux: process.env.TMUX, pane: process.env.TMUX_PANE };
	process.env.TMUX = "/private/tmp/tmux-501/default,4242,0";
	process.env.TMUX_PANE = paneId;
	try {
		return await run();
	} finally {
		if (previous.tmux === undefined) delete process.env.TMUX;
		else process.env.TMUX = previous.tmux;
		if (previous.pane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = previous.pane;
	}
}
