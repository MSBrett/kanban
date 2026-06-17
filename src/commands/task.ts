import { readFile } from "node:fs/promises";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import type { Command } from "commander";

import type {
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardDependency,
	RuntimeClineReasoningEffort,
	RuntimeTaskAgentSettings,
	RuntimeTaskClineSettings,
	RuntimeTaskProcessDefinition,
	RuntimeTaskProcessState,
	RuntimeTaskProcessVerdict,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import { runtimeAgentIdSchema, runtimeClineReasoningEffortSchema } from "../core/api-contract";
import { resolveKanbanCommandLine } from "../core/kanban-command";
import { buildKanbanRuntimeUrl, getKanbanRuntimeOrigin, getRuntimeFetch } from "../core/runtime-endpoint";
import {
	addTaskDependency,
	addTaskToColumn,
	deleteTasksFromBoard,
	getBlockingDependencyTaskIds,
	getTaskColumnId,
	moveTaskToColumn,
	type RuntimeAddTaskDependencyResult,
	removeTaskDependency,
	taskHasIncompleteProcess,
	trashTaskAndGetReadyLinkedTaskIds,
	updateTask,
	updateTaskProcess,
} from "../core/task-board-mutations";
import {
	advanceTaskProcessPastPassiveDispatchStages,
	appendTaskProcessHistory,
	assertLaunchableTaskProcessDefinitions,
	assertTaskProcessStagePromptReady,
	buildTaskProcessStagePrompt,
	createTaskProcess,
	getTaskProcessDefinition,
	getTaskProcessDefinitions,
	getTaskProcessProgress,
	getTaskProcessStage,
	isPassiveDispatchStage,
	markTaskProcessRunning,
	parseTaskProcessDefinitionsJson,
	reopenTaskProcess,
	transitionTaskProcess,
} from "../core/task-process";
import { resolveProjectInputPath } from "../projects/project-path";
import { loadWorkspaceContext, mutateWorkspaceState } from "../state/workspace-state";
import type { RuntimeAppRouter } from "../trpc/app-router";

const LIST_TASK_COLUMNS = ["backlog", "in_progress", "review", "trash"] as const;
type ListTaskColumn = (typeof LIST_TASK_COLUMNS)[number];
type TaskCommandTarget = { taskId?: string; column?: ListTaskColumn };

type ResolvedTaskCommandTarget =
	| {
			kind: "task";
			taskId: string;
	  }
	| {
			kind: "column";
			column: ListTaskColumn;
	  };

interface RuntimeWorkspaceMutationResult<T> {
	board: RuntimeWorkspaceStateResponse["board"];
	value: T;
}

type JsonRecord = Record<string, unknown>;

function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}
	return String(error);
}

function printJson(payload: unknown): void {
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function parseListColumn(value: string | undefined): ListTaskColumn | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "done") {
		return "trash";
	}
	if (value === "backlog" || value === "in_progress" || value === "review" || value === "trash") {
		return value;
	}
	throw new Error(`Invalid column "${value}". Expected one of: ${LIST_TASK_COLUMNS.join(", ")}, done.`);
}

function parseAutoReviewMode(value: string | undefined): "commit" | "pr" | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "commit" || value === "pr") {
		return value;
	}
	throw new Error(`Invalid auto review mode "${value}". Expected: commit, pr.`);
}

const VALID_AGENT_IDS = runtimeAgentIdSchema.options;

function parseAgentId(value: string | undefined): RuntimeAgentId | null | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "default") {
		return null;
	}
	const result = runtimeAgentIdSchema.safeParse(value);
	if (result.success) {
		return result.data;
	}
	throw new Error(`Invalid agent ID "${value}". Expected one of: ${VALID_AGENT_IDS.join(", ")}, default.`);
}

function parseOptionalStringOrDefault(value: string | undefined): string | null | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "default") {
		return null;
	}
	return value;
}

function parseOptionalProcessId(value: string | undefined): string | null | undefined {
	if (value === undefined) {
		return undefined;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		throw new Error("Process ID cannot be empty.");
	}
	if (trimmed === "none" || trimmed === "default") {
		return null;
	}
	return trimmed;
}

type ParsedTaskClineReasoningEffort = RuntimeClineReasoningEffort | "default" | null | undefined;

function parseTaskClineReasoningEffort(value: string | undefined): ParsedTaskClineReasoningEffort {
	if (value === undefined) {
		return undefined;
	}
	if (value === "inherit") {
		return null;
	}
	if (value === "default") {
		return "default";
	}
	const result = runtimeClineReasoningEffortSchema.safeParse(value);
	if (result.success) {
		return result.data;
	}
	throw new Error("Invalid Cline reasoning effort. Expected one of: default, low, medium, high, xhigh, inherit.");
}

function cloneTaskClineSettings(settings?: RuntimeTaskClineSettings): RuntimeTaskClineSettings | undefined {
	if (settings === undefined) {
		return undefined;
	}
	const providerId = settings.providerId?.trim();
	const modelId = settings.modelId?.trim();
	return {
		...(providerId ? { providerId } : {}),
		...(modelId ? { modelId } : {}),
		...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
	};
}

function cloneTaskAgentSettings(settings?: RuntimeTaskAgentSettings): RuntimeTaskAgentSettings | undefined {
	if (settings === undefined) {
		return undefined;
	}
	const modelId = settings.modelId?.trim();
	return {
		...(modelId ? { modelId } : {}),
		...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
	};
}

function formatTaskAgentSettings(settings?: RuntimeTaskAgentSettings): JsonRecord {
	if (settings === undefined) {
		return {};
	}
	return {
		agentSettings: cloneTaskAgentSettings(settings) ?? {},
	};
}

function formatTaskClineSettings(settings?: RuntimeTaskClineSettings): JsonRecord {
	if (settings === undefined) {
		return {};
	}
	return {
		clineSettings: cloneTaskClineSettings(settings) ?? {},
	};
}

function buildTaskClineSettingsForCreate(input: {
	providerId?: string;
	modelId?: string;
	reasoningEffort?: ParsedTaskClineReasoningEffort;
}): RuntimeTaskClineSettings | undefined {
	const providerId = input.providerId?.trim();
	const modelId = input.modelId?.trim();
	const reasoningEffort = input.reasoningEffort === null ? undefined : input.reasoningEffort;
	if (!providerId && !modelId && reasoningEffort === undefined) {
		return undefined;
	}
	return {
		...(providerId ? { providerId } : {}),
		...(modelId ? { modelId } : {}),
		...(reasoningEffort && reasoningEffort !== "default" ? { reasoningEffort } : {}),
	};
}

function buildTaskClineSettingsForUpdate(
	currentSettings: RuntimeTaskClineSettings | undefined,
	input: {
		providerId?: string | null;
		modelId?: string | null;
		reasoningEffort?: ParsedTaskClineReasoningEffort;
	},
): RuntimeTaskClineSettings | null | undefined {
	if (input.providerId === undefined && input.modelId === undefined && input.reasoningEffort === undefined) {
		return undefined;
	}
	const nextSettings = cloneTaskClineSettings(currentSettings) ?? {};
	let preserveEmptyOverride = currentSettings !== undefined && Object.keys(currentSettings).length === 0;

	if (input.providerId !== undefined) {
		const providerId = input.providerId?.trim();
		if (providerId) {
			nextSettings.providerId = providerId;
		} else {
			delete nextSettings.providerId;
		}
	}

	if (input.modelId !== undefined) {
		const modelId = input.modelId?.trim();
		if (modelId) {
			nextSettings.modelId = modelId;
		} else {
			delete nextSettings.modelId;
		}
	}

	if (input.reasoningEffort !== undefined) {
		if (input.reasoningEffort === "default") {
			delete nextSettings.reasoningEffort;
			preserveEmptyOverride = true;
		} else if (input.reasoningEffort === null) {
			delete nextSettings.reasoningEffort;
			preserveEmptyOverride = false;
		} else {
			nextSettings.reasoningEffort = input.reasoningEffort;
		}
	}

	if (
		nextSettings.providerId === undefined &&
		nextSettings.modelId === undefined &&
		nextSettings.reasoningEffort === undefined &&
		!preserveEmptyOverride
	) {
		return null;
	}

	return nextSettings;
}

function resolveTaskCommandTarget(input: TaskCommandTarget, commandName: string): ResolvedTaskCommandTarget {
	const taskId = input.taskId?.trim();
	const column = input.column;
	if (taskId && column) {
		throw new Error(`${commandName} accepts exactly one of --task-id or --column.`);
	}
	if (taskId) {
		return {
			kind: "task",
			taskId,
		};
	}
	if (column) {
		return {
			kind: "column",
			column,
		};
	}
	throw new Error(`${commandName} requires either --task-id or --column.`);
}

function createRuntimeTrpcClient(workspaceId: string | null) {
	return createTRPCProxyClient<RuntimeAppRouter>({
		links: [
			httpBatchLink({
				url: buildKanbanRuntimeUrl("/api/trpc"),
				headers: () => (workspaceId ? { "x-kanban-workspace-id": workspaceId } : {}),
				fetch: async (url, options) => {
					const runtimeFetch = await getRuntimeFetch();
					return runtimeFetch(url, options);
				},
			}),
		],
	});
}

async function resolveRuntimeWorkspace(
	projectPath: string | undefined,
	cwd: string,
	options: { autoCreateIfMissing?: boolean } = {},
) {
	const normalizedProjectPath = (projectPath ?? "").trim();
	const resolvedPath = normalizedProjectPath ? resolveProjectInputPath(normalizedProjectPath, cwd) : cwd;
	return await loadWorkspaceContext(resolvedPath, {
		autoCreateIfMissing: options.autoCreateIfMissing ?? true,
	});
}

async function resolveWorkspaceRepoPath(
	projectPath: string | undefined,
	cwd: string,
	options: { autoCreateIfMissing?: boolean } = {},
): Promise<string> {
	const workspace = await resolveRuntimeWorkspace(projectPath, cwd, options);
	return workspace.repoPath;
}

async function ensureRuntimeWorkspace(workspaceRepoPath: string): Promise<string> {
	const runtimeClient = createRuntimeTrpcClient(null);
	const added = await runtimeClient.projects.add.mutate({
		path: workspaceRepoPath,
	});
	if (!added.ok || !added.project) {
		throw new Error(added.error ?? `Could not register project ${workspaceRepoPath} in Kanban runtime.`);
	}
	return added.project.id;
}

async function notifyRuntimeWorkspaceStateUpdated(
	runtimeClient: ReturnType<typeof createRuntimeTrpcClient>,
): Promise<void> {
	await runtimeClient.workspace.notifyStateUpdated.mutate().catch(() => null);
}

async function updateRuntimeWorkspaceState<T>(
	runtimeClient: ReturnType<typeof createRuntimeTrpcClient>,
	workspaceRepoPath: string,
	mutate: (state: RuntimeWorkspaceStateResponse) => RuntimeWorkspaceMutationResult<T>,
): Promise<T> {
	const mutationResponse = await mutateWorkspaceState(workspaceRepoPath, (state) => {
		const mutation = mutate(state);
		return {
			board: mutation.board,
			value: mutation.value,
		};
	});

	if (mutationResponse.saved) {
		await notifyRuntimeWorkspaceStateUpdated(runtimeClient);
	}

	return mutationResponse.value;
}

function resolveTaskBaseRef(state: RuntimeWorkspaceStateResponse): string {
	return state.git.currentBranch ?? state.git.defaultBranch ?? state.git.branches[0] ?? "";
}

function findTaskRecord(
	state: RuntimeWorkspaceStateResponse,
	taskId: string,
): { task: RuntimeBoardCard; columnId: RuntimeBoardColumnId } | null {
	for (const column of state.board.columns) {
		const task = column.cards.find((candidate) => candidate.id === taskId);
		if (task) {
			return {
				task,
				columnId: column.id,
			};
		}
	}
	return null;
}

function formatTaskProcessRecord(process: RuntimeBoardCard["process"]): JsonRecord | null {
	if (!process) {
		return null;
	}
	const progress = getTaskProcessProgress(process);
	return {
		id: process.processId,
		name: process.processName ?? process.processId,
		digest: process.processDigest ?? null,
		stageId: process.stageId,
		status: process.status,
		lastVerdict: process.lastVerdict ?? null,
		updatedAt: process.updatedAt,
		progress: {
			stages: progress.stages,
			gatesPassed: progress.gatesPassed,
			totalGates: progress.totalGates,
			currentStageIndex: progress.currentStageIndex,
			offPath: progress.offPath,
			reworkOf: progress.reworkOf,
			complete: progress.complete,
		},
		history: process.history.map((entry) => ({
			stageId: entry.stageId,
			targetStageId: entry.targetStageId ?? null,
			recordKind: entry.recordKind ?? null,
			verdict: entry.verdict ?? null,
			agent: entry.agent ?? null,
			model: entry.model ?? null,
			notes: entry.notes ?? null,
			at: entry.at,
		})),
	};
}

function getEffectiveReadyTaskProcessStageId(
	process: RuntimeTaskProcessState,
	definitions: readonly RuntimeTaskProcessDefinition[],
): string {
	if (process.status !== "ready") {
		return process.stageId;
	}
	try {
		return advanceTaskProcessPastPassiveDispatchStages(process, { definitions }).stageId;
	} catch {
		return process.stageId;
	}
}

function formatTaskProcessDefinitionRecord(
	definition: RuntimeTaskProcessDefinition,
	customProcessIds: Set<string>,
): JsonRecord {
	return {
		...definition,
		source: customProcessIds.has(definition.id) ? "custom" : "built-in",
	};
}

function formatTaskRecord(
	state: RuntimeWorkspaceStateResponse,
	task: RuntimeBoardCard,
	columnId: RuntimeBoardColumnId,
): JsonRecord {
	const session = state.sessions[task.id] ?? null;
	return {
		id: task.id,
		prompt: task.prompt,
		column: columnId,
		baseRef: task.baseRef,
		startInPlanMode: task.startInPlanMode,
		autoReviewEnabled: task.autoReviewEnabled === true,
		autoReviewMode: task.autoReviewMode ?? "commit",
		...(task.agentId ? { agentId: task.agentId } : {}),
		...formatTaskAgentSettings(task.agentSettings),
		...formatTaskClineSettings(task.clineSettings),
		process: formatTaskProcessRecord(task.process),
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
		session: session
			? {
					state: session.state,
					agentId: session.agentId,
					pid: session.pid,
					startedAt: session.startedAt,
					updatedAt: session.updatedAt,
					lastOutputAt: session.lastOutputAt,
					reviewReason: session.reviewReason,
					exitCode: session.exitCode,
				}
			: null,
	};
}

function formatDependencyRecord(
	state: RuntimeWorkspaceStateResponse,
	dependency: RuntimeBoardDependency,
): Record<string, unknown> {
	return {
		id: dependency.id,
		backlogTaskId: dependency.fromTaskId,
		backlogTaskColumn: getTaskColumnId(state.board, dependency.fromTaskId),
		linkedTaskId: dependency.toTaskId,
		linkedTaskColumn: getTaskColumnId(state.board, dependency.toTaskId),
		createdAt: dependency.createdAt,
	};
}

function getLinkFailureMessage(reason: RuntimeAddTaskDependencyResult["reason"]): string {
	if (reason === "same_task") {
		return "A task cannot be linked to itself.";
	}
	if (reason === "duplicate") {
		return "These tasks are already linked.";
	}
	if (reason === "trash_task") {
		return "Links cannot include done tasks.";
	}
	if (reason === "non_backlog") {
		return "Links require at least one backlog task.";
	}
	return "One or both tasks could not be found.";
}

function findTasksInColumn(
	state: RuntimeWorkspaceStateResponse,
	columnId: ListTaskColumn,
): Array<{ task: RuntimeBoardCard; columnId: RuntimeBoardColumnId }> {
	const column = state.board.columns.find((candidate) => candidate.id === columnId);
	if (!column) {
		return [];
	}
	return column.cards.map((task) => ({
		task,
		columnId: column.id,
	}));
}

async function listTasks(input: { cwd: string; projectPath?: string; column?: ListTaskColumn }): Promise<JsonRecord> {
	const workspace = await resolveRuntimeWorkspace(input.projectPath, input.cwd, {
		autoCreateIfMissing: false,
	});
	const runtimeClient = createRuntimeTrpcClient(workspace.workspaceId);
	const state = await runtimeClient.workspace.getState.query();

	const tasks = state.board.columns.flatMap((boardColumn) => {
		if (!input.column && boardColumn.id === "trash") {
			return [];
		}
		if (input.column && boardColumn.id !== input.column) {
			return [];
		}
		return boardColumn.cards.map((task) => formatTaskRecord(state, task, boardColumn.id));
	});

	return {
		ok: true,
		workspacePath: workspace.repoPath,
		column: input.column ?? null,
		tasks,
		dependencies: state.board.dependencies.map((dependency) => formatDependencyRecord(state, dependency)),
		count: tasks.length,
	};
}

async function stopTaskRuntimeSession(
	runtimeClient: ReturnType<typeof createRuntimeTrpcClient>,
	taskId: string,
): Promise<void> {
	await runtimeClient.runtime.stopTaskSession
		.mutate({
			taskId,
		})
		.catch(() => null);
}

async function deleteTaskWorkspace(
	runtimeClient: ReturnType<typeof createRuntimeTrpcClient>,
	taskId: string,
): Promise<{ removed: boolean; error?: string }> {
	try {
		const deleted = await runtimeClient.workspace.deleteWorktree.mutate({
			taskId,
		});
		return {
			removed: deleted.removed,
			error: deleted.ok ? undefined : deleted.error,
		};
	} catch (error) {
		return {
			removed: false,
			error: toErrorMessage(error),
		};
	}
}

async function createTask(input: {
	cwd: string;
	taskId?: string;
	title?: string;
	prompt: string;
	projectPath?: string;
	baseRef?: string;
	startInPlanMode?: boolean;
	autoReviewEnabled?: boolean;
	autoReviewMode?: "commit" | "pr";
	agentId?: RuntimeAgentId;
	agentSettings?: RuntimeTaskAgentSettings;
	clineSettings?: RuntimeTaskClineSettings;
	processId?: string;
}): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const created = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (state) => {
		const resolvedBaseRef = (input.baseRef ?? "").trim() || resolveTaskBaseRef(state);
		if (!resolvedBaseRef) {
			throw new Error("Could not determine task base branch for this workspace.");
		}
		const result = addTaskToColumn(
			state.board,
			"backlog",
			{
				taskId: input.taskId,
				title: input.title,
				prompt: input.prompt,
				startInPlanMode: input.startInPlanMode,
				autoReviewEnabled: input.autoReviewEnabled,
				autoReviewMode: input.autoReviewMode,
				agentId: input.agentId,
				agentSettings: input.agentSettings,
				clineSettings: input.clineSettings,
				processId: input.processId,
				baseRef: resolvedBaseRef,
			},
			() => globalThis.crypto.randomUUID(),
		);
		return {
			board: result.board,
			value: result.task,
		};
	});

	return {
		ok: true,
		task: {
			id: created.id,
			column: "backlog",
			workspacePath: workspaceRepoPath,
			title: created.title,
			prompt: created.prompt,
			baseRef: created.baseRef,
			startInPlanMode: created.startInPlanMode,
			autoReviewEnabled: created.autoReviewEnabled === true,
			autoReviewMode: created.autoReviewMode ?? "commit",
			...(created.agentId ? { agentId: created.agentId } : {}),
			...formatTaskAgentSettings(created.agentSettings),
			...formatTaskClineSettings(created.clineSettings),
			process: formatTaskProcessRecord(created.process),
		},
	};
}

async function updateTaskCommand(input: {
	cwd: string;
	taskId: string;
	title?: string;
	projectPath?: string;
	prompt?: string;
	baseRef?: string;
	startInPlanMode?: boolean;
	autoReviewEnabled?: boolean;
	autoReviewMode?: "commit" | "pr";
	agentId?: RuntimeAgentId | null;
	agentSettings?: RuntimeTaskAgentSettings | null;
	clineProviderId?: string | null;
	clineModelId?: string | null;
	clineReasoningEffort?: ParsedTaskClineReasoningEffort;
	processId?: string | null;
}): Promise<JsonRecord> {
	if (
		input.title === undefined &&
		input.prompt === undefined &&
		input.baseRef === undefined &&
		input.startInPlanMode === undefined &&
		input.autoReviewEnabled === undefined &&
		input.autoReviewMode === undefined &&
		input.agentId === undefined &&
		input.agentSettings === undefined &&
		input.clineProviderId === undefined &&
		input.clineModelId === undefined &&
		input.clineReasoningEffort === undefined &&
		input.processId === undefined
	) {
		throw new Error("task update requires at least one field to change.");
	}

	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const updated = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (runtimeState) => {
		const taskRecord = findTaskRecord(runtimeState, input.taskId);
		if (!taskRecord) {
			throw new Error(`Task "${input.taskId}" was not found in workspace ${workspaceRepoPath}.`);
		}
		const nextTaskClineSettings = buildTaskClineSettingsForUpdate(taskRecord.task.clineSettings, {
			providerId: input.clineProviderId,
			modelId: input.clineModelId,
			reasoningEffort: input.clineReasoningEffort,
		});
		const nextProcess =
			input.processId === undefined
				? undefined
				: input.processId === null
					? null
					: taskRecord.task.process?.processId === input.processId
						? taskRecord.task.process
						: createTaskProcess(input.processId, Date.now(), runtimeState.board.processes ?? []);

		const updatedTask = updateTask(runtimeState.board, input.taskId, {
			title: input.title ?? taskRecord.task.title,
			prompt: input.prompt ?? taskRecord.task.prompt,
			baseRef: input.baseRef ?? taskRecord.task.baseRef,
			startInPlanMode: input.startInPlanMode ?? taskRecord.task.startInPlanMode,
			autoReviewEnabled: input.autoReviewEnabled ?? taskRecord.task.autoReviewEnabled === true,
			autoReviewMode: input.autoReviewMode ?? taskRecord.task.autoReviewMode ?? "commit",
			agentId: input.agentId,
			agentSettings: input.agentSettings,
			clineSettings: nextTaskClineSettings,
			process: nextProcess,
		});
		if (!updatedTask.updated || !updatedTask.task) {
			throw new Error(`Task "${input.taskId}" could not be updated.`);
		}

		const nextState: RuntimeWorkspaceStateResponse = {
			...runtimeState,
			board: updatedTask.board,
		};

		return {
			board: updatedTask.board,
			value: formatTaskRecord(nextState, updatedTask.task, taskRecord.columnId),
		};
	});

	return {
		ok: true,
		task: updated,
		workspacePath: workspaceRepoPath,
	};
}

async function linkTasks(input: {
	cwd: string;
	taskId: string;
	linkedTaskId: string;
	projectPath?: string;
}): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const dependency = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (runtimeState) => {
		const linked = addTaskDependency(runtimeState.board, input.taskId, input.linkedTaskId);
		if (!linked.added || !linked.dependency) {
			throw new Error(getLinkFailureMessage(linked.reason));
		}

		const nextState: RuntimeWorkspaceStateResponse = {
			...runtimeState,
			board: linked.board,
		};
		return {
			board: linked.board,
			value: formatDependencyRecord(nextState, linked.dependency),
		};
	});
	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		dependency,
	};
}

async function unlinkTasks(input: { cwd: string; dependencyId: string; projectPath?: string }): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const removedDependency = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (runtimeState) => {
		const dependency =
			runtimeState.board.dependencies.find((candidate) => candidate.id === input.dependencyId) ?? null;
		if (!dependency) {
			throw new Error(`Dependency "${input.dependencyId}" was not found in workspace ${workspaceRepoPath}.`);
		}

		const unlinked = removeTaskDependency(runtimeState.board, input.dependencyId);
		if (!unlinked.removed) {
			throw new Error(`Dependency "${input.dependencyId}" could not be removed.`);
		}

		const nextState: RuntimeWorkspaceStateResponse = {
			...runtimeState,
			board: unlinked.board,
		};
		return {
			board: unlinked.board,
			value: formatDependencyRecord(nextState, dependency),
		};
	});
	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		removedDependency,
	};
}

async function listTaskProcesses(input: { cwd: string; projectPath?: string }): Promise<JsonRecord> {
	const workspace = await resolveRuntimeWorkspace(input.projectPath, input.cwd, {
		autoCreateIfMissing: false,
	});
	const runtimeClient = createRuntimeTrpcClient(workspace.workspaceId);
	const state = await runtimeClient.workspace.getState.query();
	const customDefinitions = state.board.processes ?? [];
	const customProcessIds = new Set(customDefinitions.map((definition) => definition.id));
	const definitions = getTaskProcessDefinitions(customDefinitions);

	return {
		ok: true,
		workspacePath: workspace.repoPath,
		processes: definitions.map((definition) => formatTaskProcessDefinitionRecord(definition, customProcessIds)),
		customProcesses: customDefinitions.map((definition) =>
			formatTaskProcessDefinitionRecord(definition, customProcessIds),
		),
		count: definitions.length,
		customCount: customDefinitions.length,
	};
}

function countAssignedTaskProcesses(board: RuntimeWorkspaceStateResponse["board"], processId: string): number {
	let count = 0;
	for (const column of board.columns) {
		for (const task of column.cards) {
			if (task.process?.processId === processId) {
				count += 1;
			}
		}
	}
	return count;
}

async function importTaskProcesses(input: {
	cwd: string;
	file: string;
	projectPath?: string;
	replace?: boolean;
}): Promise<JsonRecord> {
	const filePath = resolveProjectInputPath(input.file, input.cwd);
	const importedDefinitions = parseTaskProcessDefinitionsJson(await readFile(filePath, "utf8"));
	assertLaunchableTaskProcessDefinitions(importedDefinitions);
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const imported = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (runtimeState) => {
		const byId = new Map<string, RuntimeTaskProcessDefinition>();
		const existingDefinitions = runtimeState.board.processes ?? [];
		if (!input.replace) {
			for (const definition of existingDefinitions) {
				byId.set(definition.id, definition);
			}
		}
		for (const definition of importedDefinitions) {
			byId.set(definition.id, definition);
		}
		const nextProcesses = Array.from(byId.values());
		if (input.replace) {
			const nextProcessIds = new Set(nextProcesses.map((definition) => definition.id));
			for (const definition of existingDefinitions) {
				if (nextProcessIds.has(definition.id)) {
					continue;
				}
				const assignedCount = countAssignedTaskProcesses(runtimeState.board, definition.id);
				if (assignedCount > 0) {
					throw new Error(
						`Custom process "${definition.id}" is assigned to ${assignedCount} task${assignedCount === 1 ? "" : "s"} and cannot be removed by --replace.`,
					);
				}
			}
		}
		return {
			board: {
				...runtimeState.board,
				processes: nextProcesses,
			},
			value: nextProcesses,
		};
	});
	const customProcessIds = new Set(imported.map((definition) => definition.id));

	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		importedProcessIds: importedDefinitions.map((definition) => definition.id),
		replaced: input.replace === true,
		customProcesses: imported.map((definition) => formatTaskProcessDefinitionRecord(definition, customProcessIds)),
		customCount: imported.length,
	};
}

async function exportTaskProcess(input: { cwd: string; processId: string; projectPath?: string }): Promise<JsonRecord> {
	const processId = input.processId.trim();
	if (!processId) {
		throw new Error("Process ID cannot be empty.");
	}
	const workspace = await resolveRuntimeWorkspace(input.projectPath, input.cwd, {
		autoCreateIfMissing: false,
	});
	const runtimeClient = createRuntimeTrpcClient(workspace.workspaceId);
	const state = await runtimeClient.workspace.getState.query();
	const customProcessIds = new Set((state.board.processes ?? []).map((definition) => definition.id));
	const definition = getTaskProcessDefinitions(state.board.processes ?? []).find(
		(candidate) => candidate.id === processId,
	);
	if (!definition) {
		throw new Error(`Process "${processId}" was not found in workspace ${workspace.repoPath}.`);
	}

	return {
		ok: true,
		workspacePath: workspace.repoPath,
		process: formatTaskProcessDefinitionRecord(definition, customProcessIds),
		definition,
	};
}

async function removeTaskProcess(input: { cwd: string; processId: string; projectPath?: string }): Promise<JsonRecord> {
	const processId = input.processId.trim();
	if (!processId) {
		throw new Error("Process ID cannot be empty.");
	}
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const removed = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (runtimeState) => {
		const existingDefinitions = runtimeState.board.processes ?? [];
		const nextProcesses = existingDefinitions.filter((definition) => definition.id !== processId);
		if (nextProcesses.length === existingDefinitions.length) {
			throw new Error(`Custom process "${processId}" was not found in workspace ${workspaceRepoPath}.`);
		}
		const assignedCount = countAssignedTaskProcesses(runtimeState.board, processId);
		if (assignedCount > 0) {
			throw new Error(
				`Custom process "${processId}" is assigned to ${assignedCount} task${assignedCount === 1 ? "" : "s"} and cannot be removed.`,
			);
		}
		return {
			board: {
				...runtimeState.board,
				processes: nextProcesses,
			},
			value: nextProcesses,
		};
	});
	const customProcessIds = new Set(removed.map((definition) => definition.id));

	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		removedProcessId: processId,
		customProcesses: removed.map((definition) => formatTaskProcessDefinitionRecord(definition, customProcessIds)),
		customCount: removed.length,
	};
}

function isDoneColumn(columnId: RuntimeBoardColumnId): boolean {
	return columnId === "trash";
}

function buildTaskProcessStatusSummary(
	tasks: Array<{
		task: RuntimeBoardCard;
		columnId: RuntimeBoardColumnId;
		blocked: boolean;
		ready: boolean;
		readyStageId: string;
	}>,
): JsonRecord {
	const byProcess: Record<string, number> = {};
	const byStage: Record<string, number> = {};
	const byStatus: Record<string, number> = {};
	let readyCount = 0;
	let blockedCount = 0;
	for (const entry of tasks) {
		const process = entry.task.process;
		if (!process) {
			continue;
		}
		byProcess[process.processId] = (byProcess[process.processId] ?? 0) + 1;
		byStage[process.stageId] = (byStage[process.stageId] ?? 0) + 1;
		byStatus[process.status] = (byStatus[process.status] ?? 0) + 1;
		if (entry.ready) {
			readyCount += 1;
		}
		if (entry.blocked) {
			blockedCount += 1;
		}
	}
	return {
		total: tasks.length,
		ready: readyCount,
		blocked: blockedCount,
		byProcess,
		byStage,
		byStatus,
	};
}

async function getTaskProcessStatus(input: {
	cwd: string;
	projectPath?: string;
	processId?: string;
	stage?: string;
	readyStage?: string;
	ready?: boolean;
	blocked?: boolean;
	includeDone?: boolean;
	summary?: boolean;
}): Promise<JsonRecord> {
	const workspace = await resolveRuntimeWorkspace(input.projectPath, input.cwd, {
		autoCreateIfMissing: false,
	});
	const runtimeClient = createRuntimeTrpcClient(workspace.workspaceId);
	const state = await runtimeClient.workspace.getState.query();
	const processId = input.processId?.trim() || null;
	const stage = input.stage?.trim() || null;
	const readyStage = input.readyStage?.trim() || null;
	const definitions = state.board.processes ?? [];
	const statusEntries = state.board.columns.flatMap((column) =>
		column.cards.flatMap((task) => {
			if (!task.process) {
				return [];
			}
			if (!input.includeDone && isDoneColumn(column.id)) {
				return [];
			}
			if (processId && task.process.processId !== processId) {
				return [];
			}
			const blocked = getBlockingDependencyTaskIds(state.board, task.id).length > 0;
			const ready = task.process.status === "ready" && !blocked && !isDoneColumn(column.id);
			const readyStageId = getEffectiveReadyTaskProcessStageId(task.process, definitions);
			if (stage && task.process.stageId !== stage) {
				return [];
			}
			if (readyStage && readyStageId !== readyStage) {
				return [];
			}
			if (input.ready !== undefined && ready !== input.ready) {
				return [];
			}
			if (input.blocked !== undefined && blocked !== input.blocked) {
				return [];
			}
			return [
				{
					task,
					columnId: column.id,
					ready,
					readyStageId,
					blocked,
				},
			];
		}),
	);
	const tasks = statusEntries.map(({ task, columnId, ready, readyStageId, blocked }) => {
		const processRecord = formatTaskProcessRecord(task.process);
		return {
			...formatTaskRecord(state, task, columnId),
			process: processRecord ? { ...processRecord, readyStageId } : null,
			ready,
			blocked,
		};
	});
	const summary = buildTaskProcessStatusSummary(statusEntries);
	return {
		ok: true,
		workspacePath: workspace.repoPath,
		process: processId,
		stage,
		ready: input.ready ?? null,
		blocked: input.blocked ?? null,
		includeDone: input.includeDone === true,
		tasks,
		count: tasks.length,
		...(input.summary ? { summary } : {}),
	};
}

async function getTaskProcessHistory(input: {
	cwd: string;
	taskId: string;
	projectPath?: string;
	processId?: string;
}): Promise<JsonRecord> {
	const workspace = await resolveRuntimeWorkspace(input.projectPath, input.cwd, {
		autoCreateIfMissing: false,
	});
	const runtimeClient = createRuntimeTrpcClient(workspace.workspaceId);
	const state = await runtimeClient.workspace.getState.query();
	const taskRecord = findTaskRecord(state, input.taskId);
	if (!taskRecord) {
		throw new Error(`Task "${input.taskId}" was not found in workspace ${workspace.repoPath}.`);
	}
	if (!taskRecord.task.process) {
		throw new Error(`Task "${input.taskId}" does not have a process assigned.`);
	}
	const processId = input.processId?.trim();
	if (processId && taskRecord.task.process.processId !== processId) {
		throw new Error(
			`Task "${input.taskId}" is assigned to process "${taskRecord.task.process.processId}", expected "${processId}".`,
		);
	}
	const process = formatTaskProcessRecord(taskRecord.task.process);
	return {
		ok: true,
		workspacePath: workspace.repoPath,
		task: formatTaskRecord(state, taskRecord.task, taskRecord.columnId),
		process,
		history: (process?.history as unknown[]) ?? [],
		count: taskRecord.task.process.history.length,
	};
}

async function getTaskProcessBody(input: {
	cwd: string;
	taskId: string;
	projectPath?: string;
	processId?: string;
}): Promise<JsonRecord> {
	const workspace = await resolveRuntimeWorkspace(input.projectPath, input.cwd, {
		autoCreateIfMissing: false,
	});
	const runtimeClient = createRuntimeTrpcClient(workspace.workspaceId);
	const state = await runtimeClient.workspace.getState.query();
	const taskRecord = findTaskRecord(state, input.taskId);
	if (!taskRecord) {
		throw new Error(`Task "${input.taskId}" was not found in workspace ${workspace.repoPath}.`);
	}
	if (!taskRecord.task.process) {
		throw new Error(`Task "${input.taskId}" does not have a process assigned.`);
	}
	const processId = input.processId?.trim();
	if (processId && taskRecord.task.process.processId !== processId) {
		throw new Error(
			`Task "${input.taskId}" is assigned to process "${taskRecord.task.process.processId}", expected "${processId}".`,
		);
	}
	return {
		ok: true,
		workspacePath: workspace.repoPath,
		task: formatTaskRecord(state, taskRecord.task, taskRecord.columnId),
		process: formatTaskProcessRecord(taskRecord.task.process),
		body: taskRecord.task.prompt,
	};
}

async function reopenTaskProcessCommand(input: {
	cwd: string;
	taskId: string;
	notes: string;
	projectPath?: string;
	processId?: string;
	agent?: string;
	model?: string;
	expectedStage?: string;
}): Promise<JsonRecord> {
	const notes = input.notes.trim();
	if (!notes) {
		throw new Error("Process reopen notes are required.");
	}
	const agent = input.agent?.trim();
	if (!agent) {
		throw new Error("Process reopen agent is required.");
	}
	const expectedStage = input.expectedStage?.trim();
	const processId = input.processId?.trim();
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const mutation = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (runtimeState) => {
		const taskRecord = findTaskRecord(runtimeState, input.taskId);
		if (!taskRecord) {
			throw new Error(`Task "${input.taskId}" was not found in workspace ${workspaceRepoPath}.`);
		}
		const process = taskRecord.task.process;
		if (!process) {
			throw new Error(`Task "${input.taskId}" does not have a process assigned.`);
		}
		if (processId && process.processId !== processId) {
			throw new Error(
				`Task "${input.taskId}" is assigned to process "${process.processId}", expected "${processId}".`,
			);
		}
		if (expectedStage && process.stageId !== expectedStage) {
			throw new Error(
				`Task "${input.taskId}" is at process stage "${process.stageId}", expected "${expectedStage}".`,
			);
		}
		const model = input.model?.trim();
		const nextProcess = reopenTaskProcess(process, {
			notes,
			definitions: runtimeState.board.processes ?? [],
			agent,
			...(model ? { model } : {}),
		});
		const updatedProcess = updateTaskProcess(runtimeState.board, input.taskId, nextProcess);
		if (!updatedProcess.updated || !updatedProcess.task) {
			throw new Error(`Task "${input.taskId}" process could not be reopened.`);
		}
		const moved =
			taskRecord.columnId === "backlog"
				? {
						board: updatedProcess.board,
						task: updatedProcess.task,
						fromColumnId: taskRecord.columnId,
						moved: false,
					}
				: moveTaskToColumn(updatedProcess.board, input.taskId, "backlog");
		if (!moved.task) {
			throw new Error(`Task "${input.taskId}" could not be moved to backlog.`);
		}
		const nextState: RuntimeWorkspaceStateResponse = {
			...runtimeState,
			board: moved.board,
		};
		return {
			board: moved.board,
			value: {
				task: formatTaskRecord(nextState, moved.task, "backlog"),
				process: formatTaskProcessRecord(moved.task.process),
				previousColumnId: taskRecord.columnId,
				movedToBacklog: moved.moved,
			},
		};
	});

	if (columnCanHaveLiveTaskSession(mutation.previousColumnId as ListTaskColumn)) {
		await stopTaskRuntimeSession(runtimeClient, input.taskId);
	}

	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		task: mutation.task,
		process: mutation.process,
		previousColumnId: mutation.previousColumnId,
		movedToBacklog: mutation.movedToBacklog,
	};
}

type TaskProcessAction = "append" | RuntimeTaskProcessVerdict;

interface TaskProcessStageLaunch {
	taskId: string;
	prompt: string;
	taskTitle: string;
	startInPlanMode: false;
	baseRef: string;
	process: RuntimeTaskProcessState;
	stageId: string;
	agentId?: RuntimeAgentId;
	agentSettings?: RuntimeTaskAgentSettings;
	clineSettings?: RuntimeTaskClineSettings;
}

interface TaskProcessStageHandoff extends TaskProcessStageLaunch {
	fromColumnId: RuntimeBoardColumnId;
}

function buildTaskProcessStageLaunch(input: {
	task: RuntimeBoardCard;
	process: RuntimeTaskProcessState;
	definitions: readonly RuntimeTaskProcessDefinition[];
	workspacePath: string;
	now?: number;
}): TaskProcessStageLaunch | null {
	if (input.process.status !== "ready") {
		return null;
	}
	const dispatchReadyProcess = advanceTaskProcessPastPassiveDispatchStages(input.process, {
		definitions: input.definitions,
		now: input.now,
	});
	const stage = getTaskProcessStage(dispatchReadyProcess, input.definitions);
	if (!stage || stage.terminal) {
		return null;
	}
	const runningProcess =
		dispatchReadyProcess.status === "running"
			? dispatchReadyProcess
			: markTaskProcessRunning(dispatchReadyProcess, {
					now: input.now,
					agent: "kanban",
					notes: `Started ${stage.id} stage.`,
				});
	const prompt = buildTaskProcessStagePrompt({
		taskId: input.task.id,
		taskTitle: input.task.title,
		taskPrompt: input.task.prompt,
		process: runningProcess,
		definitions: input.definitions,
		workspacePath: input.workspacePath,
		kanbanCommand: resolveKanbanCommandLine(),
	});
	const agentId = stage.agentId ?? input.task.agentId;
	return {
		taskId: input.task.id,
		prompt,
		taskTitle: input.task.title,
		startInPlanMode: false,
		baseRef: input.task.baseRef,
		process: runningProcess,
		stageId: stage.id,
		...(agentId ? { agentId } : {}),
		...(input.task.agentSettings ? { agentSettings: input.task.agentSettings } : {}),
		...(input.task.clineSettings ? { clineSettings: input.task.clineSettings } : {}),
	};
}

async function updateTaskProcessCommand(input: {
	cwd: string;
	action: TaskProcessAction;
	taskId: string;
	notes: string;
	projectPath?: string;
	processId?: string;
	agent?: string;
	model?: string;
	expectedStage?: string;
}): Promise<JsonRecord> {
	const notes = input.notes.trim();
	if (!notes) {
		throw new Error("Process notes are required.");
	}
	const expectedStage = input.expectedStage?.trim();
	const processId = input.processId?.trim();
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const mutation = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (runtimeState) => {
		const taskRecord = findTaskRecord(runtimeState, input.taskId);
		if (!taskRecord) {
			throw new Error(`Task "${input.taskId}" was not found in workspace ${workspaceRepoPath}.`);
		}
		const process = taskRecord.task.process;
		if (!process) {
			throw new Error(`Task "${input.taskId}" does not have a process assigned.`);
		}
		if (processId && process.processId !== processId) {
			throw new Error(
				`Task "${input.taskId}" is assigned to process "${process.processId}", expected "${processId}".`,
			);
		}
		if (expectedStage && process.stageId !== expectedStage) {
			throw new Error(
				`Task "${input.taskId}" is at process stage "${process.stageId}", expected "${expectedStage}".`,
			);
		}
		const definitions = runtimeState.board.processes ?? [];
		if (input.action === "append" && !expectedStage) {
			throw new Error(`Task "${input.taskId}" process append requires --expected-stage ${process.stageId}.`);
		}
		if (!expectedStage && input.action !== "append") {
			const definition = getTaskProcessDefinition(process, definitions);
			if (definition && process.stageId !== definition.initial) {
				throw new Error(
					`Task "${input.taskId}" is at process stage "${process.stageId}". Provide --expected-stage ${process.stageId} before running task process ${input.action}.`,
				);
			}
		}
		const stage = getTaskProcessStage(process, definitions);
		if (input.action !== "append") {
			assertTaskProcessStagePromptReady(process, definitions);
		}
		const agent = input.agent?.trim() || stage?.role || stage?.id || process.stageId;
		const model = input.model?.trim();
		const processForAction =
			input.action !== "append" &&
			expectedStage &&
			process.status !== "running" &&
			stage &&
			!isPassiveDispatchStage(stage)
				? markTaskProcessRunning(process, {
						agent,
						...(model ? { model } : {}),
						notes: `Accepted guarded CLI verdict for ${process.stageId}.`,
					})
				: process;
		const nextProcess =
			input.action === "append"
				? appendTaskProcessHistory(processForAction, {
						notes,
						agent,
						...(model ? { model } : {}),
					})
				: transitionTaskProcess(processForAction, input.action, {
						notes,
						definitions,
						agent,
						...(model ? { model } : {}),
					});
		let processToPersist = nextProcess;
		let handoff: TaskProcessStageHandoff | null = null;
		let handoffError: JsonRecord | null = null;
		if (input.action !== "append" && (taskRecord.columnId === "in_progress" || taskRecord.columnId === "review")) {
			try {
				const handoffLaunch = buildTaskProcessStageLaunch({
					task: taskRecord.task,
					process: nextProcess,
					definitions,
					workspacePath: workspaceRepoPath,
				});
				handoff = handoffLaunch ? { ...handoffLaunch, fromColumnId: taskRecord.columnId } : null;
			} catch (error) {
				const handoffErrorMessage = error instanceof Error ? error.message : String(error);
				handoffError = {
					ok: false,
					stageId: nextProcess.stageId,
					error: handoffErrorMessage,
				};
				processToPersist = appendTaskProcessHistory(nextProcess, {
					agent: "kanban",
					recordKind: "append",
					notes: `Stage handoff failed: ${handoffErrorMessage}`,
				});
			}
		}
		const updated = updateTaskProcess(runtimeState.board, input.taskId, processToPersist);
		if (!updated.updated || !updated.task) {
			throw new Error(`Task "${input.taskId}" process could not be updated.`);
		}
		const nextState: RuntimeWorkspaceStateResponse = {
			...runtimeState,
			board: updated.board,
		};
		return {
			board: updated.board,
			value: {
				task: formatTaskRecord(nextState, updated.task, taskRecord.columnId),
				process: formatTaskProcessRecord(updated.task.process),
				completed: processToPersist.status === "complete",
				readyProcess: {
					stageId: processToPersist.stageId,
					status: processToPersist.status,
					updatedAt: processToPersist.updatedAt,
				},
				handoff,
				handoffError,
			},
		};
	});

	let completion: TrashTaskExecutionResult | null = null;
	if (mutation.completed) {
		completion = await trashTaskById({
			cwd: input.cwd,
			taskId: input.taskId,
			projectPath: input.projectPath,
			workspaceRepoPath,
			runtimeClient,
		});
	}
	let responseTask = mutation.task;
	let responseProcess = mutation.process;
	let handoffResponse: JsonRecord | null = mutation.handoffError ?? null;
	if (!completion && mutation.handoff) {
		const handoff = mutation.handoff;
		const started = await runtimeClient.runtime.startTaskSession.mutate({
			taskId: handoff.taskId,
			prompt: handoff.prompt,
			taskTitle: handoff.taskTitle,
			startInPlanMode: handoff.startInPlanMode,
			baseRef: handoff.baseRef,
			replaceActive: true,
			agentId: handoff.agentId,
			agentSettings: handoff.agentSettings,
			clineSettings: handoff.clineSettings,
		});
		if (!started.ok || !started.summary) {
			const handoffErrorMessage = started.error ?? "Could not queue next process stage.";
			handoffResponse = {
				ok: false,
				stageId: handoff.stageId,
				error: handoffErrorMessage,
			};
			const handoffFailureState = await updateRuntimeWorkspaceState(
				runtimeClient,
				workspaceRepoPath,
				(runtimeState) => {
					const taskRecord = findTaskRecord(runtimeState, input.taskId);
					if (!taskRecord?.task.process) {
						throw new Error(`Task "${input.taskId}" process could not be resolved after failed handoff.`);
					}
					if (
						taskRecord.task.process.stageId !== mutation.readyProcess.stageId ||
						taskRecord.task.process.status !== mutation.readyProcess.status ||
						taskRecord.task.process.updatedAt !== mutation.readyProcess.updatedAt
					) {
						throw new Error(`Task "${input.taskId}" process changed before failed handoff could be recorded.`);
					}
					const processWithHandoffFailure = appendTaskProcessHistory(taskRecord.task.process, {
						agent: "kanban",
						recordKind: "append",
						notes: `Stage handoff failed: ${handoffErrorMessage}`,
					});
					const updated = updateTaskProcess(runtimeState.board, input.taskId, processWithHandoffFailure);
					if (!updated.updated || !updated.task) {
						throw new Error(`Task "${input.taskId}" failed handoff process note could not be recorded.`);
					}
					const nextState: RuntimeWorkspaceStateResponse = {
						...runtimeState,
						board: updated.board,
					};
					return {
						board: updated.board,
						value: {
							task: formatTaskRecord(nextState, updated.task, taskRecord.columnId),
							process: formatTaskProcessRecord(updated.task.process),
						},
					};
				},
			);
			responseTask = handoffFailureState.task;
			responseProcess = handoffFailureState.process;
		} else {
			const handoffState = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (runtimeState) => {
				const taskRecord = findTaskRecord(runtimeState, input.taskId);
				if (!taskRecord?.task.process) {
					throw new Error(`Task "${input.taskId}" process could not be resolved after handoff.`);
				}
				if (
					taskRecord.task.process.stageId !== mutation.readyProcess.stageId ||
					taskRecord.task.process.status !== mutation.readyProcess.status ||
					taskRecord.task.process.updatedAt !== mutation.readyProcess.updatedAt
				) {
					throw new Error(`Task "${input.taskId}" process changed before handoff could be recorded.`);
				}
				const updated = updateTaskProcess(runtimeState.board, input.taskId, handoff.process);
				if (!updated.updated || !updated.task) {
					throw new Error(`Task "${input.taskId}" handoff process could not be recorded.`);
				}
				if (taskRecord.columnId !== handoff.fromColumnId) {
					throw new Error(`Task "${input.taskId}" moved before handoff could be recorded.`);
				}
				let handoffBoard = updated.board;
				let handoffTask = updated.task;
				let responseColumnId: RuntimeBoardColumnId = taskRecord.columnId;
				if (handoff.fromColumnId === "review") {
					const moved = moveTaskToColumn(updated.board, input.taskId, "in_progress");
					if (!moved.moved || !moved.task) {
						throw new Error(`Task "${input.taskId}" could not be moved to in_progress after handoff.`);
					}
					handoffBoard = moved.board;
					handoffTask = moved.task;
					responseColumnId = "in_progress";
				}
				const nextState: RuntimeWorkspaceStateResponse = {
					...runtimeState,
					board: handoffBoard,
				};
				return {
					board: handoffBoard,
					value: {
						task: formatTaskRecord(nextState, handoffTask, responseColumnId),
						process: formatTaskProcessRecord(handoffTask.process),
					},
				};
			});
			responseTask = handoffState.task;
			responseProcess = handoffState.process;
			handoffResponse = {
				ok: true,
				stageId: handoff.stageId,
				summary: started.summary,
			};
		}
	}

	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		action: input.action,
		task: completion?.task ?? responseTask,
		process: completion?.task.process ?? responseProcess,
		completed: mutation.completed,
		movedToDone: completion ? !completion.alreadyInTrash : false,
		handoff: handoffResponse,
		readyTaskIds: completion?.readyTaskIds ?? [],
		autoStartedTasks: completion?.autoStartedTasks ?? [],
		worktreeDeleted: completion?.worktreeDeleted ?? false,
		worktreeDeleteError: completion?.worktreeDeleteError,
	};
}

async function startTask(input: { cwd: string; taskId: string; projectPath?: string }): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const runtimeState = await runtimeClient.workspace.getState.query();
	const fromColumnId = getTaskColumnId(runtimeState.board, input.taskId);
	if (!fromColumnId) {
		throw new Error(`Task "${input.taskId}" was not found in workspace ${workspaceRepoPath}.`);
	}

	const currentRecord = findTaskRecord(runtimeState, input.taskId);
	const task = currentRecord?.task;
	if (!task) {
		throw new Error(`Task "${input.taskId}" could not be resolved.`);
	}

	const canStartFromColumn =
		fromColumnId === "backlog" ||
		fromColumnId === "in_progress" ||
		(fromColumnId === "review" && task.process?.status === "ready");
	if (!canStartFromColumn) {
		throw new Error(
			`Task "${input.taskId}" is in "${fromColumnId}" and can only be started from backlog, in_progress, or review when a process stage is ready.`,
		);
	}
	if (fromColumnId === "backlog") {
		const blockingTaskIds = getBlockingDependencyTaskIds(runtimeState.board, input.taskId);
		if (blockingTaskIds.length > 0) {
			throw new Error(
				`Task "${input.taskId}" is blocked by unfinished dependency task${blockingTaskIds.length === 1 ? "" : "s"}: ${blockingTaskIds.join(", ")}.`,
			);
		}
	}

	const existingSession = runtimeState.sessions[task.id] ?? null;
	const processLaunch = task.process
		? buildTaskProcessStageLaunch({
				task,
				process: task.process,
				definitions: runtimeState.board.processes ?? [],
				workspacePath: workspaceRepoPath,
			})
		: null;
	const shouldStartSession = Boolean(processLaunch) || !existingSession || existingSession.state !== "running";
	const taskForSession = processLaunch
		? {
				...task,
				prompt: processLaunch.prompt,
				startInPlanMode: processLaunch.startInPlanMode,
				agentId: processLaunch.agentId,
				agentSettings: processLaunch.agentSettings,
				clineSettings: processLaunch.clineSettings,
				process: processLaunch.process,
			}
		: task;

	if (shouldStartSession) {
		const ensured = await runtimeClient.workspace.ensureWorktree.mutate({
			taskId: task.id,
			baseRef: task.baseRef,
		});
		if (!ensured.ok) {
			throw new Error(ensured.error ?? "Could not ensure task worktree.");
		}

		const started = await runtimeClient.runtime.startTaskSession.mutate({
			taskId: task.id,
			prompt: taskForSession.prompt,
			taskTitle: taskForSession.title,
			startInPlanMode: taskForSession.startInPlanMode,
			baseRef: task.baseRef,
			agentId: taskForSession.agentId,
			agentSettings: taskForSession.agentSettings,
			clineSettings: taskForSession.clineSettings,
			replaceActive: Boolean(processLaunch),
		});
		if (!started.ok || !started.summary) {
			throw new Error(started.error ?? "Could not start task session.");
		}
	}

	const moved = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (latestState) => {
		const movement = moveTaskToColumn(latestState.board, input.taskId, "in_progress");
		if (!movement.task) {
			throw new Error(`Task "${input.taskId}" could not be resolved.`);
		}
		if (!movement.moved) {
			const board =
				processLaunch && movement.task.process?.updatedAt === task.process?.updatedAt
					? updateTaskProcess(latestState.board, input.taskId, processLaunch.process).board
					: latestState.board;
			return {
				board,
				value: movement,
			};
		}
		const board =
			processLaunch && movement.task.process?.updatedAt === task.process?.updatedAt
				? updateTaskProcess(movement.board, input.taskId, processLaunch.process).board
				: movement.board;
		return {
			board,
			value: movement,
		};
	});

	if (!moved.moved) {
		return {
			ok: true,
			message: `Task "${input.taskId}" is already in progress.`,
			task: {
				id: task.id,
				prompt: taskForSession.prompt,
				column: "in_progress",
				workspacePath: workspaceRepoPath,
				process: processLaunch
					? formatTaskProcessRecord(processLaunch.process)
					: formatTaskProcessRecord(task.process),
			},
		};
	}

	return {
		ok: true,
		task: {
			id: task.id,
			prompt: taskForSession.prompt,
			column: "in_progress",
			workspacePath: workspaceRepoPath,
			process: processLaunch
				? formatTaskProcessRecord(processLaunch.process)
				: formatTaskProcessRecord(task.process),
		},
	};
}

async function runReadyTaskProcessStages(input: {
	cwd: string;
	projectPath?: string;
	processId?: string;
	stage?: string;
}): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const runtimeState = await runtimeClient.workspace.getState.query();
	const processId = input.processId?.trim() || null;
	const stage = input.stage?.trim() || null;
	const definitions = runtimeState.board.processes ?? [];
	const taskIds: string[] = [];

	for (const column of runtimeState.board.columns) {
		if (column.id === "trash") {
			continue;
		}
		for (const task of column.cards) {
			if (!task.process || task.process.status !== "ready") {
				continue;
			}
			if (processId && task.process.processId !== processId) {
				continue;
			}
			const readyStageId = getEffectiveReadyTaskProcessStageId(task.process, definitions);
			if (stage && task.process.stageId !== stage && readyStageId !== stage) {
				continue;
			}
			if (getBlockingDependencyTaskIds(runtimeState.board, task.id).length > 0) {
				continue;
			}
			taskIds.push(task.id);
		}
	}

	const startedTasks: unknown[] = [];
	for (const taskId of taskIds) {
		const started = await startTask({
			cwd: input.cwd,
			taskId,
			projectPath: workspaceRepoPath,
		});
		startedTasks.push(started.task ?? started);
	}

	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		filters: {
			process: processId,
			stage,
		},
		startedCount: startedTasks.length,
		startedTaskIds: taskIds,
		startedTasks,
	};
}

interface TrashTaskExecutionResult {
	task: JsonRecord;
	taskId: string;
	previousColumnId: ListTaskColumn;
	readyTaskIds: string[];
	autoStartedTasks: JsonRecord[];
	worktreeDeleted: boolean;
	worktreeDeleteError?: string;
	alreadyInTrash: boolean;
}

interface TrashTaskMutationValue {
	task: JsonRecord;
	previousColumnId: ListTaskColumn;
	readyTaskIds: string[];
	alreadyInTrash: boolean;
}

function columnCanHaveLiveTaskSession(columnId: ListTaskColumn): boolean {
	return columnId === "in_progress" || columnId === "review";
}

async function trashTaskById(input: {
	cwd: string;
	taskId: string;
	projectPath?: string;
	workspaceRepoPath: string;
	runtimeClient: ReturnType<typeof createRuntimeTrpcClient>;
}): Promise<TrashTaskExecutionResult> {
	const mutation = await mutateWorkspaceState<TrashTaskMutationValue>(input.workspaceRepoPath, (latestState) => {
		const latestRecord = findTaskRecord(latestState, input.taskId);
		if (!latestRecord) {
			throw new Error(`Task "${input.taskId}" was not found in workspace ${input.workspaceRepoPath}.`);
		}
		if (latestRecord.columnId === "trash") {
			return {
				board: latestState.board,
				value: {
					task: formatTaskRecord(latestState, latestRecord.task, latestRecord.columnId),
					previousColumnId: latestRecord.columnId,
					readyTaskIds: [] as string[],
					alreadyInTrash: true,
				},
				save: false,
			};
		}
		if (taskHasIncompleteProcess(latestRecord.task)) {
			throw new Error(
				`Task "${input.taskId}" has an incomplete process at stage "${latestRecord.task.process?.stageId}". Use task process pass/fail to complete the process before moving it to done.`,
			);
		}

		const trashed = trashTaskAndGetReadyLinkedTaskIds(latestState.board, input.taskId);
		if (!trashed.moved || !trashed.task) {
			throw new Error(`Task "${input.taskId}" could not be moved to done.`);
		}

		const nextState: RuntimeWorkspaceStateResponse = {
			...latestState,
			board: trashed.board,
		};
		return {
			board: trashed.board,
			value: {
				task: formatTaskRecord(nextState, trashed.task, "trash"),
				previousColumnId: latestRecord.columnId,
				readyTaskIds: trashed.readyTaskIds,
				alreadyInTrash: false,
			},
		};
	});

	if (mutation.saved) {
		await notifyRuntimeWorkspaceStateUpdated(input.runtimeClient);
	}

	if (mutation.value.alreadyInTrash) {
		return {
			task: mutation.value.task,
			taskId: input.taskId,
			previousColumnId: mutation.value.previousColumnId,
			readyTaskIds: [],
			autoStartedTasks: [],
			worktreeDeleted: false,
			alreadyInTrash: true,
		};
	}

	if (columnCanHaveLiveTaskSession(mutation.value.previousColumnId)) {
		await stopTaskRuntimeSession(input.runtimeClient, input.taskId);
	}

	const autoStartedTasks: JsonRecord[] = [];
	for (const readyTaskId of mutation.value.readyTaskIds) {
		const started = await startTask({
			cwd: input.cwd,
			taskId: readyTaskId,
			projectPath: input.projectPath,
		});
		autoStartedTasks.push(started);
	}

	const deletedWorkspace = await deleteTaskWorkspace(input.runtimeClient, input.taskId);

	return {
		task: mutation.value.task,
		taskId: input.taskId,
		previousColumnId: mutation.value.previousColumnId,
		readyTaskIds: mutation.value.readyTaskIds,
		autoStartedTasks,
		worktreeDeleted: deletedWorkspace.removed,
		worktreeDeleteError: deletedWorkspace.error,
		alreadyInTrash: false,
	};
}

async function trashTask(input: {
	cwd: string;
	taskId?: string;
	column?: ListTaskColumn;
	projectPath?: string;
}): Promise<JsonRecord> {
	const target = resolveTaskCommandTarget(input, "task done");
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);

	if (target.kind === "task") {
		const trashed = await trashTaskById({
			cwd: input.cwd,
			taskId: target.taskId,
			projectPath: input.projectPath,
			workspaceRepoPath,
			runtimeClient,
		});
		if (trashed.alreadyInTrash) {
			return {
				ok: true,
				message: `Task "${target.taskId}" is already done.`,
				task: trashed.task,
				workspacePath: workspaceRepoPath,
				readyTaskIds: [],
				autoStartedTasks: [],
			};
		}
		return {
			ok: true,
			task: trashed.task,
			workspacePath: workspaceRepoPath,
			readyTaskIds: trashed.readyTaskIds,
			autoStartedTasks: trashed.autoStartedTasks,
			worktreeDeleted: trashed.worktreeDeleted,
			worktreeDeleteError: trashed.worktreeDeleteError,
		};
	}

	const initialState = await runtimeClient.workspace.getState.query();
	const targetTasks = findTasksInColumn(initialState, target.column);
	if (targetTasks.length === 0) {
		return {
			ok: true,
			column: target.column,
			workspacePath: workspaceRepoPath,
			trashedTasks: [],
			alreadyTrashedTasks: [],
			readyTaskIds: [],
			autoStartedTasks: [],
			worktreeCleanup: [],
			count: 0,
		};
	}

	const results: TrashTaskExecutionResult[] = [];
	for (const { task } of targetTasks) {
		results.push(
			await trashTaskById({
				cwd: input.cwd,
				taskId: task.id,
				projectPath: input.projectPath,
				workspaceRepoPath,
				runtimeClient,
			}),
		);
	}

	const trashedTasks = results.filter((result) => !result.alreadyInTrash);
	const alreadyTrashedTasks = results.filter((result) => result.alreadyInTrash);

	return {
		ok: true,
		column: target.column,
		workspacePath: workspaceRepoPath,
		trashedTasks: trashedTasks.map((result) => result.task),
		alreadyTrashedTasks: alreadyTrashedTasks.map((result) => result.task),
		readyTaskIds: [...new Set(trashedTasks.flatMap((result) => result.readyTaskIds))],
		autoStartedTasks: trashedTasks.flatMap((result) => result.autoStartedTasks),
		worktreeCleanup: trashedTasks.map((result) => ({
			taskId: result.taskId,
			removed: result.worktreeDeleted,
			error: result.worktreeDeleteError,
		})),
		count: trashedTasks.length,
	};
}

async function deleteTaskCommand(input: {
	cwd: string;
	taskId?: string;
	column?: ListTaskColumn;
	projectPath?: string;
}): Promise<JsonRecord> {
	const target = resolveTaskCommandTarget(input, "task delete");
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const mutation = await mutateWorkspaceState(workspaceRepoPath, (latestState) => {
		const latestTargetRecords =
			target.kind === "task"
				? (() => {
						const record = findTaskRecord(latestState, target.taskId);
						if (!record) {
							throw new Error(`Task "${target.taskId}" was not found in workspace ${workspaceRepoPath}.`);
						}
						return [record];
					})()
				: findTasksInColumn(latestState, target.column);

		if (latestTargetRecords.length === 0) {
			return {
				board: latestState.board,
				value: {
					deletedTaskIds: [] as string[],
					taskIdsRequiringStop: [] as string[],
					deletedTasks: [] as JsonRecord[],
				},
				save: false,
			};
		}

		const deleted = deleteTasksFromBoard(
			latestState.board,
			latestTargetRecords.map(({ task }) => task.id),
		);
		if (!deleted.deleted) {
			return {
				board: latestState.board,
				value: {
					deletedTaskIds: [] as string[],
					taskIdsRequiringStop: [] as string[],
					deletedTasks: [] as JsonRecord[],
				},
				save: false,
			};
		}

		const deletedTasks = latestTargetRecords.map(({ task, columnId }) =>
			formatTaskRecord(latestState, task, columnId),
		);
		const taskIdsRequiringStop = latestTargetRecords
			.filter(({ columnId }) => columnCanHaveLiveTaskSession(columnId))
			.map(({ task }) => task.id);
		return {
			board: deleted.board,
			value: {
				deletedTaskIds: deleted.deletedTaskIds,
				taskIdsRequiringStop,
				deletedTasks,
			},
		};
	});

	if (mutation.saved) {
		await notifyRuntimeWorkspaceStateUpdated(runtimeClient);
	}

	if (mutation.value.deletedTaskIds.length === 0) {
		return {
			ok: true,
			workspacePath: workspaceRepoPath,
			column: target.kind === "column" ? target.column : null,
			deletedTasks: [],
			count: 0,
		};
	}

	await Promise.all(
		mutation.value.taskIdsRequiringStop.map(async (taskId) => await stopTaskRuntimeSession(runtimeClient, taskId)),
	);

	const workspaceCleanupResults = await Promise.all(
		mutation.value.deletedTaskIds.map(async (taskId) => ({
			taskId,
			...(await deleteTaskWorkspace(runtimeClient, taskId)),
		})),
	);

	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		column: target.kind === "column" ? target.column : null,
		deletedTasks: mutation.value.deletedTasks,
		count: mutation.value.deletedTaskIds.length,
		worktreeCleanup: workspaceCleanupResults,
	};
}

function parseOptionalBooleanOption(value: unknown, flagName: string): boolean | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === true || value === false) {
		return value;
	}
	if (typeof value !== "string") {
		throw new Error(`Invalid boolean value for ${flagName}. Use true or false.`);
	}
	const normalized = value.trim().toLowerCase();
	if (normalized === "true" || normalized === "1" || normalized === "yes") {
		return true;
	}
	if (normalized === "false" || normalized === "0" || normalized === "no") {
		return false;
	}
	throw new Error(`Invalid boolean value for ${flagName}: "${value}". Use true or false.`);
}

async function runTaskCommand(handler: () => Promise<JsonRecord>): Promise<void> {
	try {
		printJson(await handler());
	} catch (error) {
		printJson({
			ok: false,
			error: `Task command failed at ${getKanbanRuntimeOrigin()}: ${toErrorMessage(error)}`,
		});
		process.exitCode = 1;
	}
}

export function registerTaskCommand(program: Command): void {
	const task = program.command("task").alias("tasks").description("Manage Kanban board tasks from the CLI.");

	task
		.command("list")
		.description("List Kanban tasks for a workspace.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option(
			"--column <column>",
			"Filter column: backlog | in_progress | review | done. trash is also accepted.",
			parseListColumn,
		)
		.action(async (options: { projectPath?: string; column?: ListTaskColumn }) => {
			await runTaskCommand(
				async () =>
					await listTasks({
						cwd: process.cwd(),
						projectPath: options.projectPath,
						column: options.column,
					}),
			);
		});

	task
		.command("create")
		.description("Create a task in backlog.")
		.option("--task-id <id>", "Explicit task ID to create. Fails if the ID already exists.")
		.option("--title <text>", "Task title.")
		.requiredOption("--prompt <text>", "Task prompt text.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--base-ref <branch>", "Task base branch/ref.")
		.option("--start-in-plan-mode [value]", "Set plan mode (true|false). Flag-only implies true.")
		.option("--auto-review-enabled [value]", "Enable auto-review behavior (true|false). Flag-only implies true.")
		.option("--auto-review-mode <mode>", "Auto-review mode: commit | pr.", parseAutoReviewMode)
		.option(
			"--agent-id <id>",
			"Agent override: cline | claude | codex | copilot | droid | gemini | opencode | default.",
		)
		.option("--process <id>", "Assign a task process: sdd | tdd | gsd | lightweight | custom process id.")
		.option(
			"--cline-provider <id>",
			'Cline provider override (e.g. anthropic, openai, cline). Use "default" for workspace default.',
		)
		.option(
			"--cline-model <id>",
			'Cline model override (e.g. claude-sonnet-4-20250514). Use "default" for workspace default.',
		)
		.option(
			"--cline-reasoning-effort <level>",
			"Cline reasoning effort override: default | low | medium | high | xhigh.",
		)
		.action(
			async (options: {
				taskId?: string;
				title?: string;
				prompt: string;
				projectPath?: string;
				baseRef?: string;
				startInPlanMode?: unknown;
				autoReviewEnabled?: unknown;
				autoReviewMode?: "commit" | "pr";
				agentId?: string;
				process?: string;
				clineProvider?: string;
				clineModel?: string;
				clineReasoningEffort?: string;
			}) => {
				await runTaskCommand(
					async () =>
						await createTask({
							cwd: process.cwd(),
							taskId: options.taskId,
							title: options.title,
							prompt: options.prompt,
							projectPath: options.projectPath,
							baseRef: options.baseRef,
							startInPlanMode: parseOptionalBooleanOption(options.startInPlanMode, "--start-in-plan-mode"),
							autoReviewEnabled: parseOptionalBooleanOption(options.autoReviewEnabled, "--auto-review-enabled"),
							autoReviewMode: options.autoReviewMode,
							agentId: parseAgentId(options.agentId) ?? undefined,
							processId: parseOptionalProcessId(options.process) ?? undefined,
							clineSettings: buildTaskClineSettingsForCreate({
								providerId: parseOptionalStringOrDefault(options.clineProvider) ?? undefined,
								modelId: parseOptionalStringOrDefault(options.clineModel) ?? undefined,
								reasoningEffort: parseTaskClineReasoningEffort(options.clineReasoningEffort),
							}),
						}),
				);
			},
		);

	task
		.command("update")
		.description("Update an existing task.")
		.requiredOption("--task-id <id>", "Task ID.")
		.option("--title <text>", "Replacement task title.")
		.option("--prompt <text>", "Replacement task prompt.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--base-ref <branch>", "Replacement base branch/ref.")
		.option("--start-in-plan-mode [value]", "Set plan mode (true|false). Flag-only implies true.")
		.option("--auto-review-enabled [value]", "Enable auto-review behavior (true|false). Flag-only implies true.")
		.option("--auto-review-mode <mode>", "Auto-review mode: commit | pr.", parseAutoReviewMode)
		.option("--process <id>", 'Assign a task process by id. Use "none" to clear.')
		.option(
			"--agent-id <id>",
			'Agent override: cline | claude | codex | copilot | droid | gemini | opencode. Use "default" to clear.',
		)
		.option(
			"--cline-provider <id>",
			'Cline provider override (e.g. anthropic, openai, cline). Use "default" to clear.',
		)
		.option("--cline-model <id>", 'Cline model override (e.g. claude-sonnet-4-20250514). Use "default" to clear.')
		.option(
			"--cline-reasoning-effort <level>",
			'Cline reasoning effort override: default | low | medium | high | xhigh. Use "inherit" to clear.',
		)
		.action(
			async (options: {
				taskId: string;
				title?: string;
				prompt?: string;
				projectPath?: string;
				baseRef?: string;
				startInPlanMode?: unknown;
				autoReviewEnabled?: unknown;
				autoReviewMode?: "commit" | "pr";
				process?: string;
				agentId?: string;
				clineProvider?: string;
				clineModel?: string;
				clineReasoningEffort?: string;
			}) => {
				await runTaskCommand(
					async () =>
						await updateTaskCommand({
							cwd: process.cwd(),
							taskId: options.taskId,
							title: options.title,
							projectPath: options.projectPath,
							prompt: options.prompt,
							baseRef: options.baseRef,
							startInPlanMode: parseOptionalBooleanOption(options.startInPlanMode, "--start-in-plan-mode"),
							autoReviewEnabled: parseOptionalBooleanOption(options.autoReviewEnabled, "--auto-review-enabled"),
							autoReviewMode: options.autoReviewMode,
							processId: parseOptionalProcessId(options.process),
							agentId: parseAgentId(options.agentId),
							clineProviderId: parseOptionalStringOrDefault(options.clineProvider),
							clineModelId: parseOptionalStringOrDefault(options.clineModel),
							clineReasoningEffort: parseTaskClineReasoningEffort(options.clineReasoningEffort),
						}),
				);
			},
		);

	task
		.command("trash")
		.alias("done")
		.description("Move a task or an entire column to done and clean up task workspaces.")
		.option("--task-id <id>", "Task ID.")
		.option(
			"--column <column>",
			"Column to move to done: backlog | in_progress | review | done. trash is also accepted.",
			parseListColumn,
		)
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { taskId?: string; column?: ListTaskColumn; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await trashTask({
						cwd: process.cwd(),
						taskId: options.taskId,
						column: options.column,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("delete")
		.description("Permanently delete a task or every task in a column.")
		.option("--task-id <id>", "Task ID to permanently delete.")
		.option(
			"--column <column>",
			"Column to bulk-delete: backlog | in_progress | review | done. trash is also accepted.",
			parseListColumn,
		)
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { taskId?: string; column?: ListTaskColumn; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await deleteTaskCommand({
						cwd: process.cwd(),
						taskId: options.taskId,
						column: options.column,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("link")
		.description("Link two tasks so one task waits on another.")
		.requiredOption("--task-id <id>", "One of the two task IDs to link.")
		.requiredOption("--linked-task-id <id>", "The other task ID to link.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.addHelpText(
			"after",
			[
				"",
				"Dependency direction:",
				"  If both linked tasks are in backlog, Kanban preserves the order you pass:",
				"  --task-id waits on --linked-task-id, and on the board the arrow points into",
				"  --linked-task-id.",
				"  Once only one linked task remains in backlog, Kanban reorients the saved link",
				"  so the backlog task is the waiting dependent task and the other task is the",
				"  prerequisite.",
				"  When the prerequisite finishes review and moves to done, the waiting backlog",
				"  task becomes ready to start.",
				"",
			].join("\n"),
		)
		.action(async (options: { taskId: string; linkedTaskId: string; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await linkTasks({
						cwd: process.cwd(),
						taskId: options.taskId,
						linkedTaskId: options.linkedTaskId,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("unlink")
		.description("Remove an existing dependency link.")
		.requiredOption("--dependency-id <id>", "Dependency ID.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { dependencyId: string; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await unlinkTasks({
						cwd: process.cwd(),
						dependencyId: options.dependencyId,
						projectPath: options.projectPath,
					}),
			);
		});

	const processCommand = task.command("process").description("Record process notes and pass/fail outcomes.");

	processCommand
		.command("list")
		.description("List built-in and workspace custom process definitions.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await listTaskProcesses({
						cwd: process.cwd(),
						projectPath: options.projectPath,
					}),
			);
		});

	processCommand
		.command("import")
		.description("Import one process JSON definition or an array of definitions into the workspace.")
		.requiredOption("--file <path>", "Path to a process JSON file.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--replace", "Replace all existing custom process definitions with the imported definitions.")
		.action(async (options: { file: string; projectPath?: string; replace?: boolean }) => {
			await runTaskCommand(
				async () =>
					await importTaskProcesses({
						cwd: process.cwd(),
						file: options.file,
						projectPath: options.projectPath,
						replace: options.replace === true,
					}),
			);
		});

	processCommand
		.command("export")
		.description("Export one process definition as JSON.")
		.requiredOption("--process <id>", "Process ID to export.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { process: string; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await exportTaskProcess({
						cwd: process.cwd(),
						processId: options.process,
						projectPath: options.projectPath,
					}),
			);
		});

	processCommand
		.command("remove")
		.description("Remove a workspace custom process definition.")
		.requiredOption("--process <id>", "Custom process ID to remove.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { process: string; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await removeTaskProcess({
						cwd: process.cwd(),
						processId: options.process,
						projectPath: options.projectPath,
					}),
			);
		});

	processCommand
		.command("status")
		.description("List process-backed task status with Gate-style filters.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--process <id>", "Process ID to filter.")
		.option("--pipeline <id>", "Alias for --process.")
		.option("--stage <id>", "Process stage to filter.")
		.option("--state <id>", "Alias for --stage.")
		.option("--ready-stage <id>", "Effective runnable stage to filter after passive dispatch.")
		.option("--ready [boolean]", "Filter tasks whose current process stage is ready to run.")
		.option("--blocked [boolean]", "Filter dependency-blocked process tasks.")
		.option("--include-done [boolean]", "Include Done column process tasks.")
		.option("--summary [boolean]", "Include aggregate counts.")
		.action(
			async (options: {
				projectPath?: string;
				process?: string;
				pipeline?: string;
				stage?: string;
				state?: string;
				readyStage?: string;
				ready?: unknown;
				blocked?: unknown;
				includeDone?: unknown;
				summary?: unknown;
			}) => {
				await runTaskCommand(
					async () =>
						await getTaskProcessStatus({
							cwd: process.cwd(),
							projectPath: options.projectPath,
							processId: options.process ?? options.pipeline,
							stage: options.stage ?? options.state,
							readyStage: options.readyStage,
							ready: parseOptionalBooleanOption(options.ready, "--ready"),
							blocked: parseOptionalBooleanOption(options.blocked, "--blocked"),
							includeDone: parseOptionalBooleanOption(options.includeDone, "--include-done") ?? false,
							summary: parseOptionalBooleanOption(options.summary, "--summary") ?? false,
						}),
				);
			},
		);

	processCommand
		.command("run-ready")
		.description("Start fresh agents for ready, unblocked process stages.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--process <id>", "Process ID to filter.")
		.option("--pipeline <id>", "Alias for --process.")
		.option("--stage <id>", "Process stage to filter.")
		.option("--state <id>", "Alias for --stage.")
		.action(
			async (options: {
				projectPath?: string;
				process?: string;
				pipeline?: string;
				stage?: string;
				state?: string;
			}) => {
				await runTaskCommand(
					async () =>
						await runReadyTaskProcessStages({
							cwd: process.cwd(),
							projectPath: options.projectPath,
							processId: options.process ?? options.pipeline,
							stage: options.stage ?? options.state,
						}),
				);
			},
		);

	processCommand
		.command("history")
		.description("Read a process-backed task stage history.")
		.requiredOption("--task-id <id>", "Task ID.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--process <id>", "Process ID guard.")
		.option("--pipeline <id>", "Alias for --process.")
		.action(async (options: { taskId: string; projectPath?: string; process?: string; pipeline?: string }) => {
			await runTaskCommand(
				async () =>
					await getTaskProcessHistory({
						cwd: process.cwd(),
						taskId: options.taskId,
						projectPath: options.projectPath,
						processId: options.process ?? options.pipeline,
					}),
			);
		});

	processCommand
		.command("body")
		.description("Read a process-backed task body.")
		.requiredOption("--task-id <id>", "Task ID.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--process <id>", "Process ID guard.")
		.option("--pipeline <id>", "Alias for --process.")
		.action(async (options: { taskId: string; projectPath?: string; process?: string; pipeline?: string }) => {
			await runTaskCommand(
				async () =>
					await getTaskProcessBody({
						cwd: process.cwd(),
						taskId: options.taskId,
						projectPath: options.projectPath,
						processId: options.process ?? options.pipeline,
					}),
			);
		});

	processCommand
		.command("append")
		.description("Append notes to the current process stage without changing stage.")
		.requiredOption("--task-id <id>", "Task ID.")
		.requiredOption("--notes <text>", "Stage notes/evidence.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--agent <id>", "Agent or role recording the note. Defaults to current process stage role.")
		.option("--model <id>", "Optional model identifier.")
		.option("--process <id>", "Process ID guard.")
		.option("--pipeline <id>", "Alias for --process.")
		.option("--expected-stage <stage>", "Optional guard requiring the current process stage.")
		.action(
			async (options: {
				taskId: string;
				notes: string;
				projectPath?: string;
				agent?: string;
				model?: string;
				process?: string;
				pipeline?: string;
				expectedStage?: string;
			}) => {
				await runTaskCommand(
					async () =>
						await updateTaskProcessCommand({
							cwd: process.cwd(),
							action: "append",
							taskId: options.taskId,
							notes: options.notes,
							projectPath: options.projectPath,
							processId: options.process ?? options.pipeline,
							agent: options.agent,
							model: options.model,
							expectedStage: options.expectedStage,
						}),
				);
			},
		);

	processCommand
		.command("pass")
		.description("Pass the current process stage and follow its pass transition.")
		.requiredOption("--task-id <id>", "Task ID.")
		.requiredOption("--notes <text>", "Stage pass notes/evidence.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--agent <id>", "Agent or role recording the outcome. Defaults to current process stage role.")
		.option("--model <id>", "Optional model identifier.")
		.option("--process <id>", "Process ID guard.")
		.option("--pipeline <id>", "Alias for --process.")
		.option("--expected-stage <stage>", "Optional guard requiring the current process stage.")
		.action(
			async (options: {
				taskId: string;
				notes: string;
				projectPath?: string;
				agent?: string;
				model?: string;
				process?: string;
				pipeline?: string;
				expectedStage?: string;
			}) => {
				await runTaskCommand(
					async () =>
						await updateTaskProcessCommand({
							cwd: process.cwd(),
							action: "pass",
							taskId: options.taskId,
							notes: options.notes,
							projectPath: options.projectPath,
							processId: options.process ?? options.pipeline,
							agent: options.agent,
							model: options.model,
							expectedStage: options.expectedStage,
						}),
				);
			},
		);

	processCommand
		.command("fail")
		.description("Fail the current process stage and follow its fail transition.")
		.requiredOption("--task-id <id>", "Task ID.")
		.requiredOption("--notes <text>", "Stage fail notes/evidence.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--agent <id>", "Agent or role recording the outcome. Defaults to current process stage role.")
		.option("--model <id>", "Optional model identifier.")
		.option("--process <id>", "Process ID guard.")
		.option("--pipeline <id>", "Alias for --process.")
		.option("--expected-stage <stage>", "Optional guard requiring the current process stage.")
		.action(
			async (options: {
				taskId: string;
				notes: string;
				projectPath?: string;
				agent?: string;
				model?: string;
				process?: string;
				pipeline?: string;
				expectedStage?: string;
			}) => {
				await runTaskCommand(
					async () =>
						await updateTaskProcessCommand({
							cwd: process.cwd(),
							action: "fail",
							taskId: options.taskId,
							notes: options.notes,
							projectPath: options.projectPath,
							processId: options.process ?? options.pipeline,
							agent: options.agent,
							model: options.model,
							expectedStage: options.expectedStage,
						}),
				);
			},
		);

	processCommand
		.command("reopen")
		.description("Reopen a completed process task and reset it to the initial stage.")
		.requiredOption("--task-id <id>", "Task ID.")
		.requiredOption("--notes <text>", "Reopen notes/evidence.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.requiredOption("--agent <id>", "Agent or role recording the reopen.")
		.option("--model <id>", "Optional model identifier.")
		.option("--process <id>", "Process ID guard.")
		.option("--pipeline <id>", "Alias for --process.")
		.option("--expected-stage <stage>", "Optional guard requiring the current process stage.")
		.action(
			async (options: {
				taskId: string;
				notes: string;
				projectPath?: string;
				agent?: string;
				model?: string;
				process?: string;
				pipeline?: string;
				expectedStage?: string;
			}) => {
				await runTaskCommand(
					async () =>
						await reopenTaskProcessCommand({
							cwd: process.cwd(),
							taskId: options.taskId,
							notes: options.notes,
							projectPath: options.projectPath,
							processId: options.process ?? options.pipeline,
							agent: options.agent,
							model: options.model,
							expectedStage: options.expectedStage,
						}),
				);
			},
		);

	task
		.command("start")
		.description("Start a task session and move task to in_progress.")
		.requiredOption("--task-id <id>", "Task ID.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { taskId: string; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await startTask({
						cwd: process.cwd(),
						taskId: options.taskId,
						projectPath: options.projectPath,
					}),
			);
		});
}
