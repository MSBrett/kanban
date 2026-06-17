import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RuntimeAgentId, RuntimeAgentModelInfo } from "../core/api-contract";
import { resolveBinaryPathOnPath } from "./command-discovery";

// Live model catalogs for terminal agents. Model ids and per-model reasoning
// efforts are sourced from each agent's own install — never hardcoded in
// Kanban — so the picker always reflects what the installed CLI actually
// accepts for `--model` and which reasoning levels each model supports:
//   - copilot: the GitHub Copilot CLI SDK `listModels()` (handles its own auth)
//   - codex:   the codex on-disk model cache (`~/.codex/models_cache.json`)
//
// Results are cached briefly so opening the task dialog repeatedly does not
// re-spawn the copilot server or re-read disk on every keystroke.

const CACHE_TTL_MS = 5 * 60 * 1000;
const COPILOT_LIST_TIMEOUT_MS = 30_000;

interface CacheEntry {
	expiresAt: number;
	models: RuntimeAgentModelInfo[];
}

const cache = new Map<RuntimeAgentId, CacheEntry>();

export function clearAgentModelCatalogCache(): void {
	cache.clear();
}

export async function listAgentModels(agentId: RuntimeAgentId): Promise<RuntimeAgentModelInfo[]> {
	const cached = cache.get(agentId);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.models;
	}
	const models = await loadAgentModels(agentId);
	cache.set(agentId, { expiresAt: Date.now() + CACHE_TTL_MS, models });
	return models;
}

async function loadAgentModels(agentId: RuntimeAgentId): Promise<RuntimeAgentModelInfo[]> {
	try {
		if (agentId === "copilot") {
			return await loadCopilotModels();
		}
		if (agentId === "codex") {
			return await loadCodexModels();
		}
	} catch {
		// Enumeration is best-effort: a missing/old CLI or unreadable cache must
		// degrade to an empty list (the UI falls back to free-text entry), never
		// break opening the task dialog.
		return [];
	}
	return [];
}

// ---------------------------------------------------------------------------
// Copilot — drive the installed GitHub Copilot CLI SDK via a short-lived
// Node helper so Kanban does not need `@github/copilot` as a dependency and is
// isolated from the SDK's CJS/ESM internals.
// ---------------------------------------------------------------------------

async function loadCopilotModels(): Promise<RuntimeAgentModelInfo[]> {
	const sdkEntry = await resolveCopilotSdkEntry();
	if (!sdkEntry) {
		return [];
	}
	const raw = await runCopilotModelsHelper(sdkEntry);
	if (!raw) {
		return [];
	}
	return normalizeFetchedModels(raw);
}

async function resolveCopilotSdkEntry(): Promise<string | null> {
	const binaryPath = resolveBinaryPathOnPath("copilot");
	if (!binaryPath) {
		return null;
	}
	let resolved = binaryPath;
	try {
		resolved = await realpath(binaryPath);
	} catch {
		resolved = binaryPath;
	}
	return join(dirname(resolved), "copilot-sdk", "index.js");
}

const COPILOT_HELPER_SCRIPT = `
const { CopilotClient } = await import(process.env.KANBAN_COPILOT_SDK_PATH);
const client = new CopilotClient();
try {
	await client.start();
	const models = await client.listModels();
	const out = models.map((m) => ({
		id: m.id,
		name: m.name,
		supportsReasoning: Boolean(m.capabilities?.supports?.reasoningEffort),
		reasoningEfforts: Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : [],
		defaultReasoningEffort: m.defaultReasoningEffort ?? null,
	}));
	process.stdout.write(JSON.stringify(out));
} catch (error) {
	process.stderr.write(String(error?.message ?? error));
	process.exitCode = 1;
} finally {
	try {
		if (typeof client.stop === "function") {
			await client.stop();
		} else if (typeof client.disconnect === "function") {
			await client.disconnect();
		}
	} catch {}
	process.exit(process.exitCode ?? 0);
}
`;

interface FetchedModel {
	id?: unknown;
	name?: unknown;
	supportsReasoning?: unknown;
	reasoningEfforts?: unknown;
	defaultReasoningEffort?: unknown;
}

function runCopilotModelsHelper(sdkEntry: string): Promise<FetchedModel[] | null> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", COPILOT_HELPER_SCRIPT], {
			env: { ...process.env, KANBAN_COPILOT_SDK_PATH: sdkEntry },
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let settled = false;
		const finish = (value: FetchedModel[] | null) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};

		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(null);
		}, COPILOT_LIST_TIMEOUT_MS);

		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.on("error", () => finish(null));
		child.on("close", (code) => {
			if (code !== 0) {
				finish(null);
				return;
			}
			try {
				const parsed = JSON.parse(stdout) as unknown;
				finish(Array.isArray(parsed) ? (parsed as FetchedModel[]) : null);
			} catch {
				finish(null);
			}
		});
	});
}

function normalizeFetchedModels(raw: FetchedModel[]): RuntimeAgentModelInfo[] {
	const models: RuntimeAgentModelInfo[] = [];
	for (const entry of raw) {
		const id = typeof entry.id === "string" ? entry.id.trim() : "";
		if (!id) {
			continue;
		}
		const reasoningEfforts = Array.isArray(entry.reasoningEfforts)
			? entry.reasoningEfforts.filter((value): value is string => typeof value === "string")
			: [];
		const defaultReasoningEffort =
			typeof entry.defaultReasoningEffort === "string" ? entry.defaultReasoningEffort : null;
		models.push({
			id,
			label: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : id,
			supportsReasoning: entry.supportsReasoning === true && reasoningEfforts.length > 0,
			reasoningEfforts,
			defaultReasoningEffort,
		});
	}
	return models;
}

// ---------------------------------------------------------------------------
// Codex — read the model cache codex maintains on disk. Each entry carries its
// own supported reasoning levels, so reasoning is per-model just like copilot.
// ---------------------------------------------------------------------------

interface CodexCachedReasoningLevel {
	effort?: unknown;
}

interface CodexCachedModel {
	slug?: unknown;
	display_name?: unknown;
	default_reasoning_level?: unknown;
	supported_reasoning_levels?: unknown;
	visibility?: unknown;
	supported_in_api?: unknown;
}

interface CodexModelsCache {
	models?: unknown;
}

function getCodexHome(): string {
	const fromEnv = process.env.CODEX_HOME?.trim();
	return fromEnv ? fromEnv : join(homedir(), ".codex");
}

async function loadCodexModels(): Promise<RuntimeAgentModelInfo[]> {
	const cachePath = join(getCodexHome(), "models_cache.json");
	let contents: string;
	try {
		contents = await readFile(cachePath, "utf8");
	} catch {
		return [];
	}
	let parsed: CodexModelsCache;
	try {
		parsed = JSON.parse(contents) as CodexModelsCache;
	} catch {
		return [];
	}
	if (!Array.isArray(parsed.models)) {
		return [];
	}
	const models: RuntimeAgentModelInfo[] = [];
	for (const entry of parsed.models as CodexCachedModel[]) {
		const slug = typeof entry.slug === "string" ? entry.slug.trim() : "";
		if (!slug) {
			continue;
		}
		// Mirror codex's own model picker, which shows entries whose
		// `visibility` is "list". Hidden entries (e.g. the internal
		// "codex-auto-review" model) are not user-selectable. We intentionally
		// do NOT gate on `supported_in_api`: Kanban launches codex as an
		// interactive TUI via `-m`, where any listed model is selectable, so a
		// model like gpt-5.3-codex-spark (listed but supported_in_api=false)
		// must still appear.
		if (entry.visibility !== undefined && entry.visibility !== "list") {
			continue;
		}
		const reasoningEfforts = Array.isArray(entry.supported_reasoning_levels)
			? (entry.supported_reasoning_levels as CodexCachedReasoningLevel[])
					.map((level) => (typeof level.effort === "string" ? level.effort : ""))
					.filter((effort): effort is string => effort.length > 0)
			: [];
		const defaultReasoningEffort =
			typeof entry.default_reasoning_level === "string" ? entry.default_reasoning_level : null;
		models.push({
			id: slug,
			label: typeof entry.display_name === "string" && entry.display_name.trim() ? entry.display_name.trim() : slug,
			supportsReasoning: reasoningEfforts.length > 0,
			reasoningEfforts,
			defaultReasoningEffort,
		});
	}
	return models;
}
