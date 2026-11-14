import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModelItems } from "../autocomplete.ts";
import { createEditorHarness } from "./editor-harness.ts";

type Model = { provider: string; id: string; name?: string };

/** The model references a typed -m value lists, in menu order. */
function order(fragment: string, models: readonly Model[], scoped: readonly Model[] = []): string[] {
	return getModelItems(fragment, models, scoped).map((item) => item.value);
}

/** Like Gilad's setup: each scoped model carries his alias as its models.json name. */
const SCOPED: readonly Model[] = [
	{ provider: "openai-codex", id: "gpt-6.1-sol", name: "gpt61s" },
	{ provider: "openai-codex", id: "gpt-6.1-terra", name: "gpt61t" },
	{ provider: "openai-codex", id: "gpt-6-luna", name: "gpt6l" },
	{ provider: "openai-codex", id: "gpt-6-astra", name: "gpt6a" },
	{ provider: "anthropic", id: "claude-opus-5-5", name: "opus" },
	{ provider: "anthropic", id: "claude-sonnet-5-5", name: "sonnet" },
];

/** Built-in catalog entries as the screenshots show them, in registry order, with the scoped ones last. */
const CATALOG: readonly Model[] = [
	{ provider: "azure", id: "gpt-4", name: "GPT-4" },
	{ provider: "azure", id: "gpt-4-turbo", name: "GPT-4 Turbo" },
	{ provider: "azure", id: "gpt-4.1", name: "GPT-4.1" },
	{ provider: "azure", id: "gpt-4.1-mini", name: "GPT-4.1 mini" },
	{ provider: "azure", id: "gpt-4.1-nano", name: "GPT-4.1 nano" },
	{ provider: "azure", id: "gpt-6-sol", name: "GPT-6 Sol" },
	{ provider: "openai", id: "gpt-6-sol", name: "GPT-6 Sol" },
	{ provider: "radius", id: "gpt-6-sol", name: "GPT 6 Sol" },
	{ provider: "azure", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
	{ provider: "azure", id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
	{ provider: "radius", id: "claude-opus-4-5", name: "Claude Opus 4.5" },
	{ provider: "radius", id: "claude-opus-4-8", name: "Claude Opus 4.8" },
	{ provider: "radius", id: "claude-opus-5", name: "Claude Opus 5" },
	{ provider: "radius", id: "claude-opus-5-5", name: "Claude Opus 5.5" },
	{ provider: "opencode", id: "claude-opus-4-5", name: "Claude Opus 4.5" },
	...SCOPED,
];

describe("#21: scoped and aliased models stay ahead while typing", () => {
	test("screenshot 1, 'sol': the scoped gpt-6.1-sol leads, ahead of azure/, openai/ and radius/", () => {
		expect(order("sol", CATALOG, SCOPED)[0]).toBe("openai-codex/gpt-6.1-sol");
	});

	test("screenshot 2, 'gpt': the four scoped GPT models lead, ahead of azure/gpt-4", () => {
		expect(new Set(order("gpt", CATALOG, SCOPED).slice(0, 4))).toEqual(
			new Set([
				"openai-codex/gpt-6.1-sol",
				"openai-codex/gpt-6.1-terra",
				"openai-codex/gpt-6-luna",
				"openai-codex/gpt-6-astra",
			]),
		);
	});

	test("screenshot 3, 'opus': the scoped claude-opus-5-5 (alias opus) is ahead of every unscoped match", () => {
		const listed = order("opus", CATALOG, SCOPED);
		const firstUnscoped = listed.findIndex((reference) => !reference.startsWith("anthropic/"));
		expect(listed.indexOf("anthropic/claude-opus-5-5")).toBeLessThan(firstUnscoped);
		expect(listed[firstUnscoped]).toStartWith("radius/");
	});

	test("typing never lists a model that does not match, scoped or not", () => {
		expect(order("radius", CATALOG, SCOPED).every((reference) => reference.startsWith("radius/"))).toBe(true);
	});

	test("the empty list keeps its order: scoped first, then the catalog as registered", () => {
		const expected = [...SCOPED, ...CATALOG.filter((model) => !SCOPED.includes(model))].map(
			(model) => `${model.provider}/${model.id}`,
		);
		expect(order("", CATALOG, SCOPED)).toEqual(expected);
	});

	test("in the editor, typing sol after /side -m completes to the scoped model", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-side-chat-model-order-"));
		try {
			await mkdir(join(cwd, ".pi"));
			await writeFile(
				join(cwd, ".pi", "settings.json"),
				JSON.stringify({ enabledModels: SCOPED.map((model) => `${model.provider}/${model.id}`) }),
			);
			const harness = await createEditorHarness(cwd, CATALOG);
			harness.type("/side -m");
			await harness.waitForRender((rendered) => rendered.includes("-m <model>"));
			harness.press("\t");
			harness.type("sol");
			await harness.waitForRender((rendered) => rendered.includes("openai-codex/gpt-6.1-sol"));
			harness.press("\t");
			expect(harness.editor.getText()).toBe("/side -m openai-codex/gpt-6.1-sol ");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

describe("#22: among otherwise equal matches, the higher version comes first", () => {
	test("screenshot 3's radius/ models: 5-5, 5, 4-8, 4-5", () => {
		expect(order("opus", CATALOG, SCOPED).filter((reference) => reference.startsWith("radius/"))).toEqual([
			"radius/claude-opus-5-5",
			"radius/claude-opus-5",
			"radius/claude-opus-4-8",
			"radius/claude-opus-4-5",
		]);
	});

	test("screenshot 1's azure/ sol models: 6.1, 6, 5.6", () => {
		expect(order("sol", CATALOG, SCOPED).filter((reference) => reference.startsWith("azure/"))).toEqual([
			"azure/gpt-6.1-sol",
			"azure/gpt-6-sol",
			"azure/gpt-5.6-sol",
		]);
	});

	test("rule 1: dashes and dots both separate version parts", () => {
		expect(order("opus", [{ provider: "x", id: "opus-4-2" }, { provider: "x", id: "opus-4-5" }])).toEqual([
			"x/opus-4-5",
			"x/opus-4-2",
		]);
		expect(order("opus", [{ provider: "x", id: "opus-4.2" }, { provider: "x", id: "opus-4.5" }])).toEqual([
			"x/opus-4.5",
			"x/opus-4.2",
		]);
	});

	test("rule 2: opus-5 is higher than opus-4-5 and opus-4.5", () => {
		expect(order("opus", [{ provider: "x", id: "opus-4-5" }, { provider: "x", id: "opus-5" }])).toEqual([
			"x/opus-5",
			"x/opus-4-5",
		]);
		expect(order("opus", [{ provider: "x", id: "opus-4.5" }, { provider: "x", id: "opus-5" }])).toEqual([
			"x/opus-5",
			"x/opus-4.5",
		]);
	});

	test("rule 3: case does not matter", () => {
		expect(order("opus", [{ provider: "x", id: "Opus-4-5" }, { provider: "x", id: "opus-5" }])).toEqual([
			"x/opus-5",
			"x/Opus-4-5",
		]);
	});

	test("rule 4: the version can sit anywhere in the name", () => {
		expect(order("terra", [{ provider: "x", id: "gpt-6-terra" }, { provider: "x", id: "gpt-6.1-terra" }])).toEqual([
			"x/gpt-6.1-terra",
			"x/gpt-6-terra",
		]);
		expect(order("madeup", [{ provider: "fooprovider", id: "2-madeup" }, { provider: "fooprovider", id: "3-madeup" }])).toEqual([
			"fooprovider/3-madeup",
			"fooprovider/2-madeup",
		]);
	});

	test("rule 5: names that differ in more than the version keep their order, even with a higher version", () => {
		const models = [
			{ provider: "foo", id: "bar-4-pro" },
			{ provider: "foo", id: "bar-4-flash" },
			{ provider: "foo", id: "bar-5-flash" },
		];
		expect(order("bar", models)).toEqual(["foo/bar-4-pro", "foo/bar-5-flash", "foo/bar-4-flash"]);
	});

	test("pitfall case 1: no two DeepSeek ids differ only in one version number, so none moves", () => {
		const models = [
			"DeepSeek-V4-Flash-0731",
			"DeepSeek-V4.1-Flash-1017",
			"DeepSeek-V4.1-Flash-1017-Fast",
			"DeepSeek-V4.1-Flash-Fast",
			"DeepSeek-V4-Pro-0813",
		].map((id) => ({ provider: "baseten", id: `deepseek-ai/${id}` }));
		expect(order("deepseek", models)).toEqual(models.map((model) => `${model.provider}/${model.id}`));
	});

	test("pitfall case 2: the higher trailing number comes first", () => {
		expect(
			order("deepseek", [
				{ provider: "baseten", id: "deepseek-ai/DeepSeek-V4-Flash-731" },
				{ provider: "baseten", id: "deepseek-ai/DeepSeek-V4-Flash-1731" },
			]),
		).toEqual(["baseten/deepseek-ai/DeepSeek-V4-Flash-1731", "baseten/deepseek-ai/DeepSeek-V4-Flash-731"]);
	});

	test("a typed digit takes part in the match, so the fuzzy order stands", () => {
		const models = [
			{ provider: "x", id: "gpt-6-sol" },
			{ provider: "x", id: "gpt-6.1-sol" },
		];
		expect(order("gpt-6-sol", models)[0]).toBe("x/gpt-6-sol");
	});
});
