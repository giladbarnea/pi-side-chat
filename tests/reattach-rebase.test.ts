import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { handleAttachCommand, matchChildSessionFiles } from "../attach.ts";
import { createRebaseDelivery, handleAgentCommand } from "../runner.ts";
import type { ExtensionAPI, ExtensionCommandContext, Model, RunningAgent, Theme, UIContext } from "../shared.ts";
import { UserAgentWidget } from "../widget.ts";
import { withTemporaryAgentDir } from "./agent-dir.ts";

const DOWN = "\x1b[B";
const plain = (text: string) => text;
const theme = {
	fg: (_color: string, text: string) => text,
	bold: plain,
	italic: plain,
	underline: plain,
	strikethrough: plain,
} as unknown as Theme;
const tui = { terminal: { columns: 200, rows: 40 }, requestRender: () => undefined } as unknown as TUI;

function cannedAnswer(model: Model, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** A local provider with two models; each answers once with its own id, so no network is involved. */
async function cannedModelRuntime(): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({ allowModelNetwork: false, modelsPath: null });
	const model = (id: string) => ({
		id,
		name: id,
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 1000,
	});
	runtime.registerProvider("canned", {
		api: "canned-api",
		baseUrl: "http://127.0.0.1:9",
		apiKey: "local-test-only",
		models: [model("astra"), model("opus")],
		streamSimple: (requestModel) => {
			const message = cannedAnswer(requestModel as Model, `reviewed by ${requestModel.id}`);
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
			return stream;
		},
	});
	return runtime;
}

/**
 * The main Pi process as the user drives it: a persisted main session on `canned/astra`, the
 * widget with its keyboard, the real rebase delivery, and the `/side` and `/side-attach` handlers.
 * Given an existing session, such as a detached child's, the process resumes it instead.
 */
async function mainProcess(cwd: string, resumed?: SessionManager) {
	const runtime = await cannedModelRuntime();
	const astra = runtime.getModel("canned", "astra") as Model;
	const main = resumed ?? SessionManager.create(cwd);
	if (!resumed) {
		main.appendMessage({ role: "user", content: "plan the migration", timestamp: 1 } as never);
		main.appendMessage(cannedAnswer(astra, "here is the plan"));
	}
	let sendKey: (data: string) => unknown = () => undefined;
	let widgetComponent: Component | undefined;
	const switchedTo: string[] = [];
	const ctx = {
		hasUI: true,
		cwd,
		sessionManager: main,
		model: astra,
		modelRegistry: { runtime },
		isProjectTrusted: () => false,
		switchSession: async (file: string) => {
			switchedTo.push(file);
			return { cancelled: false };
		},
		ui: {
			notify: () => undefined,
			confirm: async () => false,
			onTerminalInput: (handler: (data: string) => unknown) => {
				sendKey = handler;
				return () => undefined;
			},
			getEditorText: () => "",
			setWidget: (_key: string, content: unknown) => {
				if (typeof content === "function") widgetComponent = content(tui, theme);
			},
		} as unknown as UIContext,
	} as unknown as ExtensionCommandContext;
	const pi = {
		getThinkingLevel: () => "off",
		appendEntry: () => undefined,
		sendMessage: () => undefined,
	} as unknown as ExtensionAPI;
	const runningAgents = new Set<RunningAgent>();
	const widget = new UserAgentWidget(
		runningAgents,
		() => undefined,
		() => undefined,
		createRebaseDelivery(pi, () => ctx),
		{ available: () => false, split: () => Promise.reject(new Error("no herdr in this test")) },
	);
	let agentNumber = 0;
	return {
		main,
		astra,
		switchedTo,
		async dispose() {
			for (const agent of runningAgents) agent.retire?.();
			await Promise.allSettled([...runningAgents].map((agent) => agent.finished));
			widget.dispose();
		},
		runningAgents,
		press: (...keys: string[]) => {
			for (const key of keys) sendKey(key);
		},
		widgetText: () => {
			if (!widgetComponent) throw new Error("The widget never rendered");
			return widgetComponent.render(200).join("\n");
		},
		dispatch: (args: string) =>
			handleAgentCommand(
				pi,
				runningAgents,
				widget,
				() => false,
				() => ++agentNumber,
				"side",
				args,
				`/side ${args}`,
				ctx,
			),
		attach: (sessionId: string) =>
			handleAttachCommand(
				pi,
				runningAgents,
				widget,
				() => false,
				() => ++agentNumber,
				sessionId,
				ctx,
			),
	};
}

async function idleAgent(runningAgents: Set<RunningAgent>): Promise<RunningAgent> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const agent = [...runningAgents].find((candidate) => candidate.status === "idle");
		if (agent) return agent;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`No agent went idle; statuses: ${[...runningAgents].map((agent) => agent.status).join(", ")}`);
}

/** Dispatch from main, let the child answer, then detach it with `d d`, as the user did. */
async function dispatchAndDetach(mainPi: Awaited<ReturnType<typeof mainProcess>>, args: string): Promise<string> {
	await mainPi.dispatch(args);
	const agent = await idleAgent(mainPi.runningAgents);
	mainPi.press(DOWN);
	expect(mainPi.widgetText(), "Fixture check: the live child offers rebase before any detach").toContain("r rebase");
	mainPi.press("d", "d");
	await agent.finished;
	expect(mainPi.runningAgents.size, "Fixture check: the detached child has no row anymore").toBe(0);
	return agent.sessionId;
}

describe("/side-attach keeps rebase available when main has not progressed (issue 17)", () => {
	test.each([
		["with the parent's model", "review the migration", "astra"],
		["switched to another model", "-m canned/opus review the migration", "opus"],
	])(
		"a detached child dispatched %s offers r rebase again after reattaching, and r fast-forwards main",
		async (_label, args, childModelId) => {
			await withTemporaryAgentDir(async (cwd) => {
				const mainPi = await mainProcess(cwd);
				try {
					const sessionId = await dispatchAndDetach(mainPi, args);
					const [childFile] = matchChildSessionFiles(sessionId, mainPi.main.getSessionDir()).map((match) => match.file);
					const childBytes = readFileSync(childFile!, "utf8");
					const mainContextBefore = mainPi.main.buildSessionContext().messages;

					await mainPi.attach(sessionId);
					await idleAgent(mainPi.runningAgents);
					mainPi.press(DOWN);

					expect(
						mainPi.widgetText(),
						"Expected rebase to stay available: main made no progress since dispatch",
					).toContain("r rebase");
					mainPi.press("r");
					expect(mainPi.switchedTo, "Expected r to fast-forward main and reload it").toEqual([
						mainPi.main.getSessionFile(),
					]);
					const mainContextAfter = mainPi.main.buildSessionContext().messages;
					expect(mainContextAfter.slice(0, mainContextBefore.length), "Main's prior context must stay intact").toEqual(
						mainContextBefore,
					);
					expect(mainContextAfter.at(-1)).toMatchObject({
						role: "assistant",
						content: [{ type: "text", text: `reviewed by ${childModelId}` }],
					});
					expect(readFileSync(childFile!, "utf8"), "The child's session history must stay untouched").toBe(childBytes);
				} finally {
					await mainPi.dispose();
				}
			});
		},
	);

	test("a reattached child still refuses to rebase over real progress in main", async () => {
		await withTemporaryAgentDir(async (cwd) => {
			const mainPi = await mainProcess(cwd);
			try {
				const sessionId = await dispatchAndDetach(mainPi, "-m canned/opus review the migration");
				mainPi.main.appendMessage({ role: "user", content: "meanwhile, in main", timestamp: 3 } as never);
				const mainEntryCount = mainPi.main.getEntries().length;

				await mainPi.attach(sessionId);
				await idleAgent(mainPi.runningAgents);
				mainPi.press(DOWN);
				expect(mainPi.widgetText()).not.toContain("r rebase");
				mainPi.press("r");

				expect(mainPi.widgetText()).toContain("Can't rebase: the main session has drifted since dispatch");
				expect(mainPi.switchedTo).toEqual([]);
				expect(mainPi.main.getEntries()).toHaveLength(mainEntryCount);
			} finally {
				await mainPi.dispose();
			}
		});
	});
});

type MainProcess = Awaited<ReturnType<typeof mainProcess>>;

function childSessionFile(parentPi: MainProcess, sessionId: string): string {
	const [match] = matchChildSessionFiles(sessionId, parentPi.main.getSessionDir());
	if (!match) throw new Error(`No session file for ${sessionId}`);
	return match.file;
}

/** The text of every user message on the session's path; a typed prompt persists as text parts. */
function userPrompts(sessionFile: string): string[] {
	return SessionManager.open(sessionFile)
		.buildSessionContext()
		.messages.flatMap((message) => {
			if (message.role !== "user") return [];
			if (typeof message.content === "string") return [message.content];
			return [message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")];
		});
}

/** Attach the child, then check that r is offered and fast-forwards the session it was dispatched from. */
async function expectAttachWithRebase(parentPi: MainProcess, sessionId: string, expectedTask: string): Promise<void> {
	await parentPi.attach(sessionId);
	const agent = await idleAgent(parentPi.runningAgents);
	expect(agent.task, "Expected attach to recover the child's own task").toBe(expectedTask);
	parentPi.press(DOWN);
	expect(
		parentPi.widgetText(),
		"Expected attach to find the child's own dispatch boundary, so rebase stays available",
	).toContain("r rebase");
	parentPi.press("r");
	expect(parentPi.switchedTo, "Expected r to fast-forward the parent session").toEqual([
		parentPi.main.getSessionFile(),
	]);
}

describe("the dispatch preamble a child receives (issues 7 and 8)", () => {
	test("a child dispatched from main is told it runs in a forked background process, not an ephemeral one", async () => {
		await withTemporaryAgentDir(async (cwd) => {
			const mainPi = await mainProcess(cwd);
			try {
				const sessionId = await dispatchAndDetach(mainPi, "review the migration");

				expect(userPrompts(childSessionFile(mainPi, sessionId))).toEqual([
					"plan the migration",
					"You are running in a forked background process now, concurrently with the main session. review the migration",
				]);
				await expectAttachWithRebase(mainPi, sessionId, "review the migration");
			} finally {
				await mainPi.dispose();
			}
		});
	});

	test("a child dispatched from a child is told it is yet another fork, and attaches back to that child with rebase", async () => {
		await withTemporaryAgentDir(async (cwd) => {
			const mainPi = await mainProcess(cwd);
			const childId = await dispatchAndDetach(mainPi, "review the migration");
			const childFile = childSessionFile(mainPi, childId);
			await mainPi.dispose();
			const childPi = await mainProcess(cwd, SessionManager.open(childFile));
			try {
				const grandchildId = await dispatchAndDetach(childPi, "audit the rollback");

				expect(userPrompts(childSessionFile(childPi, grandchildId))).toEqual([
					"plan the migration",
					"You are running in a forked background process now, concurrently with the main session. review the migration",
					"You are running in yet another forked background process now, concurrently with the main session. audit the rollback",
				]);
				await expectAttachWithRebase(childPi, grandchildId, "audit the rollback");
			} finally {
				await childPi.dispose();
			}
		});
	});

	test("a child dispatched before the change, with the old ephemeral preamble and no dispatch record, still attaches with rebase", async () => {
		await withTemporaryAgentDir(async (cwd) => {
			const mainPi = await mainProcess(cwd);
			try {
				const oldChild = SessionManager.create(cwd, undefined, { parentSession: mainPi.main.getSessionFile() });
				for (const message of mainPi.main.buildSessionContext().messages) oldChild.appendMessage(message as never);
				oldChild.appendMessage({
					role: "user",
					content:
						"You are running in an ephemeral, forked background process now, concurrently with the main session. review the migration",
					timestamp: 3,
				} as never);
				oldChild.appendMessage(cannedAnswer(mainPi.astra, "reviewed long ago"));

				await expectAttachWithRebase(mainPi, oldChild.getSessionId(), "review the migration");
			} finally {
				await mainPi.dispose();
			}
		});
	});
});

describe("sessions written before the side chat rename (0.0.19 and older)", () => {
	test("a child with 0.0.19's pi-user-agents-dispatch record attaches through /side-attach and keeps its recorded task", async () => {
		await withTemporaryAgentDir(async (cwd) => {
			const mainPi = await mainProcess(cwd);
			try {
				const oldChild = SessionManager.create(cwd, undefined, { parentSession: mainPi.main.getSessionFile() });
				oldChild.appendCustomEntry("pi-user-agents-dispatch", {
					forwardedArgs: [],
					task: "review the migration, as recorded",
					isolate: false,
				});
				for (const message of mainPi.main.buildSessionContext().messages) oldChild.appendMessage(message as never);
				oldChild.appendMessage({
					role: "user",
					content: "You are running in a forked background process now, concurrently with the main session. review the migration",
					timestamp: 3,
				} as never);
				oldChild.appendMessage(cannedAnswer(mainPi.astra, "reviewed in 0.0.19"));

				await expectAttachWithRebase(mainPi, oldChild.getSessionId(), "review the migration, as recorded");
			} finally {
				await mainPi.dispose();
			}
		});
	});
});
