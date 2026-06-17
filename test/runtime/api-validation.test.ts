import { describe, expect, it } from "vitest";
import { runtimeAgentIdSchema, runtimeBoardDataSchema } from "../../src/core/api-contract";
import {
	parseHookIngestRequest,
	parseTaskSessionStartRequest,
	parseWorkspaceFileSearchRequest,
} from "../../src/core/api-validation";

const COPILOT_REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;

describe("parseWorkspaceFileSearchRequest", () => {
	it("parses q and limit", () => {
		const parsed = parseWorkspaceFileSearchRequest(new URLSearchParams({ q: "  src/runtime ", limit: "25" }));
		expect(parsed).toEqual({
			query: "src/runtime",
			limit: 25,
		});
	});

	it("treats missing q as empty query", () => {
		const parsed = parseWorkspaceFileSearchRequest(new URLSearchParams({ limit: "10" }));
		expect(parsed).toEqual({
			query: "",
		});
	});

	it("does not accept legacy query alias", () => {
		const parsed = parseWorkspaceFileSearchRequest(new URLSearchParams({ query: "legacy" }));
		expect(parsed).toEqual({
			query: "",
		});
	});

	it("throws when limit is invalid", () => {
		expect(() => {
			parseWorkspaceFileSearchRequest(new URLSearchParams({ q: "board", limit: "0" }));
		}).toThrow("Invalid file search limit parameter.");
	});
});

describe("parseHookIngestRequest", () => {
	it("parses and trims task and workspace identifiers", () => {
		const parsed = parseHookIngestRequest({
			taskId: "  task-123  ",
			workspaceId: "  workspace-456  ",
			event: "to_review",
			metadata: {
				source: " claude ",
				activityText: " Using Read ",
			},
		});
		expect(parsed).toEqual({
			taskId: "task-123",
			workspaceId: "workspace-456",
			event: "to_review",
			metadata: {
				source: "claude",
				activityText: "Using Read",
				hookEventName: undefined,
				toolName: undefined,
				finalMessage: undefined,
				notificationType: undefined,
			},
		});
	});

	it("throws when workspaceId is missing", () => {
		expect(() => {
			parseHookIngestRequest({
				taskId: "task-1",
				workspaceId: "   ",
				event: "to_review",
			});
		}).toThrow("Missing workspaceId");
	});
});

describe("parseTaskSessionStartRequest", () => {
	it("parses resumeFromTrash and trims task identifiers", () => {
		const parsed = parseTaskSessionStartRequest({
			taskId: "  task-1  ",
			prompt: "",
			baseRef: "  main  ",
			resumeFromTrash: true,
		});
		expect(parsed).toEqual({
			taskId: "task-1",
			prompt: "",
			baseRef: "main",
			resumeFromTrash: true,
		});
	});

	it("accepts copilot as a runtime agent id", () => {
		expect(runtimeAgentIdSchema.safeParse("copilot").success).toBe(true);
	});

	it("parses Copilot model and reasoning settings through startTaskSession", () => {
		const parsed = parseTaskSessionStartRequest({
			taskId: "  task-1  ",
			prompt: "Implement the Copilot adapter",
			baseRef: "  main  ",
			agentId: "copilot",
			agentSettings: {
				modelId: "gpt-5.2",
				reasoningEffort: "max",
			},
		});

		expect(parsed).toEqual({
			taskId: "task-1",
			prompt: "Implement the Copilot adapter",
			baseRef: "main",
			agentId: "copilot",
			agentSettings: {
				modelId: "gpt-5.2",
				reasoningEffort: "max",
			},
		});
	});

	it("accepts the Copilot CLI reasoning effort levels from local copilot --help", () => {
		for (const reasoningEffort of COPILOT_REASONING_EFFORTS) {
			expect(() =>
				parseTaskSessionStartRequest({
					taskId: "task-1",
					prompt: "Implement the Copilot adapter",
					baseRef: "main",
					agentId: "copilot",
					agentSettings: {
						modelId: "gpt-5.2",
						reasoningEffort,
					},
				}),
			).not.toThrow();
		}
	});

	it("accepts an arbitrary agent reasoning effort string (validated per-model in the UI)", () => {
		// Reasoning efforts are now sourced live per-model from each agent's own
		// catalog (copilot via its SDK, codex via its on-disk cache), so the
		// contract no longer pins a fixed enum — the UI constrains choices to the
		// selected model's declared efforts. Codex, for example, exposes no
		// "none"/"max" levels, so a shared enum would be wrong.
		expect(() =>
			parseTaskSessionStartRequest({
				taskId: "task-1",
				prompt: "Implement the Codex adapter",
				baseRef: "main",
				agentId: "codex",
				agentSettings: {
					modelId: "gpt-5.5",
					reasoningEffort: "xhigh",
				},
			}),
		).not.toThrow();
	});

	it("preserves generic task agent settings through board state normalization", () => {
		const parsed = runtimeBoardDataSchema.parse({
			columns: [
				{
					id: "backlog",
					title: "Backlog",
					cards: [
						{
							id: "task-1",
							title: "Copilot task",
							prompt: "Implement the Copilot adapter",
							startInPlanMode: false,
							agentId: "copilot",
							agentSettings: {
								modelId: "gpt-5.2",
								reasoningEffort: "xhigh",
							},
							baseRef: "main",
							createdAt: 1,
							updatedAt: 1,
						},
					],
				},
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "trash", title: "Done", cards: [] },
			],
			dependencies: [],
		});

		expect(parsed.columns[0]?.cards[0]).toEqual(
			expect.objectContaining({
				agentId: "copilot",
				agentSettings: {
					modelId: "gpt-5.2",
					reasoningEffort: "xhigh",
				},
			}),
		);
	});
});
