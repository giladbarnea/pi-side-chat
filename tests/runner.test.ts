import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
	createAgentSessionFromServices,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { readDispatchRecord } from "../attach.ts";
import {
	buildChildResourceLoaderOptions,
	createChildServices,
	flushSessionFile,
	handleAgentCommand,
	PANE_DISPATCH_PREAMBLE,
	parentExtensionArgs,
	placePreamble,
	parseAgentCommand,
	parseForwardedArgs,
	persistMessages,
	resolveForwardedOptions,
	resolveToolOptions,
	runChildTurns,
	subscribeToChildSession,
	waitForInstruction,
} from "../runner.ts";
import type {
	AgentMessage,
	AgentResultMessage,
	DispatchRecordData,
	ExtensionCommandContext,
	RunningAgent,
	Theme,
	UIContext,
} from "../shared.ts";
import { DISPATCH_ENTRY_TYPE } from "../shared.ts";
import { UserAgentWidget } from "../widget.ts";
import { withLaunchArgs, withTemporaryAgentDir } from "./agent-dir.ts";
import { fakeHerdr, insideFakeHerdrPane } from "./herdr-fake.ts";
import { fakeTmux, insideFakeTmuxPane } from "./tmux-fake.ts";

/** The slice of RunningAgent that waitForInstruction reads and writes. */
type RunningAgentForTest = Pick<
	RunningAgent,
	"id" | "status" | "startedAt" | "turnStartedAt" | "completedAt" | "resume" | "retire"
>;

const base = {
	isolate: false,
	squash: false,
	place: undefined,
	forwardedArgs: [] as string[],
	warnings: [] as string[],
};

/** Build the single prose-body advisory exactly as the parser emits it (§5). */
function warning(
	command: "side",
	optionWithValue: string,
	firstProseWord: string,
): string {
	return `${optionWithValue} was included in the prompt body. To specify an argument or an option, place it at the beginning of the command input: /${command} ${optionWithValue} ${firstProseWord} …`;
}

describe("parseAgentCommand — args → prose one-way flip (§2, §4)", () => {
	test("a leading non-dash word flips the whole input to prose", () => {
		expect(parseAgentCommand("do the thing now", "side")).toEqual({
			...base,
			task: "do the thing now",
		});
	});

	test("consumes leading options then flips at the first prose word", () => {
		expect(parseAgentCommand("--thinking high do the thing", "side")).toEqual({
			...base,
			forwardedArgs: ["--thinking", "high"],
			task: "do the thing",
		});
	});

	test("never returns to args mode: a recognized option after the flip stays in the prose", () => {
		expect(parseAgentCommand("-m gpt56s hello --thinking high world", "side")).toEqual({
			...base,
			forwardedArgs: ["--model", "gpt56s"],
			task: "hello --thinking high world",
			warnings: [warning("side", "--thinking high", "hello")],
		});
	});

	test("preserves leading whitespace when the very first token is prose", () => {
		expect(parseAgentCommand("   go now", "side")).toEqual({ ...base, task: "   go now" });
	});

	test("skips leading whitespace to reach the first option (Pi passes command args untrimmed — a stray space must not drop flags)", () => {
		expect(parseAgentCommand(" --thinking high fix it", "side")).toEqual({
			...base,
			forwardedArgs: ["--thinking", "high"],
			task: "fix it",
		});
		expect(parseAgentCommand("   -i do the thing", "side")).toEqual({
			...base,
			isolate: true,
			task: "do the thing",
		});
	});
});

describe("parseAgentCommand — extension options (§3a)", () => {
	test("normalizes -m to Pi's --model option", () => {
		expect(parseAgentCommand("-m gpt56t Explain it", "side")).toEqual({
			...base,
			forwardedArgs: ["--model", "gpt56t"],
			task: "Explain it",
		});
	});

	test("consumes -i / --isolate", () => {
		expect(parseAgentCommand("-i do the thing", "side")).toEqual({
			...base,
			isolate: true,
			task: "do the thing",
		});
		expect(parseAgentCommand("--isolate do the thing", "side")).toEqual({
			...base,
			isolate: true,
			task: "do the thing",
		});
	});

	test("consumes -s / --squash", () => {
		expect(parseAgentCommand("-s do the thing", "side")).toEqual({
			...base,
			squash: true,
			task: "do the thing",
		});
		expect(parseAgentCommand("--squash do the thing", "side")).toEqual({
			...base,
			squash: true,
			task: "do the thing",
		});
	});

	test("consumes -h / --herdr", () => {
		expect(parseAgentCommand("-h do the thing", "side")).toEqual({
			...base,
			place: "herdr pane",
			task: "do the thing",
		});
		expect(parseAgentCommand("--herdr do the thing", "side")).toEqual({
			...base,
			place: "herdr pane",
			task: "do the thing",
		});
	});

	test("-h and -s conflict: an agent in a herdr pane never squashes into this context", () => {
		expect(() => parseAgentCommand("-h -s do the thing", "side")).toThrow(/-h and -s conflict/);
		expect(() => parseAgentCommand("--squash --herdr do the thing", "side")).toThrow(
			/-h and -s conflict/,
		);
	});

	test("-h takes an optional place right after it: pane, tab, or workspace", () => {
		expect(parseAgentCommand("-h pane do the thing", "side")).toEqual({
			...base,
			place: "herdr pane",
			task: "do the thing",
		});
		expect(parseAgentCommand("-h tab do the thing", "side")).toEqual({
			...base,
			place: "herdr tab",
			task: "do the thing",
		});
		expect(parseAgentCommand("--herdr workspace do the thing", "side")).toEqual({
			...base,
			place: "herdr workspace",
			task: "do the thing",
		});
		expect(parseAgentCommand("-h tab -i do the thing", "side")).toEqual({
			...base,
			isolate: true,
			place: "herdr tab",
			task: "do the thing",
		});
	});

	test("a task starting with a place word after -h loses it to the place; quoting keeps it in the task, quotes and all", () => {
		expect(parseAgentCommand("-h tab order is wrong, fix it", "side")).toEqual({
			...base,
			place: "herdr tab",
			task: "order is wrong, fix it",
		});
		expect(parseAgentCommand('-h "tab order is wrong", fix it', "side")).toEqual({
			...base,
			place: "herdr pane",
			task: '"tab order is wrong", fix it',
		});
	});

	test("only the exact lowercase place word after -h is a place", () => {
		expect(parseAgentCommand("-h tabs are wrong", "side")).toEqual({
			...base,
			place: "herdr pane",
			task: "tabs are wrong",
		});
		expect(parseAgentCommand("-h Tab order", "side")).toEqual({
			...base,
			place: "herdr pane",
			task: "Tab order",
		});
		expect(parseAgentCommand("-i tab order", "side")).toEqual({
			...base,
			isolate: true,
			task: "tab order",
		});
	});

	test("-h with only a place and no task is a usage error that names the places", () => {
		expect(() => parseAgentCommand("-h tab", "side")).toThrow(/Usage: .*-h\|--herdr \[pane\|tab\|workspace\]/);
	});

	test("consumes --tmux, which has no short spelling and takes no place", () => {
		expect(parseAgentCommand("--tmux do the thing", "side")).toEqual({
			...base,
			place: "tmux pane",
			task: "do the thing",
		});
		expect(parseAgentCommand("--tmux tab order", "side")).toEqual({
			...base,
			place: "tmux pane",
			task: "tab order",
		});
	});

	test("-t stays Pi's --tools alias", () => {
		expect(parseAgentCommand("-t read,grep do the thing", "side")).toEqual({
			...base,
			forwardedArgs: ["-t", "read,grep"],
			task: "do the thing",
		});
	});

	test("--tmux conflicts with -h and with -s", () => {
		expect(() => parseAgentCommand("-h --tmux do the thing", "side")).toThrow(
			"/side -h and --tmux conflict: a side chat opens in one place.",
		);
		expect(() => parseAgentCommand("--tmux -s do the thing", "side")).toThrow(
			"/side --tmux and -s conflict: a side chat in a tmux pane never squashes into this context.",
		);
		expect(() => parseAgentCommand("-h workspace -s do the thing", "side")).toThrow(
			"/side -h and -s conflict: a side chat in a herdr workspace never squashes into this context.",
		);
	});

	test("consumes leading options in any order", () => {
		const expected = {
			...base,
			forwardedArgs: ["--model", "gpt56t"],
			isolate: true,
			squash: true,
			task: "do the thing",
		};
		expect(parseAgentCommand("-s -i -m gpt56t do the thing", "side")).toEqual(expected);
		expect(parseAgentCommand("-m gpt56t -i --squash do the thing", "side")).toEqual(expected);
	});

	test("the previous --context option is no longer recognized", () => {
		expect(parseAgentCommand("--context do the thing", "side")).toEqual({
			...base,
			task: "--context do the thing",
		});
	});

	test("bare -m without a model name remains a usage error", () => {
		expect(() => parseAgentCommand("-m", "side")).toThrow(/Usage/);
		expect(() => parseAgentCommand("-m   ", "side")).toThrow(/Usage/);
		expect(() => parseAgentCommand("-i -m", "side")).toThrow(/Usage/);
	});

	test("an empty task after consuming options is a usage error", () => {
		expect(() => parseAgentCommand("-i", "side")).toThrow(/Usage/);
		expect(() => parseAgentCommand("--thinking high", "side")).toThrow(/Usage/);
	});
});

describe("parseAgentCommand — known pi option arity from the static table (§3b)", () => {
	test("a value option consumes the next token", () => {
		expect(parseAgentCommand("--thinking high do it", "side")).toEqual({
			...base,
			forwardedArgs: ["--thinking", "high"],
			task: "do it",
		});
	});

	test("a boolean option consumes no value", () => {
		expect(parseAgentCommand("--offline do it", "side")).toEqual({
			...base,
			forwardedArgs: ["--offline"],
			task: "do it",
		});
	});


	test("a value option swallows a following option-looking token as its verbatim value", () => {
		expect(parseAgentCommand("--thinking --offline do it", "side")).toEqual({
			...base,
			forwardedArgs: ["--thinking", "--offline"],
			task: "do it",
		});
	});

	test("a value option swallows even an extension option as its value", () => {
		expect(parseAgentCommand("--thinking -i do it", "side")).toEqual({
			...base,
			forwardedArgs: ["--thinking", "-i"],
			task: "do it",
		});
	});

	test("recognizes short-form value options", () => {
		expect(parseAgentCommand("-t read,edit do it", "side")).toEqual({
			...base,
			forwardedArgs: ["-t", "read,edit"],
			task: "do it",
		});
		expect(parseAgentCommand("-e ./ext do it", "side")).toEqual({
			...base,
			forwardedArgs: ["-e", "./ext"],
			task: "do it",
		});
	});

	test("recognizes short-form boolean options", () => {
		expect(parseAgentCommand("-nt do it", "side")).toEqual({
			...base,
			forwardedArgs: ["-nt"],
			task: "do it",
		});
		expect(parseAgentCommand("-nbt do it", "side")).toEqual({
			...base,
			forwardedArgs: ["-nbt"],
			task: "do it",
		});
	});

	test("accumulates a repeated multi-value option in input order", () => {
		expect(
			parseAgentCommand("--append-system-prompt a --append-system-prompt b do it", "side"),
		).toEqual({
			...base,
			forwardedArgs: ["--append-system-prompt", "a", "--append-system-prompt", "b"],
			task: "do it",
		});
	});

	test("a value option with no following token does not crash (empty task → usage error)", () => {
		expect(() => parseAgentCommand("--thinking", "side")).toThrow(/Usage/);
	});
});

describe("parseAgentCommand — reading a quoted option value (§3b)", () => {
	test("strips the surrounding quotes and spans internal whitespace into one forwardedArgs element", () => {
		expect(parseAgentCommand('--system-prompt "I am psyched" do it', "side")).toEqual({
			...base,
			forwardedArgs: ["--system-prompt", "I am psyched"],
			task: "do it",
		});
	});

	test("strips the quotes even when the value has no internal whitespace", () => {
		expect(parseAgentCommand('--system-prompt "Psych" do it', "side")).toEqual({
			...base,
			forwardedArgs: ["--system-prompt", "Psych"],
			task: "do it",
		});
	});

	test("reads and dequotes a quoted value for the -m alias", () => {
		expect(parseAgentCommand('-m "gpt56s" go', "side")).toEqual({
			...base,
			forwardedArgs: ["--model", "gpt56s"],
			task: "go",
		});
	});

	test("treats an option-looking quoted value as literal — no inner parsing, no spurious warning", () => {
		expect(parseAgentCommand('--system-prompt "talk about -m modelname arg" go', "side")).toEqual({
			...base,
			forwardedArgs: ["--system-prompt", "talk about -m modelname arg"],
			task: "go",
		});
	});

	test("keeps a backslash inside a quoted value verbatim (no recursion)", () => {
		expect(parseAgentCommand('--system-prompt "talk about \\-m arg" go', "side")).toEqual({
			...base,
			forwardedArgs: ["--system-prompt", "talk about \\-m arg"],
			task: "go",
		});
	});

	test("falls back to the whitespace-delimited token when a value opens a quote with no matching close", () => {
		expect(parseAgentCommand('--system-prompt "foo bar', "side")).toEqual({
			...base,
			forwardedArgs: ["--system-prompt", '"foo'],
			task: "bar",
		});
	});
});

describe("parseAgentCommand — blocked pi options (§3c, §9)", () => {
	test("rejects continuation and print options", () => {
		for (const option of ["-c", "--continue", "-p", "--print"]) {
			expect(() => parseAgentCommand(`${option} do it`, "side")).toThrow(
				`/side does not support ${option}`,
			);
		}
	});

	test("rejects a leading blocked option with a hard error", () => {
		expect(() => parseAgentCommand("--export out.html do it", "side")).toThrow(
			/does not support --export/,
		);
		expect(() => parseAgentCommand("--models a,b do it", "side")).toThrow(
			/does not support --models/,
		);
		expect(() => parseAgentCommand("--list-models do it", "side")).toThrow(
			/does not support --list-models/,
		);
		expect(() => parseAgentCommand("--help", "side")).toThrow(/does not support --help/);
		expect(() => parseAgentCommand("-v", "side")).toThrow(/does not support -v/);
		expect(() => parseAgentCommand("--version", "side")).toThrow(/does not support --version/);
	});

	test("a blocked option in the prose body warns instead of erroring", () => {
		expect(parseAgentCommand("do it --export out.html", "side")).toEqual({
			...base,
			task: "do it --export out.html",
			warnings: [warning("side", "--export", "do")],
		});
	});

	test("a blocked option consumed as a value option's value is taken verbatim, not rejected (§3b/§4)", () => {
		expect(parseAgentCommand("--thinking --help do it", "side")).toEqual({
			...base,
			forwardedArgs: ["--thinking", "--help"],
			task: "do it",
		});
		expect(parseAgentCommand("--thinking --export do it", "side")).toEqual({
			...base,
			forwardedArgs: ["--thinking", "--export"],
			task: "do it",
		});
	});
});

describe("parseAgentCommand — prose-body warnings (§5)", () => {
	test("warns when a value option is typed in the prose body", () => {
		expect(parseAgentCommand("hello world -m gpt56s", "side")).toEqual({
			...base,
			task: "hello world -m gpt56s",
			warnings: [warning("side", "-m gpt56s", "hello")],
		});
	});

	test("emits one warning per recognized option occurrence, in order", () => {
		expect(parseAgentCommand("do the thing --offline --verbose", "side")).toEqual({
			...base,
			task: "do the thing --offline --verbose",
			warnings: [warning("side", "--offline", "do"), warning("side", "--verbose", "do")],
		});
	});

	test("a value option in prose warns with the following option as its value AND that option warns again on its own (§9)", () => {
		expect(parseAgentCommand("go --thinking --offline now", "side")).toEqual({
			...base,
			task: "go --thinking --offline now",
			warnings: [
				warning("side", "--thinking --offline", "go"),
				warning("side", "--offline", "go"),
			],
		});
	});

	test("does not warn on unknown arg-looking tokens (leading or in prose)", () => {
		expect(parseAgentCommand("-g badflagname hello world", "side")).toEqual({
			...base,
			task: "-g badflagname hello world",
		});
		expect(parseAgentCommand("hello world -g badflagname", "side")).toEqual({
			...base,
			task: "hello world -g badflagname",
		});
		expect(parseAgentCommand("--doesnotexist this is my message", "side")).toEqual({
			...base,
			task: "--doesnotexist this is my message",
		});
	});

	test("does not recognize an =-form option (recognition is exact-token): flips to prose with no warning", () => {
		expect(parseAgentCommand("--thinking=high do it", "side")).toEqual({
			...base,
			task: "--thinking=high do it",
		});
	});

	test("does not warn on quoted option-looking tokens", () => {
		expect(parseAgentCommand('summarize "-m gpt56"', "side")).toEqual({
			...base,
			task: 'summarize "-m gpt56"',
		});
	});

	test("does not warn on backslash-escaped option-looking tokens", () => {
		expect(parseAgentCommand("tell me about \\-m please", "side")).toEqual({
			...base,
			task: "tell me about -m please",
		});
	});

	test("uses the unescaped first prose word in the suggested rewrite", () => {
		expect(parseAgentCommand("\\-i --thinking high do it", "side")).toEqual({
			...base,
			task: "-i --thinking high do it",
			warnings: [warning("side", "--thinking high", "-i")],
		});
	});
});

describe("parseAgentCommand — quotes never stripped, suppress parsing (§6a)", () => {
	test("keeps quotes verbatim and never parses inside a matched span", () => {
		expect(parseAgentCommand('summarize "war and peace"', "side")).toEqual({
			...base,
			task: 'summarize "war and peace"',
		});
	});

	test("a leading quoted span flips to prose and suppresses parsing", () => {
		expect(parseAgentCommand('"-m gpt56" now', "side")).toEqual({
			...base,
			task: '"-m gpt56" now',
		});
	});

	test("an unmatched quote is a literal char with no protective effect", () => {
		expect(parseAgentCommand("hello 'world -m gpt56s", "side")).toEqual({
			...base,
			task: "hello 'world -m gpt56s",
			warnings: [warning("side", "-m gpt56s", "hello")],
		});
	});

	test("a backslash inside a matched quote span is not processed", () => {
		expect(parseAgentCommand('"\\-m gpt56 hello"', "side")).toEqual({
			...base,
			task: '"\\-m gpt56 hello"',
		});
	});
});

describe("parseAgentCommand — non-straight quote pairs (§6a)", () => {
	test("reads a curly-double-quoted option value (closing quote differs from opening)", () => {
		expect(parseAgentCommand("--system-prompt “I am psyched” do it", "side")).toEqual({
			...base,
			forwardedArgs: ["--system-prompt", "I am psyched"],
			task: "do it",
		});
	});

	test("reads a curly-single-quoted option value (closing quote differs from opening)", () => {
		expect(parseAgentCommand("-m ‘gpt56s’ go", "side")).toEqual({
			...base,
			forwardedArgs: ["--model", "gpt56s"],
			task: "go",
		});
	});

	test("reads a backtick-quoted option value", () => {
		expect(parseAgentCommand("--system-prompt `be terse` do it", "side")).toEqual({
			...base,
			forwardedArgs: ["--system-prompt", "be terse"],
			task: "do it",
		});
	});

	test("a curly-quoted span in prose masks a bare recognized option inside it (no warning)", () => {
		expect(parseAgentCommand("summarize “do -m now”", "side")).toEqual({
			...base,
			task: "summarize “do -m now”",
		});
	});

	test("a backtick-quoted span in prose masks a bare recognized option inside it (no warning)", () => {
		expect(parseAgentCommand("summarize `do -m now`", "side")).toEqual({
			...base,
			task: "summarize `do -m now`",
		});
	});
});

describe("parseAgentCommand — backslash-before-dash removed, never recurses (§6b)", () => {
	test("removes a leading backslash before a dash", () => {
		expect(parseAgentCommand("\\-m hello", "side")).toEqual({ ...base, task: "-m hello" });
		expect(parseAgentCommand("\\--thinking high", "side")).toEqual({
			...base,
			task: "--thinking high",
		});
	});

	test("collapses the overly-cautious double form \\-\\- to --", () => {
		expect(parseAgentCommand("\\-\\-thinking high", "side")).toEqual({
			...base,
			task: "--thinking high",
		});
		expect(parseAgentCommand("\\--word here", "side")).toEqual({ ...base, task: "--word here" });
	});

	test("does not recurse beyond the double form", () => {
		expect(parseAgentCommand("\\-\\-\\-word here", "side")).toEqual({
			...base,
			task: "--\\-word here",
		});
	});

	test("leaves a backslash that is not at a word-start before a dash literal", () => {
		expect(parseAgentCommand("\\backslash and foo\\-bar", "side")).toEqual({
			...base,
			task: "\\backslash and foo\\-bar",
		});
	});

	test("processes a backslash-escaped dash already in prose, with no warning", () => {
		expect(parseAgentCommand("hello \\-m world", "side")).toEqual({
			...base,
			task: "hello -m world",
		});
	});

	test("an escaped leading flag does not resurrect arg parsing", () => {
		expect(parseAgentCommand("\\-i do the thing", "side")).toEqual({
			...base,
			task: "-i do the thing",
		});
	});

	test("applies the spec's mixed escape/quote worked examples", () => {
		expect(parseAgentCommand('hello agent, \\-m "gpt56s" how are you?', "side")).toEqual({
			...base,
			task: 'hello agent, -m "gpt56s" how are you?',
		});
		expect(parseAgentCommand('hello agent, \\--thi"nking" high', "side")).toEqual({
			...base,
			task: 'hello agent, --thi"nking" high',
		});
	});
});

describe("resolveForwardedOptions — static-arity forwarding (§7)", () => {
	let modelRuntime: ModelRuntime;
	beforeAll(async () => {
		modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, modelsPath: null });
	});
	const resolve = (args: string[]) =>
		resolveForwardedOptions(parseForwardedArgs(args), modelRuntime);

	test("returns nothing for no forwarded args", () => {
		expect(resolve([])).toEqual({});
	});

	test("drops --provider when --model is absent (matches pi: provider-only is a no-op)", () => {
		expect(resolve(["--provider", "openai"])).toEqual({});
	});

	test("maps --thinking to the child thinking level", () => {
		expect(resolve(["--thinking", "high"])).toEqual({ thinkingLevel: "high" });
	});

	test("resolves an exact --model through ModelRuntime", () => {
		const model = resolve(["--model", "openai-codex/gpt-5.6-luna"]).model;
		expect(model && `${model.provider}/${model.id}`).toBe("openai-codex/gpt-5.6-luna");
	});

	test("rejects partial and custom model IDs outside the live catalog", () => {
		for (const model of ["openai-codex/gpt-5.6-lun", "openai-codex/not-in-catalog"]) {
			expect(() => resolve(["--model", model])).toThrow(`Model "${model}" not found`);
		}
	});

	test("maps tool options", () => {
		expect(resolve(["--exclude-tools", "ask_question", "--no-builtin-tools"])).toEqual({
			noTools: "builtin",
			excludeTools: ["ask_question"],
		});
	});

	test("maps supported resource paths and keeps --no-themes", () => {
		expect(
			buildChildResourceLoaderOptions(
				parseForwardedArgs([
					"--no-context-files",
					"--no-themes",
					"--extension",
					"./extensions/foo.ts",
					"--extension",
					"npm:@scope/bar",
					"--skill",
					"./skills/foo",
					"--prompt-template",
					"./prompts/foo.md",
					"--append-system-prompt",
					"be terse",
				]),
				"/tmp/project",
			),
		).toEqual({
			noContextFiles: true,
			noThemes: true,
			additionalExtensionPaths: ["/tmp/project/extensions/foo.ts", "npm:@scope/bar"],
			additionalSkillPaths: ["/tmp/project/skills/foo"],
			additionalPromptTemplatePaths: ["/tmp/project/prompts/foo.md"],
			appendSystemPrompt: ["be terse"],
		});
	});

	test("carries the parent's launch extension options as absolute pi tokens", () => {
		expect(
			parentExtensionArgs(
				["--mode", "rpc", "--session", "/s.jsonl", "-ne", "-e", "./ext.ts", "--extension", "git:github.com/a/b", "hi"],
				"/launch",
			),
		).toEqual(["--no-extensions", "--extension", "/launch/ext.ts", "--extension", "git:github.com/a/b"]);
		expect(parentExtensionArgs(["--thinking", "high", "explain"], "/launch")).toEqual([]);
	});

	test("throws on a pi parser error", () => {
		expect(() => parseForwardedArgs(["--name"])).toThrow(/--name/);
	});

	test("rejects a tool list that mixes plain names with +name/-name entries", () => {
		expect(() => parseForwardedArgs(["--tools", "+grep,read"])).toThrow(/cannot be mixed/);
	});

	test("a child session gets the tools Pi selects for the forwarded tool options", async () => {
		await withTemporaryAgentDir(async (cwd) => {
			const ctx = {
				cwd,
				isProjectTrusted: () => false,
				modelRegistry: { runtime: modelRuntime },
			} as unknown as ExtensionCommandContext;
			for (const { input, activeTools } of [
				{ input: "-t +grep,-write", activeTools: ["read", "bash", "edit", "grep"] },
				{ input: "--tools -bash", activeTools: ["read", "edit", "write"] },
				{ input: "-nt -t +grep", activeTools: ["grep"] },
				{ input: "-t +grep -xt edit", activeTools: ["read", "bash", "write", "grep"] },
				{ input: "--tools read,grep", activeTools: ["read", "grep"] },
				{ input: "-xt bash", activeTools: ["read", "edit", "write"] },
				{ input: "-nt", activeTools: [] },
			]) {
				const forwardedArgs = parseAgentCommand(`${input} --no-extensions review it`, "side").forwardedArgs;
				const parsed = parseForwardedArgs(forwardedArgs);
				const services = await createChildServices(ctx, forwardedArgs);
				const { session } = await createAgentSessionFromServices({
					services,
					sessionManager: SessionManager.inMemory(cwd),
					...resolveToolOptions(parsed),
				});
				try {
					expect(
						session.getActiveToolNames(),
						`Expected /side ${input} to give the child exactly these tools`,
					).toEqual(activeTools);
				} finally {
					session.dispose();
				}
			}
		});
	});

	// Pi 1.3 resumes a session with the tool loadout its transcript records, unless the tool options
	// select tools explicitly. Attach replays the dispatch record through this same path.
	test("a resumed child keeps the tools its dispatch selected explicitly, not the loadout its transcript records", async () => {
		await withTemporaryAgentDir(async (cwd) => {
			const ctx = {
				cwd,
				isProjectTrusted: () => false,
				modelRegistry: { runtime: modelRuntime },
			} as unknown as ExtensionCommandContext;
			const recordedLoadout = ["read", "bash", "edit", "write", "grep", "find"].map((name) => ({
				name,
				description: name,
				parameters: { type: "object", properties: {} },
			}));
			for (const { input, activeTools } of [
				{ input: "--tools read,grep", activeTools: ["read", "grep"] },
				{ input: "-nt", activeTools: [] },
				{ input: "--no-builtin-tools", activeTools: [] },
			]) {
				const child = SessionManager.create(cwd);
				persistMessages(
					child,
					[
						{ role: "system", content: "child prompt", toolsAdded: recordedLoadout, timestamp: 1 },
						{ role: "user", content: "review the migration", timestamp: 2 },
						{
							role: "assistant",
							content: [{ type: "text", text: "reviewed" }],
							timestamp: 3,
							stopReason: "stop",
						},
					] as AgentMessage[],
					[],
				);
				const forwardedArgs = parseAgentCommand(`${input} --no-extensions review it`, "side").forwardedArgs;
				const parsed = parseForwardedArgs(forwardedArgs);
				const services = await createChildServices(ctx, forwardedArgs);
				const { session } = await createAgentSessionFromServices({
					services,
					sessionManager: SessionManager.open(flushSessionFile(child)),
					...resolveToolOptions(parsed),
				});
				try {
					expect(
						session.getActiveToolNames(),
						`Expected a resumed /side ${input} child to keep exactly its dispatch tools`,
					).toEqual(activeTools);
				} finally {
					session.dispose();
				}
			}
		});
	});
});

describe("persistMessages — the child session file is resumable", () => {
	function roundTrip(messages: AgentMessage[]): { messages: AgentMessage[]; entryTypes: string[] } {
		const sessionDirectory = mkdtempSync(join(tmpdir(), "pi-user-agents-"));
		try {
			const sessionManager = SessionManager.create("/tmp/project", sessionDirectory);
			persistMessages(sessionManager, messages, []);
			const sessionFile = sessionManager.getSessionFile();
			expect(sessionFile, "Expected the child session to have a file path").toBeString();
			const reopened = SessionManager.open(sessionFile as string);
			return {
				messages: reopened.buildSessionContext().messages,
				entryTypes: reopened.getEntries().map((entry) => entry.type),
			};
		} finally {
			rmSync(sessionDirectory, { recursive: true, force: true });
		}
	}

	test("a reopened child session sees the same conversation the live child inherited", () => {
		const inherited = [
			{ role: "user", content: "review the migration", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "reviewed" }],
				timestamp: 2,
				stopReason: "stop",
			},
			{
				role: "custom",
				customType: "pi-user-agents",
				content: "<user_agent>an earlier result card</user_agent>",
				display: false,
				timestamp: 3,
			},
		] as AgentMessage[];

		const restored = roundTrip(inherited);

		expect(restored.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"custom",
		]);
		expect(restored.messages[0]).toMatchObject({ role: "user", content: "review the migration" });
		expect(restored.messages[2]).toMatchObject({
			role: "custom",
			customType: "pi-user-agents",
			display: false,
		});
		expect(
			restored.entryTypes,
			"Expected a result card the child inherited to be stored as pi's own custom_message entry",
		).toEqual(["message", "message", "custom_message"]);
	});

	test("a mid-stream compaction with a kept tail rebuilds the exact compacted context", () => {
		const replayed = [
			{ role: "user", content: "first ask", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "early work" }],
				timestamp: 2,
				stopReason: "stop",
			},
			{ role: "user", content: "second ask", timestamp: 3 },
			{
				role: "assistant",
				content: [{ type: "text", text: "recent work" }],
				timestamp: 4,
				stopReason: "stop",
			},
			{
				role: "compactionSummary",
				summary: "everything before the kept tail",
				tokensBefore: 50_000,
				timestamp: 5,
				keptTailCount: 2,
			},
			{ role: "user", content: "third ask", timestamp: 6 },
			{
				role: "assistant",
				content: [{ type: "text", text: "final work" }],
				timestamp: 7,
				stopReason: "stop",
			},
		] as AgentMessage[];

		const restored = roundTrip(replayed);

		expect(
			restored.entryTypes,
			"Expected the full history persisted with the compaction as an ordinary entry",
		).toEqual(["message", "message", "message", "message", "compaction", "message", "message"]);
		expect(
			restored.messages.map((message) => message.role),
			"Expected the rebuilt context to keep the tail verbatim after the summary, like the child's live context",
		).toEqual(["compactionSummary", "user", "assistant", "user", "assistant"]);
		expect(restored.messages[1]).toMatchObject({ role: "user", content: "second ask" });
		expect(restored.messages[3]).toMatchObject({ role: "user", content: "third ask" });
	});

	test("a kept tail that reaches back into the pre-replay context keeps those messages too", () => {
		const sessionDirectory = mkdtempSync(join(tmpdir(), "pi-user-agents-"));
		try {
			const sessionManager = SessionManager.create("/tmp/project", sessionDirectory);
			const priorContextEntryIds = [
				sessionManager.appendMessage({ role: "user", content: "A ask", timestamp: 1 } as never),
				sessionManager.appendMessage({
					role: "assistant",
					content: [{ type: "text", text: "B answer" }],
					timestamp: 2,
					stopReason: "stop",
				} as never),
				sessionManager.appendMessage({ role: "user", content: "C ask", timestamp: 3 } as never),
			];

			// The child inherited [A, B, C], produced D, compacted keeping the last 3, produced E.
			persistMessages(
				sessionManager,
				[
					{ role: "user", content: "D ask", timestamp: 4 },
					{
						role: "compactionSummary",
						summary: "covers A only",
						tokensBefore: 60_000,
						timestamp: 5,
						keptTailCount: 3,
					},
					{
						role: "assistant",
						content: [{ type: "text", text: "E answer" }],
						timestamp: 6,
						stopReason: "stop",
					},
				] as AgentMessage[],
				priorContextEntryIds,
			);

			const sessionFile = sessionManager.getSessionFile();
			expect(sessionFile).toBeString();
			const restored = SessionManager.open(sessionFile as string).buildSessionContext().messages;
			expect(
				restored.map((message) => message.role),
				"Expected the kept tail to span pre-existing main messages, not only replayed ones",
			).toEqual(["compactionSummary", "assistant", "user", "user", "assistant"]);
			expect(restored[1]).toMatchObject({ role: "assistant" });
			expect(restored[2]).toMatchObject({ role: "user", content: "C ask" });
			expect(restored[3]).toMatchObject({ role: "user", content: "D ask" });
		} finally {
			rmSync(sessionDirectory, { recursive: true, force: true });
		}
	});

	test("a snapshot taken after the main session compacted or branched keeps its summaries", () => {
		const inherited = [
			{
				role: "compactionSummary",
				summary: "everything before the compaction",
				tokensBefore: 90_000,
				timestamp: 1,
			},
			{ role: "user", content: "carry on", timestamp: 2 },
			{ role: "branchSummary", summary: "the path we abandoned", fromId: "e7", timestamp: 3 },
			{
				role: "assistant",
				content: [{ type: "text", text: "carrying on" }],
				timestamp: 4,
				stopReason: "stop",
			},
		] as AgentMessage[];

		const restored = roundTrip(inherited);

		expect(restored.messages.map((message) => message.role)).toEqual([
			"compactionSummary",
			"user",
			"branchSummary",
			"assistant",
		]);
		expect(restored.messages[0]).toMatchObject({
			role: "compactionSummary",
			summary: "everything before the compaction",
			tokensBefore: 90_000,
		});
		// Stored as pi's own summary entries, not as ordinary messages: pi's compaction and branch
		// bookkeeping finds boundaries by entry type, so a plain message entry would hide them.
		expect(
			restored.entryTypes,
			"Expected summaries to be stored as compaction and branch_summary entries",
		).toEqual(["compaction", "message", "branch_summary", "message"]);
	});
});

describe("waitForInstruction — idle lifecycle parking", () => {
	function idleAgent(): RunningAgentForTest {
		return {
			id: "user-1",
			status: "idle",
			startedAt: Date.now() - 5_000,
			turnStartedAt: Date.now() - 5_000,
			completedAt: Date.now() - 1_000,
		};
	}

	test("resume starts another turn: resolves with the instruction, resets turn timing, clears both closures", async () => {
		const agent = idleAgent();
		const updates: number[] = [];
		const parked = waitForInstruction(agent as never, { update: () => updates.push(1) });
		if (!agent.resume) throw new Error("resume closure was not assigned");

		const before = Date.now();
		agent.resume("now do the follow-up");

		await expect(parked).resolves.toBe("now do the follow-up");
		expect(agent.status).toBe("running");
		expect(agent.turnStartedAt).toBeGreaterThanOrEqual(before);
		expect(agent.completedAt).toBeUndefined();
		expect(agent.resume).toBeUndefined();
		expect(agent.retire).toBeUndefined();
		expect(updates).toEqual([1]);
	});

	test("retire ends the lifecycle: resolves undefined and clears both closures", async () => {
		const agent = idleAgent();
		const parked = waitForInstruction(agent as never, { update: () => undefined });
		if (!agent.retire) throw new Error("retire closure was not assigned");

		agent.retire();

		await expect(parked).resolves.toBeUndefined();
		expect(agent.status).toBe("idle");
		expect(agent.resume).toBeUndefined();
		expect(agent.retire).toBeUndefined();
	});

	test("a second wake after settling is a no-op (closures are cleared before resolution)", async () => {
		const agent = idleAgent();
		const parked = waitForInstruction(agent as never, { update: () => undefined });
		const resume = agent.resume;
		if (!resume) throw new Error("resume closure was not assigned");

		resume("first");
		agent.resume?.("second");
		agent.retire?.();

		await expect(parked).resolves.toBe("first");
	});
});

describe("runChildTurns — main-context delivery", () => {
	test.each([false, true])("completion keeps the widget response and only squash=%s delivers hidden context", async (squash) => {
		const prompts: string[] = [];
		const messages: Array<Record<string, unknown>> = [];
		const session = {
			agent: { state: { messages } },
			prompt: (instruction: string) => {
				prompts.push(instruction);
				messages.push({ role: "user", content: instruction });
				messages.push({
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					stopReason: "stop",
				});
				return Promise.resolve();
			},
		} as unknown as NonNullable<RunningAgent["session"]>;
		const agent = {
			id: "user-1",
			sessionId: "session-1",
			command: "side",
			inheritedContext: true,
			model: "provider/model",
			modelLabel: "model",
			task: "plan the migration",
			invocation: "/side -s plan the migration",
			notifyMainAgent: squash,
			dispatchBaseFingerprint: "[]",
			mainContextState: "will-squash",
			status: "running",
			startedAt: Date.now(),
			turnStartedAt: Date.now(),
			activeTools: new Map<string, string>(),
			toolUses: 0,
			turnCount: 0,
			responseText: "",
			conversationMessages: messages as unknown as AgentMessage[],
			session,
			finished: Promise.resolve(),
		} satisfies RunningAgent;

		const entries: unknown[] = [];
		const deliveries: Array<{ message: AgentResultMessage; options: { triggerTurn: boolean } }> = [];
		const lifecycle = runChildTurns(
			{
				appendEntry: (_type: string, data: unknown) => entries.push(data),
				sendMessage: (message: AgentResultMessage, options: { triggerTurn: boolean }) => deliveries.push({ message, options }),
			} as never,
			() => false,
			"plan the migration",
			session,
			agent,
			{ update: () => undefined, addCompleted: () => undefined } as never,
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		if (!squash) {
			expect(agent.status).toBe("idle");
			expect((agent as RunningAgent).pendingSquashMessage?.content).toContain("done");
			(agent as RunningAgent).retire?.();
		}
		await lifecycle;
		expect(entries, "Completion must not append a transcript entry").toEqual([]);
		expect(agent.responseText).toBe("done");
		expect(deliveries).toHaveLength(squash ? 1 : 0);
		if (squash) {
			expect(deliveries[0]?.message.display).toBe(false);
			expect(deliveries[0]?.message.content).toContain("plan the migration");
			expect(deliveries[0]?.message.content).toContain("done");
			expect(deliveries[0]?.options).toEqual({ triggerTurn: true });
		}

		expect(
			prompts,
			"Expected the instruction to reach the child unmodified — no injected preamble",
		).toEqual(["plan the migration"]);
	});

	test("an interrupted partial response stays separate, while its resumed response can squash", async () => {
		let resolvePrompt = () => undefined;
		let promptCalls = 0;
		const messages: Array<Record<string, unknown>> = [];
		const session = {
			agent: { state: { messages } },
			prompt: () => {
				promptCalls += 1;
				if (promptCalls === 1)
					return new Promise<void>((resolve) => {
						resolvePrompt = resolve;
					});
				messages.push({
					role: "assistant",
					content: [{ type: "text", text: "Finished analysis" }],
					stopReason: "stop",
				});
				return Promise.resolve();
			},
		} as unknown as NonNullable<RunningAgent["session"]>;
		const agent = {
			id: "user-1",
			sessionId: "session-1",
			command: "side",
			inheritedContext: true,
			model: "provider/model",
			modelLabel: "model",
			task: "plan the migration",
			invocation: "/side plan the migration",
			notifyMainAgent: true,
			dispatchBaseFingerprint: "[]",
			mainContextState: "will-squash",
			status: "running",
			startedAt: Date.now(),
			turnStartedAt: Date.now(),
			activeTools: new Map<string, string>(),
			toolUses: 0,
			turnCount: 0,
			responseText: "",
			conversationMessages: [],
			session,
			finished: Promise.resolve(),
		} satisfies RunningAgent;
		const entries: unknown[] = [];
		const sentMessages: AgentResultMessage[] = [];
		const completedMessages: AgentResultMessage[] = [];
		const pi = {
			appendEntry: (_customType: string, data: unknown) => entries.push(data),
			sendMessage: (message: AgentResultMessage) => sentMessages.push(message),
		};
		const widget = {
			update: () => undefined,
			addCompleted: (_agent: RunningAgent, message: AgentResultMessage) =>
				completedMessages.push(message),
		};

		const lifecycle = runChildTurns(
			pi as never,
			() => false,
			agent.task,
			session,
			agent,
			widget as never,
		);
		await Promise.resolve();
		agent.interruptRequested = true;
		messages.push({
			role: "assistant",
			content: [{ type: "text", text: "Partial analysis" }],
			stopReason: "aborted",
		});
		resolvePrompt();
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(agent.status).toBe("idle");
		expect(agent.responseText).toContain("Interrupted by user");
		expect(agent.responseText).toContain("Partial analysis");
		expect(agent.resume).toBeFunction();
		expect(agent.retire).toBeFunction();
		expect(agent.mainContextState).toBe("separate");
		expect(entries, "Interrupted turns must not append transcript cards").toEqual([]);
		expect(sentMessages).toEqual([]);

		agent.resume?.("finish the analysis");
		expect(agent.mainContextState).toBe("will-squash");
		await lifecycle;

		expect(sentMessages).toHaveLength(1);
		expect(sentMessages[0]?.display, "Squash must reach context without a transcript card").toBe(false);
		expect(completedMessages).toHaveLength(1);
		expect(sentMessages[0]?.details).toMatchObject({
			agentId: "user-1",
			mainContextState: "will-squash",
		});
	});

	test("shutdown suppression cancels a scheduled squash", async () => {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "text", text: "Finished analysis" }],
				stopReason: "stop",
			},
		] as unknown as AgentMessage[];
		const session = {
			agent: { state: { messages } },
			prompt: async () => undefined,
		} as unknown as NonNullable<RunningAgent["session"]>;
		const agent = {
			id: "user-1",
			sessionId: "session-1",
			command: "side",
			inheritedContext: true,
			model: "provider/model",
			modelLabel: "model",
			task: "plan the migration",
			invocation: "/side -s plan the migration",
			notifyMainAgent: true,
			dispatchBaseFingerprint: "[]",
			mainContextState: "will-squash",
			status: "running",
			startedAt: Date.now(),
			turnStartedAt: Date.now(),
			activeTools: new Map<string, string>(),
			toolUses: 0,
			turnCount: 0,
			responseText: "",
			conversationMessages: [],
			session,
			finished: Promise.resolve(),
		} satisfies RunningAgent;
		const sentMessages: AgentResultMessage[] = [];
		const completedMessages: AgentResultMessage[] = [];

		await runChildTurns(
			{
				appendEntry: () => undefined,
				sendMessage: (message: AgentResultMessage) => sentMessages.push(message),
			} as never,
			() => true,
			agent.task,
			session,
			agent,
			{
				update: () => undefined,
				addCompleted: (_agent: RunningAgent, message: AgentResultMessage) =>
					completedMessages.push(message),
			} as never,
		);

		expect(agent.mainContextState).toBe("separate");
		expect(sentMessages).toEqual([]);
		expect(completedMessages).toEqual([]);
	});
});

describe("subscribeToChildSession — capturing a live child compaction", () => {
	test("compaction_end lands in the append-only conversation, carrying the kept-tail count", () => {
		let listener: ((event: unknown) => void) | undefined;
		const session = {
			isStreaming: false,
			agent: {
				state: {
					messages: [
						{ role: "compactionSummary", summary: "child summary", tokensBefore: 90_000 },
						{ role: "user", content: "kept ask" },
						{ role: "assistant", content: [{ type: "text", text: "kept answer" }] },
					],
				},
			},
			subscribe: (handler: (event: unknown) => void) => {
				listener = handler;
				return () => undefined;
			},
			getContextUsage: () => undefined,
		} as unknown as NonNullable<RunningAgent["session"]>;
		const agent = {
			id: "user-1",
			sessionId: "session-1",
			command: "side",
			inheritedContext: true,
			model: "provider/model",
			modelLabel: "model",
			task: "long task",
			invocation: "/side long task",
			notifyMainAgent: false,
			dispatchBaseFingerprint: "[]",
			mainContextState: "separate",
			status: "running",
			startedAt: Date.now(),
			turnStartedAt: Date.now(),
			activeTools: new Map<string, string>(),
			toolUses: 0,
			turnCount: 0,
			responseText: "",
			conversationMessages: [],
			session,
			finished: Promise.resolve(),
		} satisfies RunningAgent;

		subscribeToChildSession(session, agent, { update: () => undefined } as never);
		if (!listener) throw new Error("Child subscription was not installed");
		listener({
			type: "compaction_end",
			reason: "threshold",
			aborted: false,
			willRetry: false,
			result: { summary: "child summary", firstKeptEntryId: "child-e7", tokensBefore: 90_000 },
		});

		expect(agent.conversationMessages).toHaveLength(1);
		expect(agent.conversationMessages[0]).toMatchObject({
			role: "compactionSummary",
			summary: "child summary",
			tokensBefore: 90_000,
			keptTailCount: 2,
		});

		listener({
			type: "compaction_end",
			reason: "manual",
			aborted: true,
			willRetry: false,
			result: undefined,
		});
		expect(
			agent.conversationMessages,
			"Expected an aborted compaction to leave no trace in the conversation",
		).toHaveLength(1);
	});
});

describe("flushSessionFile — a child file on disk before any assistant message", () => {
	test("writes the header and dispatch record before any conversation so another Pi can resume the session", () => {
		const sessionDirectory = mkdtempSync(join(tmpdir(), "pi-user-agents-flush-"));
		try {
			const child = SessionManager.create("/tmp/project", sessionDirectory, {
				parentSession: "/tmp/main.jsonl",
			});
			const record: DispatchRecordData = { forwardedArgs: ["--tools", "read"], task: "audit", isolate: false };
			child.appendCustomEntry(DISPATCH_ENTRY_TYPE, record);
			const sessionFile = child.getSessionFile() as string;
			expect(existsSync(sessionFile), "Fixture check: metadata alone does not create a session file").toBe(false);

			expect(flushSessionFile(child)).toBe(sessionFile);

			const reopened = SessionManager.open(sessionFile);
			expect(reopened.getSessionId()).toBe(child.getSessionId());
			expect(reopened.getHeader()?.parentSession).toBe("/tmp/main.jsonl");
			expect(readDispatchRecord(reopened)).toEqual(record);
			expect(reopened.buildSessionContext().messages).toEqual([]);
			expect(flushSessionFile(child), "Expected a second flush to leave the file alone").toBe(sessionFile);
		} finally {
			rmSync(sessionDirectory, { recursive: true, force: true });
		}
	});

	test("leaves a file pi already wrote alone: an inherited assistant message flushes it at once", () => {
		const sessionDirectory = mkdtempSync(join(tmpdir(), "pi-user-agents-flush-"));
		try {
			const child = SessionManager.create("/tmp/project", sessionDirectory);
			persistMessages(
				child,
				[
					{ role: "user", content: "ask", timestamp: 1 },
					{ role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 2, stopReason: "stop" },
				] as AgentMessage[],
				[],
			);
			const sessionFile = child.getSessionFile() as string;
			expect(existsSync(sessionFile), "Fixture check: pi writes the file on the assistant message").toBe(true);

			expect(flushSessionFile(child)).toBe(sessionFile);

			expect(SessionManager.open(sessionFile).buildSessionContext().messages.map((message) => message.role)).toEqual([
				"user",
				"assistant",
			]);
		} finally {
			rmSync(sessionDirectory, { recursive: true, force: true });
		}
	});
});

describe("handleAgentCommand -h — an agent born in a herdr pane", () => {
	type Notification = { message: string; level: string };
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		underline: (text: string) => text,
		strikethrough: (text: string) => text,
	} as unknown as Theme;
	const tui = { terminal: { columns: 140, rows: 40 }, requestRender: () => undefined } as unknown as TUI;

	async function dispatchContext(cwd: string, mainPrompt = "main prompt"): Promise<{
		ctx: ExtensionCommandContext;
		main: SessionManager;
		notifications: Notification[];
		widgetComponent: () => Component;
	}> {
		const main = SessionManager.create(cwd);
		main.appendMessage({ role: "user", content: mainPrompt, timestamp: 1 } as never);
		main.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "main answer" }],
			timestamp: 2,
			stopReason: "stop",
		} as never);
		const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, modelsPath: null });
		const notifications: Notification[] = [];
		let widgetComponent: Component | undefined;
		const ui = {
			notify: (message: string, level: string) => notifications.push({ message, level }),
			onTerminalInput: () => () => undefined,
			getEditorText: () => "",
			setWidget: (_key: string, content: unknown) => {
				if (typeof content === "function") widgetComponent = content(tui, theme);
			},
		} as unknown as UIContext;
		const ctx = {
			hasUI: true,
			cwd,
			sessionManager: main,
			model: modelRuntime.getModel("openai-codex", "gpt-5.6-luna"),
			modelRegistry: { runtime: modelRuntime },
			isProjectTrusted: () => false,
			ui,
		} as unknown as ExtensionCommandContext;
		return {
			ctx,
			main,
			notifications,
			widgetComponent: () => {
				if (!widgetComponent) throw new Error("Widget did not render");
				return widgetComponent;
			},
		};
	}
	const fakePi = {
		getThinkingLevel: () => "high",
		appendEntry: () => undefined,
		sendMessage: () => undefined,
	} as never;
	const noopWidgetDependencies = [
		() => undefined,
		() => undefined,
		{ canDeliver: () => false, deliver: () => undefined },
		{ available: () => false, split: () => Promise.reject(new Error("no herdr")) },
	] as const;

	test("flushes the child file, starts pi on it in a new pane with the task, and keeps a row pointing at the pane", async () => {
		await withTemporaryAgentDir(async (cwd) => {
			const { ctx, main, notifications, widgetComponent } = await dispatchContext(cwd);
			const runningAgents = new Set<RunningAgent>();
			const widget = new UserAgentWidget(runningAgents, ...noopWidgetDependencies);
			const fake = fakeHerdr({ layout: { paneId: "w1:p1", width: 120, height: 40 }, paneId: "w1:p2" });
			try {
				await withLaunchArgs(["-e", "/opt/extensions/launch.ts"], () => insideFakeHerdrPane("w1:p1", () =>
					handleAgentCommand(
						fakePi,
						runningAgents,
						widget,
						() => false,
						() => 1,
						"side",
						"--tools read,grep --no-session -h audit the migration",
						"/side --tools read,grep --no-session -h audit the migration",
						ctx,
					),
				));

				expect(notifications.filter(({ level }) => level === "error")).toEqual([]);
				const start = fake.calls.find((call) => call[0] === "agent" && call[1] === "start");
				if (!start) throw new Error(`herdr never started an agent; calls: ${JSON.stringify(fake.calls)}`);
				const sessionFile = start[start.indexOf("--session") + 1] as string;
				expect(start).toEqual([
					"agent",
					"start",
					expect.stringMatching(/^side-[0-9a-f]{8}-[0-9a-f]{4}$/),
					"--kind",
					"pi",
					"--pane",
					"w1:p2",
					"--",
					"--extension",
					"/opt/extensions/launch.ts",
					"--tools",
					"read,grep",
					"--provider",
					"openai-codex",
					"--model",
					"gpt-5.6-luna",
					"--thinking",
					"high",
					"--session",
					sessionFile,
					`${PANE_DISPATCH_PREAMBLE}audit the migration`,
				]);
				expect(start, "Expected the inert --no-session to stay off a real pi's command line").not.toContain(
					"--no-session",
				);
				expect(fake.calls[1]).toEqual([
					"pane", "split", "--current", "--direction", "right", "--cwd", cwd, "--no-focus",
				]);
				const child = SessionManager.open(sessionFile);
				expect(child.getHeader()?.parentSession, "Expected the child to stay attachable").toBe(
					main.getSessionFile(),
				);
				expect(readDispatchRecord(child)).toEqual({
					forwardedArgs: ["--tools", "read,grep", "--no-session"],
					task: "audit the migration",
					isolate: false,
				});
				expect(
					child.buildSessionContext().model,
					"Expected the file to carry the model, or a later /side-attach or /resume falls back to the default",
				).toEqual({ provider: "openai-codex", modelId: "gpt-5.6-luna" });
				expect(child.buildSessionContext().thinkingLevel).toBe("high");
				expect(
					child.buildSessionContext().messages.map((message) => message.role),
					"Expected the pane's pi to start from the inherited conversation",
				).toEqual(["user", "assistant"]);
				expect(runningAgents.size, "Expected nothing to run in this process").toBe(0);
				expect(notifications.at(-1)).toEqual({
					message: "Started /side in herdr pane w1:p2",
					level: "info",
				});
				expect(widgetComponent().render(140).join("\n")).toContain("herdr pane w1:p2");
			} finally {
				fake.restore();
			}
		});
	});

	test("-h outside a herdr pane is a command error that leaves no file behind", async () => {
		await withTemporaryAgentDir(async (cwd) => {
			const { ctx, main, notifications } = await dispatchContext(cwd);
			const runningAgents = new Set<RunningAgent>();
			const widget = new UserAgentWidget(runningAgents, ...noopWidgetDependencies);
			const fake = fakeHerdr({ layout: { paneId: "w1:p1", width: 120, height: 40 }, paneId: "w1:p2" });
			delete process.env.HERDR_ENV;
			try {
				await handleAgentCommand(
					fakePi,
					runningAgents,
					widget,
					() => false,
					() => 1,
					"side",
					"-h audit the migration",
					"/side -h audit the migration",
					ctx,
				);

				expect(notifications.at(-1)).toEqual({
					message: "/side -h needs Pi to run inside a herdr pane",
					level: "error",
				});
				expect(fake.calls).toEqual([]);
				expect(runningAgents.size).toBe(0);
				const sessionFiles = readdirSync(main.getSessionDir()).filter((name) => name.endsWith(".jsonl"));
				expect(sessionFiles, "Expected no child file: main itself has one, nothing else").toHaveLength(1);
			} finally {
				fake.restore();
			}
		});
	});

	/** Dispatch `args` from a fresh main session; returns the notifications and the rendered widget. */
	async function dispatchInto(
		cwd: string,
		args: string,
		inside: (run: () => Promise<void>) => Promise<void>,
		mainPrompt?: string,
	): Promise<{ notifications: Notification[]; row: string }> {
		const { ctx, notifications, widgetComponent } = await dispatchContext(cwd, mainPrompt);
		const runningAgents = new Set<RunningAgent>();
		const widget = new UserAgentWidget(runningAgents, ...noopWidgetDependencies);
		await inside(() =>
			handleAgentCommand(fakePi, runningAgents, widget, () => false, () => 1, "side", args, `/side ${args}`, ctx),
		);
		expect(notifications.filter(({ level }) => level === "error")).toEqual([]);
		expect(runningAgents.size, "Expected nothing to run in this process").toBe(0);
		return { notifications, row: widgetComponent().render(140).join("\n") };
	}

	test("-h tab opens a tab in the caller's workspace and starts pi in its root pane, told it sits in a herdr tab", async () => {
		await withTemporaryAgentDir(async (cwd) => {
			const fake = fakeHerdr({ layout: { paneId: "w1:p1", width: 120, height: 40 }, paneId: "w1:p5" });
			try {
				const { notifications, row } = await dispatchInto(cwd, "-h tab audit the migration", (run) =>
					insideFakeHerdrPane("w1:p1", run),
				);
				expect(fake.calls[0]).toEqual(["tab", "create", "--workspace", "w1", "--cwd", cwd, "--no-focus"]);
				const start = fake.calls[1]!;
				expect(start.slice(0, 7)).toEqual(["agent", "start", start[2], "--kind", "pi", "--pane", "w1:p5"]);
				expect(start.at(-1)).toBe(
					"You are running in a forked session now, in a herdr tab apart from the main session. The user may talk to you here. audit the migration",
				);
				expect(fake.calls).toHaveLength(2);
				expect(notifications.at(-1)).toEqual({ message: "Started /side in herdr pane w1:p5", level: "info" });
				expect(row).toContain("herdr pane w1:p5");
			} finally {
				fake.restore();
			}
		});
	});

	test("-h workspace opens a workspace and starts pi in its root pane, told it sits in a herdr workspace", async () => {
		await withTemporaryAgentDir(async (cwd) => {
			const fake = fakeHerdr({ layout: { paneId: "w1:p1", width: 120, height: 40 }, paneId: "w2:p1" });
			try {
				await dispatchInto(cwd, "-h workspace audit the migration", (run) => insideFakeHerdrPane("w1:p1", run));
				expect(fake.calls[0]).toEqual(["workspace", "create", "--cwd", cwd, "--no-focus"]);
				expect(fake.calls[1]?.slice(5, 7)).toEqual(["--pane", "w2:p1"]);
				expect(fake.calls[1]?.at(-1)).toBe(
					"You are running in a forked session now, in a herdr workspace apart from the main session. The user may talk to you here. audit the migration",
				);
			} finally {
				fake.restore();
			}
		});
	});

	test("a pane dispatch from a session that already carries a dispatch preamble says yet another forked session", async () => {
		await withTemporaryAgentDir(async (cwd) => {
			const fake = fakeHerdr({ layout: { paneId: "w1:p1", width: 120, height: 40 }, paneId: "w1:p2" });
			try {
				await dispatchInto(
					cwd,
					"-h audit the migration",
					(run) => insideFakeHerdrPane("w1:p1", run),
					`${PANE_DISPATCH_PREAMBLE}plan the migration`,
				);
				expect(fake.calls.find((call) => call[1] === "start")?.at(-1)).toBe(
					"You are running in yet another forked session now, in a herdr pane beside the main session. The user may talk to you here. audit the migration",
				);
			} finally {
				fake.restore();
			}
		});
	});

	test("--tmux splits the calling tmux pane without focus and runs pi there directly, told it sits in a tmux pane", async () => {
		await withTemporaryAgentDir(async (cwd) => {
			const fake = fakeTmux({ size: { width: 200, height: 50 }, paneId: "%7" });
			try {
				const { notifications, row } = await withLaunchArgs(["-e", "/opt/extensions/launch.ts"], () =>
					dispatchInto(cwd, "--tmux --tools read,grep --no-session audit the migration", (run) =>
						insideFakeTmuxPane("%3", run),
					),
				);
				expect(fake.calls[0]).toEqual(["display-message", "-p", "-t", "%3", "#{pane_width} #{pane_height}"]);
				const split = fake.calls[1]!;
				const sessionFile = split[split.indexOf("--session") + 1] as string;
				expect(split).toEqual([
					"split-window",
					"-h",
					"-d",
					"-t",
					"%3",
					"-c",
					cwd,
					"-P",
					"-F",
					"#{pane_id}",
					"pi",
					"--extension",
					"/opt/extensions/launch.ts",
					"--tools",
					"read,grep",
					"--provider",
					"openai-codex",
					"--model",
					"gpt-5.6-luna",
					"--thinking",
					"high",
					"--session",
					sessionFile,
					"You are running in a forked session now, in a tmux pane beside the main session. The user may talk to you here. audit the migration",
				]);
				expect(existsSync(sessionFile), "Expected the child file on disk before pi starts").toBe(true);
				expect(notifications.at(-1)).toEqual({ message: "Started /side in tmux pane %7", level: "info" });
				expect(row).toContain("tmux pane %7");
				expect(row).not.toContain("herdr");
			} finally {
				fake.restore();
			}
		});
	});

	test("--tmux splits a narrow or tall pane down", async () => {
		await withTemporaryAgentDir(async (cwd) => {
			const fake = fakeTmux({ size: { width: 90, height: 50 }, paneId: "%7" });
			try {
				await dispatchInto(cwd, "--tmux audit the migration", (run) => insideFakeTmuxPane("%3", run));
				expect(fake.calls[1]?.slice(0, 2)).toEqual(["split-window", "-v"]);
			} finally {
				fake.restore();
			}
		});
	});

	test("--tmux outside tmux is a command error that leaves no file behind", async () => {
		await withTemporaryAgentDir(async (cwd) => {
			const { ctx, main, notifications } = await dispatchContext(cwd);
			const runningAgents = new Set<RunningAgent>();
			const widget = new UserAgentWidget(runningAgents, ...noopWidgetDependencies);
			const fake = fakeTmux({ size: { width: 200, height: 50 }, paneId: "%7" });
			delete process.env.TMUX;
			delete process.env.TMUX_PANE;
			try {
				await handleAgentCommand(
					fakePi,
					runningAgents,
					widget,
					() => false,
					() => 1,
					"side",
					"--tmux audit the migration",
					"/side --tmux audit the migration",
					ctx,
				);
				expect(notifications.at(-1)).toEqual({ message: "/side --tmux needs Pi to run inside tmux", level: "error" });
				expect(fake.calls).toEqual([]);
				const sessionFiles = readdirSync(main.getSessionDir()).filter((name) => name.endsWith(".jsonl"));
				expect(sessionFiles, "Expected no child file: main itself has one, nothing else").toHaveLength(1);
			} finally {
				fake.restore();
			}
		});
	});
});

describe("placePreamble — one text per place, each with a refork variant", () => {
	test("the herdr pane text stays byte-identical to the one every pane child so far carries", () => {
		expect(placePreamble("herdr pane", false)).toBe(
			"You are running in a forked session now, in a herdr pane beside the main session. The user may talk to you here. ",
		);
		expect(PANE_DISPATCH_PREAMBLE).toBe(placePreamble("herdr pane", false));
	});

	test("each place names itself; a pane sits beside the main session, a tab or workspace apart from it", () => {
		expect(
			(["herdr pane", "herdr tab", "herdr workspace", "tmux pane"] as const).flatMap((place) => [
				placePreamble(place, false),
				placePreamble(place, true),
			]),
		).toEqual([
			"You are running in a forked session now, in a herdr pane beside the main session. The user may talk to you here. ",
			"You are running in yet another forked session now, in a herdr pane beside the main session. The user may talk to you here. ",
			"You are running in a forked session now, in a herdr tab apart from the main session. The user may talk to you here. ",
			"You are running in yet another forked session now, in a herdr tab apart from the main session. The user may talk to you here. ",
			"You are running in a forked session now, in a herdr workspace apart from the main session. The user may talk to you here. ",
			"You are running in yet another forked session now, in a herdr workspace apart from the main session. The user may talk to you here. ",
			"You are running in a forked session now, in a tmux pane beside the main session. The user may talk to you here. ",
			"You are running in yet another forked session now, in a tmux pane beside the main session. The user may talk to you here. ",
		]);
	});
});
