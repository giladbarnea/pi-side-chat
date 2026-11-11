import * as childProcess from "node:child_process";

/** Whether this Pi runs inside a tmux pane, so new panes can be split from it. */
export function insideTmux(): boolean {
	return Boolean(process.env.TMUX && process.env.TMUX_PANE);
}

/**
 * @example tmuxPaneLabel("%7") // "tmux pane %7"
 */
export function tmuxPaneLabel(paneId: string): string {
	return `tmux pane ${paneId}`;
}

/**
 * Split the calling tmux pane without taking the user's focus and run `pi <piArgs>` in the new
 * pane; resolves with its pane id. tmux runs a multi-argument command directly, without a shell,
 * so every argument reaches pi verbatim. A wide pane splits to the right and a narrow or tall one
 * down, as in herdr.
 */
export async function openPiInTmuxPane(cwd: string, piArgs: readonly string[]): Promise<string> {
	const callerPane = process.env.TMUX_PANE!;
	const [width, height] = (await tmux(["display-message", "-p", "-t", callerPane, "#{pane_width} #{pane_height}"]))
		.split(" ")
		.map(Number);
	const direction = width! >= height! * 2 ? "-h" : "-v";
	return tmux([
		"split-window",
		direction,
		"-d",
		"-t",
		callerPane,
		"-c",
		cwd,
		"-P",
		"-F",
		"#{pane_id}",
		"pi",
		...piArgs,
	]);
}

/** Run one tmux command and resolve with its trimmed stdout. Rejects with tmux's own message. */
function tmux(args: readonly string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		childProcess.execFile("tmux", [...args], (error, stdout, stderr) => {
			if (error) reject(new Error((stderr || error.message).trim()));
			else resolve(stdout.trim());
		});
	});
}
