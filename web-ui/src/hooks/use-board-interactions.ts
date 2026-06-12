import type { DropResult } from "@hello-pangea/dnd";
import {
	advanceTaskProcessPastPassiveDispatchStages,
	appendTaskProcessHistory,
	buildTaskProcessStagePrompt,
	getTaskProcessStage,
	markTaskProcessRunning,
} from "@runtime-task-process";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { notifyError, showAppToast } from "@/components/app-toaster";
import type { TaskGitAction } from "@/git-actions/build-task-git-action-prompt";
import { useLinkedBacklogTaskActions } from "@/hooks/use-linked-backlog-task-actions";
import { useProgrammaticCardMoves } from "@/hooks/use-programmatic-card-moves";
import { useReviewAutoActions } from "@/hooks/use-review-auto-actions";
import type { UseTaskSessionsResult } from "@/hooks/use-task-sessions";
import { getDetailTerminalTaskId } from "@/hooks/use-terminal-panels";
import type { RuntimeTaskSessionSummary, RuntimeTaskWorkspaceInfoResponse } from "@/runtime/types";
import {
	applyDragResult,
	clearColumnTasks,
	disableTaskAutoReview,
	findCardSelection,
	getBlockingDependencyTaskIds,
	getTaskColumnId,
	moveTaskToColumn,
	removeTask,
	updateTask,
	updateTaskProcess,
} from "@/state/board-state";
import { clearTaskWorkspaceInfo, setTaskWorkspaceInfo } from "@/stores/workspace-metadata-store";
import type { SendTerminalInputOptions } from "@/terminal/terminal-input";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";
import { resolveTaskAutoReviewMode } from "@/types";
import { getNextDetailTaskIdAfterTrashMove } from "@/utils/detail-view-task-order";
import {
	getBrowserNotificationPermission,
	hasPromptedForBrowserNotificationPermission,
	requestBrowserNotificationPermission,
} from "@/utils/notification-permission";

interface TaskGitActionLoadingStateLike {
	commitSource: string | null;
	prSource: string | null;
}

interface SelectedBoardCard {
	card: BoardCard;
	column: {
		id: BoardColumnId;
	};
}

interface PendingProgrammaticStartMoveCompletion {
	resolve: (started: boolean) => void;
	timeoutId: number;
}

interface UseBoardInteractionsInput {
	board: BoardData;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	setSessions: Dispatch<SetStateAction<Record<string, RuntimeTaskSessionSummary>>>;
	selectedCard: SelectedBoardCard | null;
	selectedTaskId: string | null;
	currentProjectId: string | null;
	workspacePath: string | null;
	kanbanCommand: string | null;
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
	setIsClearTrashDialogOpen: Dispatch<SetStateAction<boolean>>;
	setIsGitHistoryOpen: Dispatch<SetStateAction<boolean>>;
	stopTaskSession: (taskId: string) => Promise<void>;
	cleanupTaskWorkspace: (taskId: string) => Promise<unknown>;
	ensureTaskWorkspace: UseTaskSessionsResult["ensureTaskWorkspace"];
	startTaskSession: UseTaskSessionsResult["startTaskSession"];
	fetchTaskWorkspaceInfo: (task: BoardCard) => Promise<RuntimeTaskWorkspaceInfoResponse | null>;
	sendTaskSessionInput: (
		taskId: string,
		input: string,
		options?: SendTerminalInputOptions,
	) => Promise<{ ok: boolean; message?: string }>;
	readyForReviewNotificationsEnabled: boolean;
	taskGitActionLoadingByTaskId: Record<string, TaskGitActionLoadingStateLike>;
	runAutoReviewGitAction: (taskId: string, action: TaskGitAction) => Promise<boolean>;
}

export interface UseBoardInteractionsResult {
	handleProgrammaticCardMoveReady: ReturnType<typeof useProgrammaticCardMoves>["handleProgrammaticCardMoveReady"];
	confirmMoveTaskToTrash: (task: BoardCard, currentBoard?: BoardData) => Promise<void>;
	handleCreateDependency: (fromTaskId: string, toTaskId: string) => void;
	handleDeleteDependency: (dependencyId: string) => void;
	handleDragEnd: (result: DropResult, options?: { selectDroppedTask?: boolean }) => void;
	handleStartTask: (taskId: string) => void;
	handleStartAllBacklogTasks: (taskIds?: string[]) => void;
	handleRunTaskProcessStage: (taskId: string) => Promise<boolean>;
	handleRunReadyTaskProcessStages: (taskIds?: string[]) => void;
	handleDetailTaskDragEnd: (result: DropResult) => void;
	handleCardSelect: (taskId: string) => void;
	handleMoveToTrash: () => void;
	handleMoveReviewCardToTrash: (taskId: string) => void;
	handleDeleteTask: (taskId: string) => void;
	handleRestoreTaskFromTrash: (taskId: string) => void;
	handleCancelAutomaticTaskAction: (taskId: string) => void;
	handleOpenClearTrash: () => void;
	handleConfirmClearTrash: () => void;
	handleAddReviewComments: (taskId: string, text: string) => Promise<void>;
	handleSendReviewComments: (taskId: string, text: string) => Promise<void>;
	moveToTrashLoadingById: Record<string, boolean>;
	trashTaskCount: number;
}

function buildProcessStageLaunchTask(
	task: BoardCard,
	board: BoardData,
	workspacePath: string | null,
	kanbanCommand: string | null,
): {
	task: BoardCard;
	process: NonNullable<BoardCard["process"]>;
	previousProcess: NonNullable<BoardCard["process"]>;
} | null {
	if (!task.process) {
		return null;
	}
	if (task.process.status !== "ready") {
		return null;
	}
	const now = Date.now();
	const definitions = board.processes ?? [];
	const dispatchReadyProcess = advanceTaskProcessPastPassiveDispatchStages(task.process, {
		definitions,
		now,
	});
	const stage = getTaskProcessStage(dispatchReadyProcess, definitions);
	if (!stage || stage.terminal) {
		return null;
	}
	const runningProcess =
		dispatchReadyProcess.status === "running"
			? dispatchReadyProcess
			: markTaskProcessRunning(dispatchReadyProcess, {
					now,
					agent: "kanban",
					notes: `Started ${stage.id} stage.`,
				});
	const prompt = buildTaskProcessStagePrompt({
		taskId: task.id,
		taskTitle: task.title,
		taskPrompt: task.prompt,
		process: runningProcess,
		definitions,
		workspacePath,
		kanbanCommand,
	});
	return {
		task: {
			...task,
			prompt,
			startInPlanMode: false,
			agentId: stage.agentId ?? task.agentId,
			process: runningProcess,
		},
		process: runningProcess,
		previousProcess: task.process,
	};
}

export function useBoardInteractions({
	board,
	setBoard,
	sessions,
	setSessions,
	selectedCard,
	selectedTaskId,
	currentProjectId,
	workspacePath,
	kanbanCommand,
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
}: UseBoardInteractionsInput): UseBoardInteractionsResult {
	const previousSessionsRef = useRef<Record<string, RuntimeTaskSessionSummary>>({});
	const notificationPermissionPromptInFlightRef = useRef(false);
	const moveToTrashLoadingByIdRef = useRef<Record<string, true>>({});
	const pendingProgrammaticStartMoveCompletionByTaskIdRef = useRef<
		Record<string, PendingProgrammaticStartMoveCompletion>
	>({});
	const [moveToTrashLoadingById, setMoveToTrashLoadingById] = useState<Record<string, boolean>>({});
	const {
		handleProgrammaticCardMoveReady,
		setRequestMoveTaskToTrashHandler,
		tryProgrammaticCardMove,
		consumeProgrammaticCardMove,
		resolvePendingProgrammaticTrashMove,
		waitForProgrammaticCardMoveAvailability,
		resetProgrammaticCardMoves,
		requestMoveTaskToTrashWithAnimation,
		programmaticCardMoveCycle,
	} = useProgrammaticCardMoves();

	const resolvePendingProgrammaticStartMove = useCallback((taskId: string, started: boolean) => {
		const pending = pendingProgrammaticStartMoveCompletionByTaskIdRef.current[taskId];
		if (!pending) {
			return;
		}
		window.clearTimeout(pending.timeoutId);
		delete pendingProgrammaticStartMoveCompletionByTaskIdRef.current[taskId];
		pending.resolve(started);
	}, []);

	const getPrimaryBoardTaskElement = useCallback((taskId: string): HTMLElement | null => {
		const boardElement = document.querySelector<HTMLElement>(".kb-board");
		if (!boardElement) {
			return null;
		}
		for (const element of boardElement.querySelectorAll<HTMLElement>("[data-task-id]")) {
			if (element.dataset.taskId === taskId) {
				return element;
			}
		}
		return null;
	}, []);

	const waitForBacklogCardHeightToSettle = useCallback(
		async (taskId: string): Promise<void> => {
			if (!getPrimaryBoardTaskElement(taskId)) {
				return;
			}

			await new Promise<void>((resolve) => {
				let previousHeight = 0;
				let stableFrameCount = 0;
				let framesRemaining = 8;

				const measure = () => {
					const cardElement = getPrimaryBoardTaskElement(taskId);
					const nextHeight = cardElement?.getBoundingClientRect().height ?? 0;
					if (nextHeight > 0 && previousHeight > 0 && Math.abs(nextHeight - previousHeight) < 0.5) {
						stableFrameCount += 1;
					} else {
						stableFrameCount = 0;
					}
					previousHeight = nextHeight;

					if (stableFrameCount >= 1 || framesRemaining <= 0) {
						resolve();
						return;
					}

					framesRemaining -= 1;
					window.requestAnimationFrame(measure);
				};

				window.requestAnimationFrame(measure);
			});
		},
		[getPrimaryBoardTaskElement],
	);

	const setTaskMoveToTrashLoading = useCallback((taskId: string, isLoading: boolean) => {
		if (isLoading) {
			moveToTrashLoadingByIdRef.current[taskId] = true;
			setMoveToTrashLoadingById((current) => {
				if (current[taskId]) {
					return current;
				}
				return {
					...current,
					[taskId]: true,
				};
			});
			return;
		}

		delete moveToTrashLoadingByIdRef.current[taskId];
		setMoveToTrashLoadingById((current) => {
			if (!current[taskId]) {
				return current;
			}
			const next = { ...current };
			delete next[taskId];
			return next;
		});
	}, []);

	const handleAddReviewComments = useCallback(
		async (taskId: string, text: string) => {
			const typed = await sendTaskSessionInput(taskId, text, { appendNewline: false, mode: "paste" });
			if (!typed.ok) {
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					message: typed.message ?? "Could not add review comments to the task session.",
					timeout: 7000,
				});
			}
		},
		[sendTaskSessionInput],
	);

	const handleSendReviewComments = useCallback(
		async (taskId: string, text: string) => {
			const typed = await sendTaskSessionInput(taskId, text, { appendNewline: false, mode: "paste" });
			if (!typed.ok) {
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					message: typed.message ?? "Could not send review comments to the task session.",
					timeout: 7000,
				});
				return;
			}
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 200);
			});
			const submitted = await sendTaskSessionInput(taskId, "\r", { appendNewline: false });
			if (!submitted.ok) {
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					message: submitted.message ?? "Could not submit review comments to the task session.",
					timeout: 7000,
				});
			}
		},
		[sendTaskSessionInput],
	);

	const trashTaskIds = useMemo(() => {
		const trashColumn = board.columns.find((column) => column.id === "trash");
		return trashColumn ? trashColumn.cards.map((card) => card.id) : [];
	}, [board.columns]);
	const trashTaskCount = trashTaskIds.length;

	const maybeRequestNotificationPermissionForTaskStart = useCallback(() => {
		const shouldPromptForNotificationPermission =
			readyForReviewNotificationsEnabled &&
			getBrowserNotificationPermission() === "default" &&
			!hasPromptedForBrowserNotificationPermission() &&
			!notificationPermissionPromptInFlightRef.current;
		if (!shouldPromptForNotificationPermission) {
			return;
		}
		notificationPermissionPromptInFlightRef.current = true;
		void requestBrowserNotificationPermission().finally(() => {
			notificationPermissionPromptInFlightRef.current = false;
		});
	}, [readyForReviewNotificationsEnabled]);

	const kickoffTaskInProgress = useCallback(
		async (
			task: BoardCard,
			taskId: string,
			fromColumnId: BoardColumnId,
			options?: { optimisticMove?: boolean },
		): Promise<boolean> => {
			const optimisticMove = options?.optimisticMove ?? true;
			if (fromColumnId === "backlog") {
				const blockingTaskIds = getBlockingDependencyTaskIds(board, taskId);
				if (blockingTaskIds.length > 0) {
					notifyError(
						`Task "${taskId}" is blocked by unfinished dependency task${blockingTaskIds.length === 1 ? "" : "s"}: ${blockingTaskIds.join(", ")}.`,
					);
					return false;
				}
			}
			const ensured = await ensureTaskWorkspace(task);
			if (!ensured.ok) {
				notifyError(ensured.message ?? "Could not set up task workspace.");
				if (optimisticMove) {
					setBoard((currentBoard) => {
						const currentColumnId = getTaskColumnId(currentBoard, taskId);
						if (currentColumnId !== "in_progress") {
							return currentBoard;
						}
						const reverted = moveTaskToColumn(currentBoard, taskId, fromColumnId);
						return reverted.moved ? reverted.board : currentBoard;
					});
				}
				return false;
			}
			if (ensured.response?.warning) {
				showAppToast({
					intent: "warning",
					icon: "warning-sign",
					message: ensured.response.warning,
					timeout: 7000,
				});
			}
			if (selectedTaskId === taskId) {
				if (ensured.response) {
					setTaskWorkspaceInfo({
						taskId,
						path: ensured.response.path,
						exists: true,
						baseRef: ensured.response.baseRef,
						branch: null,
						isDetached: true,
						headCommit: ensured.response.baseCommit,
					});
				}
				const infoAfterEnsure = await fetchTaskWorkspaceInfo(task);
				if (infoAfterEnsure) {
					setTaskWorkspaceInfo(infoAfterEnsure);
				}
			}
			let processLaunch: ReturnType<typeof buildProcessStageLaunchTask>;
			try {
				processLaunch = buildProcessStageLaunchTask(task, board, workspacePath, kanbanCommand);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notifyError(message);
				setBoard((currentBoard) => {
					let nextBoard = currentBoard;
					if (task.process) {
						const failedLaunchProcess = appendTaskProcessHistory(
							{
								...task.process,
								status: "ready",
							},
							{
								agent: "kanban",
								notes: `Stage handoff failed: ${message}`,
							},
						);
						const updated = updateTaskProcess(nextBoard, taskId, failedLaunchProcess);
						nextBoard = updated.updated ? updated.board : nextBoard;
					}
					if (optimisticMove && getTaskColumnId(nextBoard, taskId) === "in_progress") {
						const reverted = moveTaskToColumn(nextBoard, taskId, fromColumnId);
						nextBoard = reverted.moved ? reverted.board : nextBoard;
					}
					return nextBoard;
				});
				return false;
			}
			const taskForSession = processLaunch?.task ?? task;
			if (processLaunch?.process) {
				setBoard((currentBoard) => {
					const updated = updateTaskProcess(currentBoard, taskId, processLaunch.process);
					return updated.updated ? updated.board : currentBoard;
				});
			}
			const started = processLaunch
				? await startTaskSession(taskForSession, { replaceActive: true })
				: await startTaskSession(taskForSession);
			if (!started.ok) {
				notifyError(started.message ?? "Could not start task session.");
				if (processLaunch) {
					const failedLaunchProcess = appendTaskProcessHistory(
						{
							...processLaunch.process,
							status: "ready",
						},
						{
							agent: "kanban",
							notes: started.message?.trim()
								? `Stage handoff failed: ${started.message.trim()}`
								: "Stage handoff failed: Could not start task session.",
						},
					);
					setBoard((currentBoard) => {
						const updated = updateTaskProcess(currentBoard, taskId, failedLaunchProcess);
						return updated.updated ? updated.board : currentBoard;
					});
				}
				if (optimisticMove) {
					setBoard((currentBoard) => {
						const currentColumnId = getTaskColumnId(currentBoard, taskId);
						if (currentColumnId !== "in_progress") {
							return currentBoard;
						}
						const reverted = moveTaskToColumn(currentBoard, taskId, fromColumnId);
						return reverted.moved ? reverted.board : currentBoard;
					});
				}
				return false;
			}
			if (!optimisticMove) {
				setBoard((currentBoard) => {
					const currentColumnId = getTaskColumnId(currentBoard, taskId);
					if (currentColumnId !== fromColumnId) {
						return currentBoard;
					}
					const moved = moveTaskToColumn(currentBoard, taskId, "in_progress", { insertAtTop: true });
					return moved.moved ? moved.board : currentBoard;
				});
			}
			return true;
		},
		[
			board,
			ensureTaskWorkspace,
			fetchTaskWorkspaceInfo,
			kanbanCommand,
			selectedTaskId,
			sessions,
			setBoard,
			startTaskSession,
			stopTaskSession,
			workspacePath,
		],
	);

	const startBacklogTaskImmediately = useCallback(
		async (task: BoardCard): Promise<boolean> => {
			const selection = findCardSelection(board, task.id);
			if (!selection || selection.column.id !== "backlog") {
				return false;
			}
			const blockingTaskIds = getBlockingDependencyTaskIds(board, task.id);
			if (blockingTaskIds.length > 0) {
				notifyError(
					`Task "${task.id}" is blocked by unfinished dependency task${blockingTaskIds.length === 1 ? "" : "s"}: ${blockingTaskIds.join(", ")}.`,
				);
				return false;
			}

			setBoard((currentBoard) => {
				const currentSelection = findCardSelection(currentBoard, task.id);
				if (!currentSelection || currentSelection.column.id !== "backlog") {
					return currentBoard;
				}
				const moved = moveTaskToColumn(currentBoard, task.id, "in_progress", { insertAtTop: true });
				return moved.moved ? moved.board : currentBoard;
			});

			return kickoffTaskInProgress(task, task.id, "backlog", {
				optimisticMove: true,
			});
		},
		[board, kickoffTaskInProgress, setBoard],
	);

	const startBacklogTaskWithAnimation = useCallback(
		async (task: BoardCard): Promise<boolean> => {
			if (selectedCard) {
				return startBacklogTaskImmediately(task);
			}
			const blockingTaskIds = getBlockingDependencyTaskIds(board, task.id);
			if (blockingTaskIds.length > 0) {
				notifyError(
					`Task "${task.id}" is blocked by unfinished dependency task${blockingTaskIds.length === 1 ? "" : "s"}: ${blockingTaskIds.join(", ")}.`,
				);
				return false;
			}

			await waitForBacklogCardHeightToSettle(task.id);

			const programmaticMoveAttempt = tryProgrammaticCardMove(task.id, "backlog", "in_progress");
			if (programmaticMoveAttempt === "blocked") {
				await waitForProgrammaticCardMoveAvailability();
				return startBacklogTaskWithAnimation(task);
			}
			if (programmaticMoveAttempt === "unavailable") {
				return kickoffTaskInProgress(task, task.id, "backlog", {
					optimisticMove: false,
				});
			}

			let resolveCompletion: ((started: boolean) => void) | null = null;
			const completionPromise = new Promise<boolean>((resolve) => {
				resolveCompletion = resolve;
			});
			const timeoutId = window.setTimeout(() => {
				resolvePendingProgrammaticStartMove(task.id, false);
			}, 5000);
			pendingProgrammaticStartMoveCompletionByTaskIdRef.current[task.id] = {
				resolve: (started) => {
					resolveCompletion?.(started);
					resolveCompletion = null;
				},
				timeoutId,
			};
			return completionPromise;
		},
		[
			board,
			kickoffTaskInProgress,
			resolvePendingProgrammaticStartMove,
			selectedCard,
			startBacklogTaskImmediately,
			tryProgrammaticCardMove,
			waitForBacklogCardHeightToSettle,
			waitForProgrammaticCardMoveAvailability,
		],
	);

	useEffect(() => {
		setBoard((currentBoard) => {
			let nextBoard = currentBoard;
			const previousSessions = previousSessionsRef.current;
			const blockedInterruptedTaskIds = new Set<string>();
			for (const summary of Object.values(sessions)) {
				const previous = previousSessions[summary.taskId];
				if (previous && previous.updatedAt > summary.updatedAt) {
					continue;
				}
				const selection = findCardSelection(nextBoard, summary.taskId);
				const columnId = selection?.column.id ?? null;
				if (summary.state === "awaiting_review" && columnId === "in_progress") {
					if (!selection?.card.process) {
						const programmaticMoveAttempt = tryProgrammaticCardMove(summary.taskId, columnId, "review");
						if (programmaticMoveAttempt === "started" || programmaticMoveAttempt === "blocked") {
							continue;
						}
					}
					const moved = moveTaskToColumn(nextBoard, summary.taskId, "review", { insertAtTop: true });
					if (moved.moved) {
						nextBoard = moved.board;
					}
					continue;
				}
				if (summary.state === "running" && columnId === "review") {
					if (!selection?.card.process) {
						const programmaticMoveAttempt = tryProgrammaticCardMove(summary.taskId, columnId, "in_progress", {
							skipKickoff: true,
						});
						if (programmaticMoveAttempt === "started" || programmaticMoveAttempt === "blocked") {
							continue;
						}
					}
					const moved = moveTaskToColumn(nextBoard, summary.taskId, "in_progress", { insertAtTop: true });
					if (moved.moved) {
						nextBoard = moved.board;
					}
					continue;
				}
				if (
					summary.state === "interrupted" &&
					previous?.state !== "interrupted" &&
					columnId &&
					columnId !== "trash"
				) {
					const nextTaskId = getNextDetailTaskIdAfterTrashMove(nextBoard, summary.taskId);
					const programmaticMoveAttempt = tryProgrammaticCardMove(summary.taskId, columnId, "trash", {
						skipTrashWorkflow: true,
					});
					if (programmaticMoveAttempt === "started" || programmaticMoveAttempt === "blocked") {
						if (programmaticMoveAttempt === "blocked") {
							blockedInterruptedTaskIds.add(summary.taskId);
						}
						setSelectedTaskId((currentSelectedTaskId) =>
							currentSelectedTaskId === summary.taskId ? nextTaskId : currentSelectedTaskId,
						);
						continue;
					}
					const moved = moveTaskToColumn(nextBoard, summary.taskId, "trash", { insertAtTop: true });
					if (moved.moved) {
						setSelectedTaskId((currentSelectedTaskId) =>
							currentSelectedTaskId === summary.taskId ? nextTaskId : currentSelectedTaskId,
						);
						nextBoard = moved.board;
					}
				}
			}
			const nextPreviousSessions = { ...sessions };
			for (const taskId of blockedInterruptedTaskIds) {
				const previousSession = previousSessions[taskId];
				if (previousSession) {
					nextPreviousSessions[taskId] = previousSession;
					continue;
				}
				delete nextPreviousSessions[taskId];
			}
			previousSessionsRef.current = nextPreviousSessions;
			return nextBoard;
		});
	}, [programmaticCardMoveCycle, sessions, setBoard, setSelectedTaskId, tryProgrammaticCardMove]);

	const { confirmMoveTaskToTrash, handleCreateDependency, handleDeleteDependency, requestMoveTaskToTrash } =
		useLinkedBacklogTaskActions({
			board,
			setBoard,
			setSelectedTaskId,
			stopTaskSession,
			cleanupTaskWorkspace,
			maybeRequestNotificationPermissionForTaskStart,
			kickoffTaskInProgress,
			startBacklogTaskWithAnimation,
			waitForBacklogStartAnimationAvailability: waitForProgrammaticCardMoveAvailability,
		});

	useEffect(() => {
		setRequestMoveTaskToTrashHandler(requestMoveTaskToTrash);
	}, [requestMoveTaskToTrash, setRequestMoveTaskToTrashHandler]);

	useReviewAutoActions({
		board,
		taskGitActionLoadingByTaskId,
		runAutoReviewGitAction,
		requestMoveTaskToTrash: requestMoveTaskToTrashWithAnimation,
		resetKey: currentProjectId,
	});

	const resumeTaskFromTrash = useCallback(
		async (task: BoardCard, taskId: string, options?: { optimisticMoveApplied?: boolean }): Promise<void> => {
			const ensured = await ensureTaskWorkspace(task);
			if (!ensured.ok) {
				notifyError(ensured.message ?? "Could not set up task workspace.");
				if (!options?.optimisticMoveApplied) {
					return;
				}
				setBoard((currentBoard) => {
					const currentColumnId = getTaskColumnId(currentBoard, taskId);
					if (currentColumnId !== "review") {
						return currentBoard;
					}
					const reverted = moveTaskToColumn(currentBoard, taskId, "trash", {
						insertAtTop: true,
					});
					return reverted.moved ? reverted.board : currentBoard;
				});
				return;
			}
			if (ensured.response?.warning) {
				showAppToast({
					intent: "warning",
					icon: "warning-sign",
					message: ensured.response.warning,
					timeout: 7000,
				});
			}
			const resumed = await startTaskSession(task, { resumeFromTrash: true });
			if (resumed.ok) {
				setBoard((currentBoard) => {
					const disabledAutoReview = disableTaskAutoReview(currentBoard, taskId);
					return disabledAutoReview.updated ? disabledAutoReview.board : currentBoard;
				});
				return;
			}

			notifyError(resumed.message ?? "Could not resume task session.");
			if (!options?.optimisticMoveApplied) {
				return;
			}
			setBoard((currentBoard) => {
				const currentColumnId = getTaskColumnId(currentBoard, taskId);
				if (currentColumnId !== "review") {
					return currentBoard;
				}
				const reverted = moveTaskToColumn(currentBoard, taskId, "trash", {
					insertAtTop: true,
				});
				return reverted.moved ? reverted.board : currentBoard;
			});
		},
		[ensureTaskWorkspace, setBoard, startTaskSession],
	);

	const handleDragEnd = useCallback(
		(result: DropResult, options?: { selectDroppedTask?: boolean }) => {
			if (options?.selectDroppedTask && result.type.startsWith("CARD") && result.destination) {
				setSelectedTaskId(result.draggableId);
			}
			const { behavior: programmaticMoveBehavior, programmaticCardMoveInFlight } = consumeProgrammaticCardMove(
				result.draggableId,
			);
			if (
				result.type.startsWith("CARD") &&
				result.destination?.droppableId === "in_progress" &&
				result.source.droppableId === "backlog"
			) {
				const blockingTaskIds = getBlockingDependencyTaskIds(board, result.draggableId);
				if (blockingTaskIds.length > 0) {
					notifyError(
						`Task "${result.draggableId}" is blocked by unfinished dependency task${blockingTaskIds.length === 1 ? "" : "s"}: ${blockingTaskIds.join(", ")}.`,
					);
					resolvePendingProgrammaticStartMove(result.draggableId, false);
					return;
				}
			}

			const applied = applyDragResult(board, result, { programmaticCardMoveInFlight });

			const moveEvent = applied.moveEvent;
			if (!moveEvent) {
				resolvePendingProgrammaticStartMove(result.draggableId, false);
				setBoard(applied.board);
				return;
			}

			if (moveEvent.toColumnId === "trash") {
				setBoard(applied.board);
				if (programmaticMoveBehavior?.skipTrashWorkflow) {
					resolvePendingProgrammaticTrashMove(moveEvent.taskId);
					return;
				}
				const requestPromise = requestMoveTaskToTrash(moveEvent.taskId, moveEvent.fromColumnId, {
					optimisticMoveApplied: true,
					skipWorkingChangeWarning: programmaticMoveBehavior?.skipWorkingChangeWarning,
				});
				void requestPromise.finally(() => {
					resolvePendingProgrammaticTrashMove(moveEvent.taskId);
				});
				return;
			}

			if (moveEvent.fromColumnId === "trash" && moveEvent.toColumnId === "review") {
				setBoard(applied.board);
				const movedSelection = findCardSelection(applied.board, moveEvent.taskId);
				if (!movedSelection) {
					return;
				}
				void resumeTaskFromTrash(movedSelection.card, moveEvent.taskId, { optimisticMoveApplied: true });
				return;
			}

			setBoard(applied.board);

			if (
				moveEvent.toColumnId === "in_progress" &&
				moveEvent.fromColumnId === "backlog" &&
				!programmaticMoveBehavior?.skipKickoff
			) {
				maybeRequestNotificationPermissionForTaskStart();
				const movedSelection = findCardSelection(applied.board, moveEvent.taskId);
				if (movedSelection) {
					void kickoffTaskInProgress(movedSelection.card, moveEvent.taskId, moveEvent.fromColumnId)
						.then((started) => {
							resolvePendingProgrammaticStartMove(moveEvent.taskId, started);
						})
						.catch(() => {
							resolvePendingProgrammaticStartMove(moveEvent.taskId, false);
						});
					return;
				}
				resolvePendingProgrammaticStartMove(moveEvent.taskId, false);
				return;
			}
			resolvePendingProgrammaticStartMove(moveEvent.taskId, false);
		},
		[
			board,
			consumeProgrammaticCardMove,
			kickoffTaskInProgress,
			maybeRequestNotificationPermissionForTaskStart,
			requestMoveTaskToTrash,
			resumeTaskFromTrash,
			resolvePendingProgrammaticStartMove,
			resolvePendingProgrammaticTrashMove,
			setBoard,
			setSelectedTaskId,
		],
	);

	const handleStartTask = useCallback(
		(taskId: string) => {
			const selection = findCardSelection(board, taskId);
			if (!selection || selection.column.id !== "backlog") {
				return;
			}
			maybeRequestNotificationPermissionForTaskStart();
			void startBacklogTaskWithAnimation(selection.card);
		},
		[board, maybeRequestNotificationPermissionForTaskStart, startBacklogTaskWithAnimation],
	);

	const handleRunTaskProcessStage = useCallback(
		async (taskId: string): Promise<boolean> => {
			const selection = findCardSelection(board, taskId);
			if (!selection || selection.column.id === "trash") {
				return false;
			}
			if (!selection.card.process || selection.card.process.status !== "ready") {
				return false;
			}
			maybeRequestNotificationPermissionForTaskStart();
			if (selection.column.id === "backlog") {
				return await startBacklogTaskImmediately(selection.card);
			}
			return await kickoffTaskInProgress(selection.card, taskId, selection.column.id, {
				optimisticMove: false,
			});
		},
		[board, kickoffTaskInProgress, maybeRequestNotificationPermissionForTaskStart, startBacklogTaskImmediately],
	);

	const handleRunReadyTaskProcessStages = useCallback(
		(taskIds?: string[]) => {
			const requestedTaskIds =
				taskIds ??
				board.columns.flatMap((column) =>
					column.cards.filter((card) => card.process?.status === "ready").map((card) => card.id),
				);
			if (requestedTaskIds.length === 0) {
				return;
			}

			let nextBoard = board;
			const pendingStarts: Array<{
				task: BoardCard;
				taskId: string;
				fromColumnId: BoardColumnId;
				optimisticMove: boolean;
			}> = [];
			const startedTaskIds = new Set<string>();
			let blockedTaskCount = 0;

			for (const taskId of requestedTaskIds) {
				if (!taskId || startedTaskIds.has(taskId)) {
					continue;
				}
				const selection = findCardSelection(nextBoard, taskId);
				if (!selection || selection.column.id === "trash") {
					continue;
				}
				if (!selection.card.process || selection.card.process.status !== "ready") {
					continue;
				}
				if (getBlockingDependencyTaskIds(nextBoard, taskId).length > 0) {
					blockedTaskCount += 1;
					continue;
				}
				if (selection.column.id === "backlog") {
					const moved = moveTaskToColumn(nextBoard, taskId, "in_progress", { insertAtTop: true });
					if (!moved.moved) {
						continue;
					}
					nextBoard = moved.board;
					const movedSelection = findCardSelection(nextBoard, taskId);
					if (!movedSelection) {
						continue;
					}
					pendingStarts.push({
						task: movedSelection.card,
						taskId,
						fromColumnId: "backlog",
						optimisticMove: true,
					});
					startedTaskIds.add(taskId);
					continue;
				}
				pendingStarts.push({
					task: selection.card,
					taskId,
					fromColumnId: selection.column.id,
					optimisticMove: false,
				});
				startedTaskIds.add(taskId);
			}

			if (pendingStarts.length === 0) {
				if (blockedTaskCount > 0) {
					showAppToast({
						intent: "warning",
						icon: "warning-sign",
						message: `${blockedTaskCount} process task${blockedTaskCount === 1 ? " is" : "s are"} blocked by dependencies.`,
						timeout: 5000,
					});
				}
				return;
			}

			if (nextBoard !== board) {
				setBoard(nextBoard);
			}
			if (blockedTaskCount > 0) {
				showAppToast({
					intent: "warning",
					icon: "warning-sign",
					message: `${blockedTaskCount} process task${blockedTaskCount === 1 ? " was" : "s were"} skipped because of dependencies.`,
					timeout: 5000,
				});
			}
			maybeRequestNotificationPermissionForTaskStart();
			for (const pendingStart of pendingStarts) {
				void kickoffTaskInProgress(pendingStart.task, pendingStart.taskId, pendingStart.fromColumnId, {
					optimisticMove: pendingStart.optimisticMove,
				});
			}
		},
		[board, kickoffTaskInProgress, maybeRequestNotificationPermissionForTaskStart, setBoard],
	);

	const handleStartAllBacklogTasks = useCallback(
		(taskIds?: string[]) => {
			const requestedTaskIds =
				taskIds ?? board.columns.find((column) => column.id === "backlog")?.cards.map((card) => card.id) ?? [];
			if (requestedTaskIds.length === 0) {
				return;
			}

			let nextBoard = board;
			const pendingStarts: BoardCard[] = [];
			const startedTaskIds = new Set<string>();
			let blockedTaskCount = 0;

			for (const taskId of requestedTaskIds) {
				if (!taskId || startedTaskIds.has(taskId)) {
					continue;
				}
				const selection = findCardSelection(nextBoard, taskId);
				if (!selection || selection.column.id !== "backlog") {
					continue;
				}
				if (getBlockingDependencyTaskIds(nextBoard, taskId).length > 0) {
					blockedTaskCount += 1;
					continue;
				}
				const moved = moveTaskToColumn(nextBoard, taskId, "in_progress", { insertAtTop: true });
				if (!moved.moved) {
					continue;
				}
				nextBoard = moved.board;
				const movedSelection = findCardSelection(nextBoard, taskId);
				if (!movedSelection) {
					continue;
				}
				pendingStarts.push(movedSelection.card);
				startedTaskIds.add(taskId);
			}

			if (pendingStarts.length === 0) {
				if (blockedTaskCount > 0) {
					showAppToast({
						intent: "warning",
						icon: "warning-sign",
						message: `${blockedTaskCount} backlog task${blockedTaskCount === 1 ? " is" : "s are"} blocked by dependencies.`,
						timeout: 5000,
					});
				}
				return;
			}

			setBoard(nextBoard);
			if (blockedTaskCount > 0) {
				showAppToast({
					intent: "warning",
					icon: "warning-sign",
					message: `${blockedTaskCount} backlog task${blockedTaskCount === 1 ? " was" : "s were"} skipped because of dependencies.`,
					timeout: 5000,
				});
			}
			maybeRequestNotificationPermissionForTaskStart();
			for (const task of pendingStarts) {
				void kickoffTaskInProgress(task, task.id, "backlog");
			}
		},
		[board, kickoffTaskInProgress, maybeRequestNotificationPermissionForTaskStart, setBoard],
	);

	const handleDetailTaskDragEnd = useCallback(
		(result: DropResult) => {
			handleDragEnd(result);
		},
		[handleDragEnd],
	);

	const handleCardSelect = useCallback(
		(taskId: string) => {
			const selection = findCardSelection(board, taskId);
			if (!selection || (selection.column.id === "trash" && !selection.card.process)) {
				return;
			}
			setSelectedTaskId(taskId);
			setIsGitHistoryOpen(false);
		},
		[board, setIsGitHistoryOpen, setSelectedTaskId],
	);

	const handleMoveToTrash = useCallback(() => {
		if (!selectedCard) {
			return;
		}
		if (moveToTrashLoadingByIdRef.current[selectedCard.card.id]) {
			return;
		}
		setTaskMoveToTrashLoading(selectedCard.card.id, true);
		void requestMoveTaskToTrashWithAnimation(selectedCard.card.id, selectedCard.column.id).finally(() => {
			setTaskMoveToTrashLoading(selectedCard.card.id, false);
		});
	}, [requestMoveTaskToTrashWithAnimation, selectedCard, setTaskMoveToTrashLoading]);

	const handleMoveReviewCardToTrash = useCallback(
		(taskId: string) => {
			if (moveToTrashLoadingByIdRef.current[taskId]) {
				return;
			}
			setTaskMoveToTrashLoading(taskId, true);
			void requestMoveTaskToTrashWithAnimation(taskId, "review").finally(() => {
				setTaskMoveToTrashLoading(taskId, false);
			});
		},
		[requestMoveTaskToTrashWithAnimation, setTaskMoveToTrashLoading],
	);

	const handleDeleteTask = useCallback(
		(taskId: string) => {
			const selection = findCardSelection(board, taskId);
			if (!selection) {
				return;
			}
			setBoard((currentBoard) => {
				const removed = removeTask(currentBoard, taskId);
				return removed.removed ? removed.board : currentBoard;
			});
			setSessions((currentSessions) => {
				if (!currentSessions[taskId]) {
					return currentSessions;
				}
				const nextSessions = { ...currentSessions };
				delete nextSessions[taskId];
				return nextSessions;
			});
			if (selectedTaskId === taskId) {
				setSelectedTaskId(null);
				clearTaskWorkspaceInfo(taskId);
			}
			void (async () => {
				await Promise.all([stopTaskSession(taskId), stopTaskSession(getDetailTerminalTaskId(taskId))]);
				await cleanupTaskWorkspace(taskId);
			})();
		},
		[board, cleanupTaskWorkspace, selectedTaskId, setBoard, setSelectedTaskId, setSessions, stopTaskSession],
	);

	const handleRestoreTaskFromTrash = useCallback(
		(taskId: string) => {
			const selection = findCardSelection(board, taskId);
			if (!selection || selection.column.id !== "trash") {
				return;
			}
			if (selection.card.process?.status === "complete") {
				setSelectedTaskId(taskId);
				return;
			}
			const programmaticMoveAttempt = tryProgrammaticCardMove(taskId, "trash", "review");
			if (programmaticMoveAttempt === "started" || programmaticMoveAttempt === "blocked") {
				return;
			}

			const moved = moveTaskToColumn(board, taskId, "review", { insertAtTop: true });
			if (!moved.moved) {
				return;
			}
			setBoard(moved.board);
			const movedSelection = findCardSelection(moved.board, taskId);
			if (!movedSelection) {
				return;
			}
			void resumeTaskFromTrash(movedSelection.card, taskId, { optimisticMoveApplied: true });
		},
		[board, resumeTaskFromTrash, setBoard, setSelectedTaskId, tryProgrammaticCardMove],
	);

	const handleCancelAutomaticTaskAction = useCallback(
		(taskId: string) => {
			setBoard((currentBoard) => {
				const selection = findCardSelection(currentBoard, taskId);
				if (!selection || selection.card.autoReviewEnabled !== true) {
					return currentBoard;
				}
				const updated = updateTask(currentBoard, taskId, {
					prompt: selection.card.prompt,
					startInPlanMode: selection.card.startInPlanMode,
					autoReviewEnabled: false,
					autoReviewMode: resolveTaskAutoReviewMode(selection.card.autoReviewMode),
					images: selection.card.images,
					agentId: selection.card.agentId,
					clineSettings: selection.card.clineSettings,
					baseRef: selection.card.baseRef,
				});
				return updated.updated ? updated.board : currentBoard;
			});
		},
		[setBoard],
	);

	const handleOpenClearTrash = useCallback(() => {
		if (trashTaskCount === 0) {
			return;
		}
		setIsClearTrashDialogOpen(true);
	}, [setIsClearTrashDialogOpen, trashTaskCount]);

	const handleConfirmClearTrash = useCallback(() => {
		const taskIds = [...trashTaskIds];
		setIsClearTrashDialogOpen(false);
		if (taskIds.length === 0) {
			return;
		}

		setBoard((currentBoard) => clearColumnTasks(currentBoard, "trash").board);
		setSessions((currentSessions) => {
			const nextSessions = { ...currentSessions };
			for (const taskId of taskIds) {
				delete nextSessions[taskId];
			}
			return nextSessions;
		});
		if (selectedTaskId && taskIds.includes(selectedTaskId)) {
			setSelectedTaskId(null);
			clearTaskWorkspaceInfo(selectedTaskId);
		}

		void (async () => {
			await Promise.all(
				taskIds.map(async (taskId) => {
					await stopTaskSession(taskId);
					await cleanupTaskWorkspace(taskId);
				}),
			);
		})();
	}, [
		cleanupTaskWorkspace,
		selectedTaskId,
		setBoard,
		setIsClearTrashDialogOpen,
		setSelectedTaskId,
		setSessions,
		stopTaskSession,
		trashTaskIds,
	]);

	const resetBoardInteractionsState = useCallback(() => {
		previousSessionsRef.current = {};
		moveToTrashLoadingByIdRef.current = {};
		setMoveToTrashLoadingById({});
		for (const taskId of Object.keys(pendingProgrammaticStartMoveCompletionByTaskIdRef.current)) {
			resolvePendingProgrammaticStartMove(taskId, false);
		}
		resetProgrammaticCardMoves();
		setIsClearTrashDialogOpen(false);
	}, [resetProgrammaticCardMoves, resolvePendingProgrammaticStartMove, setIsClearTrashDialogOpen]);

	useEffect(() => {
		resetBoardInteractionsState();
	}, [currentProjectId, resetBoardInteractionsState]);

	return {
		handleProgrammaticCardMoveReady,
		confirmMoveTaskToTrash,
		handleCreateDependency,
		handleDeleteDependency,
		handleDragEnd,
		handleStartTask,
		handleStartAllBacklogTasks,
		handleRunTaskProcessStage,
		handleRunReadyTaskProcessStages,
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
	};
}
