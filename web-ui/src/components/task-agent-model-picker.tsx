import * as Collapsible from "@radix-ui/react-collapsible";
import { getRuntimeLaunchSupportedAgentCatalog } from "@runtime-agent-catalog";
import { ChevronDown } from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";

import { ClineChatModelSelector } from "@/components/detail-panels/cline-chat-model-selector";
import {
	buildClineAgentModelPickerOptions,
	buildClineSelectedModelButtonText,
	getClineReasoningEnabledModelIds,
} from "@/components/detail-panels/cline-model-picker-options";
import { SearchSelectDropdown } from "@/components/search-select-dropdown";
import { cn } from "@/components/ui/cn";
import { NativeSelect } from "@/components/ui/native-select";
import { fetchAgentModels, fetchClineProviderCatalog, fetchClineProviderModels } from "@/runtime/runtime-config-query";
import type {
	RuntimeAgentId,
	RuntimeAgentModelInfo,
	RuntimeClineProviderCatalogItem,
	RuntimeClineProviderModel,
	RuntimeClineReasoningEffort,
	RuntimeTaskAgentSettings,
	RuntimeTaskClineSettings,
} from "@/runtime/types";

// Terminal agents (copilot, codex) whose model + reasoning catalog is sourced
// live from the agent's own install via runtime.getAgentModels.
const TERMINAL_AGENT_MODEL_IDS: ReadonlySet<RuntimeAgentId> = new Set<RuntimeAgentId>(["copilot", "codex"]);

function isTerminalAgentWithModelCatalog(agentId: RuntimeAgentId | null): agentId is RuntimeAgentId {
	return agentId !== null && TERMINAL_AGENT_MODEL_IDS.has(agentId);
}

// ---------------------------------------------------------------------------
// Hook: manages fetch state for Cline provider catalog + model lists
// ---------------------------------------------------------------------------

export interface UseTaskAgentModelPickerInput {
	active: boolean;
	workspaceId: string | null;
	agentId: RuntimeAgentId | undefined;
	clineSettings?: RuntimeTaskClineSettings;
	/** The default agent ID from runtimeConfig.selectedAgentId — used to build the first option label */
	defaultAgentId?: RuntimeAgentId | null;
	/** The default Cline provider ID from runtimeConfig.clineProviderSettings.providerId */
	defaultProviderId?: string | null;
	/** The default Cline model ID from runtimeConfig.clineProviderSettings.modelId */
	defaultModelId?: string | null;
}

export interface UseTaskAgentModelPickerResult {
	agentOptions: Array<{ value: string; label: string }>;
	clineProviderOptions: Array<{ value: string; label: string }>;
	clineModelOptions: Array<{ value: string; label: string }>;
	effectiveDefaultModelId: string | null;
	providerModels: RuntimeClineProviderModel[];
	isLoadingProviders: boolean;
	isLoadingModels: boolean;
	/** Map of provider ID → its default model ID (from the provider catalog). */
	providerDefaultModels: Record<string, string>;
	/** Live model catalog for the selected terminal agent (copilot/codex). */
	agentModels: RuntimeAgentModelInfo[];
	isLoadingAgentModels: boolean;
}

export function useTaskAgentModelPicker({
	active,
	workspaceId,
	agentId,
	clineSettings,
	defaultAgentId,
	defaultProviderId,
	defaultModelId,
}: UseTaskAgentModelPickerInput): UseTaskAgentModelPickerResult {
	const [providerCatalog, setProviderCatalog] = useState<RuntimeClineProviderCatalogItem[]>([]);
	const [providerModels, setProviderModels] = useState<RuntimeClineProviderModel[]>([]);
	const [isLoadingProviders, setIsLoadingProviders] = useState(false);
	const [isLoadingModels, setIsLoadingModels] = useState(false);
	const [agentModels, setAgentModels] = useState<RuntimeAgentModelInfo[]>([]);
	const [isLoadingAgentModels, setIsLoadingAgentModels] = useState(false);

	// Derive the effective agent: explicit override takes precedence, then the global default
	const effectiveAgentId = agentId ?? defaultAgentId ?? null;

	// Fetch the live model catalog for terminal agents (copilot, codex). The
	// list and per-model reasoning efforts come from the agent's own install, so
	// the picker never hardcodes model ids or reasoning levels.
	useEffect(() => {
		if (!active || !isTerminalAgentWithModelCatalog(effectiveAgentId)) {
			setAgentModels([]);
			return;
		}
		let cancelled = false;
		setIsLoadingAgentModels(true);
		void fetchAgentModels(workspaceId, effectiveAgentId)
			.then((models) => {
				if (!cancelled) {
					setAgentModels(models);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setAgentModels([]);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setIsLoadingAgentModels(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [active, effectiveAgentId, workspaceId]);

	useEffect(() => {
		if (!active || effectiveAgentId !== "cline") {
			return;
		}
		let cancelled = false;
		setIsLoadingProviders(true);
		void fetchClineProviderCatalog(workspaceId)
			.then((catalog) => {
				if (!cancelled) {
					setProviderCatalog(catalog);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setProviderCatalog([]);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setIsLoadingProviders(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [active, effectiveAgentId, workspaceId]);

	// Derive the effective provider: explicit override takes precedence, then the global default
	const clineProviderId = clineSettings?.providerId;
	const effectiveProviderId = (clineProviderId ?? defaultProviderId ?? "").trim() || null;

	useEffect(() => {
		if (!active || effectiveAgentId !== "cline" || !effectiveProviderId) {
			setProviderModels([]);
			return;
		}
		let cancelled = false;
		setIsLoadingModels(true);
		void fetchClineProviderModels(workspaceId, effectiveProviderId)
			.then((models) => {
				if (!cancelled) {
					setProviderModels(models);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setProviderModels([]);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setIsLoadingModels(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [active, effectiveAgentId, effectiveProviderId, workspaceId]);

	const agentOptions = useMemo(() => {
		const catalog = getRuntimeLaunchSupportedAgentCatalog();
		let firstLabel = "Default";
		if (defaultAgentId) {
			const defaultAgent = catalog.find((a) => a.id === defaultAgentId);
			if (defaultAgent) {
				firstLabel = defaultAgent.label;
			}
		}
		return [
			{ value: "", label: firstLabel },
			// Exclude the default agent from the explicit list — it's already represented by the first option
			...catalog
				.filter((agent) => agent.id !== defaultAgentId)
				.map((agent) => ({ value: agent.id, label: agent.label })),
		];
	}, [defaultAgentId]);

	const clineProviderOptions = useMemo(() => {
		let firstLabel = "Default";
		if (defaultProviderId) {
			const defaultProvider = providerCatalog.find((p) => p.id === defaultProviderId);
			firstLabel = defaultProvider ? defaultProvider.name : defaultProviderId;
		}
		return [
			{ value: "", label: firstLabel },
			// Exclude the default provider from the explicit list — it's already represented by the first option
			...providerCatalog.filter((p) => p.id !== defaultProviderId).map((p) => ({ value: p.id, label: p.name })),
		];
	}, [providerCatalog, defaultProviderId]);

	// Map of provider ID → its catalog default model ID. Used by the component to
	// auto-select the right model when the user switches providers.
	const providerDefaultModels = useMemo(() => {
		const map: Record<string, string> = {};
		for (const p of providerCatalog) {
			if (p.defaultModelId) {
				map[p.id] = p.defaultModelId;
			}
		}
		return map;
	}, [providerCatalog]);

	// When an explicit provider override is selected, the "Default" model label should
	// reflect that provider's default model — not the global settings model.
	const effectiveDefaultModelId = useMemo(() => {
		if (clineProviderId) {
			const provider = providerCatalog.find((p) => p.id === clineProviderId);
			return provider?.defaultModelId ?? null;
		}
		const inheritedProviderDefaultModelId =
			providerCatalog.find((p) => p.id === defaultProviderId)?.defaultModelId ?? null;
		return defaultModelId ?? inheritedProviderDefaultModelId;
	}, [clineProviderId, defaultModelId, defaultProviderId, providerCatalog]);

	const clineModelOptions = useMemo(() => {
		let defaultLabel = "Default";
		if (effectiveDefaultModelId) {
			const defaultModel = providerModels.find((m) => m.id === effectiveDefaultModelId);
			defaultLabel = defaultModel ? defaultModel.name : effectiveDefaultModelId;
		}
		return [
			{ value: "", label: defaultLabel },
			// Exclude the default model from the explicit list — it's already represented by the first option
			...providerModels.filter((m) => m.id !== effectiveDefaultModelId).map((m) => ({ value: m.id, label: m.name })),
		];
	}, [providerModels, effectiveDefaultModelId]);

	return {
		agentOptions,
		clineProviderOptions,
		clineModelOptions,
		effectiveDefaultModelId,
		providerModels,
		isLoadingProviders,
		isLoadingModels,
		providerDefaultModels,
		agentModels,
		isLoadingAgentModels,
	};
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

// ---------------------------------------------------------------------------
// Component: renders Agent, Cline provider/model, and terminal-agent model pickers
// ---------------------------------------------------------------------------

export function TaskAgentModelPicker({
	agentId,
	onAgentIdChange,
	agentSettings,
	onAgentSettingsChange,
	clineSettings,
	onClineSettingsChange,
	agentOptions,
	clineProviderOptions,
	clineModelOptions,
	effectiveDefaultModelId = null,
	providerModels = [],
	isLoadingProviders,
	isLoadingModels,
	onPopoverOpenChange,
	defaultAgentId,
	defaultProviderId,
	defaultReasoningEffort,
	providerDefaultModels,
	agentModels = [],
	isLoadingAgentModels = false,
}: {
	agentId: RuntimeAgentId | undefined;
	onAgentIdChange: (value: RuntimeAgentId | undefined) => void;
	agentSettings?: RuntimeTaskAgentSettings | undefined;
	onAgentSettingsChange?: (value: RuntimeTaskAgentSettings | undefined) => void;
	clineSettings?: RuntimeTaskClineSettings | undefined;
	onClineSettingsChange?: (value: RuntimeTaskClineSettings | undefined) => void;
	agentOptions: Array<{ value: string; label: string }>;
	clineProviderOptions: Array<{ value: string; label: string }>;
	clineModelOptions: Array<{ value: string; label: string }>;
	effectiveDefaultModelId?: string | null;
	providerModels?: RuntimeClineProviderModel[];
	isLoadingProviders: boolean;
	isLoadingModels: boolean;
	onPopoverOpenChange?: (open: boolean) => void;
	/** The default agent ID from runtimeConfig — used to decide if Cline pickers should show by default */
	defaultAgentId?: RuntimeAgentId | null;
	/** The default Cline provider ID from runtimeConfig — used to decide if model picker should show by default */
	defaultProviderId?: string | null;
	/** The global default reasoning effort from runtimeConfig.clineProviderSettings.reasoningEffort */
	defaultReasoningEffort?: RuntimeClineReasoningEffort | null;
	/** Map of provider ID → its default model ID (from the provider catalog). */
	providerDefaultModels?: Record<string, string>;
	/** Live model catalog for the selected terminal agent (copilot/codex). */
	agentModels?: RuntimeAgentModelInfo[];
	isLoadingAgentModels?: boolean;
}): ReactElement {
	const clineProviderId = clineSettings?.providerId;
	const clineModelId = clineSettings?.modelId;
	const clineReasoningEffort = clineSettings?.reasoningEffort;
	const agentModelId = agentSettings?.modelId ?? "";
	const agentReasoningEffort = agentSettings?.reasoningEffort ?? "";

	const updateTaskClineSettings = useCallback(
		(updater: (current: RuntimeTaskClineSettings | undefined) => RuntimeTaskClineSettings | undefined) => {
			onClineSettingsChange?.(updater(cloneTaskClineSettings(clineSettings)));
		},
		[clineSettings, onClineSettingsChange],
	);
	const updateTaskAgentSettings = useCallback(
		(updater: (current: RuntimeTaskAgentSettings | undefined) => RuntimeTaskAgentSettings | undefined) => {
			onAgentSettingsChange?.(updater(cloneTaskAgentSettings(agentSettings)));
		},
		[agentSettings, onAgentSettingsChange],
	);

	// Show the Cline provider picker when the effective agent is "cline"
	// (either explicitly overridden to cline, or defaulting to cline)
	const effectiveAgentId = agentId ?? defaultAgentId ?? null;
	const showClineProviderPicker = effectiveAgentId === "cline";
	const showAgentModelSettings =
		effectiveAgentId !== null && isTerminalAgentWithModelCatalog(effectiveAgentId);

	// The model the user has effectively chosen for the terminal agent (explicit
	// override, else the agent's reported default model if any).
	const selectedAgentModel = useMemo(
		() => agentModels.find((model) => model.id === agentModelId) ?? null,
		[agentModels, agentModelId],
	);
	// Reasoning efforts come from the selected model's own metadata, so they are
	// never hardcoded and differ correctly per model and per agent.
	const agentReasoningEffortOptions = useMemo(
		() => selectedAgentModel?.reasoningEfforts ?? [],
		[selectedAgentModel],
	);
	const selectedAgentModelSupportsReasoning = Boolean(
		selectedAgentModel?.supportsReasoning && agentReasoningEffortOptions.length > 0,
	);

	// Show the Cline model picker when a provider is effectively selected
	// (either explicitly overridden, or the global default provider is set)
	const effectiveProviderId = clineProviderId ?? defaultProviderId ?? null;
	const showClineModelPicker = showClineProviderPicker && Boolean(effectiveProviderId);
	const hasTaskClineSettingsOverride = clineSettings !== undefined;
	const selectedTaskReasoningEffort = clineReasoningEffort ?? "";
	const [isSettingsExpanded, setIsSettingsExpanded] = useState(false);
	const [isProviderPopoverOpen, setIsProviderPopoverOpen] = useState(false);
	const [isModelPopoverOpen, setIsModelPopoverOpen] = useState(false);
	const agentModelSelectId = useId();
	const agentReasoningSelectId = useId();
	const [reasoningEffort, setReasoningEffort] = useState<RuntimeClineReasoningEffort | "">(
		hasTaskClineSettingsOverride ? selectedTaskReasoningEffort : (defaultReasoningEffort ?? ""),
	);
	const setReasoningEffortWithOverride = useCallback(
		(nextReasoningEffort: RuntimeClineReasoningEffort | "") => {
			setReasoningEffort(nextReasoningEffort);
			updateTaskClineSettings((currentSettings) => {
				const nextSettings = cloneTaskClineSettings(currentSettings) ?? {};
				if (nextReasoningEffort) {
					nextSettings.reasoningEffort = nextReasoningEffort;
					return nextSettings;
				}
				delete nextSettings.reasoningEffort;
				if (
					nextSettings.providerId ||
					nextSettings.modelId ||
					currentSettings !== undefined ||
					Boolean(defaultReasoningEffort)
				) {
					return nextSettings;
				}
				return undefined;
			});
		},
		[defaultReasoningEffort, updateTaskClineSettings],
	);

	const setAgentModelOverride = useCallback(
		(nextModelId: string) => {
			updateTaskAgentSettings((currentSettings) => {
				const nextSettings = cloneTaskAgentSettings(currentSettings) ?? {};
				const trimmedModelId = nextModelId.trim();
				if (trimmedModelId) {
					nextSettings.modelId = trimmedModelId;
				} else {
					delete nextSettings.modelId;
				}
				// Switching model invalidates a reasoning effort the new model may
				// not support; drop it and let the user re-pick from the new list.
				delete nextSettings.reasoningEffort;
				return nextSettings.modelId ? nextSettings : undefined;
			});
		},
		[updateTaskAgentSettings],
	);

	const setAgentReasoningEffortOverride = useCallback(
		(nextReasoningEffort: string) => {
			updateTaskAgentSettings((currentSettings) => {
				const nextSettings = cloneTaskAgentSettings(currentSettings) ?? {};
				if (nextReasoningEffort) {
					nextSettings.reasoningEffort = nextReasoningEffort;
				} else {
					delete nextSettings.reasoningEffort;
				}
				return nextSettings.modelId || nextSettings.reasoningEffort ? nextSettings : undefined;
			});
		},
		[updateTaskAgentSettings],
	);

	// Drop a stored reasoning effort once we know the selected model doesn't
	// support reasoning (or no longer offers the chosen level).
	useEffect(() => {
		if (!showAgentModelSettings || !agentReasoningEffort) {
			return;
		}
		if (agentModels.length === 0) {
			return;
		}
		const stillValid = selectedAgentModelSupportsReasoning && agentReasoningEffortOptions.includes(agentReasoningEffort);
		if (!stillValid) {
			setAgentReasoningEffortOverride("");
		}
	}, [
		showAgentModelSettings,
		agentReasoningEffort,
		agentModels.length,
		selectedAgentModelSupportsReasoning,
		agentReasoningEffortOptions,
		setAgentReasoningEffortOverride,
	]);

	const modelPickerOptions = useMemo(() => {
		const defaultOption = clineModelOptions.find((option) => option.value === "");
		const explicitOptions = clineModelOptions.filter((option) => option.value !== "");
		const providerId = (effectiveProviderId ?? "").trim();

		if (!providerId || explicitOptions.length === 0) {
			return {
				options: defaultOption ? [defaultOption, ...explicitOptions] : explicitOptions,
				recommendedModelIds: [] as string[],
				shouldPinSelectedModelToTop: true,
			};
		}

		const orderedOptions = buildClineAgentModelPickerOptions(providerId, providerModels);
		const explicitOptionByValue = new Map(explicitOptions.map((option) => [option.value, option] as const));
		const orderedExplicit = orderedOptions.options
			.map((option) => explicitOptionByValue.get(option.value))
			.filter((option): option is { value: string; label: string } => option !== undefined);
		const orderedExplicitValueSet = new Set(orderedExplicit.map((option) => option.value));
		const remainingExplicit = explicitOptions.filter((option) => !orderedExplicitValueSet.has(option.value));

		return {
			options: defaultOption ? [defaultOption, ...orderedExplicit, ...remainingExplicit] : orderedExplicit,
			recommendedModelIds: orderedOptions.recommendedModelIds,
			shouldPinSelectedModelToTop: orderedOptions.shouldPinSelectedModelToTop,
		};
	}, [clineModelOptions, effectiveProviderId, providerModels]);

	const reasoningEnabledModelIds = useMemo(() => getClineReasoningEnabledModelIds(providerModels), [providerModels]);
	const reasoningEnabledModelIdSet = useMemo(() => new Set(reasoningEnabledModelIds), [reasoningEnabledModelIds]);
	const effectiveSelectedModelId = (clineModelId ?? effectiveDefaultModelId ?? "").trim();
	const selectedModelCapabilityKnown = useMemo(
		() => providerModels.some((model) => model.id === effectiveSelectedModelId),
		[effectiveSelectedModelId, providerModels],
	);
	const selectedModelSupportsReasoningEffort = reasoningEnabledModelIdSet.has(effectiveSelectedModelId);

	useEffect(() => {
		if (!hasTaskClineSettingsOverride) {
			return;
		}
		if (selectedTaskReasoningEffort !== reasoningEffort) {
			setReasoningEffort(selectedTaskReasoningEffort);
		}
	}, [hasTaskClineSettingsOverride, reasoningEffort, selectedTaskReasoningEffort]);

	useEffect(() => {
		if (hasTaskClineSettingsOverride) {
			return;
		}
		const inheritedReasoningEffort = defaultReasoningEffort ?? "";
		if (reasoningEffort !== inheritedReasoningEffort) {
			setReasoningEffort(inheritedReasoningEffort);
		}
	}, [defaultReasoningEffort, hasTaskClineSettingsOverride, reasoningEffort]);

	useEffect(() => {
		if (!isSettingsExpanded) {
			setIsProviderPopoverOpen(false);
			setIsModelPopoverOpen(false);
		}
	}, [isSettingsExpanded]);

	useEffect(() => {
		onPopoverOpenChange?.(isProviderPopoverOpen || isModelPopoverOpen);
	}, [isModelPopoverOpen, isProviderPopoverOpen, onPopoverOpenChange]);

	useEffect(() => {
		if (!selectedModelCapabilityKnown) {
			return;
		}
		if (!selectedModelSupportsReasoningEffort && reasoningEffort) {
			setReasoningEffortWithOverride("");
		}
	}, [
		reasoningEffort,
		selectedModelCapabilityKnown,
		selectedModelSupportsReasoningEffort,
		setReasoningEffortWithOverride,
	]);

	const selectedModelButtonText = useMemo(
		() =>
			buildClineSelectedModelButtonText({
				modelOptions: modelPickerOptions.options,
				selectedModelId: clineModelId ?? "",
				reasoningEffort,
				showReasoningEffort: selectedModelSupportsReasoningEffort,
				isModelLoading: isLoadingModels,
			}),
		[
			clineModelId,
			isLoadingModels,
			modelPickerOptions.options,
			reasoningEffort,
			selectedModelSupportsReasoningEffort,
		],
	);

	// When models finish loading and the currently selected model isn't in the
	// options list, auto-select the first real model so the button never shows
	// "No models available". Pick the first non-empty option (skipping the
	// "Default" placeholder) so the user immediately sees a concrete model name.
	//
	// Guard: also skip when model options only contains the "Default"
	// placeholder (length <= 1). This prevents a race condition where the
	// effect fires on the initial render before models have been fetched —
	// at that point isLoadingModels is still false (hasn't been set to true
	// yet by the fetch effect) and the stale/empty options list would
	// incorrectly clear a valid saved clineModelId.
	useEffect(() => {
		if (isLoadingModels || !clineModelId || modelPickerOptions.options.length <= 1) {
			return;
		}
		const modelExists = modelPickerOptions.options.some((opt) => opt.value === clineModelId);
		if (!modelExists) {
			const firstRealModel = modelPickerOptions.options.find((opt) => opt.value !== "");
			updateTaskClineSettings((currentSettings) => {
				const nextSettings = cloneTaskClineSettings(currentSettings) ?? {};
				if (firstRealModel?.value) {
					nextSettings.modelId = firstRealModel.value;
					return nextSettings;
				}
				delete nextSettings.modelId;
				const preserveEmptyOverride = currentSettings !== undefined && Object.keys(currentSettings).length === 0;
				return nextSettings.providerId || nextSettings.reasoningEffort || preserveEmptyOverride
					? nextSettings
					: undefined;
			});
		}
	}, [clineModelId, isLoadingModels, modelPickerOptions.options, updateTaskClineSettings]);

	return (
		<div className="flex flex-col gap-2">
			<Collapsible.Root open={isSettingsExpanded} onOpenChange={setIsSettingsExpanded}>
				<Collapsible.Trigger asChild>
					<button
						type="button"
						className="inline-flex w-fit items-center gap-1 text-[12px] text-text-secondary hover:text-text-primary cursor-pointer bg-transparent border-none p-0"
					>
						<ChevronDown
							size={12}
							className={cn("transition-transform", isSettingsExpanded ? "rotate-0" : "-rotate-90")}
						/>
						Override Agent Settings
					</button>
				</Collapsible.Trigger>
				<Collapsible.Content className="pt-2">
					<div className="flex flex-col gap-2">
						<div className="w-full sm:w-1/2 min-w-0">
							<span className="text-[11px] text-text-secondary block mb-1">Agent</span>
							<NativeSelect
								size="sm"
								fill
								value={agentId ?? ""}
								onChange={(e) => {
									const value = e.currentTarget.value;
									const nextAgentId = value ? (value as RuntimeAgentId) : undefined;
									const nextEffectiveAgentId = nextAgentId ?? defaultAgentId ?? null;
									onAgentIdChange(nextAgentId);
									if (nextEffectiveAgentId !== "cline") {
										onClineSettingsChange?.(undefined);
										setReasoningEffort("");
									}
									// Model/reasoning overrides are agent-specific (a copilot model
									// id is not valid for codex and vice-versa), so clear them
									// whenever the effective agent actually changes.
									if (nextEffectiveAgentId !== effectiveAgentId) {
										onAgentSettingsChange?.(undefined);
									}
								}}
							>
								{agentOptions.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</NativeSelect>
						</div>
						{showClineProviderPicker ? (
							<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
								<div className="min-w-0">
									<span className="text-[11px] text-text-secondary block mb-1">
										Provider{isLoadingProviders ? " (loading\u2026)" : ""}
									</span>
									<SearchSelectDropdown
										options={clineProviderOptions}
										selectedValue={clineProviderId ?? ""}
										onSelect={(value) => {
											const newProviderId = value || undefined;
											const newDefaultModel =
												newProviderId && providerDefaultModels
													? providerDefaultModels[newProviderId]
													: undefined;
											updateTaskClineSettings((currentSettings) => {
												const nextSettings = cloneTaskClineSettings(currentSettings) ?? {};
												if (newProviderId) {
													nextSettings.providerId = newProviderId;
												} else {
													delete nextSettings.providerId;
												}
												if (newDefaultModel) {
													nextSettings.modelId = newDefaultModel;
												} else {
													delete nextSettings.modelId;
												}
												delete nextSettings.reasoningEffort;
												const preserveEmptyOverride =
													newProviderId !== undefined ||
													(currentSettings !== undefined && Object.keys(currentSettings).length === 0);
												return nextSettings.providerId || nextSettings.modelId || preserveEmptyOverride
													? nextSettings
													: undefined;
											});
											setReasoningEffort(
												newProviderId ||
													(clineSettings !== undefined && Object.keys(clineSettings).length === 0)
													? ""
													: (defaultReasoningEffort ?? ""),
											);
										}}
										disabled={isLoadingProviders}
										fill
										size="sm"
										placeholder="Search providers..."
										emptyText="No providers available"
										noResultsText="No matching providers"
										showSelectedIndicator
										onPopoverOpenChange={setIsProviderPopoverOpen}
									/>
								</div>
								{showClineModelPicker ? (
									<div className="min-w-0">
										<span className="text-[11px] text-text-secondary block mb-1">
											Model{isLoadingModels ? " (loading\u2026)" : ""}
										</span>
										<ClineChatModelSelector
											modelOptions={modelPickerOptions.options}
											recommendedModelIds={modelPickerOptions.recommendedModelIds}
											pinSelectedModelToTop={modelPickerOptions.shouldPinSelectedModelToTop}
											selectedModelId={clineModelId ?? ""}
											selectedModelButtonText={selectedModelButtonText}
											onSelectModel={(value) => {
												updateTaskClineSettings((currentSettings) => {
													const nextSettings = cloneTaskClineSettings(currentSettings) ?? {};
													if (value) {
														nextSettings.modelId = value;
													} else {
														delete nextSettings.modelId;
													}
													if (!value || !reasoningEnabledModelIdSet.has(value)) {
														delete nextSettings.reasoningEffort;
													}
													const preserveEmptyOverride =
														currentSettings !== undefined && Object.keys(currentSettings).length === 0;
													return nextSettings.providerId ||
														nextSettings.modelId ||
														nextSettings.reasoningEffort ||
														preserveEmptyOverride
														? nextSettings
														: undefined;
												});
												if (!value && !clineProviderId) {
													setReasoningEffort(
														clineSettings !== undefined && Object.keys(clineSettings).length === 0
															? ""
															: (defaultReasoningEffort ?? ""),
													);
													return;
												}
												if (!value || !reasoningEnabledModelIdSet.has(value)) {
													setReasoningEffortWithOverride("");
												}
											}}
											reasoningEnabledModelIds={reasoningEnabledModelIds}
											defaultOptionSupportsReasoningEffort={
												!clineModelId && selectedModelSupportsReasoningEffort
											}
											selectedReasoningEffort={reasoningEffort}
											onSelectReasoningEffort={(nextReasoningEffort) =>
												setReasoningEffortWithOverride(nextReasoningEffort)
											}
											disabled={isLoadingModels}
											isModelLoading={isLoadingModels}
											fill
											triggerVariant="default"
											onPopoverOpenChange={setIsModelPopoverOpen}
										/>
									</div>
								) : null}
							</div>
						) : null}
						{showAgentModelSettings ? (
							<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
								<div className="min-w-0">
									<label className="text-[11px] text-text-secondary block mb-1" htmlFor={agentModelSelectId}>
										Model
									</label>
									<NativeSelect
										id={agentModelSelectId}
										size="sm"
										fill
										value={agentModelId}
										disabled={isLoadingAgentModels && agentModels.length === 0}
										onChange={(event) => {
											setAgentModelOverride(event.currentTarget.value);
										}}
									>
										<option value="">{isLoadingAgentModels ? "Loading…" : "Default"}</option>
										{agentModels.map((model) => (
											<option key={model.id} value={model.id}>
												{model.label}
											</option>
										))}
										{agentModelId && !agentModels.some((model) => model.id === agentModelId) ? (
											<option value={agentModelId}>{agentModelId}</option>
										) : null}
									</NativeSelect>
								</div>
								{selectedAgentModelSupportsReasoning ? (
									<div className="min-w-0">
										<label
											className="text-[11px] text-text-secondary block mb-1"
											htmlFor={agentReasoningSelectId}
										>
											Reasoning effort
										</label>
										<NativeSelect
											id={agentReasoningSelectId}
											size="sm"
											fill
											value={agentReasoningEffort}
											onChange={(event) => {
												setAgentReasoningEffortOverride(event.currentTarget.value);
											}}
										>
											<option value="">
												{selectedAgentModel?.defaultReasoningEffort
													? `Default (${selectedAgentModel.defaultReasoningEffort})`
													: "Default"}
											</option>
											{agentReasoningEffortOptions.map((effort) => (
												<option key={effort} value={effort}>
													{effort}
												</option>
											))}
										</NativeSelect>
									</div>
								) : null}
							</div>
						) : null}
					</div>
				</Collapsible.Content>
			</Collapsible.Root>
		</div>
	);
}
