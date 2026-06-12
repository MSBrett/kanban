// Main React composition root for the browser app.
// Keep this file focused on wiring top-level hooks and surfaces together, and
// push runtime-specific orchestration down into hooks and service modules.

import {
	appendTaskProcessHistory,
	assertTaskProcessStagePromptReady,
	getTaskProcessDefinitions,
	getTaskProcessStage,
	isPassiveDispatchStage,
	markTaskProcessRunning,
	reopenTaskProcess,
	transitionTaskProcess,
} from "@runtime-task-process";
import { FolderOpen } from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AddProjectDialog } from "@/components/add-project-dialog";
import { notifyError, showAppToast } from "@/components/app-toaster";
import { CardDetailView } from "@/components/card-detail-view";
import { ClearTrashDialog } from "@/components/clear-trash-dialog";
import { DebugDialog } from "@/components/debug-dialog";
import { AgentTerminalPanel } from "@/components/detail-panels/agent-terminal-panel";
import { GitHistoryView } from "@/components/git-history-view";
import { KanbanBoard } from "@/components/kanban-board";
import { ProcessDefinitionsDialog } from "@/components/process-definitions-dialog";
import { ProjectNavigationPanel } from "@/components/project-navigation-panel";
import { RuntimeSettingsDialog, type RuntimeSettingsSection } from "@/components/runtime-settings-dialog";
import { StartupOnboardingDialog } from "@/components/startup-onboarding-dialog";
import { TaskCreateDialog } from "@/components/task-create-dialog";
import { TaskInlineCreateCard } from "@/components/task-inline-create-card";
import { TopBar } from "@/components/top-bar";
import { Button } from "@/components/ui/button";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { UpdateNotificationController } from "@/components/update-notification-controller";
import { createInitialBoardData } from "@/data/board-data";
import { createIdleTaskSession } from "@/hooks/app-utils";
import { KanbanAccessBlockedFallback } from "@/hooks/kanban-access-blocked-fallback";
import { RuntimeDisconnectedFallback } from "@/hooks/runtime-disconnected-fallback";
import { useAppHotkeys } from "@/hooks/use-app-hotkeys";
import { useBoardInteractions } from "@/hooks/use-board-interactions";
import { useDebugTools } from "@/hooks/use-debug-tools";
import { useDetailTaskNavigation } from "@/hooks/use-detail-task-navigation";
import { useDocumentVisibility } from "@/hooks/use-document-visibility";
import { useFeaturebaseFeedbackWidget } from "@/hooks/use-featurebase-feedback-widget";
import { useGitActions } from "@/hooks/use-git-actions";
import { useHomeSidebarAgentPanel } from "@/hooks/use-home-sidebar-agent-panel";
import { useKanbanAccessGate } from "@/hooks/use-kanban-access-gate";
import { useOpenWorkspace } from "@/hooks/use-open-workspace";
import { parseRemovedProjectPathFromStreamError, useProjectNavigation } from "@/hooks/use-project-navigation";
import { useProjectUiState } from "@/hooks/use-project-ui-state";
import { useReviewReadyNotifications } from "@/hooks/use-review-ready-notifications";
import { useShortcutActions } from "@/hooks/use-shortcut-actions";
import { useStartupOnboarding } from "@/hooks/use-startup-onboarding";
import { useTaskBranchOptions } from "@/hooks/use-task-branch-options";
import { useTaskEditor } from "@/hooks/use-task-editor";
import { useTaskSessions } from "@/hooks/use-task-sessions";
import { useTaskStartActions } from "@/hooks/use-task-start-actions";
import { useTerminalPanels } from "@/hooks/use-terminal-panels";
import { useWorkspaceSync } from "@/hooks/use-workspace-sync";
import { LayoutCustomizationsProvider } from "@/resize/layout-customizations";
import { ResizableBottomPane } from "@/resize/resizable-bottom-pane";
import { useProjectNavigationLayout } from "@/resize/use-project-navigation-layout";
import {
	getTaskAgentNavbarHint,
	isTaskAgentSetupSatisfied,
	selectLatestTaskChatMessageForTask,
	selectTaskChatMessagesForTask,
} from "@/runtime/native-agent";
import type { RuntimeClineReasoningEffort, RuntimeTaskSessionSummary } from "@/runtime/types";
import { useRuntimeProjectConfig } from "@/runtime/use-runtime-project-config";
import { useTerminalConnectionReady } from "@/runtime/use-terminal-connection-ready";
import { useWorkspacePersistence } from "@/runtime/use-workspace-persistence";
import { saveWorkspaceState } from "@/runtime/workspace-state-query";
import {
	applyTaskDetailClineSettingsChange,
	findCardSelection,
	moveTaskToColumn,
	updateTaskProcess,
} from "@/state/board-state";
import {
	getTaskWorkspaceInfo,
	getTaskWorkspaceSnapshot,
	replaceWorkspaceMetadata,
	resetWorkspaceMetadataStore,
} from "@/stores/workspace-metadata-store";
import { useTerminalThemeColors } from "@/terminal/theme-colors";
import type { BoardCard, BoardData, TaskProcessDefinition, TaskProcessVerdict } from "@/types";

export default function App(): ReactElement {
	const terminalThemeColors = useTerminalThemeColors();
	const [board, setBoard] = useState<BoardData>(() => createInitialBoardData());
	const [sessions, setSessions] = useState<Record<string, RuntimeTaskSessionSummary>>({});
	const [canPersistWorkspaceState, setCanPersistWorkspaceState] = useState(false);
	const [isSettingsOpen, setIsSettingsOpen] = useState(false);
	const [settingsInitialSection, setSettingsInitialSection] = useState<RuntimeSettingsSection | null>(null);
	const [homeSidebarSection, setHomeSidebarSection] = useState<"projects" | "agent">("projects");
	const [isClearTrashDialogOpen, setIsClearTrashDialogOpen] = useState(false);
	const [isGitHistoryOpen, setIsGitHistoryOpen] = useState(false);
	const [isProcessDefinitionsOpen, setIsProcessDefinitionsOpen] = useState(false);
	const [pendingTaskStartAfterEditId, setPendingTaskStartAfterEditId] = useState<string | null>(null);
	const [pendingTaskProcessRunAfterEditId, setPendingTaskProcessRunAfterEditId] = useState<string | null>(null);
	const autoRunProcessStageStateRef = useRef<
		Map<string, { columnId: string; status: string; stageId: string; updatedAt: number }>
	>(new Map());
	const autoRunProcessStageKeysRef = useRef<Set<string>>(new Set());
	const taskEditorResetRef = useRef<() => void>(() => {});
	const lastStreamErrorRef = useRef<string | null>(null);
	const processUsageById = useMemo(() => {
		const counts: Record<string, number> = {};
		for (const column of board.columns) {
			for (const card of column.cards) {
				if (!card.process) {
					continue;
				}
				counts[card.process.processId] = (counts[card.process.processId] ?? 0) + 1;
			}
		}
		return counts;
	}, [board.columns]);
	const totalProcessCount = useMemo(() => getTaskProcessDefinitions(board.processes ?? []).length, [board.processes]);
	const handleProjectSwitchStart = useCallback(() => {
		setCanPersistWorkspaceState(false);
		setIsGitHistoryOpen(false);
		setPendingTaskStartAfterEditId(null);
		setPendingTaskProcessRunAfterEditId(null);
		autoRunProcessStageStateRef.current = new Map();
		autoRunProcessStageKeysRef.current.clear();
		taskEditorResetRef.current();
	}, []);
	const {
		currentProjectId,
		projects,
		workspaceState: streamedWorkspaceState,
		workspaceMetadata,
		latestTaskChatMessage,
		taskChatMessagesByTaskId,
		latestTaskReadyForReview,
		latestMcpAuthStatuses,
		clineSessionContextVersion,
		streamError,
		isRuntimeDisconnected,
		hasReceivedSnapshot,
		navigationCurrentProjectId,
		removingProjectId,
		hasNoProjects,
		isProjectSwitching,
		handleSelectProject,
		handleAddProject,
		handleAddProjectSuccess,
		handleRemoveProject,
		isAddProjectDialogOpen,
		setIsAddProjectDialogOpen,
		pendingNativeGitInitPath,
		resetProjectNavigationState,
	} = useProjectNavigation({
		onProjectSwitchStart: handleProjectSwitchStart,
	});
	const activeNotificationWorkspaceId = navigationCurrentProjectId;
	const isDocumentVisible = useDocumentVisibility();
	const isInitialRuntimeLoad =
		!hasReceivedSnapshot && currentProjectId === null && projects.length === 0 && !streamError;
	const isAwaitingWorkspaceSnapshot = currentProjectId !== null && streamedWorkspaceState === null;
	const {
		config: runtimeProjectConfig,
		isLoading: isRuntimeProjectConfigLoading,
		refresh: refreshRuntimeProjectConfig,
	} = useRuntimeProjectConfig(currentProjectId);
	const { isBlocked: isKanbanAccessBlocked, refresh: refreshKanbanAccess } = useKanbanAccessGate({
		workspaceId: currentProjectId,
	});
	const isTaskAgentReady = isTaskAgentSetupSatisfied(runtimeProjectConfig);
	const settingsWorkspaceId = navigationCurrentProjectId ?? currentProjectId;
	const { config: settingsRuntimeProjectConfig, refresh: refreshSettingsRuntimeProjectConfig } =
		useRuntimeProjectConfig(settingsWorkspaceId);
	const featurebaseFeedbackState = useFeaturebaseFeedbackWidget({
		workspaceId: settingsWorkspaceId,
		clineProviderSettings: settingsRuntimeProjectConfig?.clineProviderSettings ?? null,
	});
	const {
		isStartupOnboardingDialogOpen,
		handleOpenStartupOnboardingDialog,
		handleCloseStartupOnboardingDialog,
		handleSelectOnboardingAgent,
		handleOnboardingClineSetupSaved,
	} = useStartupOnboarding({
		currentProjectId,
		runtimeProjectConfig,
		isRuntimeProjectConfigLoading,
		isTaskAgentReady,
		refreshRuntimeProjectConfig,
		refreshSettingsRuntimeProjectConfig,
	});
	const {
		debugModeEnabled,
		isDebugDialogOpen,
		isResetAllStatePending,
		handleOpenDebugDialog,
		handleShowStartupOnboardingDialog,
		handleDebugDialogOpenChange,
		handleResetAllState,
	} = useDebugTools({
		runtimeProjectConfig,
		settingsRuntimeProjectConfig,
		onOpenStartupOnboardingDialog: handleOpenStartupOnboardingDialog,
	});
	const {
		markConnectionReady: markTerminalConnectionReady,
		prepareWaitForConnection: prepareWaitForTerminalConnectionReady,
	} = useTerminalConnectionReady();
	const readyForReviewNotificationsEnabled = runtimeProjectConfig?.readyForReviewNotificationsEnabled ?? true;
	const shortcuts = runtimeProjectConfig?.shortcuts ?? [];
	const selectedShortcutLabel = useMemo(() => {
		if (shortcuts.length === 0) {
			return null;
		}
		const configured = runtimeProjectConfig?.selectedShortcutLabel ?? null;
		if (configured && shortcuts.some((shortcut) => shortcut.label === configured)) {
			return configured;
		}
		return shortcuts[0]?.label ?? null;
	}, [runtimeProjectConfig?.selectedShortcutLabel, shortcuts]);
	const {
		upsertSession,
		ensureTaskWorkspace,
		startTaskSession,
		stopTaskSession,
		sendTaskSessionInput,
		sendTaskChatMessage,
		cancelTaskChatTurn,
		fetchTaskChatMessages,
		cleanupTaskWorkspace,
		fetchTaskWorkspaceInfo,
	} = useTaskSessions({
		currentProjectId,
		setSessions,
	});

	const {
		workspacePath,
		workspaceGit,
		workspaceRevision,
		setWorkspaceRevision,
		workspaceHydrationNonce,
		isWorkspaceStateRefreshing,
		isWorkspaceMetadataPending,
		refreshWorkspaceState,
		resetWorkspaceSyncState,
	} = useWorkspaceSync({
		currentProjectId,
		streamedWorkspaceState,
		hasNoProjects,
		hasReceivedSnapshot,
		isDocumentVisible,
		setBoard,
		setSessions,
		setCanPersistWorkspaceState,
	});
	const { selectedTaskId, selectedCard, setSelectedTaskId, handleBack } = useDetailTaskNavigation({
		board,
		currentProjectId,
		isAwaitingWorkspaceSnapshot,
		isInitialRuntimeLoad,
		isProjectSwitching,
		isWorkspaceMetadataPending,
		onDetailClosed: () => {
			setIsGitHistoryOpen(false);
		},
	});

	useEffect(() => {
		replaceWorkspaceMetadata(workspaceMetadata);
	}, [workspaceMetadata]);

	useEffect(() => {
		if (!isProjectSwitching) {
			return;
		}
		resetWorkspaceMetadataStore();
	}, [isProjectSwitching]);

	const {
		displayedProjects,
		navigationProjectPath,
		shouldShowProjectLoadingState,
		isProjectListLoading,
		shouldUseNavigationPath,
	} = useProjectUiState({
		board,
		canPersistWorkspaceState,
		currentProjectId,
		projects,
		navigationCurrentProjectId,
		selectedTaskId,
		streamError,
		isProjectSwitching,
		isInitialRuntimeLoad,
		isAwaitingWorkspaceSnapshot,
		isWorkspaceMetadataPending,
		hasReceivedSnapshot,
	});

	useReviewReadyNotifications({
		activeWorkspaceId: activeNotificationWorkspaceId,
		board,
		isDocumentVisible,
		latestTaskReadyForReview,
		taskSessions: sessions,
		readyForReviewNotificationsEnabled,
		workspacePath,
	});

	const { createTaskBranchOptions, defaultTaskBranchRef } = useTaskBranchOptions({ workspaceGit });
	const queueTaskStartAfterEdit = useCallback((taskId: string) => {
		setPendingTaskStartAfterEditId(taskId);
	}, []);

	const {
		isInlineTaskCreateOpen,
		newTaskPrompt,
		setNewTaskPrompt,
		newTaskImages,
		setNewTaskImages,
		newTaskStartInPlanMode,
		setNewTaskStartInPlanMode,
		newTaskAutoReviewEnabled,
		setNewTaskAutoReviewEnabled,
		newTaskAutoReviewMode,
		setNewTaskAutoReviewMode,
		isNewTaskStartInPlanModeDisabled,
		newTaskBranchRef,
		setNewTaskBranchRef,
		newTaskAgentId,
		setNewTaskAgentId,
		newTaskClineSettings,
		setNewTaskClineSettings,
		newTaskProcessId,
		setNewTaskProcessId,
		editingTaskId,
		editTaskPrompt,
		setEditTaskPrompt,
		editTaskImages,
		setEditTaskImages,
		editTaskStartInPlanMode,
		setEditTaskStartInPlanMode,
		editTaskAutoReviewEnabled,
		setEditTaskAutoReviewEnabled,
		editTaskAutoReviewMode,
		setEditTaskAutoReviewMode,
		isEditTaskStartInPlanModeDisabled,
		editTaskBranchRef,
		setEditTaskBranchRef,
		editTaskAgentId,
		setEditTaskAgentId,
		editTaskClineSettings,
		setEditTaskClineSettings,
		editTaskProcessId,
		setEditTaskProcessId,
		handleOpenCreateTask,
		handleCancelCreateTask,
		handleOpenEditTask,
		handleCancelEditTask,
		handleSaveEditedTask,
		handleSaveAndStartEditedTask,
		handleSaveTaskTitle,
		handleCreateTask,
		handleCreateTasks,
		resetTaskEditorState,
	} = useTaskEditor({
		board,
		setBoard,
		currentProjectId,
		createTaskBranchOptions,
		defaultTaskBranchRef,
		selectedAgentId: runtimeProjectConfig?.selectedAgentId ?? null,
		setSelectedTaskId,
		queueTaskStartAfterEdit,
	});

	useEffect(() => {
		taskEditorResetRef.current = resetTaskEditorState;
	}, [resetTaskEditorState]);

	useEffect(() => {
		if (!isProjectSwitching) {
			return;
		}
		resetWorkspaceSyncState();
	}, [isProjectSwitching, resetWorkspaceSyncState]);

	useEffect(() => {
		if (!isProjectSwitching) {
			return;
		}
		resetTaskEditorState();
	}, [isProjectSwitching, resetTaskEditorState]);

	const {
		runningGitAction,
		taskGitActionLoadingByTaskId,
		commitTaskLoadingById,
		openPrTaskLoadingById,
		agentCommitTaskLoadingById,
		agentOpenPrTaskLoadingById,
		isDiscardingHomeWorkingChanges,
		gitActionError,
		gitActionErrorTitle,
		clearGitActionError,
		gitHistory,
		runGitAction,
		switchHomeBranch,
		discardHomeWorkingChanges,
		handleCommitTask,
		handleOpenPrTask,
		handleAgentCommitTask,
		handleAgentOpenPrTask,
		runAutoReviewGitAction,
		resetGitActionState,
	} = useGitActions({
		currentProjectId,
		board,
		selectedCard,
		runtimeProjectConfig,
		sendTaskSessionInput,
		sendTaskChatMessage,
		fetchTaskWorkspaceInfo,
		isGitHistoryOpen,
		refreshWorkspaceState,
	});
	const agentCommand = runtimeProjectConfig?.effectiveCommand ?? null;
	const {
		homeTerminalTaskId,
		isHomeTerminalOpen,
		isHomeTerminalStarting,
		homeTerminalPaneHeight,
		isDetailTerminalOpen,
		detailTerminalTaskId,
		isDetailTerminalStarting,
		detailTerminalPaneHeight,
		isHomeTerminalExpanded,
		isDetailTerminalExpanded,
		setHomeTerminalPaneHeight,
		setDetailTerminalPaneHeight,
		handleToggleExpandHomeTerminal,
		handleToggleExpandDetailTerminal,
		handleToggleHomeTerminal,
		handleToggleDetailTerminal,
		handleSendAgentCommandToHomeTerminal,
		handleSendAgentCommandToDetailTerminal,
		prepareTerminalForShortcut,
		resetBottomTerminalLayoutCustomizations,
		collapseHomeTerminal,
		collapseDetailTerminal,
		closeHomeTerminal,
		closeDetailTerminal,
		resetTerminalPanelsState,
	} = useTerminalPanels({
		currentProjectId,
		selectedCard,
		workspaceGit,
		agentCommand,
		upsertSession,
		sendTaskSessionInput,
	});
	const homeTerminalSummary = sessions[homeTerminalTaskId] ?? null;
	const homeSidebarAgentPanel = useHomeSidebarAgentPanel({
		currentProjectId,
		hasNoProjects,
		runtimeProjectConfig,
		clineSessionContextVersion,
		taskSessions: sessions,
		workspaceGit,
		latestTaskChatMessage,
		taskChatMessagesByTaskId,
	});
	const { runningShortcutLabel, handleSelectShortcutLabel, handleRunShortcut, handleCreateShortcut } =
		useShortcutActions({
			currentProjectId,
			selectedShortcutLabel: runtimeProjectConfig?.selectedShortcutLabel,
			shortcuts,
			refreshRuntimeProjectConfig,
			prepareTerminalForShortcut,
			prepareWaitForTerminalConnectionReady,
			sendTaskSessionInput,
		});

	const persistWorkspaceStateAsync = useCallback(
		async (input: { workspaceId: string; payload: Parameters<typeof saveWorkspaceState>[1] }) =>
			await saveWorkspaceState(input.workspaceId, input.payload),
		[],
	);
	const handleWorkspaceStateConflict = useCallback(() => {
		showAppToast(
			{
				intent: "warning",
				icon: "warning-sign",
				message: "Workspace changed elsewhere. Synced latest state. Retry your last edit if needed.",
				timeout: 5000,
			},
			"workspace-state-conflict",
		);
	}, []);

	useWorkspacePersistence({
		board,
		sessions,
		currentProjectId,
		workspaceRevision,
		hydrationNonce: workspaceHydrationNonce,
		canPersistWorkspaceState,
		isDocumentVisible,
		isWorkspaceStateRefreshing,
		persistWorkspaceState: persistWorkspaceStateAsync,
		refetchWorkspaceState: refreshWorkspaceState,
		onWorkspaceRevisionChange: setWorkspaceRevision,
		onWorkspaceStateConflict: handleWorkspaceStateConflict,
	});

	useEffect(() => {
		if (!streamError) {
			lastStreamErrorRef.current = null;
			return;
		}
		const removedPath = parseRemovedProjectPathFromStreamError(streamError);
		if (removedPath !== null) {
			showAppToast(
				{
					intent: "danger",
					icon: "warning-sign",
					message: removedPath
						? `Project no longer exists and was removed: ${removedPath}`
						: "Project no longer exists and was removed.",
					timeout: 6000,
				},
				`project-removed-${removedPath || "unknown"}`,
			);
			lastStreamErrorRef.current = null;
			return;
		}
		if (isRuntimeDisconnected) {
			lastStreamErrorRef.current = streamError;
			return;
		}
		if (lastStreamErrorRef.current !== streamError) {
			notifyError(streamError, { key: `error:${streamError}` });
		}
		lastStreamErrorRef.current = streamError;
	}, [isRuntimeDisconnected, streamError]);

	useEffect(() => {
		resetTaskEditorState();
		setIsClearTrashDialogOpen(false);
		setIsProcessDefinitionsOpen(false);
		resetGitActionState();
		resetProjectNavigationState();
		resetTerminalPanelsState();
	}, [
		currentProjectId,
		resetGitActionState,
		resetProjectNavigationState,
		resetTaskEditorState,
		resetTerminalPanelsState,
	]);

	useEffect(() => {
		if (selectedCard) {
			return;
		}
		if (hasNoProjects || !currentProjectId) {
			if (isHomeTerminalOpen) {
				closeHomeTerminal();
			}
			return;
		}
	}, [closeHomeTerminal, currentProjectId, hasNoProjects, isHomeTerminalOpen, selectedCard]);
	const showHomeBottomTerminal = !selectedCard && !hasNoProjects && isHomeTerminalOpen;
	const homeTerminalSubtitle = useMemo(
		() => workspacePath ?? navigationProjectPath ?? null,
		[navigationProjectPath, workspacePath],
	);

	const handleOpenSettings = useCallback((section?: RuntimeSettingsSection) => {
		setSettingsInitialSection(section ?? null);
		setIsSettingsOpen(true);
	}, []);
	const handleToggleGitHistory = useCallback(() => {
		if (hasNoProjects) {
			return;
		}
		setIsGitHistoryOpen((current) => !current);
	}, [hasNoProjects]);
	const handleCloseGitHistory = useCallback(() => {
		setIsGitHistoryOpen(false);
	}, []);

	const {
		confirmMoveTaskToTrash,
		handleProgrammaticCardMoveReady,
		handleCreateDependency,
		handleDeleteDependency,
		handleDragEnd,
		handleStartTask,
		handleStartAllBacklogTasks,
		handleRunTaskProcessStage,
		handleDetailTaskDragEnd,
		handleCardSelect,
		handleMoveToTrash,
		handleMoveReviewCardToTrash,
		handleDeleteTask,
		handleRestoreTaskFromTrash,
		handleCancelAutomaticTaskAction,
		handleOpenClearTrash,
		handleConfirmClearTrash,
		handleAddReviewComments,
		handleSendReviewComments,
		moveToTrashLoadingById,
		trashTaskCount,
	} = useBoardInteractions({
		board,
		setBoard,
		sessions,
		setSessions,
		selectedCard,
		selectedTaskId,
		currentProjectId,
		workspacePath: workspacePath ?? navigationProjectPath ?? null,
		kanbanCommand: runtimeProjectConfig?.kanbanCommand ?? null,
		setSelectedTaskId,
		setIsClearTrashDialogOpen,
		setIsGitHistoryOpen,
		stopTaskSession,
		cleanupTaskWorkspace,
		ensureTaskWorkspace,
		startTaskSession,
		fetchTaskWorkspaceInfo,
		sendTaskSessionInput,
		readyForReviewNotificationsEnabled,
		taskGitActionLoadingByTaskId,
		runAutoReviewGitAction,
	});

	const {
		handleCreateAndStartTask,
		handleCreateAndStartTasks,
		handleCreateStartAndOpenTask,
		handleStartTaskFromBoard,
		handleStartAllBacklogTasksFromBoard,
	} = useTaskStartActions({
		board,
		handleCreateTask,
		handleCreateTasks,
		handleStartTask,
		handleStartAllBacklogTasks,
		setSelectedTaskId,
	});

	useAppHotkeys({
		selectedCard,
		isDetailTerminalOpen,
		isHomeTerminalOpen: showHomeBottomTerminal,
		isHomeGitHistoryOpen: !selectedCard && isGitHistoryOpen,
		canUseCreateTaskShortcut: !hasNoProjects && currentProjectId !== null,
		handleToggleDetailTerminal,
		handleToggleHomeTerminal,
		handleToggleExpandDetailTerminal,
		handleToggleExpandHomeTerminal: handleToggleExpandHomeTerminal,
		handleOpenCreateTask,
		handleOpenSettings,
		handleToggleGitHistory,
		handleCloseGitHistory,
		onStartAllTasks: handleStartAllBacklogTasksFromBoard,
	});

	useEffect(() => {
		if (!pendingTaskStartAfterEditId) {
			return;
		}
		const selection = findCardSelection(board, pendingTaskStartAfterEditId);
		if (!selection || selection.column.id !== "backlog") {
			return;
		}
		handleStartTaskFromBoard(pendingTaskStartAfterEditId);
		setPendingTaskStartAfterEditId(null);
	}, [board, handleStartTaskFromBoard, pendingTaskStartAfterEditId]);

	useEffect(() => {
		if (!pendingTaskProcessRunAfterEditId) {
			return;
		}
		const selection = findCardSelection(board, pendingTaskProcessRunAfterEditId);
		if (!selection) {
			return;
		}
		setPendingTaskProcessRunAfterEditId(null);
		if (!selection.card.process || selection.card.process.status !== "ready") {
			return;
		}
		const runKey = `${selection.card.id}:${selection.card.process.stageId}:${selection.card.process.updatedAt}`;
		if (autoRunProcessStageKeysRef.current.has(runKey)) {
			return;
		}
		autoRunProcessStageKeysRef.current.add(runKey);
		void handleRunTaskProcessStage(pendingTaskProcessRunAfterEditId);
	}, [board, handleRunTaskProcessStage, pendingTaskProcessRunAfterEditId]);

	useEffect(() => {
		const previousByTaskId = autoRunProcessStageStateRef.current;
		const nextByTaskId = new Map<string, { columnId: string; status: string; stageId: string; updatedAt: number }>();
		const taskIdsToRun: string[] = [];

		for (const column of board.columns) {
			for (const card of column.cards) {
				if (!card.process) {
					continue;
				}
				const currentState = {
					columnId: column.id,
					status: card.process.status,
					stageId: card.process.stageId,
					updatedAt: card.process.updatedAt,
				};
				nextByTaskId.set(card.id, currentState);

				const previousState = previousByTaskId.get(card.id);
				if (
					column.id !== "in_progress" ||
					card.process.status !== "ready" ||
					previousState?.columnId !== "in_progress" ||
					previousState.status === "ready"
				) {
					continue;
				}

				const runKey = `${card.id}:${card.process.stageId}:${card.process.updatedAt}`;
				if (autoRunProcessStageKeysRef.current.has(runKey)) {
					continue;
				}
				autoRunProcessStageKeysRef.current.add(runKey);
				taskIdsToRun.push(card.id);
			}
		}

		autoRunProcessStageStateRef.current = nextByTaskId;
		for (const taskId of taskIdsToRun) {
			void handleRunTaskProcessStage(taskId);
		}
	}, [board, handleRunTaskProcessStage]);

	const detailSession = selectedCard
		? (sessions[selectedCard.card.id] ?? createIdleTaskSession(selectedCard.card.id))
		: null;
	const detailTerminalSummary = detailTerminalTaskId ? (sessions[detailTerminalTaskId] ?? null) : null;
	const detailTerminalSubtitle = useMemo(() => {
		if (!selectedCard) {
			return null;
		}
		return (
			getTaskWorkspaceInfo(selectedCard.card.id, selectedCard.card.baseRef)?.path ??
			getTaskWorkspaceSnapshot(selectedCard.card.id)?.path ??
			null
		);
	}, [selectedCard]);

	const runtimeHint = useMemo(() => {
		return getTaskAgentNavbarHint(runtimeProjectConfig, {
			shouldUseNavigationPath,
		});
	}, [runtimeProjectConfig, shouldUseNavigationPath]);

	const activeWorkspacePath = selectedCard
		? (getTaskWorkspaceInfo(selectedCard.card.id, selectedCard.card.baseRef)?.path ??
			getTaskWorkspaceSnapshot(selectedCard.card.id)?.path ??
			workspacePath ??
			undefined)
		: shouldUseNavigationPath
			? (navigationProjectPath ?? undefined)
			: (workspacePath ?? undefined);

	const activeWorkspaceHint = useMemo(() => {
		if (!selectedCard) {
			return undefined;
		}
		const activeSelectedTaskWorkspaceInfo = getTaskWorkspaceInfo(selectedCard.card.id, selectedCard.card.baseRef);
		if (!activeSelectedTaskWorkspaceInfo) {
			return undefined;
		}
		if (!activeSelectedTaskWorkspaceInfo.exists) {
			return selectedCard.column.id === "trash" ? "Task worktree deleted" : "Task worktree not created yet";
		}
		return undefined;
	}, [selectedCard]);

	const sidebarLayout = useProjectNavigationLayout();
	const handleToggleSidebar = useCallback(() => {
		sidebarLayout.setSidebarCollapsed(!sidebarLayout.isCollapsed);
	}, [sidebarLayout]);

	const navbarWorkspacePath = hasNoProjects ? undefined : activeWorkspacePath;
	const navbarWorkspaceHint = hasNoProjects ? undefined : activeWorkspaceHint;
	const navbarRuntimeHint = hasNoProjects ? undefined : runtimeHint;
	const shouldHideProjectDependentTopBarActions =
		!selectedCard && (isProjectSwitching || isAwaitingWorkspaceSnapshot || isWorkspaceMetadataPending);

	const {
		openTargetOptions,
		selectedOpenTargetId,
		onSelectOpenTarget,
		onOpenWorkspace,
		canOpenWorkspace,
		isOpeningWorkspace,
	} = useOpenWorkspace({
		currentProjectId,
		workspacePath: activeWorkspacePath,
	});
	const selectedTaskChatMessages = selectTaskChatMessagesForTask(selectedCard?.card.id, taskChatMessagesByTaskId);
	const latestSelectedTaskChatMessage = selectLatestTaskChatMessageForTask(
		selectedCard?.card.id,
		latestTaskChatMessage,
	);
	const defaultTaskClineProviderId =
		runtimeProjectConfig?.clineProviderSettings?.providerId ??
		runtimeProjectConfig?.clineProviderSettings?.oauthProvider ??
		null;
	const handleClineTaskSettingsChangedForTask = useCallback(
		({
			providerId,
			modelId,
			reasoningEffort,
		}: {
			providerId: string;
			modelId: string;
			reasoningEffort: RuntimeClineReasoningEffort | "";
		}) => {
			if (!selectedCard) {
				return;
			}
			const taskId = selectedCard.card.id;
			setBoard((currentBoard) => {
				const result = applyTaskDetailClineSettingsChange(
					currentBoard,
					taskId,
					{
						providerId,
						modelId,
						reasoningEffort,
					},
					{
						providerId: defaultTaskClineProviderId,
						modelId: runtimeProjectConfig?.clineProviderSettings?.modelId ?? null,
					},
				);
				return result.updated ? result.board : currentBoard;
			});
		},
		[defaultTaskClineProviderId, runtimeProjectConfig, selectedCard, setBoard],
	);

	const handleCreateDialogOpenChange = useCallback(
		(open: boolean) => {
			if (!open) {
				handleCancelCreateTask();
			}
		},
		[handleCancelCreateTask],
	);

	const handleProcessDefinitionsChange = useCallback(
		(processes: TaskProcessDefinition[]) => {
			setBoard((currentBoard) => ({
				...currentBoard,
				processes,
			}));
		},
		[setBoard],
	);

	const handleAppendProcessNote = useCallback(
		(taskId: string, notes: string, expectedStage?: string, agentOverride?: string, modelOverride?: string) => {
			const trimmedNotes = notes.trim();
			if (!trimmedNotes) {
				notifyError("Process notes are required.");
				return;
			}
			const trimmedAgentOverride = agentOverride?.trim();
			const trimmedModel = modelOverride?.trim();
			let didUpdate = false;
			let errorMessage: string | null = null;
			setBoard((currentBoard) => {
				const selection = findCardSelection(currentBoard, taskId);
				if (!selection?.card.process) {
					errorMessage = `Task "${taskId}" does not have a process assigned.`;
					return currentBoard;
				}
				if (expectedStage && selection.card.process.stageId !== expectedStage) {
					errorMessage = `Task "${taskId}" is at process stage "${selection.card.process.stageId}", expected "${expectedStage}".`;
					return currentBoard;
				}
				try {
					const stage = getTaskProcessStage(selection.card.process, currentBoard.processes ?? []);
					const agent = trimmedAgentOverride || stage?.role?.trim() || stage?.id || selection.card.process.stageId;
					const nextProcess = appendTaskProcessHistory(selection.card.process, {
						notes: trimmedNotes,
						agent,
						...(trimmedModel ? { model: trimmedModel } : {}),
					});
					const result = updateTaskProcess(currentBoard, taskId, nextProcess);
					didUpdate = result.updated;
					return result.updated ? result.board : currentBoard;
				} catch (error) {
					errorMessage = error instanceof Error ? error.message : String(error);
					return currentBoard;
				}
			});
			if (errorMessage) {
				notifyError(errorMessage);
				return;
			}
			if (didUpdate) {
				showAppToast({ intent: "success", message: "Process note appended.", timeout: 2500 });
			}
		},
		[setBoard],
	);

	const handleTaskProcessVerdict = useCallback(
		(
			taskId: string,
			verdict: TaskProcessVerdict,
			notes: string,
			expectedStage?: string,
			agentOverride?: string,
			modelOverride?: string,
		) => {
			const trimmedNotes = notes.trim();
			if (!trimmedNotes) {
				notifyError("Process verdict notes are required.");
				return;
			}
			const trimmedAgentOverride = agentOverride?.trim();
			const trimmedModel = modelOverride?.trim();
			let didUpdate = false;
			let completedTask: BoardCard | null = null;
			let completedBoard: BoardData | null = null;
			let nextStageId: string | null = null;
			let shouldRunNextStage = false;
			let errorMessage: string | null = null;
			setBoard((currentBoard) => {
				const selection = findCardSelection(currentBoard, taskId);
				if (!selection?.card.process) {
					errorMessage = `Task "${taskId}" does not have a process assigned.`;
					return currentBoard;
				}
				if (expectedStage && selection.card.process.stageId !== expectedStage) {
					errorMessage = `Task "${taskId}" is at process stage "${selection.card.process.stageId}", expected "${expectedStage}".`;
					return currentBoard;
				}
				try {
					const stage = getTaskProcessStage(selection.card.process, currentBoard.processes ?? []);
					if (verdict === "pass" || verdict === "fail") {
						assertTaskProcessStagePromptReady(selection.card.process, currentBoard.processes ?? []);
					}
					const agent = trimmedAgentOverride || stage?.role?.trim() || stage?.id || selection.card.process.stageId;
					const processForVerdict =
						expectedStage &&
						selection.card.process.status !== "running" &&
						stage &&
						!isPassiveDispatchStage(stage)
							? markTaskProcessRunning(selection.card.process, {
									agent,
									...(trimmedModel ? { model: trimmedModel } : {}),
									notes: `Accepted guarded UI verdict for ${selection.card.process.stageId}.`,
								})
							: selection.card.process;
					const nextProcess = transitionTaskProcess(processForVerdict, verdict, {
						notes: trimmedNotes,
						definitions: currentBoard.processes ?? [],
						agent,
						...(trimmedModel ? { model: trimmedModel } : {}),
					});
					nextStageId = nextProcess.stageId;
					const result = updateTaskProcess(currentBoard, taskId, nextProcess);
					if (!result.updated) {
						return currentBoard;
					}
					didUpdate = true;
					shouldRunNextStage =
						nextProcess.status === "ready" &&
						(selection.column.id === "in_progress" || selection.column.id === "review");
					if (nextProcess.status !== "complete" || !result.task) {
						return result.board;
					}
					completedTask = result.task;
					completedBoard = result.board;
					return result.board;
				} catch (error) {
					errorMessage = error instanceof Error ? error.message : String(error);
					return currentBoard;
				}
			});
			if (errorMessage) {
				notifyError(errorMessage);
				return;
			}
			if (didUpdate) {
				showAppToast({
					intent: verdict === "pass" ? "success" : "warning",
					message: `Process ${verdict} recorded${nextStageId ? `; stage is now ${nextStageId}.` : "."}`,
					timeout: 3000,
				});
			}
			if (didUpdate && shouldRunNextStage) {
				setPendingTaskProcessRunAfterEditId(taskId);
			}
			if (completedTask && completedBoard) {
				void confirmMoveTaskToTrash(completedTask, completedBoard);
			}
		},
		[confirmMoveTaskToTrash, setBoard],
	);

	const handleReopenTaskProcess = useCallback(
		(taskId: string, notes: string, expectedStage?: string, agentOverride?: string, modelOverride?: string) => {
			const trimmedNotes = notes.trim();
			if (!trimmedNotes) {
				notifyError("Process reopen notes are required.");
				return;
			}
			const trimmedAgent = agentOverride?.trim();
			if (!trimmedAgent) {
				notifyError("Process reopen agent is required.");
				return;
			}
			const trimmedModel = modelOverride?.trim();
			let didUpdate = false;
			let taskSessionStopId: string | null = null;
			let errorMessage: string | null = null;
			setBoard((currentBoard) => {
				const selection = findCardSelection(currentBoard, taskId);
				if (!selection?.card.process) {
					errorMessage = `Task "${taskId}" does not have a process assigned.`;
					return currentBoard;
				}
				if (expectedStage && selection.card.process.stageId !== expectedStage) {
					errorMessage = `Task "${taskId}" is at process stage "${selection.card.process.stageId}", expected "${expectedStage}".`;
					return currentBoard;
				}
				try {
					const nextProcess = reopenTaskProcess(selection.card.process, {
						notes: trimmedNotes,
						definitions: currentBoard.processes ?? [],
						agent: trimmedAgent,
						...(trimmedModel ? { model: trimmedModel } : {}),
					});
					const updated = updateTaskProcess(currentBoard, taskId, nextProcess);
					if (!updated.updated) {
						return currentBoard;
					}
					didUpdate = true;
					if (selection.column.id === "in_progress" || selection.column.id === "review") {
						taskSessionStopId = taskId;
					}
					if (selection.column.id === "backlog") {
						return updated.board;
					}
					const moved = moveTaskToColumn(updated.board, taskId, "backlog", { insertAtTop: true });
					return moved.moved ? moved.board : updated.board;
				} catch (error) {
					errorMessage = error instanceof Error ? error.message : String(error);
					return currentBoard;
				}
			});
			if (errorMessage) {
				notifyError(errorMessage);
				return;
			}
			if (didUpdate) {
				showAppToast({ intent: "success", message: "Process reopened.", timeout: 2500 });
			}
			if (taskSessionStopId) {
				void stopTaskSession(taskSessionStopId);
			}
		},
		[setBoard, stopTaskSession],
	);

	const editingTaskSelection = editingTaskId ? findCardSelection(board, editingTaskId) : null;
	const inlineProcessActionCard =
		editingTaskSelection?.card.process && editingTaskSelection.card.process.processId === editTaskProcessId
			? editingTaskSelection.card
			: undefined;

	const inlineTaskEditor = editingTaskId ? (
		<TaskInlineCreateCard
			prompt={editTaskPrompt}
			onPromptChange={setEditTaskPrompt}
			images={editTaskImages}
			onImagesChange={setEditTaskImages}
			onCreate={handleSaveEditedTask}
			onCreateAndStart={handleSaveAndStartEditedTask}
			onCancel={handleCancelEditTask}
			startInPlanMode={editTaskStartInPlanMode}
			onStartInPlanModeChange={setEditTaskStartInPlanMode}
			startInPlanModeDisabled={isEditTaskStartInPlanModeDisabled}
			autoReviewEnabled={editTaskAutoReviewEnabled}
			onAutoReviewEnabledChange={setEditTaskAutoReviewEnabled}
			autoReviewMode={editTaskAutoReviewMode}
			onAutoReviewModeChange={setEditTaskAutoReviewMode}
			workspaceId={currentProjectId}
			branchRef={editTaskBranchRef}
			branchOptions={createTaskBranchOptions}
			onBranchRefChange={setEditTaskBranchRef}
			agentId={editTaskAgentId}
			onAgentIdChange={setEditTaskAgentId}
			clineSettings={editTaskClineSettings}
			onClineSettingsChange={setEditTaskClineSettings}
			processId={editTaskProcessId}
			onProcessIdChange={setEditTaskProcessId}
			processDefinitions={board.processes ?? []}
			processActionCard={inlineProcessActionCard}
			onAppendProcessNote={handleAppendProcessNote}
			onTaskProcessVerdict={handleTaskProcessVerdict}
			onRunProcessStage={(taskId) => {
				if (editingTaskId === taskId) {
					const savedTaskId = handleSaveEditedTask();
					if (savedTaskId) {
						setPendingTaskProcessRunAfterEditId(savedTaskId);
					}
					return;
				}
				void handleRunTaskProcessStage(taskId);
			}}
			defaultAgentId={runtimeProjectConfig?.selectedAgentId ?? null}
			defaultProviderId={defaultTaskClineProviderId}
			defaultModelId={runtimeProjectConfig?.clineProviderSettings?.modelId ?? null}
			defaultReasoningEffort={runtimeProjectConfig?.clineProviderSettings?.reasoningEffort ?? null}
			mode="edit"
			idPrefix={`inline-edit-task-${editingTaskId}`}
		/>
	) : undefined;

	if (isRuntimeDisconnected) {
		return <RuntimeDisconnectedFallback />;
	}
	if (isKanbanAccessBlocked) {
		return <KanbanAccessBlockedFallback />;
	}

	return (
		<LayoutCustomizationsProvider onResetBottomTerminalLayoutCustomizations={resetBottomTerminalLayoutCustomizations}>
			<div className="flex h-[100svh] min-w-0 overflow-hidden">
				{!selectedCard ? (
					<ProjectNavigationPanel
						projects={displayedProjects}
						isLoadingProjects={isProjectListLoading}
						currentProjectId={navigationCurrentProjectId}
						removingProjectId={removingProjectId}
						activeSection={homeSidebarSection}
						onActiveSectionChange={setHomeSidebarSection}
						canShowAgentSection={!hasNoProjects && Boolean(currentProjectId)}
						agentSectionContent={homeSidebarAgentPanel}
						selectedAgentId={settingsRuntimeProjectConfig?.selectedAgentId ?? null}
						clineProviderSettings={settingsRuntimeProjectConfig?.clineProviderSettings ?? null}
						featurebaseFeedbackState={featurebaseFeedbackState}
						onSelectProject={(projectId) => {
							void handleSelectProject(projectId);
						}}
						onRemoveProject={handleRemoveProject}
						onAddProject={() => {
							void handleAddProject();
						}}
						sidebarWidth={sidebarLayout.sidebarWidth}
						setExpandedSidebarWidth={sidebarLayout.setExpandedSidebarWidth}
						isCollapsed={sidebarLayout.isCollapsed}
						setSidebarCollapsed={sidebarLayout.setSidebarCollapsed}
					/>
				) : null}
				<div className="flex flex-col flex-1 min-w-0 overflow-hidden">
					<TopBar
						onToggleSidebar={!selectedCard ? handleToggleSidebar : undefined}
						onBack={selectedCard ? handleBack : undefined}
						workspacePath={navbarWorkspacePath}
						isWorkspacePathLoading={shouldShowProjectLoadingState}
						workspaceHint={navbarWorkspaceHint}
						runtimeHint={navbarRuntimeHint}
						selectedTaskId={selectedCard?.card.id ?? null}
						selectedTaskBaseRef={selectedCard?.card.baseRef ?? null}
						showHomeGitSummary={!hasNoProjects && !selectedCard}
						runningGitAction={selectedCard || hasNoProjects ? null : runningGitAction}
						onGitFetch={
							selectedCard
								? undefined
								: () => {
										void runGitAction("fetch");
									}
						}
						onGitPull={
							selectedCard
								? undefined
								: () => {
										void runGitAction("pull");
									}
						}
						onGitPush={
							selectedCard
								? undefined
								: () => {
										void runGitAction("push");
									}
						}
						onToggleTerminal={
							hasNoProjects ? undefined : selectedCard ? handleToggleDetailTerminal : handleToggleHomeTerminal
						}
						isTerminalOpen={selectedCard ? isDetailTerminalOpen : showHomeBottomTerminal}
						isTerminalLoading={selectedCard ? isDetailTerminalStarting : isHomeTerminalStarting}
						onOpenProcesses={hasNoProjects ? undefined : () => setIsProcessDefinitionsOpen(true)}
						processCount={totalProcessCount}
						onOpenSettings={handleOpenSettings}
						showDebugButton={debugModeEnabled}
						onOpenDebugDialog={debugModeEnabled ? handleOpenDebugDialog : undefined}
						shortcuts={shortcuts}
						selectedShortcutLabel={selectedShortcutLabel}
						onSelectShortcutLabel={handleSelectShortcutLabel}
						runningShortcutLabel={runningShortcutLabel}
						onRunShortcut={handleRunShortcut}
						onCreateFirstShortcut={currentProjectId ? handleCreateShortcut : undefined}
						openTargetOptions={openTargetOptions}
						selectedOpenTargetId={selectedOpenTargetId}
						onSelectOpenTarget={onSelectOpenTarget}
						onOpenWorkspace={onOpenWorkspace}
						canOpenWorkspace={canOpenWorkspace}
						isOpeningWorkspace={isOpeningWorkspace}
						onToggleGitHistory={hasNoProjects ? undefined : handleToggleGitHistory}
						isGitHistoryOpen={isGitHistoryOpen}
						hideProjectDependentActions={shouldHideProjectDependentTopBarActions}
					/>
					<div className="relative flex flex-1 min-h-0 min-w-0 overflow-hidden">
						<div
							className="kb-home-layout"
							aria-hidden={selectedCard ? true : undefined}
							style={selectedCard ? { visibility: "hidden" } : undefined}
						>
							{shouldShowProjectLoadingState ? (
								<div className="flex flex-1 min-h-0 items-center justify-center bg-surface-0">
									<Spinner size={30} />
								</div>
							) : hasNoProjects ? (
								<div className="flex flex-1 min-h-0 items-center justify-center bg-surface-0 p-6">
									<div className="flex flex-col items-center justify-center gap-3 text-text-tertiary">
										<FolderOpen size={48} strokeWidth={1} />
										<h3 className="text-sm font-semibold text-text-primary">No projects yet</h3>
										<p className="text-[13px] text-text-secondary">
											Add a git repository to start using Kanban.
										</p>
										<Button
											variant="primary"
											onClick={() => {
												void handleAddProject();
											}}
										>
											Add Project
										</Button>
									</div>
								</div>
							) : (
								<div className="flex flex-1 flex-col min-h-0 min-w-0">
									<div className="flex flex-1 min-h-0 min-w-0">
										{isGitHistoryOpen ? (
											<GitHistoryView
												workspaceId={currentProjectId}
												gitHistory={gitHistory}
												onCheckoutBranch={(branch) => {
													void switchHomeBranch(branch);
												}}
												onDiscardWorkingChanges={() => {
													void discardHomeWorkingChanges();
												}}
												isDiscardWorkingChangesPending={isDiscardingHomeWorkingChanges}
											/>
										) : (
											<div className="flex min-h-0 min-w-0 flex-1 flex-col">
												<KanbanBoard
													data={board}
													taskSessions={sessions}
													workspacePath={workspacePath}
													onCardSelect={handleCardSelect}
													onCreateTask={handleOpenCreateTask}
													onStartTask={handleStartTaskFromBoard}
													onStartAllTasks={handleStartAllBacklogTasksFromBoard}
													onClearTrash={handleOpenClearTrash}
													editingTaskId={editingTaskId}
													inlineTaskEditor={inlineTaskEditor}
													onEditTask={handleOpenEditTask}
													onSaveTaskTitle={handleSaveTaskTitle}
													onCommitTask={handleCommitTask}
													onOpenPrTask={handleOpenPrTask}
													onCancelAutomaticTaskAction={handleCancelAutomaticTaskAction}
													commitTaskLoadingById={commitTaskLoadingById}
													openPrTaskLoadingById={openPrTaskLoadingById}
													moveToTrashLoadingById={moveToTrashLoadingById}
													onMoveToTrashTask={handleMoveReviewCardToTrash}
													onDeleteTask={handleDeleteTask}
													onRestoreFromTrashTask={handleRestoreTaskFromTrash}
													dependencies={board.dependencies}
													onCreateDependency={handleCreateDependency}
													onDeleteDependency={handleDeleteDependency}
													onRequestProgrammaticCardMoveReady={
														selectedCard ? undefined : handleProgrammaticCardMoveReady
													}
													onDragEnd={handleDragEnd}
													defaultClineModelId={
														runtimeProjectConfig?.clineProviderSettings?.modelId ?? null
													}
												/>
											</div>
										)}
									</div>
									{showHomeBottomTerminal ? (
										<ResizableBottomPane
											minHeight={200}
											initialHeight={homeTerminalPaneHeight}
											onHeightChange={setHomeTerminalPaneHeight}
											onCollapse={collapseHomeTerminal}
											isExpanded={isHomeTerminalExpanded}
										>
											<div
												style={{
													display: "flex",
													flex: "1 1 0",
													minWidth: 0,
													paddingLeft: 12,
													paddingRight: 12,
												}}
											>
												<AgentTerminalPanel
													key={`home-shell-${homeTerminalTaskId}`}
													taskId={homeTerminalTaskId}
													workspaceId={currentProjectId}
													summary={homeTerminalSummary}
													onSummary={upsertSession}
													showSessionToolbar={false}
													autoFocus
													onClose={closeHomeTerminal}
													minimalHeaderTitle="Terminal"
													minimalHeaderSubtitle={homeTerminalSubtitle}
													panelBackgroundColor="var(--color-surface-1)"
													terminalBackgroundColor={terminalThemeColors.surfaceRaised}
													cursorColor={terminalThemeColors.textPrimary}
													onConnectionReady={markTerminalConnectionReady}
													agentCommand={agentCommand}
													onSendAgentCommand={handleSendAgentCommandToHomeTerminal}
													isExpanded={isHomeTerminalExpanded}
													onToggleExpand={handleToggleExpandHomeTerminal}
												/>
											</div>
										</ResizableBottomPane>
									) : null}
								</div>
							)}
						</div>
						{selectedCard && detailSession ? (
							<div className="absolute inset-0 flex min-h-0 min-w-0">
								<CardDetailView
									selection={selectedCard}
									currentProjectId={currentProjectId}
									workspacePath={workspacePath}
									selectedAgentId={runtimeProjectConfig?.selectedAgentId ?? null}
									runtimeConfig={runtimeProjectConfig ?? null}
									sessionSummary={detailSession}
									taskSessions={sessions}
									onSessionSummary={upsertSession}
									onCardSelect={handleCardSelect}
									onTaskDragEnd={handleDetailTaskDragEnd}
									onCreateTask={handleOpenCreateTask}
									onStartTask={handleStartTaskFromBoard}
									onStartAllTasks={handleStartAllBacklogTasksFromBoard}
									onClearTrash={handleOpenClearTrash}
									editingTaskId={editingTaskId}
									inlineTaskEditor={inlineTaskEditor}
									onEditTask={(task) => {
										handleOpenEditTask(task, { preserveDetailSelection: true });
									}}
									onSaveTaskTitle={handleSaveTaskTitle}
									onCommitTask={handleCommitTask}
									onOpenPrTask={handleOpenPrTask}
									onAgentCommitTask={handleAgentCommitTask}
									onAgentOpenPrTask={handleAgentOpenPrTask}
									commitTaskLoadingById={commitTaskLoadingById}
									openPrTaskLoadingById={openPrTaskLoadingById}
									agentCommitTaskLoadingById={agentCommitTaskLoadingById}
									agentOpenPrTaskLoadingById={agentOpenPrTaskLoadingById}
									moveToTrashLoadingById={moveToTrashLoadingById}
									onMoveReviewCardToTrash={handleMoveReviewCardToTrash}
									onRestoreTaskFromTrash={handleRestoreTaskFromTrash}
									onCancelAutomaticTaskAction={handleCancelAutomaticTaskAction}
									onAddReviewComments={(taskId: string, text: string) => {
										void handleAddReviewComments(taskId, text);
									}}
									onSendReviewComments={(taskId: string, text: string) => {
										void handleSendReviewComments(taskId, text);
									}}
									onAppendProcessNote={handleAppendProcessNote}
									onTaskProcessVerdict={handleTaskProcessVerdict}
									onReopenTaskProcess={handleReopenTaskProcess}
									onRunProcessStage={(taskId: string) => {
										void handleRunTaskProcessStage(taskId);
									}}
									onSendClineChatMessage={sendTaskChatMessage}
									onCancelClineChatTurn={cancelTaskChatTurn}
									onLoadClineChatMessages={fetchTaskChatMessages}
									latestClineChatMessage={latestSelectedTaskChatMessage}
									streamedClineChatMessages={selectedTaskChatMessages}
									onMoveToTrash={handleMoveToTrash}
									isMoveToTrashLoading={moveToTrashLoadingById[selectedCard.card.id] ?? false}
									gitHistoryPanel={
										isGitHistoryOpen ? (
											<GitHistoryView workspaceId={currentProjectId} gitHistory={gitHistory} />
										) : undefined
									}
									onCloseGitHistory={handleCloseGitHistory}
									bottomTerminalOpen={isDetailTerminalOpen}
									bottomTerminalTaskId={detailTerminalTaskId}
									bottomTerminalSummary={detailTerminalSummary}
									bottomTerminalSubtitle={detailTerminalSubtitle}
									onBottomTerminalClose={closeDetailTerminal}
									onBottomTerminalCollapse={collapseDetailTerminal}
									bottomTerminalPaneHeight={detailTerminalPaneHeight}
									onBottomTerminalPaneHeightChange={setDetailTerminalPaneHeight}
									onBottomTerminalConnectionReady={markTerminalConnectionReady}
									bottomTerminalAgentCommand={agentCommand}
									onBottomTerminalSendAgentCommand={handleSendAgentCommandToDetailTerminal}
									isBottomTerminalExpanded={isDetailTerminalExpanded}
									onBottomTerminalToggleExpand={handleToggleExpandDetailTerminal}
									isDocumentVisible={isDocumentVisible}
									onClineSettingsSaved={refreshRuntimeProjectConfig}
									onTaskClineSettingsChanged={handleClineTaskSettingsChangedForTask}
								/>
							</div>
						) : null}
					</div>
				</div>
				<RuntimeSettingsDialog
					open={isSettingsOpen}
					workspaceId={settingsWorkspaceId}
					initialConfig={settingsRuntimeProjectConfig}
					liveMcpAuthStatuses={latestMcpAuthStatuses}
					initialSection={settingsInitialSection}
					onOpenChange={(nextOpen) => {
						setIsSettingsOpen(nextOpen);
						if (!nextOpen) {
							setSettingsInitialSection(null);
						}
					}}
					onSaved={() => {
						refreshRuntimeProjectConfig();
						refreshSettingsRuntimeProjectConfig();
					}}
					onAccountSwitched={refreshKanbanAccess}
				/>
				<DebugDialog
					open={isDebugDialogOpen}
					onOpenChange={handleDebugDialogOpenChange}
					isResetAllStatePending={isResetAllStatePending}
					onShowStartupOnboardingDialog={handleShowStartupOnboardingDialog}
					onResetAllState={handleResetAllState}
				/>
				<ProcessDefinitionsDialog
					open={isProcessDefinitionsOpen}
					onOpenChange={setIsProcessDefinitionsOpen}
					processDefinitions={board.processes ?? []}
					processUsageById={processUsageById}
					onProcessDefinitionsChange={handleProcessDefinitionsChange}
				/>
				<TaskCreateDialog
					open={isInlineTaskCreateOpen}
					onOpenChange={handleCreateDialogOpenChange}
					prompt={newTaskPrompt}
					onPromptChange={setNewTaskPrompt}
					images={newTaskImages}
					onImagesChange={setNewTaskImages}
					onCreate={handleCreateTask}
					onCreateAndStart={handleCreateAndStartTask}
					onCreateStartAndOpen={handleCreateStartAndOpenTask}
					onCreateMultiple={handleCreateTasks}
					onCreateAndStartMultiple={handleCreateAndStartTasks}
					startInPlanMode={newTaskStartInPlanMode}
					onStartInPlanModeChange={setNewTaskStartInPlanMode}
					startInPlanModeDisabled={isNewTaskStartInPlanModeDisabled}
					autoReviewEnabled={newTaskAutoReviewEnabled}
					onAutoReviewEnabledChange={setNewTaskAutoReviewEnabled}
					autoReviewMode={newTaskAutoReviewMode}
					onAutoReviewModeChange={setNewTaskAutoReviewMode}
					workspaceId={currentProjectId}
					branchRef={newTaskBranchRef}
					branchOptions={createTaskBranchOptions}
					onBranchRefChange={setNewTaskBranchRef}
					agentId={newTaskAgentId}
					onAgentIdChange={setNewTaskAgentId}
					clineSettings={newTaskClineSettings}
					onClineSettingsChange={setNewTaskClineSettings}
					processId={newTaskProcessId}
					onProcessIdChange={setNewTaskProcessId}
					processDefinitions={board.processes ?? []}
					defaultAgentId={runtimeProjectConfig?.selectedAgentId ?? null}
					defaultProviderId={defaultTaskClineProviderId}
					defaultModelId={runtimeProjectConfig?.clineProviderSettings?.modelId ?? null}
					defaultReasoningEffort={runtimeProjectConfig?.clineProviderSettings?.reasoningEffort ?? null}
				/>
				<ClearTrashDialog
					open={isClearTrashDialogOpen}
					taskCount={trashTaskCount}
					onCancel={() => setIsClearTrashDialogOpen(false)}
					onConfirm={handleConfirmClearTrash}
				/>
				<StartupOnboardingDialog
					open={isStartupOnboardingDialogOpen}
					onClose={handleCloseStartupOnboardingDialog}
					selectedAgentId={runtimeProjectConfig?.selectedAgentId ?? null}
					agents={runtimeProjectConfig?.agents ?? []}
					clineProviderSettings={runtimeProjectConfig?.clineProviderSettings ?? null}
					workspaceId={currentProjectId}
					runtimeConfig={runtimeProjectConfig ?? null}
					onSelectAgent={handleSelectOnboardingAgent}
					onClineSetupSaved={handleOnboardingClineSetupSaved}
				/>

				<AddProjectDialog
					open={isAddProjectDialogOpen}
					onOpenChange={setIsAddProjectDialogOpen}
					onProjectAdded={handleAddProjectSuccess}
					currentProjectId={currentProjectId}
					initialGitInitPath={pendingNativeGitInitPath}
				/>

				<UpdateNotificationController />

				<AlertDialog
					open={gitActionError !== null}
					onOpenChange={(open) => {
						if (!open) {
							clearGitActionError();
						}
					}}
				>
					<AlertDialogHeader>
						<AlertDialogTitle>{gitActionErrorTitle}</AlertDialogTitle>
					</AlertDialogHeader>
					<AlertDialogBody>
						<p>{gitActionError?.message}</p>
						{gitActionError?.output ? (
							<pre className="max-h-[220px] overflow-auto rounded-md bg-surface-0 p-3 font-mono text-xs text-text-secondary whitespace-pre-wrap">
								{gitActionError.output}
							</pre>
						) : null}
					</AlertDialogBody>
					<AlertDialogFooter className="justify-end">
						<AlertDialogAction asChild>
							<Button variant="default" onClick={clearGitActionError}>
								Close
							</Button>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialog>
			</div>
		</LayoutCustomizationsProvider>
	);
}
