import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { RuntimeConfigState } from "../config/runtime-config";
import { getRuntimeLaunchSupportedAgentCatalog, RUNTIME_AGENT_CATALOG } from "../core/agent-catalog";
import type {
	RuntimeAgentDefinition,
	RuntimeAgentId,
	RuntimeClineProviderSettings,
	RuntimeConfigResponse,
} from "../core/api-contract";
import { resolveKanbanCommandLine } from "../core/kanban-command";
import { isBinaryAvailableOnPath } from "./command-discovery";

const require = createRequire(import.meta.url);

const CODEX_PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
	"x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
	"aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
	"x86_64-apple-darwin": "@openai/codex-darwin-x64",
	"aarch64-apple-darwin": "@openai/codex-darwin-arm64",
	"x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
	"aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
};

export interface ResolvedAgentCommand {
	agentId: RuntimeAgentId;
	label: string;
	command: string;
	binary: string;
	args: string[];
}

function getDefaultArgs(agentId: RuntimeAgentId): string[] {
	const entry = RUNTIME_AGENT_CATALOG.find((candidate) => candidate.id === agentId);
	if (!entry) {
		return [];
	}
	return [...entry.baseArgs];
}

function quoteForDisplay(part: string): string {
	if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(part)) {
		return part;
	}
	return JSON.stringify(part);
}

function joinCommand(binary: string, args: string[]): string {
	if (args.length === 0) {
		return binary;
	}
	return [binary, ...args.map(quoteForDisplay)].join(" ");
}

function canExecuteFile(path: string): boolean {
	try {
		accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function resolvePackageJsonPath(packageName: string): string | null {
	try {
		return require.resolve(`${packageName}/package.json`);
	} catch {
		return null;
	}
}

function resolveCodexTargetTriple(platform: NodeJS.Platform, arch: string): string | null {
	if (platform === "darwin") {
		if (arch === "arm64") {
			return "aarch64-apple-darwin";
		}
		if (arch === "x64") {
			return "x86_64-apple-darwin";
		}
		return null;
	}
	if (platform === "linux" || platform === "android") {
		if (arch === "arm64") {
			return "aarch64-unknown-linux-musl";
		}
		if (arch === "x64") {
			return "x86_64-unknown-linux-musl";
		}
		return null;
	}
	if (platform === "win32") {
		if (arch === "arm64") {
			return "aarch64-pc-windows-msvc";
		}
		if (arch === "x64") {
			return "x86_64-pc-windows-msvc";
		}
	}
	return null;
}

export interface ResolveBundledCodexCommandOptions {
	platform: NodeJS.Platform;
	arch: string;
	resolvePackageJson: (packageName: string) => string | null;
	canExecute: (path: string) => boolean;
}

export function resolveBundledCodexCommandForPlatform({
	platform,
	arch,
	resolvePackageJson,
	canExecute,
}: ResolveBundledCodexCommandOptions): string | null {
	const targetTriple = resolveCodexTargetTriple(platform, arch);
	if (!targetTriple) {
		return null;
	}
	const platformPackage = CODEX_PLATFORM_PACKAGE_BY_TARGET[targetTriple];
	if (!platformPackage) {
		return null;
	}
	const packageJsonPath = resolvePackageJson("@openai/codex");
	const platformPackageJsonPath = resolvePackageJson(platformPackage);
	if (!packageJsonPath || !platformPackageJsonPath) {
		return null;
	}

	const nativeBinary = join(
		dirname(platformPackageJsonPath),
		"vendor",
		targetTriple,
		"bin",
		platform === "win32" ? "codex.exe" : "codex",
	);
	if (!canExecute(nativeBinary)) {
		return null;
	}

	if (platform === "win32") {
		return nativeBinary;
	}

	const packageShim = join(dirname(packageJsonPath), "bin", "codex.js");
	return canExecute(packageShim) ? packageShim : nativeBinary;
}

function resolveBundledCodexCommand(): string | null {
	return resolveBundledCodexCommandForPlatform({
		platform: process.platform,
		arch: process.arch,
		resolvePackageJson: resolvePackageJsonPath,
		canExecute: canExecuteFile,
	});
}

function parseBooleanEnvValue(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isRuntimeDebugModeEnabled(): boolean {
	const debugModeValue = process.env.KANBAN_DEBUG_MODE ?? process.env.DEBUG_MODE ?? process.env.debug_mode;
	return parseBooleanEnvValue(debugModeValue);
}

export function detectInstalledCommands(): string[] {
	const candidates = [...RUNTIME_AGENT_CATALOG.map((entry) => entry.binary), "npx"];
	const detected: string[] = [];

	for (const candidate of candidates) {
		if (isBinaryAvailableOnPath(candidate)) {
			detected.push(candidate);
		}
	}

	return detected;
}

function getCuratedDefinitions(runtimeConfig: RuntimeConfigState, detected: string[]): RuntimeAgentDefinition[] {
	const detectedSet = new Set(detected);
	return getRuntimeLaunchSupportedAgentCatalog().map((entry) => {
		const defaultArgs = getDefaultArgs(entry.id);
		const command = joinCommand(entry.binary, defaultArgs);
		const isInstalled = entry.id === "cline" ? true : detectedSet.has(entry.binary);
		return {
			id: entry.id,
			label: entry.label,
			binary: entry.binary,
			command,
			defaultArgs,
			installed: isInstalled,
			configured: runtimeConfig.selectedAgentId === entry.id,
		};
	});
}

export function resolveAgentCommand(runtimeConfig: RuntimeConfigState): ResolvedAgentCommand | null {
	const selected = getRuntimeLaunchSupportedAgentCatalog().find((entry) => entry.id === runtimeConfig.selectedAgentId);
	if (!selected) {
		return null;
	}
	const defaultArgs = getDefaultArgs(selected.id);
	const command = joinCommand(selected.binary, defaultArgs);
	if (isBinaryAvailableOnPath(selected.binary)) {
		return {
			agentId: selected.id,
			label: selected.label,
			command,
			binary: selected.binary,
			args: defaultArgs,
		};
	}
	const bundledCodexCommand = selected.id === "codex" ? resolveBundledCodexCommand() : null;
	if (bundledCodexCommand) {
		const bundledCommand = joinCommand(bundledCodexCommand, defaultArgs);
		return {
			agentId: selected.id,
			label: selected.label,
			command: bundledCommand,
			binary: bundledCodexCommand,
			args: defaultArgs,
		};
	}
	return null;
}

export function buildRuntimeConfigResponse(
	runtimeConfig: RuntimeConfigState,
	clineProviderSettings: RuntimeClineProviderSettings,
): RuntimeConfigResponse {
	const detectedCommands = detectInstalledCommands();
	const agents = getCuratedDefinitions(runtimeConfig, detectedCommands);
	const resolved = resolveAgentCommand(runtimeConfig);
	const effectiveCommand = resolved ? joinCommand(resolved.binary, resolved.args) : null;

	return {
		selectedAgentId: runtimeConfig.selectedAgentId,
		selectedShortcutLabel: runtimeConfig.selectedShortcutLabel,
		agentAutonomousModeEnabled: runtimeConfig.agentAutonomousModeEnabled,
		debugModeEnabled: isRuntimeDebugModeEnabled(),
		effectiveCommand,
		globalConfigPath: runtimeConfig.globalConfigPath,
		projectConfigPath: runtimeConfig.projectConfigPath,
		readyForReviewNotificationsEnabled: runtimeConfig.readyForReviewNotificationsEnabled,
		detectedCommands,
		agents,
		shortcuts: runtimeConfig.shortcuts,
		clineProviderSettings,
		kanbanCommand: resolveKanbanCommandLine(),
		commitPromptTemplate: runtimeConfig.commitPromptTemplate,
		openPrPromptTemplate: runtimeConfig.openPrPromptTemplate,
		commitPromptTemplateDefault: runtimeConfig.commitPromptTemplateDefault,
		openPrPromptTemplateDefault: runtimeConfig.openPrPromptTemplateDefault,
	};
}
