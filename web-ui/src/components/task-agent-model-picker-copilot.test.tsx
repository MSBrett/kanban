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
}));

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

	it("renders Copilot model and reasoning controls without Cline provider controls", async () => {
		const onAgentSettingsChange = vi.fn();

		await act(async () => {
			root.render(
				<CopilotTaskAgentModelPicker
					agentId={"copilot" as RuntimeAgentId}
					onAgentIdChange={() => {}}
					agentSettings={{
						modelId: "gpt-5.2",
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
		for (const effort of ["none", "low", "medium", "high", "xhigh", "max"]) {
			expect(container.textContent).toContain(effort);
		}
		expect(onAgentSettingsChange).not.toHaveBeenCalled();
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
