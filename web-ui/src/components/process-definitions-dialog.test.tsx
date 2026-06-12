import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProcessDefinitionsDialog } from "@/components/process-definitions-dialog";
import type { TaskProcessDefinition } from "@/types";

function findButtonByText(container: ParentNode, text: string): HTMLButtonElement | null {
	return (Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === text) ??
		null) as HTMLButtonElement | null;
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
	const descriptor = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");
	descriptor?.set?.call(textarea, value);
	textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function setInputValue(input: HTMLInputElement, value: string): void {
	const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
	descriptor?.set?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setFileInput(input: HTMLInputElement, file: File): void {
	Object.defineProperty(input, "files", {
		configurable: true,
		value: [file],
	});
	input.dispatchEvent(new Event("change", { bubbles: true }));
}

function readBlobText(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
		reader.addEventListener("error", () => reject(reader.error ?? new Error("Could not read blob text.")));
		reader.readAsText(blob);
	});
}

describe("ProcessDefinitionsDialog", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let originalCreateObjectUrl: ((obj: Blob | MediaSource) => string) | undefined;
	let originalRevokeObjectUrl: ((url: string) => void) | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		originalCreateObjectUrl = URL.createObjectURL;
		originalRevokeObjectUrl = URL.revokeObjectURL;
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
		if (originalCreateObjectUrl) {
			URL.createObjectURL = originalCreateObjectUrl;
		} else {
			Reflect.deleteProperty(URL, "createObjectURL");
		}
		if (originalRevokeObjectUrl) {
			URL.revokeObjectURL = originalRevokeObjectUrl;
		} else {
			Reflect.deleteProperty(URL, "revokeObjectURL");
		}
	});

	it("imports process JSON and saves it as a custom definition", async () => {
		const onOpenChange = vi.fn();
		const onProcessDefinitionsChange = vi.fn();
		const importedProcess = {
			schemaVersion: 1,
			id: "uat-json-process",
			name: "UAT JSON Process",
			initial: "pending",
			states: {
				pending: { label: "Pending", on: { pass: "swe" } },
				swe: {
					label: "SWE",
					role: "swe",
					agentId: "codex",
					prompt: "Do the work and record evidence.",
					on: { fail: "pending", pass: "done" },
					conditions: [
						{
							verdict: "fail",
							path: "agent",
							equals: "user",
							target: "research",
							label: "User rejection restarts research.",
						},
					],
				},
				research: {
					label: "Research",
					role: "research",
					agentId: "codex",
					prompt: "Research the rejected direction.",
					on: { pass: "swe" },
				},
				done: { label: "Done", terminal: true, on: {} },
			},
		};

		await act(async () => {
			root.render(
				<ProcessDefinitionsDialog
					open
					onOpenChange={onOpenChange}
					processDefinitions={[]}
					processUsageById={{ "uat-json-process": 2 }}
					onProcessDefinitionsChange={onProcessDefinitionsChange}
				/>,
			);
		});

		const jsonButton = findButtonByText(document.body, "JSON");
		expect(jsonButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			jsonButton?.click();
		});

		const jsonTextarea = Array.from(document.body.querySelectorAll("textarea")).find((textarea) =>
			textarea.placeholder.includes("process JSON"),
		);
		expect(jsonTextarea).toBeInstanceOf(HTMLTextAreaElement);

		await act(async () => {
			if (!jsonTextarea) {
				return;
			}
			setTextareaValue(jsonTextarea, JSON.stringify(importedProcess));
		});

		const importButton = findButtonByText(document.body, "Import JSON");
		expect(importButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			importButton?.click();
		});

		expect(document.body.textContent).toContain("UAT JSON Process");
		expect(document.body.textContent).toContain("Route Preview");
		expect(document.body.textContent).toContain("assigned cards 2");
		expect(document.body.textContent).toContain("Assigned cards keep captured definitions");
		expect(document.body.textContent).toContain("prompts 2/2");
		expect(document.body.textContent).toContain("pending pass -> swe");
		expect(document.body.textContent).toContain("swe fail -> pending");
		expect(document.body.textContent).toContain(
			'swe fail when agent equals "user" -> research (User rejection restarts research.)',
		);
		expect(document.body.textContent).toContain("swe pass -> done");

		const saveButton = findButtonByText(document.body, "Save");
		expect(saveButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			saveButton?.click();
		});

		expect(onProcessDefinitionsChange).toHaveBeenCalledWith([
			expect.objectContaining({
				id: "uat-json-process",
				name: "UAT JSON Process",
				states: expect.objectContaining({
					swe: expect.objectContaining({
						conditions: [
							expect.objectContaining({
								verdict: "fail",
								path: "agent",
								equals: "user",
								target: "research",
							}),
						],
					}),
				}),
			}),
		]);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("reorders conditional edges before saving process JSON", async () => {
		const onOpenChange = vi.fn();
		const onProcessDefinitionsChange = vi.fn();
		const processDefinition = {
			schemaVersion: 1,
			id: "ordered-conditions-process",
			name: "Ordered Conditions Process",
			initial: "pending",
			states: {
				pending: { label: "Pending", on: { pass: "swe" } },
				swe: {
					label: "SWE",
					role: "swe",
					agentId: "codex",
					prompt: "Implement and route failures by reviewer evidence.",
					on: { fail: "pending", pass: "done" },
					conditions: [
						{
							verdict: "fail",
							path: "agent",
							equals: "user",
							target: "research",
							label: "User rejection",
						},
						{
							verdict: "fail",
							path: "notes",
							contains: "PM rejects",
							target: "spec",
							label: "PM rejection",
						},
					],
				},
				research: {
					label: "Research",
					role: "research",
					agentId: "codex",
					prompt: "Research the rejected direction.",
					on: { pass: "swe" },
				},
				spec: {
					label: "Spec",
					role: "spec",
					agentId: "codex",
					prompt: "Rewrite the acceptance contract.",
					on: { pass: "swe" },
				},
				done: { label: "Done", terminal: true, on: {} },
			},
		} satisfies TaskProcessDefinition;

		await act(async () => {
			root.render(
				<ProcessDefinitionsDialog
					open
					onOpenChange={onOpenChange}
					processDefinitions={[processDefinition]}
					onProcessDefinitionsChange={onProcessDefinitionsChange}
				/>,
			);
		});

		const sweStageButton = Array.from(document.body.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("SWE"),
		);
		expect(sweStageButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			sweStageButton?.click();
		});

		const moveDownButton = document.body.querySelector<HTMLButtonElement>(
			'button[aria-label="Move conditional edge 1 down"]',
		);
		expect(moveDownButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			moveDownButton?.click();
		});

		const saveButton = findButtonByText(document.body, "Save");
		expect(saveButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			saveButton?.click();
		});

		expect(onProcessDefinitionsChange).toHaveBeenCalledWith([
			expect.objectContaining({
				id: "ordered-conditions-process",
				states: expect.objectContaining({
					swe: expect.objectContaining({
						conditions: [
							expect.objectContaining({
								path: "notes",
								contains: "PM rejects",
								target: "spec",
							}),
							expect.objectContaining({
								path: "agent",
								equals: "user",
								target: "research",
							}),
						],
					}),
				}),
			}),
		]);
	});

	it("retargets conditional edges when a custom stage is renamed", async () => {
		const onOpenChange = vi.fn();
		const onProcessDefinitionsChange = vi.fn();
		const processDefinition = {
			schemaVersion: 1,
			id: "rename-conditional-target-process",
			name: "Rename Conditional Target Process",
			initial: "pending",
			states: {
				pending: { label: "Pending", on: { pass: "swe" } },
				swe: {
					label: "SWE",
					role: "swe",
					agentId: "codex",
					prompt: "Implement and route failures by reviewer evidence.",
					on: { fail: "pending", pass: "done" },
					conditions: [
						{
							verdict: "fail",
							path: "agent",
							equals: "user",
							target: "research",
							label: "User rejection",
						},
					],
				},
				research: {
					label: "Research",
					role: "research",
					agentId: "codex",
					prompt: "Research the rejected direction.",
					on: { pass: "swe" },
				},
				done: { label: "Done", terminal: true, on: {} },
			},
		} satisfies TaskProcessDefinition;

		await act(async () => {
			root.render(
				<ProcessDefinitionsDialog
					open
					onOpenChange={onOpenChange}
					processDefinitions={[processDefinition]}
					onProcessDefinitionsChange={onProcessDefinitionsChange}
				/>,
			);
		});

		const researchStageButton = Array.from(document.body.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Research"),
		);
		expect(researchStageButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			researchStageButton?.click();
		});

		const stageIdInput = Array.from(document.body.querySelectorAll("input")).find(
			(input) => input.value === "research",
		);
		expect(stageIdInput).toBeInstanceOf(HTMLInputElement);

		await act(async () => {
			if (stageIdInput) {
				setInputValue(stageIdInput, "investigate");
			}
		});

		const saveButton = findButtonByText(document.body, "Save");
		expect(saveButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			saveButton?.click();
		});

		expect(onProcessDefinitionsChange).toHaveBeenCalledWith([
			expect.objectContaining({
				id: "rename-conditional-target-process",
				states: expect.objectContaining({
					investigate: expect.objectContaining({
						role: "research",
					}),
					swe: expect.objectContaining({
						conditions: [
							expect.objectContaining({
								path: "agent",
								equals: "user",
								target: "investigate",
							}),
						],
					}),
				}),
			}),
		]);
	});

	it("can replace existing custom definitions from JSON import", async () => {
		const onOpenChange = vi.fn();
		const onProcessDefinitionsChange = vi.fn();
		const importedProcess = {
			schemaVersion: 1,
			id: "replacement-process",
			name: "Replacement Process",
			initial: "pending",
			states: {
				pending: { label: "Pending", on: { pass: "done" } },
				done: { label: "Done", terminal: true, on: {} },
			},
		};

		await act(async () => {
			root.render(
				<ProcessDefinitionsDialog
					open
					onOpenChange={onOpenChange}
					processDefinitions={[
						{
							schemaVersion: 1,
							id: "existing-process",
							name: "Existing Process",
							initial: "pending",
							states: {
								pending: { label: "Pending", on: { pass: "done" } },
								done: { label: "Done", terminal: true, on: {} },
							},
						},
					]}
					onProcessDefinitionsChange={onProcessDefinitionsChange}
				/>,
			);
		});

		const jsonButton = findButtonByText(document.body, "JSON");
		expect(jsonButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			jsonButton?.click();
		});

		const jsonTextarea = Array.from(document.body.querySelectorAll("textarea")).find((textarea) =>
			textarea.placeholder.includes("process JSON"),
		);
		expect(jsonTextarea).toBeInstanceOf(HTMLTextAreaElement);

		await act(async () => {
			if (!jsonTextarea) {
				return;
			}
			setTextareaValue(jsonTextarea, JSON.stringify(importedProcess));
		});

		const replaceCheckbox = Array.from(document.body.querySelectorAll("input[type='checkbox']")).find((input) =>
			input.parentElement?.textContent?.includes("Replace custom"),
		);
		expect(replaceCheckbox).toBeInstanceOf(HTMLInputElement);

		await act(async () => {
			if (!(replaceCheckbox instanceof HTMLInputElement)) {
				return;
			}
			replaceCheckbox.click();
		});

		const importButton = findButtonByText(document.body, "Import JSON");
		expect(importButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			importButton?.click();
		});

		const saveButton = findButtonByText(document.body, "Save");
		expect(saveButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			saveButton?.click();
		});

		expect(onProcessDefinitionsChange).toHaveBeenCalledWith([
			expect.objectContaining({
				id: "replacement-process",
				name: "Replacement Process",
			}),
		]);
		expect(onProcessDefinitionsChange).not.toHaveBeenCalledWith(
			expect.arrayContaining([
				expect.objectContaining({
					id: "existing-process",
				}),
			]),
		);
	});

	it("rejects process definitions with reachable nonterminal dead ends", async () => {
		const onOpenChange = vi.fn();
		const onProcessDefinitionsChange = vi.fn();
		const invalidProcess = {
			schemaVersion: 1,
			id: "dead-end-process",
			name: "Dead End Process",
			initial: "pending",
			states: {
				pending: { label: "Pending", on: { pass: "stuck" } },
				stuck: {
					label: "Stuck",
					role: "swe",
					agentId: "codex",
					prompt: "This stage has no way to advance.",
					on: {},
				},
				done: { label: "Done", terminal: true, on: {} },
			},
		};

		await act(async () => {
			root.render(
				<ProcessDefinitionsDialog
					open
					onOpenChange={onOpenChange}
					processDefinitions={[]}
					onProcessDefinitionsChange={onProcessDefinitionsChange}
				/>,
			);
		});

		const jsonButton = findButtonByText(document.body, "JSON");
		await act(async () => {
			jsonButton?.click();
		});

		const jsonTextarea = Array.from(document.body.querySelectorAll("textarea")).find((textarea) =>
			textarea.placeholder.includes("process JSON"),
		);
		await act(async () => {
			if (!jsonTextarea) {
				return;
			}
			setTextareaValue(jsonTextarea, JSON.stringify(invalidProcess));
		});

		const importButton = findButtonByText(document.body, "Import JSON");
		await act(async () => {
			importButton?.click();
		});

		expect(document.body.textContent).toContain(
			"Reachable nonterminal process stage(s) must define pass or fail transitions: stuck.",
		);
		expect(onProcessDefinitionsChange).not.toHaveBeenCalled();
	});

	it("imports promptless runnable definitions as drafts but blocks saving them", async () => {
		const onOpenChange = vi.fn();
		const onProcessDefinitionsChange = vi.fn();
		const invalidProcess = {
			schemaVersion: 1,
			id: "missing-prompt-process",
			name: "Missing Prompt Process",
			initial: "pending",
			states: {
				pending: { label: "Pending", on: { pass: "swe" } },
				swe: {
					label: "SWE",
					role: "swe",
					agentId: "codex",
					on: { fail: "pending", pass: "done" },
				},
				done: { label: "Done", terminal: true, on: {} },
			},
		};

		await act(async () => {
			root.render(
				<ProcessDefinitionsDialog
					open
					onOpenChange={onOpenChange}
					processDefinitions={[]}
					onProcessDefinitionsChange={onProcessDefinitionsChange}
				/>,
			);
		});

		const jsonButton = findButtonByText(document.body, "JSON");
		await act(async () => {
			jsonButton?.click();
		});

		const jsonTextarea = Array.from(document.body.querySelectorAll("textarea")).find((textarea) =>
			textarea.placeholder.includes("process JSON"),
		);
		await act(async () => {
			if (!jsonTextarea) {
				return;
			}
			setTextareaValue(jsonTextarea, JSON.stringify(invalidProcess));
		});

		const importButton = findButtonByText(document.body, "Import JSON");
		await act(async () => {
			importButton?.click();
		});

		expect(document.body.textContent).toContain("Missing Prompt Process");
		expect(document.body.textContent).toContain("prompts 0/1");
		expect(document.body.textContent).toContain("Missing prompts: swe");
		expect(onProcessDefinitionsChange).not.toHaveBeenCalled();

		const saveButton = findButtonByText(document.body, "Save");
		await act(async () => {
			saveButton?.click();
		});

		expect(document.body.textContent).toContain(
			'Process "missing-prompt-process" must define prompt(s) for runnable stage(s): swe.',
		);
		expect(onProcessDefinitionsChange).not.toHaveBeenCalled();
	});

	it("imports a process JSON file and saves it as a custom definition", async () => {
		const onOpenChange = vi.fn();
		const onProcessDefinitionsChange = vi.fn();
		const importedProcess = {
			schemaVersion: 1,
			id: "file-import-process",
			name: "File Import Process",
			initial: "pending",
			states: {
				pending: { label: "Pending", on: { pass: "swe" } },
				swe: {
					label: "SWE",
					role: "swe",
					agentId: "codex",
					prompt: "Implement from file import.",
					on: { fail: "pending", pass: "done" },
				},
				done: { label: "Done", terminal: true, on: {} },
			},
		};
		const fileText = `${JSON.stringify(importedProcess, null, 2)}\n`;
		const file = new File([fileText], "file-import-process.json", { type: "application/json" });
		Object.defineProperty(file, "text", {
			value: async () => fileText,
		});

		await act(async () => {
			root.render(
				<ProcessDefinitionsDialog
					open
					onOpenChange={onOpenChange}
					processDefinitions={[]}
					onProcessDefinitionsChange={onProcessDefinitionsChange}
				/>,
			);
		});

		const importFileButton = findButtonByText(document.body, "Import file");
		expect(importFileButton).toBeInstanceOf(HTMLButtonElement);
		const fileInput = document.body.querySelector('input[type="file"]');
		expect(fileInput).toBeInstanceOf(HTMLInputElement);

		await act(async () => {
			if (fileInput instanceof HTMLInputElement) {
				setFileInput(fileInput, file);
			}
		});

		expect(document.body.textContent).toContain("File Import Process");
		expect(document.body.textContent).toContain("pending pass -> swe");
		expect(document.body.textContent).toContain("swe pass -> done");

		const saveButton = findButtonByText(document.body, "Save");
		expect(saveButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			saveButton?.click();
		});

		expect(onProcessDefinitionsChange).toHaveBeenCalledWith([
			expect.objectContaining({
				id: "file-import-process",
				name: "File Import Process",
			}),
		]);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("downloads selected process JSON without UI metadata", async () => {
		const onOpenChange = vi.fn();
		const onProcessDefinitionsChange = vi.fn();
		const createObjectUrl = vi.fn((blob: Blob | MediaSource) => {
			void blob;
			return "blob:process-json";
		});
		const revokeObjectUrl = vi.fn((url: string) => {
			void url;
		});
		URL.createObjectURL = createObjectUrl;
		URL.revokeObjectURL = revokeObjectUrl;
		const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		const processDefinition = {
			schemaVersion: 1,
			id: "download-process",
			name: "Download Process",
			initial: "pending",
			states: {
				pending: { label: "Pending", on: { pass: "done" } },
				done: { label: "Done", terminal: true, on: {} },
			},
		} satisfies TaskProcessDefinition;

		await act(async () => {
			root.render(
				<ProcessDefinitionsDialog
					open
					onOpenChange={onOpenChange}
					processDefinitions={[processDefinition]}
					onProcessDefinitionsChange={onProcessDefinitionsChange}
				/>,
			);
		});

		const downloadButton = findButtonByText(document.body, "Download");
		expect(downloadButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			downloadButton?.click();
		});

		expect(createObjectUrl).toHaveBeenCalledTimes(1);
		const blob = createObjectUrl.mock.calls[0]?.[0];
		expect(blob).toBeInstanceOf(Blob);
		const downloadedJson = await readBlobText(blob as Blob);
		expect(JSON.parse(downloadedJson)).toEqual(processDefinition);
		expect(downloadedJson).not.toContain('"source"');
		expect(anchorClick).toHaveBeenCalledTimes(1);
		expect(revokeObjectUrl).toHaveBeenCalledWith("blob:process-json");
		anchorClick.mockRestore();
	});

	it("does not allow deleting assigned process definitions", async () => {
		const onOpenChange = vi.fn();
		const onProcessDefinitionsChange = vi.fn();

		await act(async () => {
			root.render(
				<ProcessDefinitionsDialog
					open
					onOpenChange={onOpenChange}
					processDefinitions={[
						{
							schemaVersion: 1,
							id: "assigned-process",
							name: "Assigned Process",
							initial: "pending",
							states: {
								pending: { label: "Pending", on: { pass: "done" } },
								done: { label: "Done", terminal: true, on: {} },
							},
						},
					]}
					processUsageById={{ "assigned-process": 1 }}
					onProcessDefinitionsChange={onProcessDefinitionsChange}
				/>,
			);
		});

		const deleteButton = findButtonByText(document.body, "Delete");
		expect(deleteButton).toBeInstanceOf(HTMLButtonElement);
		expect(deleteButton?.disabled).toBe(true);
		expect(document.body.textContent).toContain("assigned cards 1");
	});

	it("rejects replacing custom definitions when it would remove an assigned process", async () => {
		const onOpenChange = vi.fn();
		const onProcessDefinitionsChange = vi.fn();
		const replacementProcess = {
			schemaVersion: 1,
			id: "replacement-process",
			name: "Replacement Process",
			initial: "pending",
			states: {
				pending: { label: "Pending", on: { pass: "done" } },
				done: { label: "Done", terminal: true, on: {} },
			},
		};

		await act(async () => {
			root.render(
				<ProcessDefinitionsDialog
					open
					onOpenChange={onOpenChange}
					processDefinitions={[
						{
							schemaVersion: 1,
							id: "assigned-process",
							name: "Assigned Process",
							initial: "pending",
							states: {
								pending: { label: "Pending", on: { pass: "done" } },
								done: { label: "Done", terminal: true, on: {} },
							},
						},
					]}
					processUsageById={{ "assigned-process": 1 }}
					onProcessDefinitionsChange={onProcessDefinitionsChange}
				/>,
			);
		});

		const jsonButton = findButtonByText(document.body, "JSON");
		await act(async () => {
			jsonButton?.click();
		});

		const jsonTextarea = Array.from(document.body.querySelectorAll("textarea")).find((textarea) =>
			textarea.placeholder.includes("process JSON"),
		);
		await act(async () => {
			if (!jsonTextarea) {
				return;
			}
			setTextareaValue(jsonTextarea, JSON.stringify(replacementProcess));
		});

		const replaceCheckbox = Array.from(document.body.querySelectorAll("input[type='checkbox']")).find((input) =>
			input.parentElement?.textContent?.includes("Replace custom"),
		);
		await act(async () => {
			if (replaceCheckbox instanceof HTMLInputElement) {
				replaceCheckbox.click();
			}
		});

		const importButton = findButtonByText(document.body, "Import JSON");
		await act(async () => {
			importButton?.click();
		});

		expect(document.body.textContent).toContain("Assigned processes cannot be removed: assigned-process.");
		expect(onProcessDefinitionsChange).not.toHaveBeenCalled();
	});
});
