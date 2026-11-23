import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	parseArgs,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import userAgents from "../index.ts";
import type { AgentCommandDetails } from "../shared.ts";
import { MESSAGE_TYPE } from "../shared.ts";
import { withLaunchArgs, withTemporaryAgentDir } from "./agent-dir.ts";

const MARKERS_SCRIPT = 'text("marker_" + (40 + 2)); text("marker_" + (40 + 3));';
const MCP_SCRIPT = 'text(await tools.mcp__fake__echo({ text: "ping" }));';

/** The local stdio MCP server registered as `fake`; its `echo` tool answers `echo:<text>`. */
const FAKE_MCP_CONFIG = {
	mcpServers: {
		fake: { command: process.execPath, args: [resolve(import.meta.dir, "fixtures/fake-mcp-server.mjs")] },
	},
};

/**
 * A scripted local model. Offered `codemode`, it calls it once with `script`; then it answers with
 * the tools it was offered and every tool result it got.
 */
const scriptedModelSource = (script: string): string => `
import * as ai from "@earendil-works/pi-ai";

const SCRIPT = ${JSON.stringify(script)};

export default function (pi) {
	pi.registerProvider("scripted-provider", {
		api: "scripted-api",
		baseUrl: "http://127.0.0.1:9",
		apiKey: "local-test-only",
		models: [{ id: "scripted-model", name: "scripted model", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
		streamSimple: (model, context) => {
			const tools = (context.tools ?? ai.getCurrentTools(context.messages)).map((tool) => tool.name);
			const results = context.messages
				.filter((message) => message.role === "toolResult")
				.map((message) => ({
					text: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\\n"),
					isError: message.isError,
				}));
			const callsCodemode = tools.includes("codemode") && results.length === 0;
			const content = callsCodemode
				? [{ type: "toolCall", id: "call-codemode", name: "codemode", arguments: { code: SCRIPT } }]
				: [{ type: "text", text: JSON.stringify({ tools, results }) }];
			const stopReason = callsCodemode ? "toolUse" : "stop";
			const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
				stopReason, timestamp: Date.now(),
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			const stream = ai.createAssistantMessageEventStream();
			queueMicrotask(() => stream.push({ type: "done", reason: stopReason, message }));
			return stream;
		},
	});
}
`;

/** A third-party extension that registers its own `codemode`, replacing Pi's built-in one. */
const REPLACEMENT_SOURCE = `
export default function (pi) {
	pi.registerTool({ name: "codemode", label: "codemode", description: "A replacement codemode",
		parameters: { type: "object", properties: { code: { type: "string" } } },
		execute: async () => ({ content: [{ type: "text", text: "replacement-ran" }], details: {} }) });
}
`;

type ChildReport = { tools: string[]; results: Array<{ text: string; isError: boolean }> };

type DispatchOptions = {
	script?: string;
	withReplacement?: boolean;
	/** Written as the agent directory's `mcp.json`; none when absent. */
	mcpConfig?: typeof FAKE_MCP_CONFIG;
	extraLaunchArgs?: string[];
};

/**
 * Launch a parent as `pi -e <scripted model> [-e <replacement>] <extraLaunchArgs>` with `settings`,
 * dispatch a background `/side -s <sideOptions>`, and return what the child's model was offered and
 * got back.
 */
async function dispatchSide(
	settings: Record<string, unknown>,
	sideOptions: string,
	{ script = MARKERS_SCRIPT, withReplacement = false, mcpConfig, extraLaunchArgs = [] }: DispatchOptions = {},
): Promise<ChildReport> {
	const extensionDirectory = mkdtempSync(join(tmpdir(), "pi-side-codemode-"));
	const scriptedModel = join(extensionDirectory, "scripted-model.ts");
	const replacement = join(extensionDirectory, "replacement.ts");
	writeFileSync(scriptedModel, scriptedModelSource(script));
	writeFileSync(replacement, REPLACEMENT_SOURCE);
	const args = ["-e", scriptedModel, ...(withReplacement ? ["-e", replacement] : []), ...extraLaunchArgs];
	try {
		return await withTemporaryAgentDir((cwd) =>
			withLaunchArgs(args, async () => {
				const agentDir = process.env.PI_CODING_AGENT_DIR!;
				writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
				if (mcpConfig) writeFileSync(join(agentDir, "mcp.json"), JSON.stringify(mcpConfig));
				const services = await createAgentSessionServices({
					cwd,
					agentDir,
					resourceLoaderOptions: {
						additionalExtensionPaths: parseArgs(args).extensions,
						extensionFactories: [userAgents],
					},
				});
				const model = services.modelRuntime.getModel("scripted-provider", "scripted-model");
				if (!model) throw new Error("Fixture defect: the parent did not load the scripted provider");
				const { session } = await createAgentSessionFromServices({
					services,
					sessionManager: SessionManager.create(cwd),
					model,
					thinkingLevel: "off",
				});
				try {
					await session.bindExtensions({ mode: "print" });
					await session.prompt(`/side -s ${sideOptions} run the script`.replace(/\s+/g, " "));
					const details = await squashedDetails(() => session.messages);
					expect(details.ok, `Expected the child to answer, got error: ${details.error}`).toBe(true);
					return JSON.parse(details.responseText ?? "") as ChildReport;
				} finally {
					session.dispose();
				}
			}),
		);
	} finally {
		rmSync(extensionDirectory, { recursive: true, force: true });
	}
}

async function squashedDetails(messages: () => readonly unknown[]): Promise<AgentCommandDetails> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const squashed = messages().find(
			(message) =>
				(message as { role?: string }).role === "custom" &&
				(message as { customType?: string }).customType === MESSAGE_TYPE,
		) as { details: AgentCommandDetails } | undefined;
		if (squashed) return squashed.details;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("The child never squashed its result into the parent");
}

test.each([
	["the defaultTools setting", { defaultTools: ["+codemode"] }, ""],
	["/side --tools", {}, "--tools +codemode"],
])("a background child runs Code Mode when %s enables it", async (_label, settings, sideOptions) => {
	const child = await dispatchSide(settings, sideOptions);

	expect(child.tools, "Expected the child to offer codemode").toContain("codemode");
	expect(child.results, "Expected exactly one codemode result").toHaveLength(1);
	const [result] = child.results;
	expect(result!.isError, `Expected the script to succeed, got: ${result!.text}`).toBe(false);
	expect(result!.text).toContain("marker_42");
	expect(result!.text).toContain("marker_43");
});

test.each([
	["by default", {}, ""],
	["when settings disable the built-in extension", { defaultTools: ["+codemode"], extensions: ["-builtin:codemode"] }, ""],
	["when /side excludes the tool", { defaultTools: ["+codemode"] }, "-xt codemode"],
])("a background child does not offer Code Mode %s", async (_label, settings, sideOptions) => {
	const child = await dispatchSide(settings, sideOptions);

	expect(child.tools, "Expected codemode to stay off").not.toContain("codemode");
	expect(child.results).toEqual([]);
});

test("an extension that registers codemode replaces the built-in in a background child", async () => {
	const child = await dispatchSide({ defaultTools: ["+codemode"] }, "", { withReplacement: true });

	expect(child.tools.filter((name) => name === "codemode"), "Expected one codemode tool").toHaveLength(1);
	expect(child.results).toEqual([{ text: "replacement-ran", isError: false }]);
});

test("a background child reaches a configured MCP server through Code Mode", async () => {
	const child = await dispatchSide({}, "", { script: MCP_SCRIPT, mcpConfig: FAKE_MCP_CONFIG });

	expect(child.tools, "Expected MCP's codemode exposure to enable codemode").toContain("codemode");
	expect(child.results, "Expected exactly one codemode result").toHaveLength(1);
	const [result] = child.results;
	expect(result!.isError, `Expected the script to succeed, got: ${result!.text}`).toBe(false);
	expect(result!.text, "Expected the fake server's echo in the script output").toContain("echo:ping");
});

test.each([
	["settings disable the built-in extension", { extensions: ["-builtin:mcp"] }, [], FAKE_MCP_CONFIG],
	["the parent was launched with --no-mcp", {}, ["--no-mcp"], FAKE_MCP_CONFIG],
	["there is no mcp.json", {}, [], undefined],
])("a background child has no MCP tools when %s", async (_label, settings, extraLaunchArgs, mcpConfig) => {
	const child = await dispatchSide({ defaultTools: ["+codemode"], ...settings }, "", {
		script: MCP_SCRIPT,
		mcpConfig,
		extraLaunchArgs,
	});

	expect(child.results, "Expected exactly one codemode result").toHaveLength(1);
	const [result] = child.results;
	expect(result!.isError, `Expected the MCP call to fail, got: ${result!.text}`).toBe(true);
	expect(result!.text).toContain("tools.mcp__fake__echo does not exist");
});
