import {
	buildTaskProcessStagePrompt,
	getTaskProcessDefinition,
	getTaskProcessProgress,
	getTaskProcessStage,
	getTaskProcessStagePromptIssue,
	taskProcessTransitionConditionMatches,
} from "@runtime-task-process";
import { Check, Circle, CircleCheck, CircleDot, Play, RotateCcw, Workflow, XCircle } from "lucide-react";
import { type ReactElement, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import type { RuntimeTaskProcessHistoryEntry } from "@/runtime/types";
import type { BoardCard, TaskProcessVerdict } from "@/types";

function getLastStageRecord(
	history: readonly RuntimeTaskProcessHistoryEntry[],
	stageId: string,
): RuntimeTaskProcessHistoryEntry | undefined {
	for (let index = history.length - 1; index >= 0; index -= 1) {
		const entry = history[index];
		if (entry?.stageId === stageId) {
			return entry;
		}
	}
	return undefined;
}

function getStageRecordCount(history: readonly RuntimeTaskProcessHistoryEntry[], stageId: string): number {
	return history.reduce((count, entry) => count + (entry.stageId === stageId ? 1 : 0), 0);
}

function formatHistoryTimestamp(value: number): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return String(value);
	}
	return date.toISOString();
}

function getHistoryKindLabel(entry: RuntimeTaskProcessHistoryEntry): string {
	if (entry.recordKind) {
		return entry.recordKind;
	}
	return entry.verdict ? "outcome" : "append";
}

function formatAuditRoute(history: readonly RuntimeTaskProcessHistoryEntry[], currentStageId: string): string {
	const route: string[] = [];
	for (const entry of history) {
		if (route.at(-1) !== entry.stageId) {
			route.push(entry.stageId);
		}
		if (entry.targetStageId && route.at(-1) !== entry.targetStageId) {
			route.push(entry.targetStageId);
		}
	}
	if (route.length === 0 || route.at(-1) !== currentStageId) {
		route.push(currentStageId);
	}
	return route.join(" -> ");
}

export function TaskProcessPanel({
	card,
	onAppend,
	onVerdict,
	onReopen,
	onRunStage,
	workspacePath,
	kanbanCommand,
	variant = "detail",
}: {
	card: BoardCard;
	onAppend?: (taskId: string, notes: string, expectedStage: string, agent: string, model?: string) => void;
	onVerdict?: (
		taskId: string,
		verdict: TaskProcessVerdict,
		notes: string,
		expectedStage: string,
		agent: string,
		model?: string,
	) => void;
	onReopen?: (taskId: string, notes: string, expectedStage: string, agent: string, model?: string) => void;
	onRunStage?: (taskId: string) => void;
	workspacePath?: string | null;
	kanbanCommand?: string | null;
	variant?: "detail" | "inline";
}): ReactElement | null {
	const [notes, setNotes] = useState("");
	const [agent, setAgent] = useState("");
	const [model, setModel] = useState("");
	const process = card.process;
	const definition = process ? getTaskProcessDefinition(process) : null;
	const stage = process ? getTaskProcessStage(process) : null;
	const defaultAgent = process
		? process.status === "complete"
			? "kanban"
			: stage?.role?.trim() || stage?.id || process.stageId
		: "";
	const trimmedAgent = agent.trim();
	const resolvedAgent = trimmedAgent || defaultAgent;
	const trimmedModel = model.trim();
	useEffect(() => {
		if (!process) {
			return;
		}
		setAgent(defaultAgent);
		setModel("");
		setNotes("");
	}, [card.id, defaultAgent, process?.stageId, process?.updatedAt]);
	const progress = process ? getTaskProcessProgress(process) : null;
	const stageIds = process ? (definition ? Object.keys(definition.states) : [process.stageId]) : [];
	const stagePromptIssue = process ? getTaskProcessStagePromptIssue(process) : null;
	const canAct = process ? process.status !== "complete" : false;
	const canReopen = process ? process.status === "complete" : false;
	const canRunStage = process ? process.status === "ready" && !stage?.terminal && !stagePromptIssue : false;
	const trimmedNotes = notes.trim();
	const routePreview = useMemo(() => {
		if (!process || !stage || stage.terminal) {
			return [];
		}
		const rows: Array<{ id: string; verdict: TaskProcessVerdict; target: string; text: string; active: boolean }> =
			[];
		for (const condition of stage.conditions ?? []) {
			const matcherValue = condition.equals ?? condition.contains ?? "";
			const active = taskProcessTransitionConditionMatches(condition, {
				verdict: condition.verdict,
				stageId: process.stageId,
				...(resolvedAgent ? { agent: resolvedAgent } : {}),
				...(trimmedModel ? { model: trimmedModel } : {}),
				...(trimmedNotes ? { notes: trimmedNotes } : {}),
			});
			const matcher = condition.equals !== undefined ? "equals" : "contains";
			rows.push({
				id: `${condition.verdict}:${condition.path}:${matcher}:${matcherValue}:${condition.target}`,
				verdict: condition.verdict,
				target: condition.target,
				active,
				text: `${condition.verdict} when ${condition.path} ${matcher} "${matcherValue}" -> ${condition.target}${condition.label ? ` (${condition.label})` : ""}`,
			});
		}
		if (stage.on.pass) {
			rows.push({
				id: `pass:fallback:${stage.on.pass}`,
				verdict: "pass",
				target: stage.on.pass,
				active: !rows.some((row) => row.verdict === "pass" && row.active),
				text: `pass fallback -> ${stage.on.pass}`,
			});
		}
		if (stage.on.fail) {
			rows.push({
				id: `fail:fallback:${stage.on.fail}`,
				verdict: "fail",
				target: stage.on.fail,
				active: !rows.some((row) => row.verdict === "fail" && row.active),
				text: `fail fallback -> ${stage.on.fail}`,
			});
		}
		return rows;
	}, [process, resolvedAgent, stage, trimmedModel, trimmedNotes]);
	const canSubmitVerdict = process
		? (process.status === "running" || process.status === "ready") && !stagePromptIssue
		: false;
	const canPass = canSubmitVerdict && Boolean(stage?.on.pass || routePreview.some((row) => row.verdict === "pass"));
	const canFail = canSubmitVerdict && Boolean(stage?.on.fail || routePreview.some((row) => row.verdict === "fail"));
	const handoffPreview = useMemo(() => {
		if (!process || !stage || stage.terminal) {
			return null;
		}
		try {
			return buildTaskProcessStagePrompt({
				taskId: card.id,
				taskTitle: card.title,
				taskPrompt: card.prompt,
				process,
				workspacePath,
				kanbanCommand,
			});
		} catch {
			return null;
		}
	}, [card.id, card.prompt, card.title, kanbanCommand, process, stage, workspacePath]);
	if (!process || !progress) {
		return null;
	}
	const handleAppend = () => {
		if (!trimmedNotes) {
			return;
		}
		onAppend?.(card.id, trimmedNotes, process.stageId, resolvedAgent, trimmedModel || undefined);
		setNotes("");
	};
	const handleVerdict = (verdict: TaskProcessVerdict) => {
		if (!trimmedNotes) {
			return;
		}
		onVerdict?.(card.id, verdict, trimmedNotes, process.stageId, resolvedAgent, trimmedModel || undefined);
		setNotes("");
	};
	const handleReopen = () => {
		if (!trimmedNotes) {
			return;
		}
		onReopen?.(card.id, trimmedNotes, process.stageId, resolvedAgent, trimmedModel || undefined);
		setNotes("");
	};
	const displayHistoryStage = (entry: RuntimeTaskProcessHistoryEntry): string =>
		entry.targetStageId ? `${entry.stageId} -> ${entry.targetStageId}` : entry.stageId;
	const auditRoute = formatAuditRoute(process.history, process.stageId);
	const coveredPathStageIds = new Set<string>([process.stageId]);
	for (const entry of process.history) {
		coveredPathStageIds.add(entry.stageId);
		if (entry.targetStageId) {
			coveredPathStageIds.add(entry.targetStageId);
		}
	}
	const coveredPathStageCount = progress.stages.filter((stageId) => coveredPathStageIds.has(stageId)).length;
	const outcomeHistoryEntries = process.history.filter(
		(entry) => entry.verdict === "pass" || entry.verdict === "fail",
	);
	const passCount = outcomeHistoryEntries.filter((entry) => entry.verdict === "pass").length;
	const failCount = outcomeHistoryEntries.filter((entry) => entry.verdict === "fail").length;
	const latestOutcomeEntry = outcomeHistoryEntries.at(-1);

	return (
		<div
			className={cn(
				"bg-surface-1 px-3 py-2",
				variant === "detail" ? "border-b border-divider" : "rounded-md border border-border-bright",
			)}
		>
			<div className="mb-2 flex flex-wrap items-center gap-2">
				<Workflow size={14} className="text-status-purple" />
				<div className="min-w-0 flex-1">
					<div className="truncate text-xs font-semibold text-text-primary">
						{process.processName ?? process.processId}
					</div>
					<div className="font-mono text-[11px] text-text-tertiary">
						{stage?.label ?? process.stageId} / {process.status}
					</div>
				</div>
				{stage?.on.pass ? (
					<span className="rounded-sm border border-status-green/40 bg-status-green/10 px-1.5 py-0.5 font-mono text-[10px] text-status-green">
						pass -&gt; {stage.on.pass}
					</span>
				) : null}
				{stage?.on.fail ? (
					<span className="rounded-sm border border-status-red/40 bg-status-red/10 px-1.5 py-0.5 font-mono text-[10px] text-status-red">
						fail -&gt; {stage.on.fail}
					</span>
				) : null}
				<span
					className={cn(
						"rounded-sm border px-1.5 py-0.5 font-mono text-[10px]",
						progress.offPath
							? "border-status-orange/40 bg-status-orange/10 text-status-orange"
							: "border-status-green/40 bg-status-green/10 text-status-green",
					)}
				>
					{progress.gatesPassed}/{progress.totalGates} gates
					{progress.offPath ? ` rework${progress.reworkOf ? ` from ${progress.reworkOf}` : ""}` : ""}
				</span>
				{canRunStage ? (
					<Button
						size="sm"
						variant="primary"
						icon={<Play size={13} />}
						onClick={() => onRunStage?.(card.id)}
						disabled={!onRunStage}
					>
						Run Stage
					</Button>
				) : null}
				{stagePromptIssue ? (
					<span className="rounded-sm border border-status-orange/40 bg-status-orange/10 px-1.5 py-0.5 font-mono text-[10px] text-status-orange">
						{stagePromptIssue}
					</span>
				) : null}
			</div>
			<div className="mb-2 flex flex-wrap items-center gap-1.5">
				{stageIds.map((stageId) => {
					const stageDefinition = definition?.states[stageId];
					const isCurrent = stageId === process.stageId;
					const isPassPath = progress.stages.includes(stageId);
					const lastRecord = getLastStageRecord(process.history, stageId);
					const recordCount = getStageRecordCount(process.history, stageId);
					const hasRecord = Boolean(lastRecord);
					const isTerminal = stageDefinition?.terminal === true;
					const tone =
						isCurrent && process.status !== "complete"
							? "border-accent/60 bg-accent/10 text-accent"
							: lastRecord?.verdict === "fail"
								? "border-status-red/40 bg-status-red/10 text-status-red"
								: hasRecord || (isCurrent && process.status === "complete")
									? "border-status-green/40 bg-status-green/10 text-status-green"
									: "border-border bg-surface-2 text-text-tertiary";
					const Icon =
						isCurrent && process.status !== "complete"
							? CircleDot
							: hasRecord || (isCurrent && process.status === "complete")
								? CircleCheck
								: Circle;
					return (
						<div
							key={stageId}
							className={cn("flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px]", tone)}
						>
							<Icon size={11} />
							<span className="font-mono">{stageId}</span>
							{isPassPath ? <span>path</span> : <span>off-path</span>}
							{lastRecord?.verdict ? (
								<span className="uppercase">
									{lastRecord.verdict}
									{lastRecord.targetStageId ? ` -> ${lastRecord.targetStageId}` : ""}
								</span>
							) : null}
							{recordCount > 1 ? <span>x{recordCount}</span> : null}
							{isTerminal ? <span>terminal</span> : null}
						</div>
					);
				})}
			</div>
			<div className="mb-2 grid gap-1 rounded-md border border-border bg-surface-0 px-2 py-1.5 text-[11px] text-text-secondary">
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
					<span className="text-[10px] font-semibold uppercase tracking-normal text-text-tertiary">Audit</span>
					<span className="font-mono text-text-primary">{auditRoute}</span>
				</div>
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="rounded-sm border border-border-bright bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">
						path {coveredPathStageCount}/{progress.stages.length}
					</span>
					<span className="rounded-sm border border-status-green/40 bg-status-green/10 px-1.5 py-0.5 font-mono text-[10px] text-status-green">
						pass {passCount}
					</span>
					<span className="rounded-sm border border-status-red/40 bg-status-red/10 px-1.5 py-0.5 font-mono text-[10px] text-status-red">
						fail {failCount}
					</span>
					<span className="rounded-sm border border-border-bright bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">
						outcomes {outcomeHistoryEntries.length}
					</span>
					{latestOutcomeEntry ? (
						<span className="rounded-sm border border-border-bright bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">
							latest {displayHistoryStage(latestOutcomeEntry)}{" "}
							{latestOutcomeEntry.verdict ?? getHistoryKindLabel(latestOutcomeEntry)}
						</span>
					) : null}
				</div>
			</div>
			{handoffPreview ? (
				<div className="mb-2 rounded-md border border-border bg-surface-0">
					<div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1.5">
						<span className="text-[11px] font-semibold uppercase tracking-normal text-text-tertiary">
							Agent handoff
						</span>
						<span className="rounded-sm border border-border-bright bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">
							agent {stage?.agentId ?? card.agentId ?? "default"}
						</span>
						<span className="rounded-sm border border-border-bright bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">
							role {stage?.role?.trim() || stage?.id || process.stageId}
						</span>
						<span className="rounded-sm border border-border-bright bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">
							expected {stage?.id ?? process.stageId}
						</span>
					</div>
					<pre
						className={cn(
							"whitespace-pre-wrap break-words px-2 py-1.5 font-mono text-[10px] leading-relaxed text-text-secondary",
							variant === "detail" ? "max-h-56 overflow-y-auto" : "max-h-32 overflow-y-auto",
						)}
					>
						{handoffPreview}
					</pre>
				</div>
			) : null}
			{canAct || canReopen ? (
				<div className="grid gap-2">
					{routePreview.length > 0 ? (
						<div className="flex flex-wrap gap-1.5">
							{routePreview.map((route) => (
								<span
									key={route.id}
									className={cn(
										"rounded-sm border px-1.5 py-0.5 font-mono text-[10px]",
										route.active
											? route.verdict === "pass"
												? "border-status-green/50 bg-status-green/10 text-status-green"
												: "border-status-red/50 bg-status-red/10 text-status-red"
											: "border-border bg-surface-2 text-text-tertiary",
									)}
								>
									{route.active ? "active " : ""}
									{route.text}
								</span>
							))}
						</div>
					) : null}
					<div className="flex gap-2">
						<div className="flex min-w-0 flex-1 flex-col gap-2">
							<textarea
								value={notes}
								onChange={(event) => setNotes(event.currentTarget.value)}
								placeholder="Stage notes and evidence"
								className="min-h-[58px] resize-none rounded-md border border-border bg-surface-2 px-2 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary outline-none focus:border-border-focus"
							/>
							<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
								<label className="grid gap-1 text-[10px] font-semibold uppercase tracking-normal text-text-tertiary">
									Agent
									<input
										value={agent}
										onChange={(event) => setAgent(event.currentTarget.value)}
										placeholder={defaultAgent}
										className="h-7 min-w-0 rounded-md border border-border bg-surface-2 px-2 font-mono text-[11px] normal-case text-text-primary outline-none placeholder:text-text-tertiary focus:border-border-focus"
									/>
								</label>
								<label className="grid gap-1 text-[10px] font-semibold uppercase tracking-normal text-text-tertiary">
									Model
									<input
										value={model}
										onChange={(event) => setModel(event.currentTarget.value)}
										placeholder="optional"
										className="h-7 min-w-0 rounded-md border border-border bg-surface-2 px-2 font-mono text-[11px] normal-case text-text-primary outline-none placeholder:text-text-tertiary focus:border-border-focus"
									/>
								</label>
							</div>
						</div>
						<div className="flex w-[104px] flex-col gap-1">
							{canAct ? (
								<>
									<Button size="sm" onClick={handleAppend} disabled={!trimmedNotes}>
										Append
									</Button>
									<Button
										size="sm"
										variant="primary"
										icon={<Check size={13} />}
										onClick={() => handleVerdict("pass")}
										disabled={!trimmedNotes || !canPass}
									>
										Pass
									</Button>
									<Button
										size="sm"
										variant="danger"
										icon={<XCircle size={13} />}
										onClick={() => handleVerdict("fail")}
										disabled={!trimmedNotes || !canFail}
									>
										Fail
									</Button>
								</>
							) : null}
							{canReopen ? (
								<Button
									size="sm"
									variant="primary"
									icon={<RotateCcw size={13} />}
									onClick={handleReopen}
									disabled={!trimmedNotes || !onReopen}
								>
									Reopen
								</Button>
							) : null}
						</div>
					</div>
				</div>
			) : null}
			{process.history.length > 0 ? (
				<div
					className={cn(
						"mt-2 overflow-y-auto rounded-md border border-border bg-surface-0 px-2 py-1",
						variant === "detail" ? "max-h-72" : "max-h-36",
					)}
				>
					{process.history.map((entry, index) => (
						<div key={`${entry.at}-${index}`} className="grid gap-0.5 py-0.5 text-[11px] text-text-secondary">
							<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
								<span className="font-mono text-text-tertiary">{formatHistoryTimestamp(entry.at)}</span>
								<span className="font-mono text-text-primary">{displayHistoryStage(entry)}</span>
								<span className="uppercase">{entry.verdict ?? getHistoryKindLabel(entry)}</span>
								<span className="font-mono text-text-tertiary">kind={getHistoryKindLabel(entry)}</span>
								{entry.agent ? <span>agent={entry.agent}</span> : null}
								{entry.model ? <span>model={entry.model}</span> : null}
							</div>
							{entry.notes ? <span>: {entry.notes}</span> : null}
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}
