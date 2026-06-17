import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearAgentModelCatalogCache, listAgentModels } from "../../../src/terminal/agent-model-catalog";

describe("listAgentModels – codex", () => {
	let tempHome: string;
	let previousCodexHome: string | undefined;

	beforeEach(() => {
		clearAgentModelCatalogCache();
		tempHome = mkdtempSync(join(tmpdir(), "kanban-codex-models-"));
		previousCodexHome = process.env.CODEX_HOME;
		process.env.CODEX_HOME = tempHome;
	});

	afterEach(() => {
		clearAgentModelCatalogCache();
		if (previousCodexHome === undefined) {
			delete process.env.CODEX_HOME;
		} else {
			process.env.CODEX_HOME = previousCodexHome;
		}
		rmSync(tempHome, { recursive: true, force: true });
	});

	function writeCache(contents: unknown): void {
		writeFileSync(join(tempHome, "models_cache.json"), JSON.stringify(contents), "utf8");
	}

	it("maps listable api models with their per-model reasoning efforts", async () => {
		writeCache({
			models: [
				{
					slug: "gpt-5.5",
					display_name: "GPT-5.5",
					default_reasoning_level: "medium",
					supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }],
					visibility: "list",
					supported_in_api: true,
				},
			],
		});

		const models = await listAgentModels("codex");
		expect(models).toEqual([
			{
				id: "gpt-5.5",
				label: "GPT-5.5",
				supportsReasoning: true,
				reasoningEfforts: ["low", "medium", "high", "xhigh"],
				defaultReasoningEffort: "medium",
			},
		]);
	});

	it("includes listed models even when not API-supported, but excludes hidden codex-internal models", async () => {
		writeCache({
			models: [
				{ slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", supported_in_api: true },
				{ slug: "codex-auto-review", display_name: "Auto Review", visibility: "hide", supported_in_api: true },
				{ slug: "gpt-5.3-codex-spark", display_name: "Spark", visibility: "list", supported_in_api: false },
			],
		});

		const models = await listAgentModels("codex");
		// gpt-5.3-codex-spark is shown in codex's own picker (visibility=list) so
		// it must appear even though supported_in_api is false; the hidden
		// auto-review model is excluded.
		expect(models.map((model) => model.id)).toEqual(["gpt-5.5", "gpt-5.3-codex-spark"]);
	});

	it("returns an empty list when the cache is missing or malformed", async () => {
		const missing = await listAgentModels("codex");
		expect(missing).toEqual([]);

		clearAgentModelCatalogCache();
		writeFileSync(join(tempHome, "models_cache.json"), "{ not json", "utf8");
		const malformed = await listAgentModels("codex");
		expect(malformed).toEqual([]);
	});
});
