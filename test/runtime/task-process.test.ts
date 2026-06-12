import { describe, expect, it } from "vitest";

import {
	assertLaunchableTaskProcessDefinitions,
	assertTaskProcessStagePromptReady,
	buildTaskProcessStagePrompt,
	createTaskProcess,
	getMissingRunnableTaskProcessPromptStageIds,
	getTaskProcessDefinition,
	getTaskProcessProgress,
	markTaskProcessRunning,
	parseTaskProcessDefinitionInput,
	reopenTaskProcess,
	transitionTaskProcess,
} from "../../src/core/task-process";

function recordRunningStage(
	process: Parameters<typeof transitionTaskProcess>[0],
	verdict: Parameters<typeof transitionTaskProcess>[1],
	options: Parameters<typeof transitionTaskProcess>[2] = {},
): ReturnType<typeof transitionTaskProcess> {
	return transitionTaskProcess(markTaskProcessRunning(process, { now: options.now }), verdict, options);
}

describe("task process definitions", () => {
	it("rejects unknown process outcome keys", () => {
		expect(() =>
			parseTaskProcessDefinitionInput({
				schemaVersion: 1,
				id: "bad-process",
				name: "Bad Process",
				initial: "pending",
				states: {
					pending: {
						on: {
							pass: "done",
							reject: "pending",
						},
					},
					done: { terminal: true },
				},
			}),
		).toThrow(/reject/);
	});

	it("rejects unreachable process stages", () => {
		expect(() =>
			parseTaskProcessDefinitionInput({
				schemaVersion: 1,
				id: "unreachable-process",
				name: "Unreachable Process",
				initial: "pending",
				states: {
					pending: { on: { pass: "done" } },
					orphan: { on: { pass: "done" } },
					done: { terminal: true },
				},
			}),
		).toThrow(/not reachable from initial stage "pending": orphan/);
	});

	it("rejects reachable process stages that cannot reach terminal completion", () => {
		expect(() =>
			parseTaskProcessDefinitionInput({
				schemaVersion: 1,
				id: "cycle-process",
				name: "Cycle Process",
				initial: "pending",
				states: {
					pending: { on: { pass: "loop" } },
					loop: { on: { fail: "pending" } },
					done: { terminal: true },
				},
			}),
		).toThrow(/cannot reach a terminal stage: pending, loop/);
	});

	it("accepts promptless Gate-compatible process definitions but rejects launching promptless work stages", () => {
		const definition = parseTaskProcessDefinitionInput({
			schemaVersion: 1,
			id: "missing-prompt-process",
			name: "Missing Prompt Process",
			initial: "pending",
			states: {
				pending: { on: { pass: "swe" } },
				swe: {
					role: "swe",
					agentId: "codex",
					on: { fail: "pending", pass: "done" },
				},
				done: { terminal: true },
			},
		});
		const process = transitionTaskProcess(createTaskProcess("missing-prompt-process", 100, [definition]), "pass", {
			now: 101,
			definitions: [definition],
		});

		expect(() =>
			buildTaskProcessStagePrompt({
				taskId: "task-1",
				taskPrompt: "Work the item.",
				process,
				definitions: [definition],
			}),
		).toThrow(/stage "swe" is missing a stage prompt/);
	});

	it("reports missing prompts for runnable stages before process definitions become launchable", () => {
		const definition = parseTaskProcessDefinitionInput({
			schemaVersion: 1,
			id: "missing-prompt-process",
			name: "Missing Prompt Process",
			initial: "pending",
			states: {
				pending: { on: { pass: "swe" } },
				swe: {
					role: "swe",
					agentId: "codex",
					on: { fail: "pending", pass: "done" },
				},
				done: { terminal: true },
			},
		});

		expect(getMissingRunnableTaskProcessPromptStageIds(definition)).toEqual(["swe"]);
		expect(() => assertLaunchableTaskProcessDefinitions([definition])).toThrow(
			'Process "missing-prompt-process" must define prompt(s) for runnable stage(s): swe.',
		);
	});

	it("rejects direct work-stage actions when the current runnable stage has no prompt", () => {
		const definition = parseTaskProcessDefinitionInput({
			schemaVersion: 1,
			id: "missing-prompt-process",
			name: "Missing Prompt Process",
			initial: "pending",
			states: {
				pending: { on: { pass: "swe" } },
				swe: {
					role: "swe",
					agentId: "codex",
					on: { fail: "pending", pass: "done" },
				},
				done: { terminal: true },
			},
		});
		const process = transitionTaskProcess(createTaskProcess("missing-prompt-process", 100, [definition]), "pass", {
			now: 101,
			definitions: [definition],
		});

		expect(() => assertTaskProcessStagePromptReady(process, [definition])).toThrow(
			'Task process "missing-prompt-process" stage "swe" is missing a stage prompt.',
		);
	});

	it("allows passive dispatch stages without prompts", () => {
		expect(
			parseTaskProcessDefinitionInput({
				schemaVersion: 1,
				id: "passive-dispatch-process",
				name: "Passive Dispatch Process",
				initial: "pending",
				states: {
					pending: { on: { pass: "swe" } },
					swe: {
						role: "swe",
						agentId: "codex",
						prompt: "Implement the item and record evidence.",
						on: { fail: "pending", pass: "done" },
					},
					done: { terminal: true },
				},
			}),
		).toMatchObject({
			id: "passive-dispatch-process",
			states: {
				pending: { on: { pass: "swe" } },
				swe: { prompt: "Implement the item and record evidence." },
			},
		});
	});

	it("rejects active stage verdicts before the stage is running", () => {
		const pending = createTaskProcess("lightweight", 100);
		const swe = transitionTaskProcess(pending, "pass", { now: 101, agent: "kanban" });

		expect(() => transitionTaskProcess(swe, "pass", { now: 102, agent: "swe" })).toThrow(
			/stage "swe" must be running before recording pass/,
		);
	});

	it("records passive dispatch transitions as dispatch history", () => {
		const pending = createTaskProcess("lightweight", 100);
		const swe = transitionTaskProcess(pending, "pass", { now: 101, agent: "kanban" });

		expect(swe.history.at(-1)).toMatchObject({
			stageId: "pending",
			targetStageId: "swe",
			verdict: "pass",
			recordKind: "dispatch",
			agent: "kanban",
			at: 101,
		});
	});

	it("records a dispatch entry when a stage starts running", () => {
		const pending = createTaskProcess("lightweight", 100);
		const swe = transitionTaskProcess(pending, "pass", { now: 101, agent: "kanban" });
		const running = markTaskProcessRunning(swe, { now: 102 });

		expect(running).toMatchObject({
			stageId: "swe",
			status: "running",
			updatedAt: 102,
		});
		expect(running.history.at(-1)).toMatchObject({
			stageId: "swe",
			recordKind: "dispatch",
			agent: "kanban",
			notes: "Started swe stage.",
			at: 102,
		});
	});

	it("rejects conditional process transitions that point to unknown stages", () => {
		expect(() =>
			parseTaskProcessDefinitionInput({
				schemaVersion: 1,
				id: "bad-conditional-process",
				name: "Bad Conditional Process",
				initial: "pending",
				states: {
					pending: { on: { pass: "review" } },
					review: {
						role: "review",
						prompt: "Review the item.",
						on: { fail: "pending", pass: "done" },
						conditions: [
							{
								verdict: "fail",
								path: "agent",
								equals: "user",
								target: "missing",
							},
						],
					},
					done: { terminal: true },
				},
			}),
		).toThrow(/conditional transition points to unknown target "missing"/);
	});

	it("routes pass/fail through the first matching conditional edge before the fallback edge", () => {
		const definition = parseTaskProcessDefinitionInput({
			schemaVersion: 1,
			id: "conditional-process",
			name: "Conditional Process",
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
							path: "agent",
							equals: "user",
							target: "research",
							label: "User rejection restarts research.",
						},
						{
							verdict: "fail",
							path: "notes",
							contains: "PM rejected",
							target: "blue",
						},
					],
				},
				research: {
					role: "research",
					prompt: "Research the rejected direction.",
					on: { pass: "review" },
				},
				blue: {
					role: "blue",
					prompt: "Verify PM remediation.",
					on: { pass: "done", fail: "remediate" },
				},
				remediate: {
					role: "swe",
					prompt: "Remediate review findings.",
					on: { pass: "review", fail: "pending" },
				},
				done: { terminal: true },
			},
		});
		const pending = createTaskProcess("conditional-process", 100, [definition]);
		const review = transitionTaskProcess(pending, "pass", { now: 101, definitions: [definition] });

		const userRejected = recordRunningStage(review, "fail", {
			now: 102,
			definitions: [definition],
			agent: "user",
			notes: "Rejecting the direction.",
		});
		expect(userRejected).toMatchObject({
			stageId: "research",
			lastVerdict: "fail",
		});

		const pmRejected = recordRunningStage(review, "fail", {
			now: 103,
			definitions: [definition],
			agent: "pm",
			notes: "PM rejected the blue-team evidence.",
		});
		expect(pmRejected.stageId).toBe("blue");

		const defaultFail = recordRunningStage(review, "fail", {
			now: 104,
			definitions: [definition],
			agent: "red-team",
			notes: "Implementation finding.",
		});
		expect(defaultFail.stageId).toBe("remediate");
	});

	it("keeps built-in process routes aligned with Gate stage names", () => {
		expect(getTaskProcessDefinition("sdd")).toMatchObject({
			initial: "pending",
			states: {
				pending: { on: { pass: "swe" } },
				swe: { role: "swe", on: { fail: "pending", pass: "red-team" } },
				"red-team": { role: "red-team", on: { fail: "pending", pass: "blue-team" } },
				"blue-team": { role: "blue-team", on: { fail: "pending", pass: "done" } },
				done: { terminal: true },
			},
		});
		expect(getTaskProcessDefinition("tdd")).toMatchObject({
			initial: "pending",
			states: {
				pending: { on: { pass: "blue-team" } },
				"blue-team": { role: "blue-team", on: { fail: "pending", pass: "swe" } },
				swe: { role: "swe", on: { fail: "pending", pass: "red-team" } },
				"red-team": { role: "red-team", on: { fail: "pending", pass: "done" } },
				done: { terminal: true },
			},
		});
		expect(getTaskProcessDefinition("lightweight")).toMatchObject({
			initial: "pending",
			states: {
				pending: { on: { pass: "swe" } },
				swe: { role: "swe", on: { fail: "pending", pass: "blue-team" } },
				"blue-team": { role: "blue-team", on: { fail: "pending", pass: "done" } },
				done: { terminal: true },
			},
		});
	});

	it("models the SLC conditional remediation loop", () => {
		const pending = createTaskProcess("slc", 100);
		const discovery = transitionTaskProcess(pending, "pass", { now: 101 });
		const spec = recordRunningStage(discovery, "pass", { now: 102 });
		const swe = recordRunningStage(spec, "pass", { now: 103 });
		const redTeam = recordRunningStage(swe, "pass", { now: 104 });
		const remediate = recordRunningStage(redTeam, "fail", {
			now: 105,
			agent: "red-team",
			notes: "Implementation misses the lovable acceptance criterion.",
		});
		const redTeamAgain = recordRunningStage(remediate, "pass", { now: 106 });
		const blueTeam = recordRunningStage(redTeamAgain, "pass", { now: 107 });
		const done = recordRunningStage(blueTeam, "pass", { now: 108 });

		expect(remediate).toMatchObject({
			processId: "slc",
			processName: "Simple, Lovable, Complete",
			stageId: "remediate",
			status: "ready",
			lastVerdict: "fail",
		});
		expect(done).toMatchObject({
			stageId: "done",
			status: "complete",
			lastVerdict: "pass",
		});
		expect(
			done.history
				.filter((entry) => entry.recordKind === "outcome")
				.map((entry) => [entry.stageId, entry.verdict, entry.targetStageId]),
		).toEqual([
			["discovery", "pass", "spec"],
			["spec", "pass", "swe"],
			["swe", "pass", "red-team"],
			["red-team", "fail", "remediate"],
			["remediate", "pass", "red-team"],
			["red-team", "pass", "blue-team"],
			["blue-team", "pass", "done"],
		]);
		expect(getTaskProcessProgress(remediate)).toEqual({
			stages: ["pending", "discovery", "spec", "swe", "red-team", "blue-team", "done"],
			gatesPassed: 4,
			totalGates: 6,
			currentStageIndex: null,
			offPath: true,
			reworkOf: "red-team",
			complete: false,
		});
		expect(getTaskProcessProgress(done)).toEqual({
			stages: ["pending", "discovery", "spec", "swe", "red-team", "blue-team", "done"],
			gatesPassed: 6,
			totalGates: 6,
			currentStageIndex: 6,
			offPath: true,
			reworkOf: "red-team",
			complete: true,
		});
	});

	it("routes SLC user rejection from blue-team back to discovery", () => {
		const pending = createTaskProcess("slc", 100);
		const discovery = transitionTaskProcess(pending, "pass", { now: 101 });
		const spec = recordRunningStage(discovery, "pass", { now: 102 });
		const swe = recordRunningStage(spec, "pass", { now: 103 });
		const redTeam = recordRunningStage(swe, "pass", { now: 104 });
		const blueTeam = recordRunningStage(redTeam, "pass", { now: 105 });
		const rejected = recordRunningStage(blueTeam, "fail", {
			now: 106,
			agent: "user",
			notes: "User rejected the product direction.",
		});

		expect(rejected).toMatchObject({
			stageId: "discovery",
			status: "ready",
			lastVerdict: "fail",
		});
		expect(rejected.history.at(-1)).toMatchObject({
			stageId: "blue-team",
			targetStageId: "discovery",
			verdict: "fail",
			agent: "user",
		});
	});

	it("generates an SLC stage prompt with guarded pass and fail commands", () => {
		const pending = createTaskProcess("slc", 100);
		const discovery = transitionTaskProcess(pending, "pass", { now: 101 });
		const spec = recordRunningStage(discovery, "pass", { now: 102 });
		const prompt = buildTaskProcessStagePrompt({
			taskId: "task-123",
			taskTitle: "Ship SLC process",
			taskPrompt: "Build Simple, Lovable, Complete orchestration.",
			process: spec,
			workspacePath: "/workspace/kanban",
		});

		expect(prompt).toContain("Process: Simple, Lovable, Complete");
		expect(prompt).toContain("Current stage: spec (Spec)");
		expect(prompt).toContain("Expected stage guard: spec");
		expect(prompt).toContain("Turn discovery into a concrete Simple, Lovable, Complete contract.");
		expect(prompt).toContain("target=spec kind=outcome verdict=pass");
		expect(prompt).toContain("Transition routes:\n- pass -> swe\n- fail -> discovery");
		expect(prompt).toContain("--process 'slc' --expected-stage 'spec' --agent 'spec'");
		expect(prompt).toContain("task process pass --task-id 'task-123'");
		expect(prompt).toContain("task process fail --task-id 'task-123'");
	});

	it("includes conditional routes in stage prompts", () => {
		const pending = createTaskProcess("slc", 100);
		const discovery = transitionTaskProcess(pending, "pass", { now: 101 });
		const spec = recordRunningStage(discovery, "pass", { now: 102 });
		const swe = recordRunningStage(spec, "pass", { now: 103 });
		const redTeam = recordRunningStage(swe, "pass", { now: 104 });
		const blueTeam = recordRunningStage(redTeam, "pass", { now: 105 });
		const prompt = buildTaskProcessStagePrompt({
			taskId: "task-456",
			taskTitle: "Verify SLC process",
			taskPrompt: "Verify Simple, Lovable, Complete orchestration.",
			process: blueTeam,
			workspacePath: "/workspace/kanban",
		});

		expect(prompt).toContain(
			"Transition routes:\n- fail when agent equals 'user' -> discovery (User rejection restarts discovery.)\n- pass -> done\n- fail -> remediate",
		);
		expect(prompt).toContain("--process 'slc' --expected-stage 'blue-team' --agent 'blue-team'");
	});

	it("reopens a terminal process to its initial stage", () => {
		const pending = createTaskProcess("tdd", 100);
		const blueTeam = transitionTaskProcess(pending, "pass", { now: 101, agent: "pm" });
		const swe = recordRunningStage(blueTeam, "pass", { now: 102, agent: "blue-team" });
		const redTeam = recordRunningStage(swe, "pass", { now: 103, agent: "swe" });
		const done = recordRunningStage(redTeam, "pass", { now: 104, agent: "red-team" });

		const reopened = reopenTaskProcess(done, {
			now: 105,
			agent: "pm",
			notes: "Reopen for another pass.",
		});

		expect(reopened).toMatchObject({
			processId: "tdd",
			stageId: "pending",
			status: "ready",
			updatedAt: 105,
		});
		expect(reopened.lastVerdict).toBeUndefined();
		expect(reopened.history.at(-1)).toMatchObject({
			stageId: "reopened",
			targetStageId: "pending",
			recordKind: "reopen",
			agent: "pm",
			notes: "Reopen for another pass.",
			at: 105,
		});
		const advanced = transitionTaskProcess(reopened, "pass", { now: 106, agent: "pm" });
		expect(advanced).toMatchObject({
			stageId: "blue-team",
			status: "ready",
			lastVerdict: "pass",
		});
	});

	it("rejects reopening a non-terminal process", () => {
		const pending = createTaskProcess("sdd", 100);
		const swe = transitionTaskProcess(pending, "pass", { now: 101, agent: "pm" });

		expect(() =>
			reopenTaskProcess(swe, {
				now: 102,
				agent: "pm",
				notes: "Cannot reopen mid-pipeline.",
			}),
		).toThrow(/not in a terminal state/);
	});
});
