import { beforeEach, describe, expect, it, vi } from "vitest";

const commandDiscoveryMocks = vi.hoisted(() => ({
	isBinaryAvailableOnPath: vi.fn(),
}));

vi.mock("../../../src/terminal/command-discovery.js", () => ({
	isBinaryAvailableOnPath: commandDiscoveryMocks.isBinaryAvailableOnPath,
}));

import type { RuntimeConfigState } from "../../../src/config/runtime-config";
import {
	buildRuntimeConfigResponse,
	detectInstalledCommands,
	resolveAgentCommand,
	resolveBundledCodexCommandForPlatform,
} from "../../../src/terminal/agent-registry";

function createRuntimeConfigState(overrides: Partial<RuntimeConfigState> = {}): RuntimeConfigState {
	return {
		globalConfigPath: "/tmp/global-config.json",
		projectConfigPath: "/tmp/project-config.json",
		selectedAgentId: "claude",
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		readyForReviewNotificationsEnabled: true,
		shortcuts: [],
		commitPromptTemplate: "commit",
		openPrPromptTemplate: "pr",
		commitPromptTemplateDefault: "commit",
		openPrPromptTemplateDefault: "pr",
		...overrides,
	};
}

beforeEach(() => {
	commandDiscoveryMocks.isBinaryAvailableOnPath.mockReset();
	commandDiscoveryMocks.isBinaryAvailableOnPath.mockReturnValue(false);
	delete process.env.KANBAN_DEBUG_MODE;
	delete process.env.DEBUG_MODE;
	delete process.env.debug_mode;
});

describe("agent-registry", () => {
	it("detects installed commands from the inherited PATH", () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "claude");

		const detected = detectInstalledCommands();

		expect(detected).toEqual(["claude"]);
		expect(commandDiscoveryMocks.isBinaryAvailableOnPath).toHaveBeenCalledTimes(8);
	});

	it("treats shell-only agents as unavailable", () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "npx");

		const resolved = resolveAgentCommand(createRuntimeConfigState({ selectedAgentId: "claude" }));

		expect(resolved).toBeNull();
	});

	it("uses the current bundled Codex package shim when the native package layout is valid", () => {
		const root = "/repo/node_modules";
		const executablePaths = new Set([
			`${root}/@openai/codex/bin/codex.js`,
			`${root}/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`,
		]);

		const resolved = resolveBundledCodexCommandForPlatform({
			platform: "darwin",
			arch: "arm64",
			resolvePackageJson: (packageName) => {
				if (packageName === "@openai/codex") {
					return `${root}/@openai/codex/package.json`;
				}
				if (packageName === "@openai/codex-darwin-arm64") {
					return `${root}/@openai/codex-darwin-arm64/package.json`;
				}
				return null;
			},
			canExecute: (path) => executablePaths.has(path),
		});

		expect(resolved).toBe(`${root}/@openai/codex/bin/codex.js`);
	});

	it("rejects the obsolete bundled Codex layout that spawned a missing codex/codex binary", () => {
		const root = "/repo/node_modules";
		const executablePaths = new Set([
			`${root}/@openai/codex/bin/codex.js`,
			`${root}/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex`,
		]);

		const resolved = resolveBundledCodexCommandForPlatform({
			platform: "darwin",
			arch: "arm64",
			resolvePackageJson: (packageName) => {
				if (packageName === "@openai/codex") {
					return `${root}/@openai/codex/package.json`;
				}
				if (packageName === "@openai/codex-darwin-arm64") {
					return `${root}/@openai/codex-darwin-arm64/package.json`;
				}
				return null;
			},
			canExecute: (path) => executablePaths.has(path),
		});

		expect(resolved).toBeNull();
	});
});

describe("buildRuntimeConfigResponse", () => {
	it("keeps curated agent default args independent of autonomous mode", () => {
		const config = createRuntimeConfigState({
			agentAutonomousModeEnabled: true,
		});

		const response = buildRuntimeConfigResponse(config, {
			providerId: null,
			modelId: null,
			baseUrl: null,
			apiKeyConfigured: false,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		});

		expect(response.agentAutonomousModeEnabled).toBe(true);
		expect(response.agents.map((agent) => agent.id)).toEqual(["claude", "codex", "cline", "droid", "kiro"]);
		expect(response.agents.find((agent) => agent.id === "claude")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "codex")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "cline")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "droid")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "kiro")?.defaultArgs).toEqual(["chat"]);
		expect(response.agents.find((agent) => agent.id === "cline")?.installed).toBe(true);
	});

	it("omits autonomous flags from curated agent commands when disabled", () => {
		const config = createRuntimeConfigState({
			agentAutonomousModeEnabled: false,
		});
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "claude");

		const response = buildRuntimeConfigResponse(config, {
			providerId: null,
			modelId: null,
			baseUrl: null,
			apiKeyConfigured: false,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		});

		expect(response.agentAutonomousModeEnabled).toBe(false);
		expect(response.agents.map((agent) => agent.id)).toEqual(["claude", "codex", "cline", "droid", "kiro"]);
		expect(response.agents.find((agent) => agent.id === "claude")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "codex")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "cline")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "droid")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "kiro")?.defaultArgs).toEqual(["chat"]);
		expect(response.agents.find((agent) => agent.id === "cline")?.installed).toBe(true);
		expect(response.agents.find((agent) => agent.id === "claude")?.command).toBe("claude");
		expect(response.agents.find((agent) => agent.id === "codex")?.command).toBe("codex");
		expect(response.agents.find((agent) => agent.id === "droid")?.command).toBe("droid");
		expect(response.agents.find((agent) => agent.id === "kiro")?.command).toBe("kiro-cli chat");
	});

	it("sets debug mode from runtime environment variables", () => {
		process.env.KANBAN_DEBUG_MODE = "true";
		const response = buildRuntimeConfigResponse(createRuntimeConfigState(), {
			providerId: null,
			modelId: null,
			baseUrl: null,
			apiKeyConfigured: false,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		});
		expect(response.debugModeEnabled).toBe(true);
	});

	it("supports debug_mode fallback env name", () => {
		process.env.debug_mode = "1";
		const response = buildRuntimeConfigResponse(createRuntimeConfigState(), {
			providerId: null,
			modelId: null,
			baseUrl: null,
			apiKeyConfigured: false,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		});
		expect(response.debugModeEnabled).toBe(true);
	});
});
