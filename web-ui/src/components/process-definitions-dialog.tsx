import { getRuntimeLaunchSupportedAgentCatalog } from "@runtime-agent-catalog";
import {
	getTaskProcessDefinitions,
	parseTaskProcessDefinitionInput,
	parseTaskProcessDefinitionsJson,
} from "@runtime-task-process";
import { ArrowDown, ArrowUp, Braces, Copy, Download, FileJson, Plus, Save, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import type {
	RuntimeAgentId,
	RuntimeTaskProcessConditionalTransition,
	RuntimeTaskProcessConditionPath,
	RuntimeTaskProcessVerdict,
} from "@/runtime/types";
import type { TaskProcessDefinition } from "@/types";

function toProcessId(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function nextCustomId(existingIds: Set<string>, base = "custom-process"): string {
	const normalizedBase = toProcessId(base) || "custom-process";
	if (!existingIds.has(normalizedBase)) {
		return normalizedBase;
	}
	let index = 2;
	while (existingIds.has(`${normalizedBase}-${index}`)) {
		index += 1;
	}
	return `${normalizedBase}-${index}`;
}

function createCustomDefinition(existingIds: Set<string>): TaskProcessDefinition {
	const id = nextCustomId(existingIds);
	return {
		schemaVersion: 1,
		id,
		name: "Custom Process",
		initial: "pending",
		states: {
			pending: { label: "Pending", on: { pass: "swe" } },
			swe: {
				label: "SWE",
				role: "swe",
				agentId: "codex",
				prompt: "Implement the Kanban item, record evidence, then pass or fail this stage.",
				on: { fail: "pending", pass: "done" },
			},
			done: { label: "Done", terminal: true, on: {} },
		},
	};
}

function cloneDefinition(definition: TaskProcessDefinition): TaskProcessDefinition {
	return {
		...definition,
		states: Object.fromEntries(
			Object.entries(definition.states).map(([stageId, stage]) => [
				stageId,
				{
					...stage,
					on: { ...stage.on },
					...(stage.conditions
						? {
								conditions: stage.conditions.map((condition) => ({ ...condition })),
							}
						: {}),
				},
			]),
		),
	};
}

function formatConditionalEdge(condition: RuntimeTaskProcessConditionalTransition): string {
	const matcher =
		condition.equals !== undefined
			? `${condition.path} equals "${condition.equals}"`
			: `${condition.path} contains "${condition.contains ?? ""}"`;
	const label = condition.label?.trim() ? ` (${condition.label.trim()})` : "";
	return `${condition.verdict} when ${matcher} -> ${condition.target}${label}`;
}

function duplicateDefinition(definition: TaskProcessDefinition, existingIds: Set<string>): TaskProcessDefinition {
	const id = nextCustomId(existingIds, definition.id);
	return {
		...cloneDefinition(definition),
		id,
		name: `${definition.name} Copy`,
	};
}

function FieldLabel({ children }: { children: React.ReactNode }): React.ReactElement {
	return <span className="mb-1 block text-[11px] font-medium text-text-secondary">{children}</span>;
}

function textInputClassName(extra?: string): string {
	return cn(
		"h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-xs text-text-primary placeholder:text-text-tertiary outline-none focus:border-border-focus",
		extra,
	);
}

function selectClassName(extra?: string): string {
	return cn(
		"h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-xs text-text-primary outline-none focus:border-border-focus",
		extra,
	);
}

interface ProcessRouteAnalysis {
	edgeLabels: string[];
	missingPromptStageIds: string[];
	noOutgoingStageIds: string[];
	promptableStageCount: number;
	promptedStageCount: number;
	reachableStageIds: Set<string>;
	terminalStageIds: string[];
	unreachableStageIds: string[];
}

function isPassiveDispatchStage(stage: TaskProcessDefinition["states"][string]): boolean {
	return (
		stage.terminal !== true &&
		!stage.prompt?.trim() &&
		!stage.role?.trim() &&
		stage.agentId === undefined &&
		(!stage.conditions || stage.conditions.length === 0) &&
		Boolean(stage.on.pass) &&
		!stage.on.fail
	);
}

function analyzeProcessRoute(definition: TaskProcessDefinition): ProcessRouteAnalysis {
	const stageIds = Object.keys(definition.states);
	const reachableStageIds = new Set<string>();
	const pendingStageIds = [definition.initial];
	for (const stageId of pendingStageIds) {
		if (reachableStageIds.has(stageId)) {
			continue;
		}
		const stage = definition.states[stageId];
		if (!stage) {
			continue;
		}
		reachableStageIds.add(stageId);
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
	const edgeLabels = stageIds.flatMap((stageId) => {
		const stage = definition.states[stageId];
		if (!stage || stage.terminal) {
			return [];
		}
		return [
			stage.on.pass ? `${stageId} pass -> ${stage.on.pass}` : null,
			stage.on.fail ? `${stageId} fail -> ${stage.on.fail}` : null,
			...(stage.conditions ?? []).map((condition) => `${stageId} ${formatConditionalEdge(condition)}`),
		].filter((edge): edge is string => Boolean(edge));
	});
	const terminalStageIds = stageIds.filter((stageId) => definition.states[stageId]?.terminal === true);
	const unreachableStageIds = stageIds.filter((stageId) => !reachableStageIds.has(stageId));
	const noOutgoingStageIds = stageIds.filter((stageId) => {
		const stage = definition.states[stageId];
		return (
			reachableStageIds.has(stageId) &&
			stage?.terminal !== true &&
			!stage?.on.pass &&
			!stage?.on.fail &&
			(stage?.conditions?.length ?? 0) === 0
		);
	});
	const promptableStageIds = stageIds.filter((stageId) => {
		const stage = definition.states[stageId];
		return Boolean(
			stage && reachableStageIds.has(stageId) && stage.terminal !== true && !isPassiveDispatchStage(stage),
		);
	});
	const promptedStageCount = promptableStageIds.filter((stageId) => {
		const stage = definition.states[stageId];
		return Boolean(stage?.prompt?.trim());
	}).length;
	const missingPromptStageIds = promptableStageIds.filter((stageId) => !definition.states[stageId]?.prompt?.trim());
	return {
		edgeLabels,
		missingPromptStageIds,
		noOutgoingStageIds,
		promptableStageCount: promptableStageIds.length,
		promptedStageCount,
		reachableStageIds,
		terminalStageIds,
		unreachableStageIds,
	};
}

function ProcessRoutePreview({
	definition,
	selectedStageId,
	usageCount,
}: {
	definition: TaskProcessDefinition;
	selectedStageId: string | null;
	usageCount: number;
}): React.ReactElement {
	const analysis = analyzeProcessRoute(definition);
	const stageIds = Object.keys(definition.states);
	const warningLabels = [
		analysis.unreachableStageIds.length ? `Unreachable: ${analysis.unreachableStageIds.join(", ")}` : null,
		analysis.noOutgoingStageIds.length ? `No edge: ${analysis.noOutgoingStageIds.join(", ")}` : null,
		analysis.missingPromptStageIds.length ? `Missing prompts: ${analysis.missingPromptStageIds.join(", ")}` : null,
		analysis.terminalStageIds.length === 0 ? "No terminal stage" : null,
	].filter((label): label is string => Boolean(label));
	return (
		<div className="mt-3 grid gap-2 rounded-md border border-border bg-surface-1 p-2">
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-[11px] font-semibold uppercase text-text-tertiary">Route Preview</span>
				<span className="rounded-sm border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text-tertiary">
					assigned cards {usageCount}
				</span>
				<span className="rounded-sm border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text-tertiary">
					prompts {analysis.promptedStageCount}/{analysis.promptableStageCount}
				</span>
				{analysis.terminalStageIds.map((stageId) => (
					<span
						key={stageId}
						className="rounded-sm border border-status-green/40 bg-status-green/10 px-1.5 py-0.5 font-mono text-[10px] text-status-green"
					>
						terminal {stageId}
					</span>
				))}
			</div>
			<div className="flex flex-wrap gap-1.5">
				{stageIds.map((stageId) => {
					const stage = definition.states[stageId];
					const isSelected = stageId === selectedStageId;
					const isReachable = analysis.reachableStageIds.has(stageId);
					return (
						<span
							key={stageId}
							className={cn(
								"rounded-sm border px-1.5 py-0.5 font-mono text-[10px]",
								isSelected
									? "border-accent/60 bg-accent/10 text-accent"
									: isReachable
										? "border-border-bright bg-surface-2 text-text-secondary"
										: "border-status-red/40 bg-status-red/10 text-status-red",
							)}
						>
							{stageId}
							{stage?.terminal ? " terminal" : ""}
						</span>
					);
				})}
			</div>
			{analysis.edgeLabels.length ? (
				<div className="flex flex-wrap gap-1.5">
					{analysis.edgeLabels.map((edge) => (
						<span
							key={edge}
							className="rounded-sm border border-border bg-surface-0 px-1.5 py-0.5 font-mono text-[10px] text-text-secondary"
						>
							{edge}
						</span>
					))}
				</div>
			) : null}
			{warningLabels.length ? (
				<div className="flex flex-wrap gap-1.5">
					{warningLabels.map((warning) => (
						<span
							key={warning}
							className="rounded-sm border border-status-orange/40 bg-status-orange/10 px-1.5 py-0.5 font-mono text-[10px] text-status-orange"
						>
							{warning}
						</span>
					))}
				</div>
			) : null}
		</div>
	);
}

function validateDefinitions(
	definitions: readonly TaskProcessDefinition[],
	options: { requirePrompts?: boolean } = {},
): string | null {
	const requirePrompts = options.requirePrompts ?? true;
	const ids = new Set<string>();
	for (const [index, definition] of definitions.entries()) {
		if (ids.has(definition.id)) {
			return `Duplicate process id "${definition.id}".`;
		}
		ids.add(definition.id);
		try {
			parseTaskProcessDefinitionInput(definition, `process[${index}]`);
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
		const routeAnalysis = analyzeProcessRoute(definition);
		if (routeAnalysis.terminalStageIds.length === 0) {
			return `Process "${definition.id}" must define at least one terminal stage.`;
		}
		if (routeAnalysis.noOutgoingStageIds.length > 0) {
			return `Process "${definition.id}" has reachable nonterminal stage(s) without pass/fail edges: ${routeAnalysis.noOutgoingStageIds.join(", ")}.`;
		}
		if (requirePrompts && routeAnalysis.missingPromptStageIds.length > 0) {
			return `Process "${definition.id}" must define prompt(s) for runnable stage(s): ${routeAnalysis.missingPromptStageIds.join(", ")}.`;
		}
	}
	return null;
}

function getMissingAssignedCustomProcessIds(
	definitions: readonly TaskProcessDefinition[],
	processUsageById: Record<string, number>,
): string[] {
	const builtInProcessIds = new Set(getTaskProcessDefinitions([]).map((definition) => definition.id));
	const definitionIds = new Set(definitions.map((definition) => definition.id));
	return Object.entries(processUsageById)
		.filter(([processId, count]) => count > 0 && !builtInProcessIds.has(processId) && !definitionIds.has(processId))
		.map(([processId]) => processId);
}

function renameStage(definition: TaskProcessDefinition, fromStageId: string, toStageId: string): TaskProcessDefinition {
	const nextStageId = toProcessId(toStageId);
	if (!nextStageId || nextStageId === fromStageId || definition.states[nextStageId]) {
		return definition;
	}
	const nextStates: TaskProcessDefinition["states"] = {};
	for (const [stageId, stage] of Object.entries(definition.states)) {
		const outputStageId = stageId === fromStageId ? nextStageId : stageId;
		nextStates[outputStageId] = {
			...stage,
			on: {
				pass: stage.on.pass === fromStageId ? nextStageId : stage.on.pass,
				fail: stage.on.fail === fromStageId ? nextStageId : stage.on.fail,
			},
			...(stage.conditions
				? {
						conditions: stage.conditions.map((condition) => ({
							...condition,
							target: condition.target === fromStageId ? nextStageId : condition.target,
						})),
					}
				: {}),
		};
	}
	return {
		...definition,
		initial: definition.initial === fromStageId ? nextStageId : definition.initial,
		states: nextStates,
	};
}

export function ProcessDefinitionsDialog({
	open,
	onOpenChange,
	processDefinitions,
	onProcessDefinitionsChange,
	processUsageById = {},
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	processDefinitions: TaskProcessDefinition[];
	onProcessDefinitionsChange: (definitions: TaskProcessDefinition[]) => void;
	processUsageById?: Record<string, number>;
}): React.ReactElement {
	const [draftDefinitions, setDraftDefinitions] = useState<TaskProcessDefinition[]>(() =>
		processDefinitions.map(cloneDefinition),
	);
	const [selectedProcessId, setSelectedProcessId] = useState<string | null>(null);
	const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
	const [isJsonEditorOpen, setIsJsonEditorOpen] = useState(false);
	const [isJsonReplaceEnabled, setIsJsonReplaceEnabled] = useState(false);
	const [jsonDraft, setJsonDraft] = useState("");
	const [error, setError] = useState<string | null>(null);
	const jsonFileInputRef = useRef<HTMLInputElement | null>(null);
	const allDefinitions = useMemo(() => getTaskProcessDefinitions(draftDefinitions), [draftDefinitions]);
	const processAgentOptions = useMemo(
		() => getRuntimeLaunchSupportedAgentCatalog().map((agent) => ({ value: agent.id, label: agent.label })),
		[],
	);
	const customProcessIds = useMemo(
		() => new Set(draftDefinitions.map((definition) => definition.id)),
		[draftDefinitions],
	);
	const allProcessIds = useMemo(() => new Set(allDefinitions.map((definition) => definition.id)), [allDefinitions]);
	const selectedDefinition =
		allDefinitions.find((definition) => definition.id === selectedProcessId) ?? allDefinitions[0] ?? null;
	const selectedIsCustom = Boolean(selectedDefinition && customProcessIds.has(selectedDefinition.id));
	const selectedCustomDefinition = selectedIsCustom
		? (draftDefinitions.find((definition) => definition.id === selectedDefinition?.id) ?? null)
		: null;
	const selectedStageIds = selectedDefinition ? Object.keys(selectedDefinition.states) : [];
	const selectedStage =
		selectedDefinition && selectedStageId
			? selectedDefinition.states[selectedStageId]
			: selectedDefinition
				? selectedDefinition.states[selectedDefinition.initial]
				: null;
	const effectiveSelectedStageId =
		selectedDefinition && selectedStage
			? selectedStageId && selectedDefinition.states[selectedStageId]
				? selectedStageId
				: selectedDefinition.initial
			: null;
	const selectedProcessUsageCount = selectedDefinition ? (processUsageById[selectedDefinition.id] ?? 0) : 0;

	useEffect(() => {
		if (!open) {
			return;
		}
		const nextDrafts = processDefinitions.map(cloneDefinition);
		setDraftDefinitions(nextDrafts);
		setSelectedProcessId(nextDrafts[0]?.id ?? "sdd");
		setSelectedStageId(null);
		setIsJsonEditorOpen(false);
		setIsJsonReplaceEnabled(false);
		setJsonDraft("");
		setError(null);
	}, [open, processDefinitions]);

	useEffect(() => {
		if (!selectedDefinition) {
			setSelectedStageId(null);
			return;
		}
		if (selectedStageId && selectedDefinition.states[selectedStageId]) {
			return;
		}
		setSelectedStageId(selectedDefinition.initial);
	}, [selectedDefinition, selectedStageId]);

	const updateSelectedCustomDefinition = (updater: (definition: TaskProcessDefinition) => TaskProcessDefinition) => {
		if (!selectedCustomDefinition) {
			return;
		}
		setDraftDefinitions((current) =>
			current.map((definition) =>
				definition.id === selectedCustomDefinition.id ? updater(definition) : definition,
			),
		);
		setError(null);
	};

	const handleAddCustomProcess = () => {
		const nextDefinition = createCustomDefinition(allProcessIds);
		setDraftDefinitions((current) => [...current, nextDefinition]);
		setSelectedProcessId(nextDefinition.id);
		setSelectedStageId(nextDefinition.initial);
		setError(null);
	};

	const handleDuplicateSelected = () => {
		if (!selectedDefinition) {
			return;
		}
		const nextDefinition = duplicateDefinition(selectedDefinition, allProcessIds);
		setDraftDefinitions((current) => [...current, nextDefinition]);
		setSelectedProcessId(nextDefinition.id);
		setSelectedStageId(nextDefinition.initial);
		setError(null);
	};

	const handleDeleteSelected = () => {
		if (!selectedCustomDefinition) {
			return;
		}
		const assignedCount = processUsageById[selectedCustomDefinition.id] ?? 0;
		if (assignedCount > 0) {
			setError(
				`Process "${selectedCustomDefinition.id}" is assigned to ${assignedCount} task${assignedCount === 1 ? "" : "s"} and cannot be deleted.`,
			);
			return;
		}
		const nextDrafts = draftDefinitions.filter((definition) => definition.id !== selectedCustomDefinition.id);
		setDraftDefinitions(nextDrafts);
		setSelectedProcessId(nextDrafts[0]?.id ?? "sdd");
		setSelectedStageId(null);
		setError(null);
	};

	const handleExportSelectedJson = () => {
		if (!selectedDefinition) {
			return;
		}
		setJsonDraft(`${JSON.stringify(selectedDefinition, null, 2)}\n`);
		setIsJsonEditorOpen(true);
		setError(null);
	};

	const applyImportedDefinitions = (importedDefinitions: TaskProcessDefinition[]) => {
		const nextDefinitionsById = new Map<string, TaskProcessDefinition>();
		if (!isJsonReplaceEnabled) {
			for (const definition of draftDefinitions) {
				nextDefinitionsById.set(definition.id, definition);
			}
		}
		for (const importedDefinition of importedDefinitions) {
			nextDefinitionsById.set(importedDefinition.id, cloneDefinition(importedDefinition));
		}
		const nextDraftDefinitions = Array.from(nextDefinitionsById.values());
		const validationError = validateDefinitions(nextDraftDefinitions, { requirePrompts: false });
		if (validationError) {
			setError(validationError);
			return;
		}
		const missingAssignedProcessIds = getMissingAssignedCustomProcessIds(nextDraftDefinitions, processUsageById);
		if (missingAssignedProcessIds.length > 0) {
			setError(`Assigned processes cannot be removed: ${missingAssignedProcessIds.join(", ")}.`);
			return;
		}
		setDraftDefinitions(nextDraftDefinitions);
		setSelectedProcessId(importedDefinitions[0]?.id ?? nextDraftDefinitions[0]?.id ?? "sdd");
		setSelectedStageId(importedDefinitions[0]?.initial ?? null);
		setError(null);
	};

	const handleImportJson = () => {
		try {
			applyImportedDefinitions(parseTaskProcessDefinitionsJson(jsonDraft));
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		}
	};

	const handleImportJsonFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
		const file = event.currentTarget.files?.[0];
		event.currentTarget.value = "";
		if (!file) {
			return;
		}
		try {
			const nextJsonDraft = await file.text();
			setJsonDraft(nextJsonDraft);
			setIsJsonEditorOpen(true);
			applyImportedDefinitions(parseTaskProcessDefinitionsJson(nextJsonDraft));
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		}
	};

	const handleDownloadSelectedJson = () => {
		if (!selectedDefinition) {
			return;
		}
		const blob = new Blob([`${JSON.stringify(selectedDefinition, null, 2)}\n`], {
			type: "application/json",
		});
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = `${selectedDefinition.id}.json`;
		anchor.click();
		URL.revokeObjectURL(url);
	};

	const handleAddStage = () => {
		updateSelectedCustomDefinition((definition) => {
			const stageId = nextCustomId(new Set(Object.keys(definition.states)), "stage");
			setSelectedStageId(stageId);
			return {
				...definition,
				states: {
					...definition.states,
					[stageId]: {
						label: "New Stage",
						role: stageId,
						agentId: "codex",
						prompt: "Complete this process stage with concrete notes before passing or failing.",
						on: {},
					},
				},
			};
		});
	};

	const handleRemoveStage = (stageId: string) => {
		updateSelectedCustomDefinition((definition) => {
			if (Object.keys(definition.states).length <= 1) {
				return definition;
			}
			const nextStates = Object.fromEntries(
				Object.entries(definition.states)
					.filter(([currentStageId]) => currentStageId !== stageId)
					.map(([currentStageId, stage]) => [
						currentStageId,
						{
							...stage,
							on: {
								pass: stage.on.pass === stageId ? undefined : stage.on.pass,
								fail: stage.on.fail === stageId ? undefined : stage.on.fail,
							},
							conditions: stage.conditions?.filter((condition) => condition.target !== stageId),
						},
					]),
			);
			const nextInitial = definition.initial === stageId ? Object.keys(nextStates)[0] : definition.initial;
			setSelectedStageId(nextInitial ?? null);
			return {
				...definition,
				initial: nextInitial ?? definition.initial,
				states: nextStates,
			};
		});
	};

	const updateSelectedStageDefinition = (
		stageId: string,
		updater: (stage: TaskProcessDefinition["states"][string]) => TaskProcessDefinition["states"][string],
	) => {
		updateSelectedCustomDefinition((definition) => {
			const stage = definition.states[stageId];
			if (!stage) {
				return definition;
			}
			return {
				...definition,
				states: {
					...definition.states,
					[stageId]: updater(stage),
				},
			};
		});
	};

	const handleAddConditionalEdge = (stageId: string) => {
		updateSelectedStageDefinition(stageId, (stage) => {
			const target = stage.on.fail ?? stage.on.pass ?? Object.keys(selectedDefinition?.states ?? {})[0] ?? stageId;
			const nextCondition: RuntimeTaskProcessConditionalTransition = {
				verdict: "fail",
				path: "agent",
				equals: "user",
				target,
			};
			return {
				...stage,
				conditions: [...(stage.conditions ?? []), nextCondition],
			};
		});
	};

	const handleUpdateConditionalEdge = (
		stageId: string,
		conditionIndex: number,
		updater: (condition: RuntimeTaskProcessConditionalTransition) => RuntimeTaskProcessConditionalTransition,
	) => {
		updateSelectedStageDefinition(stageId, (stage) => ({
			...stage,
			conditions: (stage.conditions ?? []).map((condition, index) =>
				index === conditionIndex ? updater(condition) : condition,
			),
		}));
	};

	const handleRemoveConditionalEdge = (stageId: string, conditionIndex: number) => {
		updateSelectedStageDefinition(stageId, (stage) => ({
			...stage,
			conditions: (stage.conditions ?? []).filter((_, index) => index !== conditionIndex),
		}));
	};

	const handleMoveConditionalEdge = (stageId: string, conditionIndex: number, direction: -1 | 1) => {
		updateSelectedStageDefinition(stageId, (stage) => {
			const conditions = [...(stage.conditions ?? [])];
			const nextIndex = conditionIndex + direction;
			if (
				conditionIndex < 0 ||
				nextIndex < 0 ||
				conditionIndex >= conditions.length ||
				nextIndex >= conditions.length
			) {
				return stage;
			}
			const current = conditions[conditionIndex];
			const next = conditions[nextIndex];
			if (!current || !next) {
				return stage;
			}
			conditions[conditionIndex] = next;
			conditions[nextIndex] = current;
			return {
				...stage,
				conditions,
			};
		});
	};

	const handleSave = () => {
		const validationError = validateDefinitions(draftDefinitions);
		if (validationError) {
			setError(validationError);
			return;
		}
		const missingAssignedProcessIds = getMissingAssignedCustomProcessIds(draftDefinitions, processUsageById);
		if (missingAssignedProcessIds.length > 0) {
			setError(`Assigned processes cannot be removed: ${missingAssignedProcessIds.join(", ")}.`);
			return;
		}
		onProcessDefinitionsChange(draftDefinitions.map(cloneDefinition));
		onOpenChange(false);
	};

	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
			contentClassName="!w-[calc(100vw-24px)] !max-w-[1200px] !max-h-[calc(100vh-24px)] overflow-hidden"
			contentAriaDescribedBy={undefined}
		>
			<DialogHeader title="Processes" icon={<Braces size={16} />} />
			<DialogBody className="flex h-[calc(100vh-116px)] max-h-[820px] flex-col gap-2 overflow-hidden overflow-x-hidden p-3">
				<div className="flex flex-wrap items-center gap-2">
					<Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={handleAddCustomProcess}>
						New process
					</Button>
					<Button
						size="sm"
						icon={<FileJson size={14} />}
						onClick={() => {
							setIsJsonEditorOpen((current) => !current);
							setError(null);
						}}
					>
						JSON
					</Button>
					<input
						ref={jsonFileInputRef}
						type="file"
						accept="application/json,.json"
						className="hidden"
						onChange={handleImportJsonFile}
					/>
					<Button
						size="sm"
						icon={<Upload size={14} />}
						onClick={() => {
							jsonFileInputRef.current?.click();
							setError(null);
						}}
					>
						Import file
					</Button>
					<Button
						size="sm"
						icon={<Copy size={14} />}
						onClick={handleExportSelectedJson}
						disabled={!selectedDefinition}
					>
						Export selected
					</Button>
					<Button
						size="sm"
						icon={<Download size={14} />}
						onClick={handleDownloadSelectedJson}
						disabled={!selectedDefinition}
					>
						Download
					</Button>
					<Button
						size="sm"
						icon={<Copy size={14} />}
						onClick={handleDuplicateSelected}
						disabled={!selectedDefinition}
					>
						Duplicate
					</Button>
					<Button
						size="sm"
						variant="danger"
						icon={<Trash2 size={14} />}
						onClick={handleDeleteSelected}
						disabled={!selectedIsCustom || selectedProcessUsageCount > 0}
					>
						Delete
					</Button>
				</div>
				{isJsonEditorOpen ? (
					<div className="grid gap-2 rounded-md border border-border bg-surface-0 p-2 md:grid-cols-[minmax(0,1fr)_116px]">
						<textarea
							value={jsonDraft}
							onChange={(event) => setJsonDraft(event.currentTarget.value)}
							placeholder="Paste a Gate/Kanban process JSON definition or an array of definitions."
							className="min-h-20 resize-y rounded-md border border-border bg-surface-2 px-2 py-2 font-mono text-xs text-text-primary placeholder:text-text-tertiary outline-none focus:border-border-focus"
						/>
						<div className="flex flex-col justify-end gap-2">
							<label className="flex items-center gap-2 text-xs text-text-secondary">
								<input
									type="checkbox"
									checked={isJsonReplaceEnabled}
									onChange={(event) => setIsJsonReplaceEnabled(event.currentTarget.checked)}
								/>
								Replace custom
							</label>
							<Button size="sm" variant="primary" icon={<Save size={14} />} onClick={handleImportJson}>
								Import JSON
							</Button>
						</div>
					</div>
				) : null}
				<div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-hidden lg:grid-cols-[240px_minmax(0,1fr)]">
					<div className="max-h-40 min-h-0 overflow-y-auto rounded-md border border-border bg-surface-0 p-1 lg:max-h-none">
						{allDefinitions.map((definition) => {
							const isSelected = definition.id === selectedDefinition?.id;
							const sourceLabel = customProcessIds.has(definition.id) ? "Custom" : "Built-in";
							return (
								<button
									key={definition.id}
									type="button"
									onClick={() => {
										setSelectedProcessId(definition.id);
										setSelectedStageId(definition.initial);
									}}
									className={cn(
										"flex w-full flex-col gap-1 rounded-md px-2 py-2 text-left text-xs transition-colors",
										isSelected ? "bg-surface-3 text-text-primary" : "text-text-secondary hover:bg-surface-2",
									)}
								>
									<span className="font-semibold">{definition.name}</span>
									<span className="font-mono text-[10px] text-text-tertiary">
										{definition.id} / {sourceLabel}
									</span>
								</button>
							);
						})}
					</div>
					<div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-md border border-border bg-surface-0">
						{selectedDefinition ? (
							<>
								<div className="border-b border-border p-2">
									<div className="grid gap-2 md:grid-cols-[1fr_1fr_180px]">
										<label>
											<FieldLabel>Process ID</FieldLabel>
											<input
												value={selectedDefinition.id}
												disabled={!selectedIsCustom}
												onChange={(event) => {
													const nextId = toProcessId(event.currentTarget.value);
													if (!nextId || nextId === selectedDefinition.id || allProcessIds.has(nextId)) {
														return;
													}
													setDraftDefinitions((current) =>
														current.map((definition) =>
															definition.id === selectedDefinition.id
																? { ...definition, id: nextId }
																: definition,
														),
													);
													setSelectedProcessId(nextId);
													setError(null);
												}}
												className={textInputClassName(!selectedIsCustom ? "opacity-70" : undefined)}
											/>
										</label>
										<label>
											<FieldLabel>Name</FieldLabel>
											<input
												value={selectedDefinition.name}
												disabled={!selectedIsCustom}
												onChange={(event) =>
													updateSelectedCustomDefinition((definition) => ({
														...definition,
														name: event.currentTarget.value,
													}))
												}
												className={textInputClassName(!selectedIsCustom ? "opacity-70" : undefined)}
											/>
										</label>
										<label>
											<FieldLabel>Initial Stage</FieldLabel>
											<select
												value={selectedDefinition.initial}
												disabled={!selectedIsCustom}
												onChange={(event) =>
													updateSelectedCustomDefinition((definition) => ({
														...definition,
														initial: event.currentTarget.value,
													}))
												}
												className={selectClassName(!selectedIsCustom ? "opacity-70" : undefined)}
											>
												{selectedStageIds.map((stageId) => (
													<option key={stageId} value={stageId}>
														{stageId}
													</option>
												))}
											</select>
										</label>
									</div>
									<label className="mt-2 block">
										<FieldLabel>Description</FieldLabel>
										<input
											value={selectedDefinition.description ?? ""}
											disabled={!selectedIsCustom}
											onChange={(event) =>
												updateSelectedCustomDefinition((definition) => ({
													...definition,
													description: event.currentTarget.value.trim()
														? event.currentTarget.value
														: undefined,
												}))
											}
											className={textInputClassName(!selectedIsCustom ? "opacity-70" : undefined)}
											placeholder="Optional process description"
										/>
									</label>
									{selectedIsCustom && selectedProcessUsageCount > 0 ? (
										<div className="mt-2 rounded-md border border-status-orange/40 bg-status-orange/10 px-2 py-1.5 text-xs text-status-orange">
											Assigned cards keep captured definitions; edits apply to future assignments.
										</div>
									) : null}
									<ProcessRoutePreview
										definition={selectedDefinition}
										selectedStageId={effectiveSelectedStageId}
										usageCount={selectedProcessUsageCount}
									/>
								</div>
								<div className="grid min-h-0 grid-cols-1 lg:grid-cols-[210px_minmax(0,1fr)]">
									<div className="max-h-36 min-h-0 overflow-y-auto border-b border-border p-2 lg:max-h-none lg:border-r lg:border-b-0">
										<div className="mb-2 flex items-center justify-between">
											<span className="text-[11px] font-semibold uppercase text-text-tertiary">Stages</span>
											<Button
												size="sm"
												variant="ghost"
												icon={<Plus size={14} />}
												onClick={handleAddStage}
												disabled={!selectedIsCustom}
											/>
										</div>
										<div className="flex flex-col gap-1">
											{selectedStageIds.map((stageId) => {
												const stage = selectedDefinition.states[stageId];
												const isSelected = stageId === effectiveSelectedStageId;
												return (
													<button
														key={stageId}
														type="button"
														onClick={() => setSelectedStageId(stageId)}
														className={cn(
															"rounded-md px-2 py-2 text-left text-xs",
															isSelected
																? "bg-surface-3 text-text-primary"
																: "text-text-secondary hover:bg-surface-2",
														)}
													>
														<span className="block truncate font-semibold">
															{stage?.label ?? stageId}
														</span>
														<span className="block truncate font-mono text-[10px] text-text-tertiary">
															{stageId}
														</span>
													</button>
												);
											})}
										</div>
									</div>
									<div className="min-h-0 overflow-y-auto overflow-x-auto p-3">
										{effectiveSelectedStageId && selectedStage ? (
											<div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(260px,0.8fr)]">
												<div className="flex flex-col gap-3">
													<div className="grid gap-2 md:grid-cols-[1fr_1fr_140px]">
														<label>
															<FieldLabel>Stage ID</FieldLabel>
															<input
																value={effectiveSelectedStageId}
																disabled={!selectedIsCustom}
																onChange={(event) =>
																	updateSelectedCustomDefinition((definition) =>
																		renameStage(
																			definition,
																			effectiveSelectedStageId,
																			event.currentTarget.value,
																		),
																	)
																}
																className={textInputClassName(
																	!selectedIsCustom ? "opacity-70" : undefined,
																)}
															/>
														</label>
														<label>
															<FieldLabel>Label</FieldLabel>
															<input
																value={selectedStage.label ?? ""}
																disabled={!selectedIsCustom}
																onChange={(event) =>
																	updateSelectedCustomDefinition((definition) => ({
																		...definition,
																		states: {
																			...definition.states,
																			[effectiveSelectedStageId]: {
																				...selectedStage,
																				label: event.currentTarget.value.trim()
																					? event.currentTarget.value
																					: undefined,
																			},
																		},
																	}))
																}
																className={textInputClassName(
																	!selectedIsCustom ? "opacity-70" : undefined,
																)}
															/>
														</label>
														<label className="flex items-end gap-2 pb-1 text-xs text-text-primary">
															<input
																type="checkbox"
																checked={selectedStage.terminal === true}
																disabled={!selectedIsCustom}
																onChange={(event) =>
																	updateSelectedCustomDefinition((definition) => ({
																		...definition,
																		states: {
																			...definition.states,
																			[effectiveSelectedStageId]: {
																				...selectedStage,
																				terminal: event.currentTarget.checked,
																				on: event.currentTarget.checked ? {} : selectedStage.on,
																				conditions: event.currentTarget.checked
																					? []
																					: selectedStage.conditions,
																			},
																		},
																	}))
																}
															/>
															Terminal
														</label>
													</div>
													<div className="grid gap-2 md:grid-cols-[1fr_1fr_1fr]">
														<label>
															<FieldLabel>Role</FieldLabel>
															<input
																value={selectedStage.role ?? ""}
																disabled={!selectedIsCustom}
																onChange={(event) =>
																	updateSelectedCustomDefinition((definition) => ({
																		...definition,
																		states: {
																			...definition.states,
																			[effectiveSelectedStageId]: {
																				...selectedStage,
																				role: event.currentTarget.value.trim()
																					? event.currentTarget.value
																					: undefined,
																			},
																		},
																	}))
																}
																className={textInputClassName(
																	!selectedIsCustom ? "opacity-70" : undefined,
																)}
															/>
														</label>
														<label>
															<FieldLabel>Agent</FieldLabel>
															<select
																value={selectedStage.agentId ?? ""}
																disabled={!selectedIsCustom}
																onChange={(event) =>
																	updateSelectedCustomDefinition((definition) => ({
																		...definition,
																		states: {
																			...definition.states,
																			[effectiveSelectedStageId]: {
																				...selectedStage,
																				agentId: event.currentTarget.value
																					? (event.currentTarget.value as RuntimeAgentId)
																					: undefined,
																			},
																		},
																	}))
																}
																className={selectClassName(
																	!selectedIsCustom ? "opacity-70" : undefined,
																)}
															>
																<option value="">Default</option>
																{processAgentOptions.map((option) => (
																	<option key={option.value} value={option.value}>
																		{option.label}
																	</option>
																))}
															</select>
														</label>
														<div className="flex items-end">
															<Button
																size="sm"
																variant="danger"
																icon={<Trash2 size={14} />}
																onClick={() => handleRemoveStage(effectiveSelectedStageId)}
																disabled={!selectedIsCustom || selectedStageIds.length <= 1}
															>
																Remove stage
															</Button>
														</div>
													</div>
													<div className="grid gap-2 md:grid-cols-2">
														<label>
															<FieldLabel>Pass Edge</FieldLabel>
															<select
																value={selectedStage.on.pass ?? ""}
																disabled={!selectedIsCustom || selectedStage.terminal === true}
																onChange={(event) =>
																	updateSelectedCustomDefinition((definition) => ({
																		...definition,
																		states: {
																			...definition.states,
																			[effectiveSelectedStageId]: {
																				...selectedStage,
																				on: {
																					...selectedStage.on,
																					pass: event.currentTarget.value || undefined,
																				},
																			},
																		},
																	}))
																}
																className={selectClassName(
																	!selectedIsCustom ? "opacity-70" : undefined,
																)}
															>
																<option value="">No pass edge</option>
																{selectedStageIds.map((stageId) => (
																	<option key={stageId} value={stageId}>
																		{stageId}
																	</option>
																))}
															</select>
														</label>
														<label>
															<FieldLabel>Fail Edge</FieldLabel>
															<select
																value={selectedStage.on.fail ?? ""}
																disabled={!selectedIsCustom || selectedStage.terminal === true}
																onChange={(event) =>
																	updateSelectedCustomDefinition((definition) => ({
																		...definition,
																		states: {
																			...definition.states,
																			[effectiveSelectedStageId]: {
																				...selectedStage,
																				on: {
																					...selectedStage.on,
																					fail: event.currentTarget.value || undefined,
																				},
																			},
																		},
																	}))
																}
																className={selectClassName(
																	!selectedIsCustom ? "opacity-70" : undefined,
																)}
															>
																<option value="">No fail edge</option>
																{selectedStageIds.map((stageId) => (
																	<option key={stageId} value={stageId}>
																		{stageId}
																	</option>
																))}
															</select>
														</label>
													</div>
												</div>
												<div className="grid gap-2 rounded-md border border-border bg-surface-1 p-2">
													<div className="flex flex-wrap items-center justify-between gap-2">
														<span className="text-[11px] font-semibold uppercase text-text-tertiary">
															Conditional Edges
														</span>
														<Button
															size="sm"
															variant="ghost"
															icon={<Plus size={14} />}
															onClick={() => handleAddConditionalEdge(effectiveSelectedStageId)}
															disabled={!selectedIsCustom || selectedStage.terminal === true}
														>
															Add conditional edge
														</Button>
													</div>
													{(selectedStage.conditions ?? []).length === 0 ? (
														<p className="text-xs text-text-tertiary">
															No conditional edges. Pass and fail use the static edges above.
														</p>
													) : (
														<div className="grid gap-2">
															{(selectedStage.conditions ?? []).map((condition, conditionIndex) => {
																const matcherKind =
																	condition.equals !== undefined ? "equals" : "contains";
																const matcherValue = condition.equals ?? condition.contains ?? "";
																return (
																	<div
																		key={`${condition.verdict}-${condition.path}-${conditionIndex}`}
																		className="grid min-w-0 gap-2 rounded-md border border-border bg-surface-2 p-2 lg:grid-cols-[minmax(80px,96px)_minmax(96px,112px)_minmax(96px,112px)_minmax(120px,1fr)] xl:min-w-[860px] xl:grid-cols-[minmax(80px,96px)_minmax(96px,112px)_minmax(96px,112px)_minmax(120px,1fr)_minmax(96px,112px)_minmax(120px,1fr)_auto]"
																	>
																		<label className="min-w-0">
																			<FieldLabel>Outcome</FieldLabel>
																			<select
																				value={condition.verdict}
																				disabled={
																					!selectedIsCustom || selectedStage.terminal === true
																				}
																				onChange={(event) =>
																					handleUpdateConditionalEdge(
																						effectiveSelectedStageId,
																						conditionIndex,
																						(currentCondition) => ({
																							...currentCondition,
																							verdict: event.currentTarget
																								.value as RuntimeTaskProcessVerdict,
																						}),
																					)
																				}
																				className={selectClassName(
																					!selectedIsCustom ? "opacity-70" : undefined,
																				)}
																			>
																				<option value="pass">pass</option>
																				<option value="fail">fail</option>
																			</select>
																		</label>
																		<label className="min-w-0">
																			<FieldLabel>Field</FieldLabel>
																			<select
																				value={condition.path}
																				disabled={
																					!selectedIsCustom || selectedStage.terminal === true
																				}
																				onChange={(event) =>
																					handleUpdateConditionalEdge(
																						effectiveSelectedStageId,
																						conditionIndex,
																						(currentCondition) => ({
																							...currentCondition,
																							path: event.currentTarget
																								.value as RuntimeTaskProcessConditionPath,
																						}),
																					)
																				}
																				className={selectClassName(
																					!selectedIsCustom ? "opacity-70" : undefined,
																				)}
																			>
																				<option value="agent">agent</option>
																				<option value="model">model</option>
																				<option value="notes">notes</option>
																			</select>
																		</label>
																		<label className="min-w-0">
																			<FieldLabel>Matcher</FieldLabel>
																			<select
																				value={matcherKind}
																				disabled={
																					!selectedIsCustom || selectedStage.terminal === true
																				}
																				onChange={(event) =>
																					handleUpdateConditionalEdge(
																						effectiveSelectedStageId,
																						conditionIndex,
																						(currentCondition) =>
																							event.currentTarget.value === "equals"
																								? {
																										...currentCondition,
																										equals: matcherValue,
																										contains: undefined,
																									}
																								: {
																										...currentCondition,
																										equals: undefined,
																										contains: matcherValue,
																									},
																					)
																				}
																				className={selectClassName(
																					!selectedIsCustom ? "opacity-70" : undefined,
																				)}
																			>
																				<option value="equals">equals</option>
																				<option value="contains">contains</option>
																			</select>
																		</label>
																		<label className="min-w-0">
																			<FieldLabel>Value</FieldLabel>
																			<input
																				value={matcherValue}
																				disabled={
																					!selectedIsCustom || selectedStage.terminal === true
																				}
																				onChange={(event) =>
																					handleUpdateConditionalEdge(
																						effectiveSelectedStageId,
																						conditionIndex,
																						(currentCondition) =>
																							matcherKind === "equals"
																								? {
																										...currentCondition,
																										equals: event.currentTarget.value,
																										contains: undefined,
																									}
																								: {
																										...currentCondition,
																										equals: undefined,
																										contains: event.currentTarget.value,
																									},
																					)
																				}
																				className={textInputClassName(
																					!selectedIsCustom ? "opacity-70" : undefined,
																				)}
																			/>
																		</label>
																		<label className="min-w-0">
																			<FieldLabel>Target</FieldLabel>
																			<select
																				value={condition.target}
																				disabled={
																					!selectedIsCustom || selectedStage.terminal === true
																				}
																				onChange={(event) =>
																					handleUpdateConditionalEdge(
																						effectiveSelectedStageId,
																						conditionIndex,
																						(currentCondition) => ({
																							...currentCondition,
																							target: event.currentTarget.value,
																						}),
																					)
																				}
																				className={selectClassName(
																					!selectedIsCustom ? "opacity-70" : undefined,
																				)}
																			>
																				{selectedStageIds.map((stageId) => (
																					<option key={stageId} value={stageId}>
																						{stageId}
																					</option>
																				))}
																			</select>
																		</label>
																		<label className="min-w-0">
																			<FieldLabel>Label</FieldLabel>
																			<input
																				value={condition.label ?? ""}
																				disabled={
																					!selectedIsCustom || selectedStage.terminal === true
																				}
																				onChange={(event) =>
																					handleUpdateConditionalEdge(
																						effectiveSelectedStageId,
																						conditionIndex,
																						(currentCondition) => ({
																							...currentCondition,
																							label: event.currentTarget.value.trim()
																								? event.currentTarget.value
																								: undefined,
																						}),
																					)
																				}
																				className={textInputClassName(
																					!selectedIsCustom ? "opacity-70" : undefined,
																				)}
																			/>
																		</label>
																		<div className="flex flex-wrap items-end gap-1">
																			<Button
																				size="sm"
																				variant="ghost"
																				icon={<ArrowUp size={14} />}
																				aria-label={`Move conditional edge ${conditionIndex + 1} up`}
																				onClick={() =>
																					handleMoveConditionalEdge(
																						effectiveSelectedStageId,
																						conditionIndex,
																						-1,
																					)
																				}
																				disabled={
																					!selectedIsCustom ||
																					selectedStage.terminal === true ||
																					conditionIndex === 0
																				}
																			>
																				Up
																			</Button>
																			<Button
																				size="sm"
																				variant="ghost"
																				icon={<ArrowDown size={14} />}
																				aria-label={`Move conditional edge ${conditionIndex + 1} down`}
																				onClick={() =>
																					handleMoveConditionalEdge(
																						effectiveSelectedStageId,
																						conditionIndex,
																						1,
																					)
																				}
																				disabled={
																					!selectedIsCustom ||
																					selectedStage.terminal === true ||
																					conditionIndex ===
																						(selectedStage.conditions ?? []).length - 1
																				}
																			>
																				Down
																			</Button>
																			<Button
																				size="sm"
																				variant="danger"
																				icon={<Trash2 size={14} />}
																				onClick={() =>
																					handleRemoveConditionalEdge(
																						effectiveSelectedStageId,
																						conditionIndex,
																					)
																				}
																				disabled={
																					!selectedIsCustom || selectedStage.terminal === true
																				}
																			>
																				Remove
																			</Button>
																		</div>
																	</div>
																);
															})}
														</div>
													)}
												</div>
												<label className="min-h-0">
													<FieldLabel>Stage Prompt</FieldLabel>
													<textarea
														value={selectedStage.prompt ?? ""}
														disabled={!selectedIsCustom}
														onChange={(event) =>
															updateSelectedCustomDefinition((definition) => ({
																...definition,
																states: {
																	...definition.states,
																	[effectiveSelectedStageId]: {
																		...selectedStage,
																		prompt: event.currentTarget.value.trim()
																			? event.currentTarget.value
																			: undefined,
																	},
																},
															}))
														}
														className={cn(
															"min-h-[150px] w-full resize-y rounded-md border border-border bg-surface-2 px-2 py-2 text-xs text-text-primary outline-none focus:border-border-focus",
															!selectedIsCustom && "opacity-70",
														)}
													/>
												</label>
											</div>
										) : null}
									</div>
								</div>
							</>
						) : (
							<div className="p-3 text-xs text-text-tertiary">No process definitions available.</div>
						)}
					</div>
				</div>
				{error ? (
					<pre className="max-h-28 overflow-auto whitespace-pre-wrap text-xs text-status-red">{error}</pre>
				) : null}
			</DialogBody>
			<DialogFooter>
				<Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
					Cancel
				</Button>
				<Button variant="primary" size="sm" icon={<Save size={14} />} onClick={handleSave}>
					Save
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
