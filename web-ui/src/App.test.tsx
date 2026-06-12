import {
	createTaskProcess,
	getTaskProcessDefinitions,
	markTaskProcessRunning,
	parseTaskProcessDefinitionInput,
	transitionTaskProcess,
} from "@runtime-task-process";
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "@/App";
import type { BoardCard, BoardData, CardSelection, TaskProcessVerdict } from "@/types";

const appTestMocks = vi.hoisted(() => ({
	createInitialBoardData: vi.fn(),
	handleRunTaskProcessStage: vi.fn(),
	useBoardInteractions: vi.fn(),
	useDetailTaskNavigation: vi.fn(),
	notifyError: vi.fn(),
	showAppToast: vi.fn(),
	stopTaskSession: vi.fn(async (_taskId: string) => {}),
}));

interface MockChildrenProps {
	children?: ReactNode;
}

interface MockCardDetailViewProps {
	selection: CardSelection;
	onTaskProcessVerdict: (
		taskId: string,
		verdict: TaskProcessVerdict,
		notes: string,
		expectedStage: string,
		agent: string,
		model?: string,
	) => void;
	onReopenTaskProcess: (taskId: string, notes: string, expectedStage: string, agent: string, model?: string) => void;
}

interface MockTopBarProps {
	processCount: number;
}

function findTaskSelection(board: BoardData, taskId: string): CardSelection | null {
	for (const column of board.columns) {
		const card = column.cards.find((candidate) => candidate.id === taskId);
		if (card) {
			return {
				card,
				column,
				allColumns: board.columns,
			};
		}
	}
	return null;
}

function createTask(taskId: string, prompt: string, processStartedAt: number): BoardCard {
	return {
		id: taskId,
		title: prompt,
		prompt,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt: processStartedAt,
		updatedAt: processStartedAt,
		process: createTaskProcess("lightweight", processStartedAt),
	};
}

function recordRunningStage(
	process: Parameters<typeof transitionTaskProcess>[0],
	verdict: Parameters<typeof transitionTaskProcess>[1],
	options: Parameters<typeof transitionTaskProcess>[2] = {},
): ReturnType<typeof transitionTaskProcess> {
	return transitionTaskProcess(markTaskProcessRunning(process), verdict, options);
}

function createProcessBoard(): BoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [createTask("task-1", "Run the process", 100)] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
		processes: [],
	};
}

vi.mock("@/components/app-toaster", () => ({
	notifyError: appTestMocks.notifyError,
	showAppToast: appTestMocks.showAppToast,
}));

vi.mock("@/components/add-project-dialog", () => ({
	AddProjectDialog: () => null,
}));

vi.mock("@/components/card-detail-view", () => ({
	CardDetailView: ({
		selection,
		onTaskProcessVerdict,
		onReopenTaskProcess,
	}: MockCardDetailViewProps): ReactElement => {
		const lastHistoryEntry = selection.card.process?.history.at(-1);
		return (
			<div data-testid="card-detail">
				<span data-testid="selected-column">{selection.column.id}</span>
				<span data-testid="process-stage">{selection.card.process?.stageId ?? "none"}</span>
				<span data-testid="process-status">{selection.card.process?.status ?? "none"}</span>
				<span data-testid="history-kinds">
					{selection.card.process?.history.map((entry) => entry.recordKind ?? "outcome").join(",") ?? "none"}
				</span>
				<span data-testid="history-notes">
					{selection.card.process?.history.map((entry) => entry.notes ?? "").join("|") ?? "none"}
				</span>
				<span data-testid="last-history-agent">{lastHistoryEntry?.agent ?? "none"}</span>
				<span data-testid="last-history-model">{lastHistoryEntry?.model ?? "none"}</span>
				<button
					type="button"
					onClick={() =>
						onTaskProcessVerdict(
							selection.card.id,
							"pass",
							"UI stage passed.",
							selection.card.process?.stageId ?? "",
							"ui-red",
							"ui-model",
						)
					}
				>
					Pass process
				</button>
				<button
					type="button"
					onClick={() =>
						onTaskProcessVerdict(
							selection.card.id,
							"fail",
							"UI stage failed.",
							selection.card.process?.stageId ?? "",
							"ui-blue",
							"ui-fail-model",
						)
					}
				>
					Fail process
				</button>
				<button
					type="button"
					onClick={() =>
						onReopenTaskProcess(
							selection.card.id,
							"UI process reopened.",
							selection.card.process?.stageId ?? "",
							"ui-reopen",
							"ui-reopen-model",
						)
					}
				>
					Reopen process
				</button>
			</div>
		);
	},
}));

vi.mock("@/components/clear-trash-dialog", () => ({
	ClearTrashDialog: () => null,
}));

vi.mock("@/components/debug-dialog", () => ({
	DebugDialog: () => null,
}));

vi.mock("@/components/detail-panels/agent-terminal-panel", () => ({
	AgentTerminalPanel: () => null,
}));

vi.mock("@/components/git-history-view", () => ({
	GitHistoryView: () => null,
}));

vi.mock("@/components/kanban-board", () => ({
	KanbanBoard: () => <div data-testid="kanban-board" />,
}));

vi.mock("@/components/process-definitions-dialog", () => ({
	ProcessDefinitionsDialog: () => null,
}));

vi.mock("@/components/project-navigation-panel", () => ({
	ProjectNavigationPanel: () => null,
}));

vi.mock("@/components/runtime-settings-dialog", () => ({
	RuntimeSettingsDialog: () => null,
}));

vi.mock("@/components/startup-onboarding-dialog", () => ({
	StartupOnboardingDialog: () => null,
}));

vi.mock("@/components/task-create-dialog", () => ({
	TaskCreateDialog: () => null,
}));

vi.mock("@/components/task-inline-create-card", () => ({
	TaskInlineCreateCard: () => null,
}));

vi.mock("@/components/top-bar", () => ({
	TopBar: ({ processCount }: MockTopBarProps) => <div data-testid="top-bar">{processCount}</div>,
}));

vi.mock("@/components/update-notification-controller", () => ({
	UpdateNotificationController: () => null,
}));

vi.mock("@/data/board-data", () => ({
	createInitialBoardData: appTestMocks.createInitialBoardData,
}));

vi.mock("@/hooks/kanban-access-blocked-fallback", () => ({
	KanbanAccessBlockedFallback: () => <div data-testid="access-blocked" />,
}));

vi.mock("@/hooks/runtime-disconnected-fallback", () => ({
	RuntimeDisconnectedFallback: () => <div data-testid="runtime-disconnected" />,
}));

vi.mock("@/hooks/use-app-hotkeys", () => ({
	useAppHotkeys: () => {},
}));

vi.mock("@/hooks/use-board-interactions", () => ({
	useBoardInteractions: (input: unknown) => appTestMocks.useBoardInteractions(input),
}));

vi.mock("@/hooks/use-debug-tools", () => ({
	useDebugTools: () => ({
		debugModeEnabled: false,
		isDebugDialogOpen: false,
		isResetAllStatePending: false,
		handleOpenDebugDialog: () => {},
		handleShowStartupOnboardingDialog: () => {},
		handleDebugDialogOpenChange: () => {},
		handleResetAllState: () => {},
	}),
}));

vi.mock("@/hooks/use-detail-task-navigation", () => ({
	useDetailTaskNavigation: (input: unknown) => appTestMocks.useDetailTaskNavigation(input),
}));

vi.mock("@/hooks/use-document-visibility", () => ({
	useDocumentVisibility: () => true,
}));

vi.mock("@/hooks/use-featurebase-feedback-widget", () => ({
	useFeaturebaseFeedbackWidget: () => null,
}));

vi.mock("@/hooks/use-git-actions", () => ({
	useGitActions: () => ({
		runningGitAction: null,
		taskGitActionLoadingByTaskId: {},
		commitTaskLoadingById: {},
		openPrTaskLoadingById: {},
		agentCommitTaskLoadingById: {},
		agentOpenPrTaskLoadingById: {},
		isDiscardingHomeWorkingChanges: false,
		gitActionError: null,
		gitActionErrorTitle: "Git action failed",
		clearGitActionError: () => {},
		gitHistory: null,
		runGitAction: async () => false,
		switchHomeBranch: async () => false,
		discardHomeWorkingChanges: async () => false,
		handleCommitTask: () => {},
		handleOpenPrTask: () => {},
		handleAgentCommitTask: () => {},
		handleAgentOpenPrTask: () => {},
		runAutoReviewGitAction: async () => false,
		resetGitActionState: () => {},
	}),
}));

vi.mock("@/hooks/use-home-sidebar-agent-panel", () => ({
	useHomeSidebarAgentPanel: () => null,
}));

vi.mock("@/hooks/use-kanban-access-gate", () => ({
	useKanbanAccessGate: () => ({ isBlocked: false, refresh: () => {} }),
}));

vi.mock("@/hooks/use-open-workspace", () => ({
	useOpenWorkspace: () => ({
		openTargetOptions: [],
		selectedOpenTargetId: "vscode",
		onSelectOpenTarget: () => {},
		onOpenWorkspace: () => {},
		canOpenWorkspace: false,
		isOpeningWorkspace: false,
	}),
}));

vi.mock("@/hooks/use-project-navigation", () => ({
	parseRemovedProjectPathFromStreamError: () => null,
	useProjectNavigation: () => ({
		currentProjectId: "project-1",
		projects: [{ id: "project-1", path: "/workspace/project-1", name: "Project" }],
		workspaceState: null,
		workspaceMetadata: null,
		latestTaskChatMessage: null,
		taskChatMessagesByTaskId: {},
		latestTaskReadyForReview: null,
		latestMcpAuthStatuses: [],
		clineSessionContextVersion: 0,
		streamError: null,
		isRuntimeDisconnected: false,
		hasReceivedSnapshot: true,
		navigationCurrentProjectId: "project-1",
		removingProjectId: null,
		hasNoProjects: false,
		isProjectSwitching: false,
		handleSelectProject: async () => {},
		handleAddProject: async () => {},
		handleAddProjectSuccess: () => {},
		handleRemoveProject: () => {},
		isAddProjectDialogOpen: false,
		setIsAddProjectDialogOpen: () => {},
		pendingNativeGitInitPath: null,
		resetProjectNavigationState: () => {},
	}),
}));

vi.mock("@/hooks/use-project-ui-state", () => ({
	useProjectUiState: () => ({
		displayedProjects: [{ id: "project-1", path: "/workspace/project-1", name: "Project" }],
		navigationProjectPath: "/workspace/project-1",
		shouldShowProjectLoadingState: false,
		isProjectListLoading: false,
		shouldUseNavigationPath: false,
	}),
}));

vi.mock("@/hooks/use-review-ready-notifications", () => ({
	useReviewReadyNotifications: () => {},
}));

vi.mock("@/hooks/use-shortcut-actions", () => ({
	useShortcutActions: () => ({
		runningShortcutLabel: null,
		handleSelectShortcutLabel: () => {},
		handleRunShortcut: async () => false,
		handleCreateShortcut: async () => ({ ok: true }),
	}),
}));

vi.mock("@/hooks/use-startup-onboarding", () => ({
	useStartupOnboarding: () => ({
		isStartupOnboardingDialogOpen: false,
		handleOpenStartupOnboardingDialog: () => {},
		handleCloseStartupOnboardingDialog: () => {},
		handleSelectOnboardingAgent: async () => ({ ok: true }),
		handleOnboardingClineSetupSaved: () => {},
	}),
}));

vi.mock("@/hooks/use-task-branch-options", () => ({
	useTaskBranchOptions: () => ({ createTaskBranchOptions: [], defaultTaskBranchRef: "main" }),
}));

vi.mock("@/hooks/use-task-editor", () => ({
	useTaskEditor: () => ({
		isInlineTaskCreateOpen: false,
		newTaskPrompt: "",
		setNewTaskPrompt: () => {},
		newTaskImages: [],
		setNewTaskImages: () => {},
		newTaskStartInPlanMode: false,
		setNewTaskStartInPlanMode: () => {},
		newTaskAutoReviewEnabled: false,
		setNewTaskAutoReviewEnabled: () => {},
		newTaskAutoReviewMode: "commit",
		setNewTaskAutoReviewMode: () => {},
		isNewTaskStartInPlanModeDisabled: false,
		newTaskBranchRef: "main",
		setNewTaskBranchRef: () => {},
		newTaskAgentId: "codex",
		setNewTaskAgentId: () => {},
		newTaskClineSettings: undefined,
		setNewTaskClineSettings: () => {},
		newTaskProcessId: "lightweight",
		setNewTaskProcessId: () => {},
		editingTaskId: null,
		editTaskPrompt: "",
		setEditTaskPrompt: () => {},
		editTaskImages: [],
		setEditTaskImages: () => {},
		editTaskStartInPlanMode: false,
		setEditTaskStartInPlanMode: () => {},
		editTaskAutoReviewEnabled: false,
		setEditTaskAutoReviewEnabled: () => {},
		editTaskAutoReviewMode: "commit",
		setEditTaskAutoReviewMode: () => {},
		isEditTaskStartInPlanModeDisabled: false,
		editTaskBranchRef: "main",
		setEditTaskBranchRef: () => {},
		editTaskAgentId: "codex",
		setEditTaskAgentId: () => {},
		editTaskClineSettings: undefined,
		setEditTaskClineSettings: () => {},
		editTaskProcessId: "lightweight",
		setEditTaskProcessId: () => {},
		handleOpenCreateTask: () => {},
		handleCancelCreateTask: () => {},
		handleOpenEditTask: () => {},
		handleCancelEditTask: () => {},
		handleSaveEditedTask: () => null,
		handleSaveAndStartEditedTask: () => null,
		handleSaveTaskTitle: () => {},
		handleCreateTask: () => null,
		handleCreateTasks: () => [],
		resetTaskEditorState: () => {},
	}),
}));

vi.mock("@/hooks/use-task-sessions", () => ({
	useTaskSessions: () => ({
		upsertSession: () => {},
		ensureTaskWorkspace: async () => ({ ok: true, response: { ok: true, path: "/workspace/project-1/task-1" } }),
		startTaskSession: async () => ({ ok: true }),
		stopTaskSession: appTestMocks.stopTaskSession,
		sendTaskSessionInput: async () => ({ ok: true }),
		sendTaskChatMessage: async () => ({ ok: true }),
		cancelTaskChatTurn: async () => ({ ok: true }),
		fetchTaskChatMessages: async () => [],
		cleanupTaskWorkspace: async () => null,
		fetchTaskWorkspaceInfo: async () => null,
	}),
}));

vi.mock("@/hooks/use-task-start-actions", () => ({
	useTaskStartActions: () => ({
		handleCreateAndStartTask: () => {},
		handleCreateAndStartTasks: () => {},
		handleCreateStartAndOpenTask: () => {},
		handleStartTaskFromBoard: () => {},
		handleStartAllBacklogTasksFromBoard: () => {},
	}),
}));

vi.mock("@/hooks/use-terminal-panels", () => ({
	useTerminalPanels: () => ({
		homeTerminalTaskId: "home",
		isHomeTerminalOpen: false,
		isHomeTerminalStarting: false,
		homeTerminalPaneHeight: undefined,
		isDetailTerminalOpen: false,
		detailTerminalTaskId: null,
		isDetailTerminalStarting: false,
		detailTerminalPaneHeight: undefined,
		isHomeTerminalExpanded: false,
		isDetailTerminalExpanded: false,
		setHomeTerminalPaneHeight: () => {},
		setDetailTerminalPaneHeight: () => {},
		handleToggleExpandHomeTerminal: () => {},
		handleToggleExpandDetailTerminal: () => {},
		handleToggleHomeTerminal: () => {},
		handleToggleDetailTerminal: () => {},
		handleSendAgentCommandToHomeTerminal: () => {},
		handleSendAgentCommandToDetailTerminal: () => {},
		prepareTerminalForShortcut: async () => true,
		resetBottomTerminalLayoutCustomizations: () => {},
		collapseHomeTerminal: () => {},
		collapseDetailTerminal: () => {},
		closeHomeTerminal: () => {},
		closeDetailTerminal: () => {},
		resetTerminalPanelsState: () => {},
	}),
}));

vi.mock("@/hooks/use-workspace-sync", () => ({
	useWorkspaceSync: () => ({
		workspacePath: "/workspace/project-1",
		workspaceGit: null,
		workspaceRevision: 1,
		setWorkspaceRevision: () => {},
		workspaceHydrationNonce: 1,
		isWorkspaceStateRefreshing: false,
		isWorkspaceMetadataPending: false,
		refreshWorkspaceState: async () => {},
		resetWorkspaceSyncState: () => {},
	}),
}));

vi.mock("@/resize/layout-customizations", () => ({
	LayoutCustomizationsProvider: ({ children }: MockChildrenProps): ReactElement => <>{children}</>,
}));

vi.mock("@/resize/resizable-bottom-pane", () => ({
	ResizableBottomPane: ({ children }: MockChildrenProps): ReactElement => <>{children}</>,
}));

vi.mock("@/resize/use-project-navigation-layout", () => ({
	useProjectNavigationLayout: () => ({
		sidebarWidth: 260,
		setExpandedSidebarWidth: () => {},
		isCollapsed: false,
		setSidebarCollapsed: () => {},
	}),
}));

vi.mock("@/runtime/native-agent", () => ({
	getTaskAgentNavbarHint: () => "Codex",
	isTaskAgentSetupSatisfied: () => true,
	selectLatestTaskChatMessageForTask: () => null,
	selectTaskChatMessagesForTask: () => [],
}));

vi.mock("@/runtime/use-runtime-project-config", () => ({
	useRuntimeProjectConfig: () => ({
		config: {
			selectedAgentId: "codex",
			agents: [],
			shortcuts: [],
			clineProviderSettings: null,
			readyForReviewNotificationsEnabled: false,
		},
		isLoading: false,
		refresh: () => {},
	}),
}));

vi.mock("@/runtime/use-terminal-connection-ready", () => ({
	useTerminalConnectionReady: () => ({
		markConnectionReady: () => {},
		prepareWaitForConnection: async () => {},
	}),
}));

vi.mock("@/runtime/use-workspace-persistence", () => ({
	useWorkspacePersistence: () => {},
}));

vi.mock("@/runtime/workspace-state-query", () => ({
	saveWorkspaceState: async () => ({ ok: true }),
}));

vi.mock("@/stores/workspace-metadata-store", () => ({
	getTaskWorkspaceInfo: () => null,
	getTaskWorkspaceSnapshot: () => null,
	replaceWorkspaceMetadata: () => {},
	resetWorkspaceMetadataStore: () => {},
}));

vi.mock("@/terminal/theme-colors", () => ({
	useTerminalThemeColors: () => ({
		surfaceRaised: "#24292E",
		textPrimary: "#E6EDF3",
	}),
}));

function createBoardInteractionsResult(): object {
	return {
		confirmMoveTaskToTrash: async () => {},
		handleProgrammaticCardMoveReady: () => {},
		handleCreateDependency: () => {},
		handleDeleteDependency: () => {},
		handleDragEnd: () => {},
		handleStartTask: () => {},
		handleStartAllBacklogTasks: () => {},
		handleRunTaskProcessStage: appTestMocks.handleRunTaskProcessStage,
		handleRunReadyTaskProcessStages: () => {},
		handleDetailTaskDragEnd: () => {},
		handleCardSelect: () => {},
		handleMoveToTrash: () => {},
		handleMoveReviewCardToTrash: () => {},
		handleRestoreTaskFromTrash: () => {},
		handleCancelAutomaticTaskAction: () => {},
		handleOpenClearTrash: () => {},
		handleConfirmClearTrash: () => {},
		handleAddReviewComments: async () => {},
		handleSendReviewComments: async () => {},
		moveToTrashLoadingById: {},
		trashTaskCount: 0,
	};
}

describe("App process orchestration", () => {
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
		appTestMocks.createInitialBoardData.mockReturnValue(createProcessBoard());
		appTestMocks.handleRunTaskProcessStage.mockReset();
		appTestMocks.handleRunTaskProcessStage.mockResolvedValue(true);
		appTestMocks.stopTaskSession.mockReset();
		appTestMocks.stopTaskSession.mockResolvedValue(undefined);
		appTestMocks.useBoardInteractions.mockReset();
		appTestMocks.useBoardInteractions.mockReturnValue(createBoardInteractionsResult());
		appTestMocks.useDetailTaskNavigation.mockReset();
		appTestMocks.useDetailTaskNavigation.mockImplementation((input: { board: BoardData }) => {
			return {
				selectedTaskId: "task-1",
				selectedCard: findTaskSelection(input.board, "task-1"),
				setSelectedTaskId: () => {},
				handleBack: () => {},
			};
		});
		appTestMocks.notifyError.mockReset();
		appTestMocks.showAppToast.mockReset();
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

	it("queues a fresh process stage run after a UI verdict advances to another ready stage", async () => {
		await act(async () => {
			root.render(<App />);
		});

		expect(container.querySelector('[data-testid="process-stage"]')?.textContent).toBe("pending");
		expect(container.querySelector('[data-testid="process-status"]')?.textContent).toBe("ready");
		expect(container.querySelector('[data-testid="top-bar"]')?.textContent).toBe(
			String(getTaskProcessDefinitions([]).length),
		);
		expect(appTestMocks.handleRunTaskProcessStage).not.toHaveBeenCalled();

		const passButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Pass process",
		);
		expect(passButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			passButton?.click();
		});
		await act(async () => {});

		expect(container.querySelector('[data-testid="process-stage"]')?.textContent).toBe("swe");
		expect(container.querySelector('[data-testid="process-status"]')?.textContent).toBe("ready");
		expect(container.querySelector('[data-testid="history-kinds"]')?.textContent).toBe("dispatch");
		expect(container.querySelector('[data-testid="last-history-agent"]')?.textContent).toBe("ui-red");
		expect(container.querySelector('[data-testid="last-history-model"]')?.textContent).toBe("ui-model");
		expect(appTestMocks.handleRunTaskProcessStage).toHaveBeenCalledTimes(1);
		expect(appTestMocks.handleRunTaskProcessStage).toHaveBeenCalledWith("task-1");
	});

	it("rejects UI verdicts for promptless runnable stages before mutating process state", async () => {
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
			createTaskProcess("promptless-process", 100, [promptlessDefinition]),
			"pass",
			{
				now: 101,
				agent: "kanban",
				definitions: [promptlessDefinition],
				recordKind: "dispatch",
				notes: "Dispatched pending to swe.",
			},
		);
		appTestMocks.createInitialBoardData.mockReturnValue({
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{
					id: "in_progress",
					title: "In Progress",
					cards: [{ ...createTask("task-1", "Run the process", 100), process: promptlessProcess }],
				},
				{ id: "review", title: "Review", cards: [] },
				{ id: "trash", title: "Done", cards: [] },
			],
			dependencies: [],
			processes: [promptlessDefinition],
		});

		await act(async () => {
			root.render(<App />);
		});

		expect(container.querySelector('[data-testid="process-stage"]')?.textContent).toBe("swe");
		expect(container.querySelector('[data-testid="process-status"]')?.textContent).toBe("ready");

		const passButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Pass process",
		);
		expect(passButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			passButton?.click();
		});
		await act(async () => {});

		expect(container.querySelector('[data-testid="process-stage"]')?.textContent).toBe("swe");
		expect(container.querySelector('[data-testid="process-status"]')?.textContent).toBe("ready");
		expect(container.querySelector('[data-testid="history-kinds"]')?.textContent).toBe("dispatch");
		expect(appTestMocks.notifyError).toHaveBeenCalledWith(
			'Task process "promptless-process" stage "swe" is missing a stage prompt.',
		);
		expect(appTestMocks.showAppToast).not.toHaveBeenCalled();
		expect(appTestMocks.handleRunTaskProcessStage).not.toHaveBeenCalled();
	});

	it("records a guarded dispatch before accepting a UI verdict from a ready non-passive stage", async () => {
		const sweProcess = transitionTaskProcess(createTaskProcess("lightweight", 100), "pass", {
			now: 101,
			agent: "kanban",
			recordKind: "dispatch",
			notes: "Dispatched pending to swe.",
		});
		appTestMocks.createInitialBoardData.mockReturnValue({
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{
					id: "in_progress",
					title: "In Progress",
					cards: [{ ...createTask("task-1", "Run the process", 100), process: sweProcess }],
				},
				{ id: "review", title: "Review", cards: [] },
				{ id: "trash", title: "Done", cards: [] },
			],
			dependencies: [],
			processes: [],
		});

		await act(async () => {
			root.render(<App />);
		});

		expect(container.querySelector('[data-testid="process-stage"]')?.textContent).toBe("swe");
		expect(container.querySelector('[data-testid="process-status"]')?.textContent).toBe("ready");

		const passButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Pass process",
		);
		expect(passButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			passButton?.click();
		});
		await act(async () => {});

		expect(container.querySelector('[data-testid="process-stage"]')?.textContent).toBe("blue-team");
		expect(container.querySelector('[data-testid="process-status"]')?.textContent).toBe("ready");
		expect(container.querySelector('[data-testid="history-kinds"]')?.textContent).toBe("dispatch,dispatch,outcome");
		expect(container.querySelector('[data-testid="history-notes"]')?.textContent).toContain(
			"Accepted guarded UI verdict for swe.",
		);
		expect(appTestMocks.handleRunTaskProcessStage).toHaveBeenCalledTimes(1);
		expect(appTestMocks.handleRunTaskProcessStage).toHaveBeenCalledWith("task-1");
	});

	it("does not auto-dispatch the next process stage from backlog after a UI verdict", async () => {
		appTestMocks.createInitialBoardData.mockReturnValue({
			columns: [
				{ id: "backlog", title: "Backlog", cards: [createTask("task-1", "Run the process", 100)] },
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "trash", title: "Done", cards: [] },
			],
			dependencies: [],
			processes: [],
		});

		await act(async () => {
			root.render(<App />);
		});

		expect(container.querySelector('[data-testid="process-stage"]')?.textContent).toBe("pending");
		expect(container.querySelector('[data-testid="process-status"]')?.textContent).toBe("ready");

		const passButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Pass process",
		);
		expect(passButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			passButton?.click();
		});
		await act(async () => {});

		expect(container.querySelector('[data-testid="process-stage"]')?.textContent).toBe("swe");
		expect(container.querySelector('[data-testid="process-status"]')?.textContent).toBe("ready");
		expect(container.querySelector('[data-testid="last-history-agent"]')?.textContent).toBe("ui-red");
		expect(container.querySelector('[data-testid="last-history-model"]')?.textContent).toBe("ui-model");
		expect(appTestMocks.handleRunTaskProcessStage).not.toHaveBeenCalled();
	});

	it("queues a fresh process stage run after a UI fail verdict moves to the fail target", async () => {
		const pendingProcess = createTaskProcess("lightweight", 100);
		const sweProcess = transitionTaskProcess(pendingProcess, "pass", {
			now: 101,
			agent: "kanban",
			recordKind: "dispatch",
			notes: "Dispatched pending to swe.",
		});
		appTestMocks.createInitialBoardData.mockReturnValue({
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{
					id: "in_progress",
					title: "In Progress",
					cards: [
						{ ...createTask("task-1", "Run the process", 100), process: markTaskProcessRunning(sweProcess) },
					],
				},
				{ id: "review", title: "Review", cards: [] },
				{ id: "trash", title: "Done", cards: [] },
			],
			dependencies: [],
			processes: [],
		});

		await act(async () => {
			root.render(<App />);
		});

		expect(container.querySelector('[data-testid="process-stage"]')?.textContent).toBe("swe");
		expect(container.querySelector('[data-testid="process-status"]')?.textContent).toBe("running");
		expect(appTestMocks.handleRunTaskProcessStage).not.toHaveBeenCalled();

		const failButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Fail process",
		);
		expect(failButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			failButton?.click();
		});
		await act(async () => {});

		expect(container.querySelector('[data-testid="process-stage"]')?.textContent).toBe("pending");
		expect(container.querySelector('[data-testid="process-status"]')?.textContent).toBe("ready");
		expect(container.querySelector('[data-testid="last-history-agent"]')?.textContent).toBe("ui-blue");
		expect(container.querySelector('[data-testid="last-history-model"]')?.textContent).toBe("ui-fail-model");
		expect(appTestMocks.handleRunTaskProcessStage).toHaveBeenCalledTimes(1);
		expect(appTestMocks.handleRunTaskProcessStage).toHaveBeenCalledWith("task-1");
	});

	it("moves reopened active process tasks to backlog and stops the active session", async () => {
		const pendingProcess = createTaskProcess("lightweight", 100);
		const sweProcess = transitionTaskProcess(pendingProcess, "pass", {
			now: 101,
			agent: "kanban",
			recordKind: "dispatch",
			notes: "Dispatched pending to swe.",
		});
		const blueProcess = recordRunningStage(sweProcess, "pass", {
			now: 102,
			agent: "swe",
			notes: "Implementation accepted.",
		});
		const doneProcess = recordRunningStage(blueProcess, "pass", {
			now: 103,
			agent: "blue-team",
			notes: "Verification accepted.",
		});
		appTestMocks.createInitialBoardData.mockReturnValue({
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{
					id: "in_progress",
					title: "In Progress",
					cards: [{ ...createTask("task-1", "Run the process", 100), process: doneProcess }],
				},
				{ id: "review", title: "Review", cards: [] },
				{ id: "trash", title: "Done", cards: [] },
			],
			dependencies: [],
			processes: [],
		});

		await act(async () => {
			root.render(<App />);
		});

		expect(container.querySelector('[data-testid="selected-column"]')?.textContent).toBe("in_progress");
		expect(container.querySelector('[data-testid="process-stage"]')?.textContent).toBe("done");
		expect(container.querySelector('[data-testid="process-status"]')?.textContent).toBe("complete");

		const reopenButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Reopen process",
		);
		expect(reopenButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			reopenButton?.click();
		});
		await act(async () => {});

		expect(appTestMocks.notifyError).not.toHaveBeenCalled();
		expect(container.querySelector('[data-testid="process-stage"]')?.textContent).toBe("pending");
		expect(container.querySelector('[data-testid="process-status"]')?.textContent).toBe("ready");
		expect(container.querySelector('[data-testid="selected-column"]')?.textContent).toBe("backlog");
		expect(container.querySelector('[data-testid="last-history-agent"]')?.textContent).toBe("ui-reopen");
		expect(container.querySelector('[data-testid="last-history-model"]')?.textContent).toBe("ui-reopen-model");
		expect(appTestMocks.stopTaskSession).toHaveBeenCalledTimes(1);
		expect(appTestMocks.stopTaskSession).toHaveBeenCalledWith("task-1");
	});
});
