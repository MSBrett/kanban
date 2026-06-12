import {
	createTaskProcess,
	markTaskProcessRunning,
	parseTaskProcessDefinitionInput,
	transitionTaskProcess,
} from "@runtime-task-process";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskProcessPanel } from "@/components/task-process-panel";
import type { BoardCard, TaskProcessDefinition } from "@/types";

function recordRunningStage(
	process: Parameters<typeof transitionTaskProcess>[0],
	verdict: Parameters<typeof transitionTaskProcess>[1],
	options: Parameters<typeof transitionTaskProcess>[2] = {},
): ReturnType<typeof transitionTaskProcess> {
	return transitionTaskProcess(markTaskProcessRunning(process), verdict, options);
}

function createProcessCard(): BoardCard {
	const initialProcess = createTaskProcess("slc", 100);
	const discoveryProcess = transitionTaskProcess(initialProcess, "pass", {
		now: 101,
		agent: "kanban",
		recordKind: "dispatch",
		notes: "Dispatched pending to discovery.",
	});
	const specProcess = recordRunningStage(discoveryProcess, "pass", {
		now: 102,
		agent: "discovery",
		notes: "Discovery produced acceptance criteria.",
	});
	const sweProcess = recordRunningStage(specProcess, "pass", {
		now: 103,
		agent: "spec",
		notes: "Spec accepted.",
	});
	const redTeamProcess = recordRunningStage(sweProcess, "pass", {
		now: 104,
		agent: "swe",
		notes: "Implementation ready for audit.",
	});
	const remediationProcess = recordRunningStage(redTeamProcess, "fail", {
		now: 105,
		agent: "red-team",
		notes: "Missing fail-back proof.",
	});

	return {
		id: "task-1",
		title: "Prove process route",
		prompt: "Prove process route",
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		process: markTaskProcessRunning(remediationProcess),
	};
}

function createCompletedProcessCard(): BoardCard {
	const pendingProcess = createTaskProcess("lightweight", 200);
	const sweProcess = transitionTaskProcess(pendingProcess, "pass", {
		now: 201,
		agent: "kanban",
		notes: "Pending passed.",
	});
	const blueProcess = recordRunningStage(sweProcess, "pass", {
		now: 202,
		agent: "swe",
		notes: "SWE passed.",
	});
	const doneProcess = recordRunningStage(blueProcess, "pass", {
		now: 203,
		agent: "blue-team",
		notes: "Blue-team passed.",
	});
	return {
		id: "task-complete",
		title: "Completed process route",
		prompt: "Completed process route",
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt: 2,
		updatedAt: 2,
		process: doneProcess,
	};
}

function createBlueTeamProcessCard(): BoardCard {
	const initialProcess = createTaskProcess("slc", 300);
	const discoveryProcess = transitionTaskProcess(initialProcess, "pass", {
		now: 301,
		agent: "kanban",
		recordKind: "dispatch",
		notes: "Dispatched pending to discovery.",
	});
	const specProcess = recordRunningStage(discoveryProcess, "pass", {
		now: 302,
		agent: "discovery",
		notes: "Discovery accepted.",
	});
	const sweProcess = recordRunningStage(specProcess, "pass", {
		now: 303,
		agent: "spec",
		notes: "Spec accepted.",
	});
	const redTeamProcess = recordRunningStage(sweProcess, "pass", {
		now: 304,
		agent: "swe",
		notes: "Implementation accepted.",
	});
	const blueTeamProcess = recordRunningStage(redTeamProcess, "pass", {
		now: 305,
		agent: "red-team",
		notes: "Red-team accepted.",
	});

	return {
		id: "task-blue",
		title: "Blue team conditional route",
		prompt: "Blue team conditional route",
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt: 3,
		updatedAt: 3,
		process: markTaskProcessRunning(blueTeamProcess),
	};
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
	if (!setter) {
		throw new Error("Expected textarea value setter.");
	}
	setter.call(textarea, value);
	textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
}

function setInputValue(input: HTMLInputElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	if (!setter) {
		throw new Error("Expected input value setter.");
	}
	setter.call(input, value);
	input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
}

describe("TaskProcessPanel", () => {
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
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("shows the process route, current stage, fail-back edge, and history", () => {
		const card = createProcessCard();

		act(() => {
			root.render(<TaskProcessPanel card={card} workspacePath="/workspace/project" kanbanCommand="kanban-dev" />);
		});

		expect(container.textContent).toContain("Simple, Lovable, Complete");
		expect(container.textContent).toContain("Remediate / running");
		expect(container.textContent).toContain("Agent handoff");
		expect(container.textContent).toContain("Expected stage guard: remediate");
		expect(container.textContent).toContain("Fix only the concrete red-team or blue-team findings");
		expect(container.textContent).toContain(
			"kanban-dev task process pass --task-id 'task-1' --project-path '/workspace/project' --process 'slc' --expected-stage 'remediate' --agent 'swe'",
		);
		expect(container.textContent).toContain("pending");
		expect(container.textContent).toContain("discovery");
		expect(container.textContent).toContain("spec");
		expect(container.textContent).toContain("swe");
		expect(container.textContent).toContain("red-team");
		expect(container.textContent).toContain("remediate");
		expect(container.textContent).toContain("fail -> spec");
		expect(container.textContent).toContain("pass -> red-team");
		expect(container.textContent).toContain("4/6 gates rework from red-team");
		expect(container.textContent).toContain("off-path");
		expect(container.textContent).toContain("Audit");
		expect(container.textContent).toContain("pending -> discovery -> spec -> swe -> red-team -> remediate");
		expect(container.textContent).toContain("path 5/7");
		expect(container.textContent).toContain("pass 4");
		expect(container.textContent).toContain("fail 1");
		expect(container.textContent).toContain("outcomes 5");
		expect(container.textContent).toContain("latest red-team -> remediate fail");
		expect(container.textContent).toContain("1970-01-01T00:00:00.105Z");
		expect(container.textContent).toContain("red-team -> remediate");
		expect(container.textContent).toContain("kind=outcome");
		expect(container.textContent).toContain("agent=red-team");
		expect(container.textContent).toContain(": Missing fail-back proof.");
	});

	it("passes notes to append and verdict handlers", () => {
		const card = createProcessCard();
		const onAppend = vi.fn();
		const onVerdict = vi.fn();

		act(() => {
			root.render(<TaskProcessPanel card={card} onAppend={onAppend} onVerdict={onVerdict} />);
		});

		const notes = container.querySelector("textarea");
		if (!(notes instanceof HTMLTextAreaElement)) {
			throw new Error("Expected notes textarea.");
		}
		const evidenceInputs = container.querySelectorAll("input");
		const agentInput = evidenceInputs[0];
		const modelInput = evidenceInputs[1];
		if (!(agentInput instanceof HTMLInputElement) || !(modelInput instanceof HTMLInputElement)) {
			throw new Error("Expected agent and model inputs.");
		}
		act(() => {
			setInputValue(agentInput, "red-team");
			setInputValue(modelInput, "gpt-5.5");
			setTextareaValue(notes, "Evidence recorded.");
		});

		const appendButton = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Append"),
		);
		if (!appendButton) {
			throw new Error("Expected append button.");
		}
		act(() => {
			appendButton.click();
		});
		expect(onAppend).toHaveBeenCalledWith("task-1", "Evidence recorded.", "remediate", "red-team", "gpt-5.5");

		act(() => {
			setInputValue(agentInput, "blue-team");
			setInputValue(modelInput, "claude-opus-4.6");
			setTextareaValue(notes, "Stage passes.");
		});
		const passButton = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Pass"),
		);
		if (!passButton) {
			throw new Error("Expected pass button.");
		}
		act(() => {
			passButton.click();
		});
		expect(onVerdict).toHaveBeenCalledWith(
			"task-1",
			"pass",
			"Stage passes.",
			"remediate",
			"blue-team",
			"claude-opus-4.6",
		);
	});

	it("shows promptless runnable stages but disables run and verdict actions", () => {
		const promptlessDefinition = parseTaskProcessDefinitionInput({
			schemaVersion: 1,
			id: "promptless-process",
			name: "Promptless Process",
			initial: "pending",
			states: {
				pending: { label: "Pending", on: { pass: "swe" } },
				swe: {
					label: "SWE",
					role: "swe",
					agentId: "codex",
					on: { fail: "pending", pass: "done" },
				},
				done: { label: "Done", terminal: true },
			},
		});
		const promptlessProcess = transitionTaskProcess(
			createTaskProcess("promptless-process", 400, [promptlessDefinition]),
			"pass",
			{ now: 401, definitions: [promptlessDefinition] },
		);
		const card: BoardCard = {
			id: "task-promptless",
			title: "Promptless process card",
			prompt: "Promptless process card",
			startInPlanMode: false,
			autoReviewEnabled: false,
			autoReviewMode: "commit",
			baseRef: "main",
			createdAt: 400,
			updatedAt: 401,
			process: promptlessProcess,
		};
		const onRunStage = vi.fn();
		const onVerdict = vi.fn();

		act(() => {
			root.render(<TaskProcessPanel card={card} onRunStage={onRunStage} onVerdict={onVerdict} />);
		});

		expect(container.textContent).toContain("Promptless Process");
		expect(container.textContent).toContain("SWE / ready");
		expect(container.textContent).toContain(
			'Task process "promptless-process" stage "swe" is missing a stage prompt.',
		);
		expect(
			Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "Run Stage"),
		).toBe(false);

		const notes = container.querySelector("textarea");
		if (!(notes instanceof HTMLTextAreaElement)) {
			throw new Error("Expected notes textarea.");
		}
		act(() => {
			setTextareaValue(notes, "Trying to pass without a prompt.");
		});
		const passButton = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Pass"),
		);
		if (!(passButton instanceof HTMLButtonElement)) {
			throw new Error("Expected pass button.");
		}
		expect(passButton.disabled).toBe(true);
		act(() => {
			passButton.click();
		});
		expect(onRunStage).not.toHaveBeenCalled();
		expect(onVerdict).not.toHaveBeenCalled();
	});

	it("previews conditional fail routes from current agent evidence", () => {
		const card = createBlueTeamProcessCard();
		const onVerdict = vi.fn();

		act(() => {
			root.render(<TaskProcessPanel card={card} onVerdict={onVerdict} />);
		});

		expect(container.textContent).toContain('fail when agent equals "user" -> discovery');
		expect(container.textContent).toContain("active fail fallback -> remediate");
		const notes = container.querySelector("textarea");
		if (!(notes instanceof HTMLTextAreaElement)) {
			throw new Error("Expected notes textarea.");
		}
		const agentInput = container.querySelector("input");
		if (!(agentInput instanceof HTMLInputElement)) {
			throw new Error("Expected agent input.");
		}

		act(() => {
			setInputValue(agentInput, "user");
			setTextareaValue(notes, "Rejecting the blue-team proof.");
		});

		expect(container.textContent).toContain('active fail when agent equals "user" -> discovery');
		const failButton = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Fail"),
		);
		if (!failButton) {
			throw new Error("Expected fail button.");
		}
		act(() => {
			failButton.click();
		});

		expect(onVerdict).toHaveBeenCalledWith(
			"task-blue",
			"fail",
			"Rejecting the blue-team proof.",
			"blue-team",
			"user",
			undefined,
		);
	});

	it("previews conditional contains routes with the runtime case-sensitive matcher", () => {
		const definition = {
			schemaVersion: 1,
			id: "case-sensitive-conditional-process",
			name: "Case Sensitive Conditional Process",
			initial: "pending",
			states: {
				pending: { on: { pass: "review" } },
				review: {
					role: "review",
					prompt: "Review the item.",
					on: { fail: "remediate", pass: "done" },
					conditions: [
						{
							verdict: "fail",
							path: "notes",
							contains: "PM rejects",
							target: "spec",
							label: "PM rejection",
						},
					],
				},
				spec: {
					role: "spec",
					prompt: "Rewrite the acceptance contract.",
					on: { pass: "review" },
				},
				remediate: {
					role: "swe",
					prompt: "Remediate review findings.",
					on: { pass: "review", fail: "pending" },
				},
				done: { terminal: true, on: {} },
			},
		} satisfies TaskProcessDefinition;
		const reviewProcess = transitionTaskProcess(
			createTaskProcess("case-sensitive-conditional-process", 100, [definition]),
			"pass",
			{ now: 101, definitions: [definition] },
		);
		const card: BoardCard = {
			id: "task-case-sensitive",
			title: "Case sensitive conditional route",
			prompt: "Case sensitive conditional route",
			startInPlanMode: false,
			autoReviewEnabled: false,
			autoReviewMode: "commit",
			baseRef: "main",
			createdAt: 100,
			updatedAt: 101,
			process: markTaskProcessRunning(reviewProcess),
		};

		act(() => {
			root.render(<TaskProcessPanel card={card} />);
		});

		const notes = container.querySelector("textarea");
		if (!(notes instanceof HTMLTextAreaElement)) {
			throw new Error("Expected notes textarea.");
		}

		act(() => {
			setTextareaValue(notes, "pm rejects the proof.");
		});

		expect(container.textContent).toContain('fail when notes contains "PM rejects" -> spec');
		expect(container.textContent).toContain("active fail fallback -> remediate");
		expect(container.textContent).not.toContain('active fail when notes contains "PM rejects" -> spec');

		act(() => {
			setTextareaValue(notes, "PM rejects the proof.");
		});

		expect(container.textContent).toContain('active fail when notes contains "PM rejects" -> spec');
	});

	it("passes notes to the reopen handler for a completed process", () => {
		const card = createCompletedProcessCard();
		const onReopen = vi.fn();

		act(() => {
			root.render(<TaskProcessPanel card={card} onReopen={onReopen} />);
		});

		expect(container.textContent).toContain("Done / complete");
		const notes = container.querySelector("textarea");
		if (!(notes instanceof HTMLTextAreaElement)) {
			throw new Error("Expected reopen notes textarea.");
		}
		const evidenceInputs = container.querySelectorAll("input");
		const agentInput = evidenceInputs[0];
		const modelInput = evidenceInputs[1];
		if (!(agentInput instanceof HTMLInputElement) || !(modelInput instanceof HTMLInputElement)) {
			throw new Error("Expected reopen agent and model inputs.");
		}
		act(() => {
			setInputValue(agentInput, "pm");
			setInputValue(modelInput, "review-model");
			setTextareaValue(notes, "Reopen with new evidence.");
		});

		const reopenButton = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Reopen"),
		);
		if (!reopenButton) {
			throw new Error("Expected reopen button.");
		}
		act(() => {
			reopenButton.click();
		});

		expect(onReopen).toHaveBeenCalledWith("task-complete", "Reopen with new evidence.", "done", "pm", "review-model");
	});
});
