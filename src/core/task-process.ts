import {
	type RuntimeTaskProcessConditionalTransition,
	type RuntimeTaskProcessDefinition,
	type RuntimeTaskProcessHistoryEntry,
	type RuntimeTaskProcessHistoryRecordKind,
	type RuntimeTaskProcessId,
	type RuntimeTaskProcessState,
	type RuntimeTaskProcessStateDefinition,
	type RuntimeTaskProcessVerdict,
	runtimeTaskProcessDefinitionSchema,
} from "./api-contract";

export interface RuntimeTaskProcessStageDefinition extends RuntimeTaskProcessStateDefinition {
	id: string;
	label: string;
}

export interface RuntimeTaskProcessProgress {
	stages: string[];
	gatesPassed: number;
	totalGates: number;
	currentStageIndex: number | null;
	offPath: boolean;
	reworkOf: string | null;
	complete: boolean;
}

interface TransitionTaskProcessOptions {
	notes?: string;
	now?: number;
	definitions?: readonly RuntimeTaskProcessDefinition[];
	agent?: string;
	model?: string;
	recordKind?: RuntimeTaskProcessHistoryRecordKind;
}

export interface TaskProcessTransitionContext {
	verdict: RuntimeTaskProcessVerdict;
	stageId: string;
	agent?: string;
	model?: string;
	notes?: string;
	lastVerdict?: RuntimeTaskProcessVerdict;
}

interface AppendTaskProcessHistoryOptions {
	notes: string;
	now?: number;
	agent?: string;
	model?: string;
	recordKind?: RuntimeTaskProcessHistoryRecordKind;
}

interface ReopenTaskProcessOptions {
	notes: string;
	now?: number;
	definitions?: readonly RuntimeTaskProcessDefinition[];
	agent?: string;
	model?: string;
}

interface MarkTaskProcessRunningOptions {
	now?: number;
	agent?: string;
	model?: string;
	notes?: string;
}

interface TaskProcessLaunchPromptInput {
	taskId: string;
	taskTitle?: string;
	taskPrompt: string;
	process: RuntimeTaskProcessState;
	definitions?: readonly RuntimeTaskProcessDefinition[];
	workspacePath?: string | null;
	kanbanCommand?: string | null;
}

const DEFAULT_STAGE_PROMPTS: Record<string, string> = {
	"blue-team": [
		"Verify the work end-to-end against the Kanban item and prior process history.",
		"Do not make implementation changes unless they are strictly required to verify the work.",
		"Pass only with concrete evidence. Fail with exact remediation notes.",
	].join("\n"),
	blue: [
		"Verify the integrated behavior end-to-end against the Kanban item, process history, and prior audit evidence.",
		"Do not make implementation changes unless verification is impossible without a small, explicit fix.",
		"Pass only when behavior is proven. Fail with command/output evidence and exact remediation notes.",
	].join("\n"),
	"red-team": [
		"Audit the work against the Kanban item and prior process history.",
		"Do not make implementation changes in this stage.",
		"Pass only if the work satisfies the item and has meaningful validation. Fail with concrete remediation notes.",
	].join("\n"),
	red: [
		"Audit the work, the Kanban item, and the process history against the actual implementation.",
		"Do not modify source code in this stage.",
		"Challenge weak specs and insufficient evidence. Pass only when the contract holds; fail with specific findings.",
	].join("\n"),
	discovery: [
		"Research the item, dependencies, constraints, and unknowns.",
		"Update the Kanban item with concrete findings and the smallest viable path to Simple, Lovable, Complete.",
		"Pass when the spec stage has enough evidence to write acceptance criteria. Fail when the item must return to planning.",
	].join("\n"),
	remediate: [
		"Fix only the concrete red-team or blue-team findings from the process history.",
		"Do not broaden scope unless the finding proves the spec is wrong.",
		"Pass back to red-team with evidence. Fail back to spec when the required change needs a rewritten contract.",
	].join("\n"),
	research: [
		"Research the item, constraints, relevant files, and prior process history.",
		"Update the item with concrete findings and the recommended path.",
		"Pass when the next stage has enough evidence to proceed. Fail with the missing evidence.",
	].join("\n"),
	spec: [
		"Turn discovery into a concrete Simple, Lovable, Complete contract.",
		"Define acceptance criteria, dependencies, validation commands, and any deliberate non-goals.",
		"Challenge weak premises before passing to implementation. Fail back to discovery when evidence is missing.",
	].join("\n"),
	swe: [
		"Implement the requested behavior in the Kanban item.",
		"Run focused validation that proves the change.",
		"Pass only when implementation and validation are complete. Fail with specific remediation notes.",
	].join("\n"),
	test: [
		"Create or refine the tests/spec checks that define the requested behavior before implementation.",
		"Do not complete the product implementation in this stage.",
		"Pass when the test/spec signal is ready for implementation. Fail with missing-requirement notes.",
	].join("\n"),
	verify: [
		"Verify the work end-to-end against the Kanban item and prior process history.",
		"Do not make implementation changes unless they are strictly required to run verification.",
		"Pass only if verification succeeds. Fail with command/output evidence and remediation notes.",
	].join("\n"),
};

const BUILTIN_PROCESS_DEFINITIONS: RuntimeTaskProcessDefinition[] = [
	{
		schemaVersion: 1,
		id: "slc",
		name: "Simple, Lovable, Complete",
		initial: "pending",
		states: {
			pending: { on: { pass: "discovery" } },
			discovery: {
				role: "discovery",
				agentId: "codex",
				prompt: DEFAULT_STAGE_PROMPTS.discovery,
				on: { fail: "pending", pass: "spec" },
			},
			spec: {
				role: "spec",
				agentId: "codex",
				prompt: DEFAULT_STAGE_PROMPTS.spec,
				on: { fail: "discovery", pass: "swe" },
			},
			swe: {
				role: "swe",
				agentId: "codex",
				prompt: [
					DEFAULT_STAGE_PROMPTS.swe,
					"Challenge the spec before coding; if the contract is wrong, fail with the exact gap instead of guessing.",
					"Keep implementation scoped to the Kanban item and process history.",
				].join("\n"),
				on: { fail: "spec", pass: "red-team" },
			},
			"red-team": {
				role: "red-team",
				agentId: "codex",
				prompt: [
					DEFAULT_STAGE_PROMPTS["red-team"],
					"Audit the spec, implementation, and evidence. Do not modify source code.",
					"Fail to remediation with exact findings; pass only when the contract and implementation both hold.",
				].join("\n"),
				on: { fail: "remediate", pass: "blue-team" },
			},
			remediate: {
				role: "swe",
				agentId: "codex",
				prompt: DEFAULT_STAGE_PROMPTS.remediate,
				on: { fail: "spec", pass: "red-team" },
			},
			"blue-team": {
				role: "blue-team",
				agentId: "codex",
				prompt: [
					DEFAULT_STAGE_PROMPTS["blue-team"],
					"Verify the integrated behavior, not just compilation. Do not modify source code unless verification is impossible otherwise.",
					"Fail to remediation with exact evidence; pass only when Simple, Lovable, Complete is proven.",
				].join("\n"),
				on: { fail: "remediate", pass: "done" },
				conditions: [
					{
						verdict: "fail",
						path: "agent",
						equals: "user",
						target: "discovery",
						label: "User rejection restarts discovery.",
					},
				],
			},
			done: { terminal: true, on: {} },
		},
	},
	{
		schemaVersion: 1,
		id: "sdd",
		name: "Spec Driven Development",
		initial: "pending",
		states: {
			pending: { on: { pass: "swe" } },
			swe: { role: "swe", prompt: DEFAULT_STAGE_PROMPTS.swe, on: { fail: "pending", pass: "red-team" } },
			"red-team": {
				role: "red-team",
				prompt: DEFAULT_STAGE_PROMPTS["red-team"],
				on: { fail: "pending", pass: "blue-team" },
			},
			"blue-team": {
				role: "blue-team",
				prompt: DEFAULT_STAGE_PROMPTS["blue-team"],
				on: { fail: "pending", pass: "done" },
			},
			done: { terminal: true, on: {} },
		},
	},
	{
		schemaVersion: 1,
		id: "tdd",
		name: "Test Driven Development",
		initial: "pending",
		states: {
			pending: { on: { pass: "blue-team" } },
			"blue-team": {
				role: "blue-team",
				prompt: DEFAULT_STAGE_PROMPTS.test,
				on: { fail: "pending", pass: "swe" },
			},
			swe: {
				role: "swe",
				prompt: DEFAULT_STAGE_PROMPTS.swe,
				on: { fail: "pending", pass: "red-team" },
			},
			"red-team": {
				role: "red-team",
				prompt: DEFAULT_STAGE_PROMPTS["red-team"],
				on: { fail: "pending", pass: "done" },
			},
			done: { terminal: true, on: {} },
		},
	},
	{
		schemaVersion: 1,
		id: "gsd",
		name: "Get Stuff Done",
		initial: "pending",
		states: {
			pending: { on: { pass: "research" } },
			research: { role: "research", prompt: DEFAULT_STAGE_PROMPTS.research, on: { fail: "pending", pass: "plan" } },
			plan: {
				role: "plan",
				prompt:
					"Create a concrete implementation plan from the Kanban item, research, and prior process history. Pass when execution has a clear sequence and validation target. Fail when the item is not actionable.",
				on: { fail: "pending", pass: "execute" },
			},
			execute: { role: "execute", prompt: DEFAULT_STAGE_PROMPTS.swe, on: { fail: "pending", pass: "verify" } },
			verify: { role: "verify", prompt: DEFAULT_STAGE_PROMPTS.verify, on: { fail: "execute", pass: "done" } },
			done: { terminal: true, on: {} },
		},
	},
	{
		schemaVersion: 1,
		id: "lightweight",
		name: "Lightweight",
		initial: "pending",
		states: {
			pending: { on: { pass: "swe" } },
			swe: { role: "swe", prompt: DEFAULT_STAGE_PROMPTS.swe, on: { fail: "pending", pass: "blue-team" } },
			"blue-team": {
				role: "blue-team",
				prompt: DEFAULT_STAGE_PROMPTS["blue-team"],
				on: { fail: "pending", pass: "done" },
			},
			done: { terminal: true, on: {} },
		},
	},
];

export const RUNTIME_TASK_PROCESS_DEFINITIONS: readonly RuntimeTaskProcessDefinition[] = BUILTIN_PROCESS_DEFINITIONS;

function titleCaseSegment(segment: string): string {
	if (!segment) {
		return segment;
	}
	return `${segment[0]?.toUpperCase() ?? ""}${segment.slice(1).toLowerCase()}`;
}

function labelFromStageId(stageId: string): string {
	return stageId.split("-").map(titleCaseSegment).join("-");
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableJson).join(",")}]`;
	}
	if (value && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function definitionDigest(definition: RuntimeTaskProcessDefinition): string {
	let hash = 0x811c9dc5;
	for (const char of stableJson(definition)) {
		hash ^= char.charCodeAt(0);
		hash = Math.imul(hash, 0x01000193);
	}
	return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function cloneProcessDefinition(definition: RuntimeTaskProcessDefinition): RuntimeTaskProcessDefinition {
	return {
		...definition,
		states: Object.fromEntries(
			Object.entries(definition.states).map(([stageId, stage]) => [stageId, { ...stage, on: { ...stage.on } }]),
		),
	};
}

export function cloneTaskProcess(process?: RuntimeTaskProcessState | null): RuntimeTaskProcessState | undefined {
	if (!process) {
		return undefined;
	}
	return {
		...process,
		definition: process.definition ? cloneProcessDefinition(process.definition) : undefined,
		history: process.history.map((entry) => ({ ...entry })),
	};
}

function stageWithId(stageId: string, stage: RuntimeTaskProcessStateDefinition): RuntimeTaskProcessStageDefinition {
	return {
		...stage,
		id: stageId,
		label: stage.label ?? labelFromStageId(stageId),
		terminal: stage.terminal ?? false,
		on: { ...stage.on },
	};
}

function allDefinitions(definitions: readonly RuntimeTaskProcessDefinition[] = []): RuntimeTaskProcessDefinition[] {
	const byId = new Map<string, RuntimeTaskProcessDefinition>();
	for (const definition of BUILTIN_PROCESS_DEFINITIONS) {
		byId.set(definition.id, definition);
	}
	for (const definition of definitions) {
		byId.set(definition.id, definition);
	}
	return Array.from(byId.values());
}

export function getTaskProcessDefinitions(
	definitions?: readonly RuntimeTaskProcessDefinition[],
): RuntimeTaskProcessDefinition[] {
	return allDefinitions(definitions);
}

export function getTaskProcessDefinition(
	processOrId: RuntimeTaskProcessId | RuntimeTaskProcessState,
	definitions?: readonly RuntimeTaskProcessDefinition[],
): RuntimeTaskProcessDefinition | null {
	if (typeof processOrId !== "string" && processOrId.definition) {
		return processOrId.definition;
	}
	const processId = typeof processOrId === "string" ? processOrId : processOrId.processId;
	return allDefinitions(definitions).find((definition) => definition.id === processId) ?? null;
}

export function getTaskProcessStage(
	process: RuntimeTaskProcessState,
	definitions?: readonly RuntimeTaskProcessDefinition[],
): RuntimeTaskProcessStageDefinition | null {
	const definition = getTaskProcessDefinition(process, definitions);
	const stage = definition?.states[process.stageId];
	return stage ? stageWithId(process.stageId, stage) : null;
}

function transitionConditionValue(
	condition: RuntimeTaskProcessConditionalTransition,
	context: TaskProcessTransitionContext,
): string | null {
	switch (condition.path) {
		case "agent":
			return context.agent ?? null;
		case "model":
			return context.model ?? null;
		case "notes":
			return context.notes ?? null;
	}
}

export function taskProcessTransitionConditionMatches(
	condition: RuntimeTaskProcessConditionalTransition,
	context: TaskProcessTransitionContext,
): boolean {
	if (condition.verdict !== context.verdict) {
		return false;
	}
	const value = transitionConditionValue(condition, context);
	if (!value) {
		return false;
	}
	if (condition.equals !== undefined) {
		return value === condition.equals;
	}
	if (condition.contains !== undefined) {
		return value.includes(condition.contains);
	}
	return false;
}

function resolveTaskProcessTargetStageId(
	stage: RuntimeTaskProcessStateDefinition,
	context: TaskProcessTransitionContext,
): string | undefined {
	const conditionalTransition = stage.conditions?.find((condition) =>
		taskProcessTransitionConditionMatches(condition, context),
	);
	return conditionalTransition?.target ?? stage.on[context.verdict];
}

function formatConditionalTransition(condition: RuntimeTaskProcessConditionalTransition): string {
	const matcher =
		condition.equals !== undefined
			? `${condition.path} equals ${shellQuote(condition.equals)}`
			: `${condition.path} contains ${shellQuote(condition.contains ?? "")}`;
	const label = condition.label?.trim() ? ` (${condition.label.trim()})` : "";
	return `${condition.verdict} when ${matcher} -> ${condition.target}${label}`;
}

function getTaskProcessPassPath(definition: RuntimeTaskProcessDefinition): string[] {
	const stages: string[] = [];
	const seen = new Set<string>();
	let stageId: string | undefined = definition.initial;
	for (let index = 0; stageId && index <= Object.keys(definition.states).length; index += 1) {
		if (seen.has(stageId)) {
			break;
		}
		seen.add(stageId);
		stages.push(stageId);
		const stage: RuntimeTaskProcessStateDefinition | undefined = definition.states[stageId];
		if (!stage || stage.terminal) {
			break;
		}
		stageId = stage.on.pass;
	}
	return stages;
}

export function getTaskProcessProgress(
	process: RuntimeTaskProcessState,
	definitions?: readonly RuntimeTaskProcessDefinition[],
): RuntimeTaskProcessProgress {
	const definition = getTaskProcessDefinition(process, definitions);
	if (!definition) {
		return {
			stages: [process.stageId],
			gatesPassed: process.status === "complete" ? 1 : 0,
			totalGates: process.status === "complete" ? 1 : 0,
			currentStageIndex: 0,
			offPath: false,
			reworkOf: null,
			complete: process.status === "complete",
		};
	}
	const stages = getTaskProcessPassPath(definition);
	const passPathStageSet = new Set(stages);
	const totalGates = Math.max(0, stages.length - 1);
	const passedPathStages = new Set<string>();
	let offPath = !passPathStageSet.has(process.stageId);
	let reworkOf: string | null = null;
	for (const entry of process.history) {
		if (entry.recordKind === "append") {
			continue;
		}
		if (entry.verdict === "pass" && passPathStageSet.has(entry.stageId)) {
			passedPathStages.add(entry.stageId);
			continue;
		}
		if (entry.verdict === "fail") {
			offPath = true;
			reworkOf = entry.stageId;
			continue;
		}
		if (entry.verdict && !passPathStageSet.has(entry.stageId)) {
			offPath = true;
		}
	}
	const currentStageIndex = stages.indexOf(process.stageId);
	return {
		stages,
		gatesPassed: process.status === "complete" ? totalGates : Math.min(passedPathStages.size, totalGates),
		totalGates,
		currentStageIndex: currentStageIndex >= 0 ? currentStageIndex : null,
		offPath,
		reworkOf,
		complete: process.status === "complete",
	};
}

export function createTaskProcess(
	processId: RuntimeTaskProcessId,
	now: number = Date.now(),
	definitions?: readonly RuntimeTaskProcessDefinition[],
): RuntimeTaskProcessState {
	const definition = getTaskProcessDefinition(processId, definitions);
	if (!definition) {
		throw new Error(`Unsupported task process "${processId}".`);
	}
	const clonedDefinition = cloneProcessDefinition(definition);
	return {
		processId: clonedDefinition.id,
		processName: clonedDefinition.name,
		processDigest: definitionDigest(clonedDefinition),
		definition: clonedDefinition,
		stageId: clonedDefinition.initial,
		status: "ready",
		updatedAt: now,
		history: [],
	};
}

export function markTaskProcessRunning(
	process: RuntimeTaskProcessState,
	options: MarkTaskProcessRunningOptions = {},
): RuntimeTaskProcessState {
	if (process.status === "complete") {
		return process;
	}
	const now = options.now ?? Date.now();
	const notes = options.notes?.trim() || `Started ${process.stageId} stage.`;
	const agent = options.agent?.trim() || "kanban";
	const model = options.model?.trim();
	const historyEntry: RuntimeTaskProcessHistoryEntry = {
		stageId: process.stageId,
		recordKind: "dispatch",
		agent,
		...(model ? { model } : {}),
		notes,
		at: now,
	};
	return { ...process, status: "running", updatedAt: now, history: [...process.history, historyEntry] };
}

export function isPassiveDispatchStage(stage: RuntimeTaskProcessStageDefinition): boolean {
	return (
		stage.terminal !== true &&
		!stage.prompt?.trim() &&
		!stage.role?.trim() &&
		!stage.agentId &&
		(!stage.conditions || stage.conditions.length === 0) &&
		Boolean(stage.on.pass) &&
		!stage.on.fail
	);
}

export function getMissingRunnableTaskProcessPromptStageIds(definition: RuntimeTaskProcessDefinition): string[] {
	const missingStageIds: string[] = [];
	const reachableStageIds = new Set<string>();
	const pendingStageIds = [definition.initial];
	for (const stageId of pendingStageIds) {
		if (reachableStageIds.has(stageId)) {
			continue;
		}
		const stateDefinition = definition.states[stageId];
		if (!stateDefinition) {
			continue;
		}
		reachableStageIds.add(stageId);
		const stage = stageWithId(stageId, stateDefinition);
		if (stage.terminal !== true && !isPassiveDispatchStage(stage) && !stage.prompt?.trim()) {
			missingStageIds.push(stageId);
		}
		for (const targetStageId of [
			stage.on.pass,
			stage.on.fail,
			...(stage.conditions ?? []).map((condition) => condition.target),
		]) {
			if (targetStageId && !reachableStageIds.has(targetStageId)) {
				pendingStageIds.push(targetStageId);
			}
		}
	}
	return missingStageIds;
}

export function assertLaunchableTaskProcessDefinitions(definitions: readonly RuntimeTaskProcessDefinition[]): void {
	for (const definition of definitions) {
		const missingPromptStageIds = getMissingRunnableTaskProcessPromptStageIds(definition);
		if (missingPromptStageIds.length > 0) {
			throw new Error(
				`Process "${definition.id}" must define prompt(s) for runnable stage(s): ${missingPromptStageIds.join(", ")}.`,
			);
		}
	}
}

export function getTaskProcessStagePromptIssue(
	process: RuntimeTaskProcessState,
	definitions?: readonly RuntimeTaskProcessDefinition[],
): string | null {
	const stage = getTaskProcessStage(process, definitions);
	if (!stage || stage.terminal || isPassiveDispatchStage(stage) || stage.prompt?.trim()) {
		return null;
	}
	return `Task process "${process.processId}" stage "${stage.id}" is missing a stage prompt.`;
}

export function assertTaskProcessStagePromptReady(
	process: RuntimeTaskProcessState,
	definitions?: readonly RuntimeTaskProcessDefinition[],
): void {
	const promptIssue = getTaskProcessStagePromptIssue(process, definitions);
	if (promptIssue) {
		throw new Error(promptIssue);
	}
}

export function advanceTaskProcessPastPassiveDispatchStages(
	process: RuntimeTaskProcessState,
	options: { now?: number; definitions?: readonly RuntimeTaskProcessDefinition[] } = {},
): RuntimeTaskProcessState {
	let nextProcess = process;
	const definition = getTaskProcessDefinition(process, options.definitions);
	const maxTransitions = definition ? Object.keys(definition.states).length + 1 : 1;
	for (let index = 0; index < maxTransitions; index += 1) {
		const stage = getTaskProcessStage(nextProcess, options.definitions);
		if (!stage || !isPassiveDispatchStage(stage)) {
			return nextProcess;
		}
		nextProcess = transitionTaskProcess(nextProcess, "pass", {
			definitions: options.definitions,
			recordKind: "dispatch",
			agent: "kanban",
			notes: `Dispatched ${stage.id} to ${stage.on.pass}.`,
			now: options.now,
		});
	}
	throw new Error(`Task process "${process.processId}" passive dispatch loop exceeded the stage count.`);
}

export function transitionTaskProcess(
	process: RuntimeTaskProcessState,
	verdict: RuntimeTaskProcessVerdict,
	options: TransitionTaskProcessOptions = {},
): RuntimeTaskProcessState {
	if (process.status === "complete") {
		throw new Error(`Task process "${process.processId}" is already complete.`);
	}
	const definition = getTaskProcessDefinition(process, options.definitions);
	if (!definition) {
		throw new Error(`Unsupported task process "${process.processId}".`);
	}
	const stage = definition.states[process.stageId];
	if (!stage) {
		throw new Error(`Task process "${process.processId}" does not define stage "${process.stageId}".`);
	}
	if (stage.terminal) {
		throw new Error(`Task process "${process.processId}" stage "${process.stageId}" is terminal.`);
	}
	const stageDefinition = stageWithId(process.stageId, stage);
	const isPassiveStage = isPassiveDispatchStage(stageDefinition);
	const recordKind = options.recordKind ?? (isPassiveStage ? "dispatch" : "outcome");
	const isDispatchTransition = recordKind === "dispatch";
	if (!isDispatchTransition && !isPassiveStage && process.status !== "running") {
		throw new Error(
			`Task process "${process.processId}" stage "${process.stageId}" must be running before recording ${verdict}. Run the stage first.`,
		);
	}
	const notes = options.notes?.trim();
	const agent = options.agent?.trim();
	const model = options.model?.trim();
	const nextStageId = resolveTaskProcessTargetStageId(stage, {
		verdict,
		stageId: process.stageId,
		...(agent ? { agent } : {}),
		...(model ? { model } : {}),
		...(notes ? { notes } : {}),
		...(process.lastVerdict ? { lastVerdict: process.lastVerdict } : {}),
	});
	if (!nextStageId) {
		throw new Error(`Task process "${process.processId}" stage "${process.stageId}" does not allow ${verdict}.`);
	}
	const nextStage = definition.states[nextStageId];
	if (!nextStage) {
		throw new Error(`Task process "${process.processId}" transition points to unknown stage "${nextStageId}".`);
	}

	const now = options.now ?? Date.now();
	const historyEntry: RuntimeTaskProcessHistoryEntry = {
		stageId: process.stageId,
		targetStageId: nextStageId,
		verdict,
		recordKind,
		...(agent ? { agent } : {}),
		...(model ? { model } : {}),
		...(notes ? { notes } : {}),
		at: now,
	};
	return {
		...process,
		processName: process.processName ?? definition.name,
		processDigest: process.processDigest ?? definitionDigest(definition),
		definition: process.definition ?? cloneProcessDefinition(definition),
		stageId: nextStageId,
		status: nextStage.terminal ? "complete" : "ready",
		lastVerdict: verdict,
		updatedAt: now,
		history: [...process.history, historyEntry],
	};
}

export function appendTaskProcessHistory(
	process: RuntimeTaskProcessState,
	options: AppendTaskProcessHistoryOptions,
): RuntimeTaskProcessState {
	if (process.status === "complete") {
		throw new Error(`Task process "${process.processId}" is already complete.`);
	}
	const notes = options.notes.trim();
	if (!notes) {
		throw new Error("Process notes cannot be empty.");
	}
	const now = options.now ?? Date.now();
	const historyEntry: RuntimeTaskProcessHistoryEntry = {
		stageId: process.stageId,
		recordKind: options.recordKind ?? "append",
		...(options.agent?.trim() ? { agent: options.agent.trim() } : {}),
		...(options.model?.trim() ? { model: options.model.trim() } : {}),
		notes,
		at: now,
	};
	return {
		...process,
		updatedAt: now,
		history: [...process.history, historyEntry],
	};
}

export function reopenTaskProcess(
	process: RuntimeTaskProcessState,
	options: ReopenTaskProcessOptions,
): RuntimeTaskProcessState {
	const definition = getTaskProcessDefinition(process, options.definitions);
	if (!definition) {
		throw new Error(`Unsupported task process "${process.processId}".`);
	}
	const stage = definition.states[process.stageId];
	if (!stage) {
		throw new Error(`Task process "${process.processId}" does not define stage "${process.stageId}".`);
	}
	if (process.status !== "complete" || !stage.terminal) {
		throw new Error(`Task process "${process.processId}" is not in a terminal state; use append, pass, or fail.`);
	}
	const initialStage = definition.states[definition.initial];
	if (!initialStage) {
		throw new Error(`Task process "${process.processId}" initial stage "${definition.initial}" is not defined.`);
	}
	if (initialStage.terminal) {
		throw new Error(`Task process "${process.processId}" initial stage "${definition.initial}" is terminal.`);
	}
	const notes = options.notes.trim();
	if (!notes) {
		throw new Error("Process reopen notes cannot be empty.");
	}
	const now = options.now ?? Date.now();
	const historyEntry: RuntimeTaskProcessHistoryEntry = {
		stageId: "reopened",
		targetStageId: definition.initial,
		recordKind: "reopen",
		...(options.agent?.trim() ? { agent: options.agent.trim() } : {}),
		...(options.model?.trim() ? { model: options.model.trim() } : {}),
		notes,
		at: now,
	};
	const { lastVerdict: _lastVerdict, ...processWithoutLastVerdict } = process;
	return {
		...processWithoutLastVerdict,
		processName: process.processName ?? definition.name,
		processDigest: process.processDigest ?? definitionDigest(definition),
		definition: process.definition ?? cloneProcessDefinition(definition),
		stageId: definition.initial,
		status: "ready",
		updatedAt: now,
		history: [...process.history, historyEntry],
	};
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatProcessHistory(process: RuntimeTaskProcessState): string {
	if (process.history.length === 0) {
		return "No prior process history.";
	}
	return process.history
		.map((entry) => {
			const parts = [
				`- ${entry.stageId}`,
				entry.targetStageId ? `target=${entry.targetStageId}` : null,
				entry.recordKind ? `kind=${entry.recordKind}` : null,
				entry.verdict ? `verdict=${entry.verdict}` : null,
				entry.agent ? `agent=${entry.agent}` : null,
				entry.model ? `model=${entry.model}` : null,
				entry.notes ? `notes=${entry.notes}` : null,
			].filter((part): part is string => Boolean(part));
			return parts.join(" ");
		})
		.join("\n");
}

function formatStageTransitionRules(stage: RuntimeTaskProcessStageDefinition): string {
	const rules = [
		...(stage.conditions ?? []).map(formatConditionalTransition),
		stage.on.pass ? `pass -> ${stage.on.pass}` : null,
		stage.on.fail ? `fail -> ${stage.on.fail}` : null,
	].filter((rule): rule is string => Boolean(rule));
	if (rules.length === 0) {
		return "No outgoing transitions.";
	}
	return rules.map((rule) => `- ${rule}`).join("\n");
}

export function buildTaskProcessStagePrompt(input: TaskProcessLaunchPromptInput): string {
	const stage = getTaskProcessStage(input.process, input.definitions);
	if (!stage) {
		throw new Error(`Task process "${input.process.processId}" does not define stage "${input.process.stageId}".`);
	}
	if (stage.terminal) {
		throw new Error(`Task process "${input.process.processId}" stage "${stage.id}" is terminal.`);
	}
	const stageAgent = stage.role?.trim() || stage.id;
	const projectArg = input.workspacePath?.trim() ? ` --project-path ${shellQuote(input.workspacePath.trim())}` : "";
	const baseCommandArgs = `--task-id ${shellQuote(input.taskId)}${projectArg} --process ${shellQuote(input.process.processId)} --expected-stage ${shellQuote(stage.id)} --agent ${shellQuote(stageAgent)}`;
	const kanbanCommand = input.kanbanCommand?.trim() || "kanban";
	const stageInstructions = stage.prompt?.trim();
	if (!stageInstructions) {
		throw new Error(`Task process "${input.process.processId}" stage "${stage.id}" is missing a stage prompt.`);
	}
	const title = input.taskTitle?.trim();
	return [
		"You are the fresh agent for a Kanban process stage.",
		[
			`Task ID: ${input.taskId}`,
			title ? `Task title: ${title}` : null,
			`Process: ${input.process.processName ?? input.process.processId}`,
			`Current stage: ${stage.id} (${stage.label})`,
			`Expected stage guard: ${stage.id}`,
		]
			.filter((line): line is string => Boolean(line))
			.join("\n"),
		`Stage instructions:\n${stageInstructions}`,
		`Kanban item:\n${input.taskPrompt.trim()}`,
		`Process history:\n${formatProcessHistory(input.process)}`,
		`Transition routes:\n${formatStageTransitionRules(stage)}`,
		[
			"Use the Kanban CLI to update process state. Do not edit process state by hand.",
			`Append evidence without changing stage:\n${kanbanCommand} task process append ${baseCommandArgs} --notes ${shellQuote("what changed / evidence")}`,
			`Pass this stage:\n${kanbanCommand} task process pass ${baseCommandArgs} --notes ${shellQuote("why this stage passes / evidence")}`,
			`Fail this stage:\n${kanbanCommand} task process fail ${baseCommandArgs} --notes ${shellQuote("why this stage fails / required rework")}`,
		].join("\n\n"),
	].join("\n\n");
}

function processDefinitionIssueText(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
	return error.issues
		.map((issue) => `${issue.path.map((segment) => String(segment)).join(".") || "definition"}: ${issue.message}`)
		.join("; ");
}

export function parseTaskProcessDefinitionInput(
	rawDefinition: unknown,
	indexLabel = "definition",
): RuntimeTaskProcessDefinition {
	const parsedDefinition = runtimeTaskProcessDefinitionSchema.safeParse(rawDefinition);
	if (parsedDefinition.success) {
		return parsedDefinition.data;
	}
	throw new Error(
		`Invalid process definition at ${indexLabel}: ${processDefinitionIssueText(parsedDefinition.error)}`,
	);
}

export function parseTaskProcessDefinitionsJson(value: string): RuntimeTaskProcessDefinition[] {
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(value);
	} catch (error) {
		const message = error instanceof Error && error.message.trim() ? error.message : String(error);
		throw new Error(`Invalid process JSON: ${message}`);
	}
	const rawDefinitions = Array.isArray(parsedJson) ? parsedJson : [parsedJson];
	return rawDefinitions.map((rawDefinition, index) =>
		parseTaskProcessDefinitionInput(rawDefinition, `definition[${index}]`),
	);
}
