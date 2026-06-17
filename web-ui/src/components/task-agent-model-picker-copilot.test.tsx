import { act, type ComponentProps, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskAgentModelPicker } from "@/components/task-agent-model-picker";
import type { RuntimeAgentId, RuntimeTaskAgentSettings } from "@/runtime/types";

vi.mock("@runtime-agent-catalog", () => ({
	getRuntimeLaunchSupportedAgentCatalog: vi.fn(() => [
		{ id: "cline", label: "Cline", binary: "cline" },
		{ id: "codex", label: "OpenAI Codex", binary: "codex" },
		{ id: "copilot", label: "GitHub Copilot", binary: "copilot" },
	]),
}));

vi.mock("@/runtime/runtime-config-query", () => ({
	fetchClineProviderCatalog: vi.fn(async () => []),
	fetchClineProviderModels: vi.fn(async () => []),
	fetchAgentModels: vi.fn(async () => []),
}));

const COPILOT_MODELS = [
	{
		id: "claude-sonnet-4.5",
		label: "Claude Sonnet 4.5",
		supportsReasoning: false,
		reasoningEfforts: [] as string[],
		defaultReasoningEffort: null,
	},
	{
		id: "gpt-5.4",
		label: "GPT-5.4",
		supportsReasoning: true,
		reasoningEfforts: ["low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "medium",
	},
];

type CopilotTaskAgentModelPickerProps = ComponentProps<typeof TaskAgentModelPicker> & {
	agentSettings?: RuntimeTaskAgentSettings;
	onAgentSettingsChange?: (value: RuntimeTaskAgentSettings | undefined) => void;
};

const CopilotTaskAgentModelPicker = TaskAgentModelPicker as unknown as ComponentType<CopilotTaskAgentModelPickerProps>;

function findButtonByText(container: ParentNode, text: string): HTMLButtonElement | null {
	return (Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === text) ??
		null) as HTMLButtonElement | null;
}

describe("TaskAgentModelPicker – Copilot settings", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		document.body.innerHTML = "";
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
		vi.restoreAllMocks();
	});

	it("renders Copilot model dropdown and per-model reasoning efforts from the live catalog", async () => {
		const onAgentSettingsChange = vi.fn();

		await act(async () => {
			root.render(
				<CopilotTaskAgentModelPicker
					agentId={"copilot" as RuntimeAgentId}
					onAgentIdChange={() => {}}
					agentSettings={{
						modelId: "gpt-5.4",
						reasoningEffort: "xhigh",
					}}
					onAgentSettingsChange={onAgentSettingsChange}
					clineSettings={undefined}
					onClineSettingsChange={() => {}}
					agentOptions={[
						{ value: "", label: "OpenAI Codex" },
						{ value: "copilot", label: "GitHub Copilot" },
						{ value: "cline", label: "Cline" },
					]}
					clineProviderOptions={[]}
					clineModelOptions={[]}
					isLoadingProviders={false}
					isLoadingModels={false}
					defaultAgentId={"codex" as RuntimeAgentId}
					defaultProviderId={null}
					agentModels={COPILOT_MODELS}
					isLoadingAgentModels={false}
				/>,
			);
		});

		const settingsTrigger = findButtonByText(container, "Override Agent Settings");
		expect(settingsTrigger).toBeInstanceOf(HTMLButtonElement);
		await act(async () => {
			settingsTrigger?.click();
		});

		expect(container.textContent).toContain("Model");
		expect(container.textContent).toContain("Reasoning effort");
		expect(container.textContent).not.toContain("Provider");
		// The model's own efforts are shown — including xhigh, which the old
		// hardcoded list happened to share — but NOT levels the model never
		// declares (e.g. copilot's old hardcoded "none"/"max").
		for (const effort of ["low", "medium", "high", "xhigh"]) {
			expect(container.textContent).toContain(effort);
		}
		expect(container.textContent).not.toContain("max");
		// Model dropdown is populated from the live catalog.
		expect(container.textContent).toContain("Claude Sonnet 4.5");
		expect(container.textContent).toContain("GPT-5.4");
		expect(onAgentSettingsChange).not.toHaveBeenCalled();
	});

	it("hides reasoning effort for a model that does not support reasoning", async () => {
		const onAgentSettingsChange = vi.fn();

		await act(async () => {
			root.render(
				<CopilotTaskAgentModelPicker
					agentId={"copilot" as RuntimeAgentId}
					onAgentIdChange={() => {}}
					agentSettings={{ modelId: "claude-sonnet-4.5" }}
					onAgentSettingsChange={onAgentSettingsChange}
					clineSettings={undefined}
					onClineSettingsChange={() => {}}
					agentOptions={[
						{ value: "", label: "OpenAI Codex" },
						{ value: "copilot", label: "GitHub Copilot" },
					]}
					clineProviderOptions={[]}
					clineModelOptions={[]}
					isLoadingProviders={false}
					isLoadingModels={false}
					defaultAgentId={"codex" as RuntimeAgentId}
					defaultProviderId={null}
					agentModels={COPILOT_MODELS}
					isLoadingAgentModels={false}
				/>,
			);
		});

		const settingsTrigger = findButtonByText(container, "Override Agent Settings");
		await act(async () => {
			settingsTrigger?.click();
		});

		expect(container.textContent).toContain("Model");
		expect(container.textContent).not.toContain("Reasoning effort");
	});

	it("clears Copilot settings when switching to a non-Copilot agent", async () => {
		const onAgentIdChange = vi.fn();
		const onAgentSettingsChange = vi.fn();

		await act(async () => {
			root.render(
				<CopilotTaskAgentModelPicker
					agentId={"copilot" as RuntimeAgentId}
					onAgentIdChange={onAgentIdChange}
					agentSettings={{
						modelId: "gpt-5.2",
						reasoningEffort: "max",
					}}
					onAgentSettingsChange={onAgentSettingsChange}
					clineSettings={undefined}
					onClineSettingsChange={() => {}}
					agentOptions={[
						{ value: "", label: "OpenAI Codex" },
						{ value: "copilot", label: "GitHub Copilot" },
						{ value: "codex", label: "OpenAI Codex" },
					]}
					clineProviderOptions={[]}
					clineModelOptions={[]}
					isLoadingProviders={false}
					isLoadingModels={false}
					defaultAgentId={"codex" as RuntimeAgentId}
					defaultProviderId={null}
				/>,
			);
		});

		const settingsTrigger = findButtonByText(container, "Override Agent Settings");
		expect(settingsTrigger).toBeInstanceOf(HTMLButtonElement);
		await act(async () => {
			settingsTrigger?.click();
		});

		const agentSelect = container.querySelector("select");
		expect(agentSelect).toBeInstanceOf(HTMLSelectElement);
		await act(async () => {
			if (!agentSelect) {
				throw new Error("Expected agent select.");
			}
			agentSelect.value = "codex";
			agentSelect.dispatchEvent(new Event("change", { bubbles: true }));
		});

		expect(onAgentIdChange).toHaveBeenCalledWith("codex");
		expect(onAgentSettingsChange).toHaveBeenCalledWith(undefined);
	});
});
