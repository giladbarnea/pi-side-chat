import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
	analyzeAgentEditorInput,
	forwardedArgsForPane,
	scanAgentCommandLine,
} from "../command-line.ts";
import { parseAgentCommand } from "../runner.ts";

describe("theme option policy", () => {
	test("--theme is rejected while --no-themes remains supported", () => {
		assert.throws(
			() => parseAgentCommand("--theme ./theme.json do it", "side"),
			/\/side does not support --theme/,
			"Expected /side to reject Pi's singular --theme option",
		);
		assert.deepEqual(
			parseAgentCommand("--no-themes do it", "side"),
			{
				isolate: false,
				squash: false,
				place: undefined,
				forwardedArgs: ["--no-themes"],
				task: "do it",
				warnings: [],
			},
			"Expected /side to continue forwarding --no-themes",
		);
	});

	test("a prose-mode --theme advisory retains its path value", () => {
		const parsed = parseAgentCommand("do it --theme ./theme.json", "side");
		assert.deepEqual(
			parsed,
			{
				isolate: false,
				squash: false,
				place: undefined,
				forwardedArgs: [],
				task: "do it --theme ./theme.json",
				warnings: [
					"--theme ./theme.json was included in the prompt body. To specify an argument or an option, place it at the beginning of the command input: /side --theme ./theme.json do …",
				],
			},
			`Expected the unsupported theme advisory to retain its path. Got: ${JSON.stringify(parsed)}`,
		);
	});
});

describe("forwardedArgsForPane — what a Pi in a herdr pane receives", () => {
	test("drops inert options and the model, provider, and thinking options, by declared arity", () => {
		assert.deepEqual(
			forwardedArgsForPane([
				"--provider",
				"openai",
				"--model",
				"opus",
				"--no-session",
				"--fork",
				"0199",
				"--tools",
				"read,grep",
				"--thinking",
				"high",
				"--no-extensions",
				"--approve",
			]),
			["--tools", "read,grep", "--no-extensions"],
			"Expected only options that a real pi process should obey",
		);
	});

	test("never mistakes a value for an option", () => {
		assert.deepEqual(
			forwardedArgsForPane(["--system-prompt", "--no-session", "--append-system-prompt", "--model"]),
			["--system-prompt", "--no-session", "--append-system-prompt", "--model"],
		);
		assert.deepEqual(forwardedArgsForPane([]), []);
	});
});

describe("/side-attach stays outside the /side editor machinery", () => {
	test("neither the semantic scan nor cursor analysis recognizes an /side-attach line", () => {
		assert.equal(
			scanAgentCommandLine("/side-attach 0199c4f2"),
			undefined,
			"Expected /side coloring to ignore /side-attach lines",
		);
		assert.equal(
			analyzeAgentEditorInput("/side-attach -", "/side-attach -".length),
			undefined,
			"Expected /side autocomplete to ignore /side-attach lines",
		);
	});
});

describe("-h place and --tmux in the editor machinery", () => {
	test("the place after -h is a value token; a quoted place word stays prose", () => {
		const line = "/side -h tab audit it";
		const scan = scanAgentCommandLine(line);
		assert.deepEqual(
			scan?.tokens.map((token) => [token.semantic, line.slice(token.start, token.end), token.option.semanticId]),
			[
				["option", "-h", "herdr"],
				["value", "tab", "herdr"],
			],
		);
		const quoted = '/side -h "tab" audit it';
		assert.deepEqual(
			scanAgentCommandLine(quoted)?.tokens.map((token) => quoted.slice(token.start, token.end)),
			["-h"],
		);
	});

	test("--tmux is an option token, and -t still reads a tools value", () => {
		const line = "/side --tmux -t read audit it";
		assert.deepEqual(
			scanAgentCommandLine(line)?.tokens.map((token) => [token.semantic, line.slice(token.start, token.end)]),
			[
				["option", "--tmux"],
				["option", "-t"],
				["value", "read"],
			],
		);
	});

	test("option completion continues after the place of -h", () => {
		const line = "/side -h tab -";
		const expectation = analyzeAgentEditorInput(line, line.length);
		assert.equal(expectation?.kind, "option");
		assert.ok(expectation?.usedSemanticIds.has("herdr"), "Expected -h to count as used");
	});

	test("a misplaced -h in prose cites its place in the advisory", () => {
		assert.deepEqual(parseAgentCommand("audit it -h tab", "side").warnings, [
			"-h tab was included in the prompt body. To specify an argument or an option, place it at the beginning of the command input: /side -h tab audit …",
		]);
	});
});
