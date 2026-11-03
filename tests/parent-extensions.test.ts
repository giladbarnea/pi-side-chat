import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * A local extension with a local provider. Its model answers with the tools it was offered and the
 * markers of the context hooks that ran, so the child's answer shows which extensions it loaded.
 */
function fakeExtensionSource(name: string): string {
	return `
import * as ai from "@earendil-works/pi-ai";

export default function (pi) {
	pi.registerProvider("${name}-provider", {
		api: "${name}-api",
		baseUrl: "http://127.0.0.1:9",
		apiKey: "local-test-only",
		models: [{ id: "${name}-model", name: "${name} model", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
		streamSimple: (model, context) => {
			const tools = (context.tools ?? ai.getCurrentTools(context.messages)).map((tool) => tool.name);
			const hooks = JSON.stringify(context.messages).match(/hook-ran:[a-z]+/g) ?? [];
			const message = { role: "assistant", content: [{ type: "text", text: JSON.stringify({ tools, hooks }) }],
				api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			const stream = ai.createAssistantMessageEventStream();
			queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
			return stream;
		},
	});
	pi.registerTool({ name: "${name}_tool", label: "${name}", description: "A ${name} test tool",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) });
	pi.on("context", (event) => ({ messages: [...event.messages,
		{ role: "user", content: "hook-ran:${name}", timestamp: Date.now() }] }));
}
`;
}

type Extensions = { launch: string; settings: string; agent: string };
type ChildReport = { tools: string[]; hooks: string[] };

/**
 * Start a parent session as `pi <launchArgs>` does, with the `settings` extension configured in
 * settings. Then dispatch `/agent -s <agentOptions>` and return what the child's model was offered.
 */
async function dispatchFromLaunchedParent(
	launchArgs: (extensions: Extensions) => string[],
	agentOptions: (extensions: Extensions) => string,
): Promise<ChildReport> {
	const extensionDirectory = mkdtempSync(join(tmpdir(), "pi-user-agents-extensions-"));
	const extensions: Extensions = {
		launch: join(extensionDirectory, "launch.ts"),
		settings: join(extensionDirectory, "settings.ts"),
		agent: join(extensionDirectory, "agent.ts"),
	};
	for (const [name, file] of Object.entries(extensions)) writeFileSync(file, fakeExtensionSource(name));
	const args = launchArgs(extensions);
	try {
		return await withTemporaryAgentDir((cwd) =>
			withLaunchArgs(args, async () => {
				const agentDir = process.env.PI_CODING_AGENT_DIR!;
				writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [extensions.settings] }));
				// The parent's resources, as pi's main builds them from the same arguments.
				const launch = parseArgs(args);
				const services = await createAgentSessionServices({
					cwd,
					agentDir,
					resourceLoaderOptions: {
						additionalExtensionPaths: launch.extensions,
						noExtensions: launch.noExtensions,
						extensionFactories: [userAgents],
					},
				});
				const model = services.modelRuntime.getModel("launch-provider", "launch-model");
				if (!model) throw new Error("The parent did not load its launch extension's provider");
				const { session } = await createAgentSessionFromServices({
					services,
					sessionManager: SessionManager.create(cwd),
					model,
					thinkingLevel: "off",
				});
				try {
					await session.bindExtensions({ mode: "print" });
					await session.prompt(`/agent -s ${agentOptions(extensions)} report what you were given`);
					const details = await squashedDetails(() => session.messages);
					expect(details.ok, `Expected the child to answer, got error: ${details.error}`).toBe(true);
					expect(details.model, "Expected the child to run on the parent's launch provider").toStartWith(
						"launch-provider/launch-model",
					);
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

test("a child loads the extension its parent was launched with -e: provider, tool, and hook", async () => {
	const child = await dispatchFromLaunchedParent(
		(extensions) => ["-e", extensions.launch],
		() => "",
	);
	expect(child.tools, "Expected the child to offer the parent's launch tool").toContain("launch_tool");
	expect(child.tools, "Expected the child to keep the configured settings tool").toContain("settings_tool");
	expect(child.hooks.sort(), "Expected the launch and settings hooks to run in the child").toEqual([
		"hook-ran:launch",
		"hook-ran:settings",
	]);
});

test("a child of a parent launched with --no-extensions loads exactly the parent's extensions", async () => {
	const child = await dispatchFromLaunchedParent(
		(extensions) => ["--no-extensions", "-e", extensions.launch],
		() => "",
	);
	expect(child.tools, "Expected the child to offer the parent's launch tool").toContain("launch_tool");
	expect(child.tools, "Expected the child to skip the settings tool the parent skipped").not.toContain(
		"settings_tool",
	);
	expect(child.hooks).toEqual(["hook-ran:launch"]);
});

test("/agent -e and /agent --no-extensions still apply on top of the parent's launch extensions", async () => {
	const added = await dispatchFromLaunchedParent(
		(extensions) => ["-e", extensions.launch],
		(extensions) => `-e ${extensions.agent}`,
	);
	expect(added.hooks.sort(), "Expected the launch, settings, and /agent -e extensions in the child").toEqual([
		"hook-ran:agent",
		"hook-ran:launch",
		"hook-ran:settings",
	]);

	const discoveryOff = await dispatchFromLaunchedParent(
		(extensions) => ["-e", extensions.launch],
		(extensions) => `--no-extensions -e ${extensions.agent}`,
	);
	expect(
		discoveryOff.hooks.sort(),
		"Expected --no-extensions to drop configured extensions while explicit -e paths still load, as in pi",
	).toEqual(["hook-ran:agent", "hook-ran:launch"]);
});
