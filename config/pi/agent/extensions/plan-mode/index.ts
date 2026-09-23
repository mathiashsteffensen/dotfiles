/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, only explicitly allowed, already-active read-only tools remain.
 *
 * Features:
 * - /plan command or Ctrl+Alt+P to toggle
 * - Bash uses auto-approve's read-only sandbox while planning
 * - Extracts numbered plan steps from "Plan:" sections
 * - [DONE:n] markers to complete steps during execution
 * - Compact plan preview and progress widget
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Key, truncateToWidth } from "@earendil-works/pi-tui";
import {
	cleanStepText,
	extractTodoItems,
	getPlanModeTools,
	isPlanModeBlockedTool,
	markCompletedSteps,
	type TodoItem,
} from "./utils.ts";

interface PlanModeState {
	enabled: boolean;
	todos?: TodoItem[];
	executing?: boolean;
	toolsBeforePlanMode?: string[];
}

// Type guard for assistant messages
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

// Extract text content from an assistant message
function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];
	let toolsBeforePlanMode: string[] | undefined;
	const trustedPaths: Record<string, string> = {
		bash: realpathSync(fileURLToPath(new URL("../auto-approve/index.ts", import.meta.url))),
		ask_user_question: realpathSync(fileURLToPath(new URL("../ask-user-question.ts", import.meta.url))),
	};

	function trustedTool(name: string, mode: ExtensionContext["mode"] = "tui"): boolean {
		if (isPlanModeBlockedTool(name)) return false;
		if (name === "ask_user_question" && mode !== "tui") return false;
		const info = pi.getAllTools().find((tool) => tool.name === name);
		if (!info) return false;
		if (["read", "grep", "find", "ls"].includes(name)) return info.sourceInfo.source === "builtin";
		try {
			return realpathSync(info.sourceInfo.path) === trustedPaths[name];
		} catch {
			return false;
		}
	}

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		// Footer status
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((t) => t.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `· 📋 ${completed}/${todoItems.length}`));
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", "· ") + ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		// Keep the editor uncluttered; /todos shows the full plan.
		if (todoItems.length > 0) {
			const completed = todoItems.filter((t) => t.completed).length;
			const lines = [`Plan · ${completed}/${todoItems.length} · /todos · /plan execute`];
			for (const item of todoItems.slice(0, 4)) {
				lines.push(`${item.completed ? "✓" : "○"} ${item.step}. ${cleanStepText(item.text)}`);
			}
			if (todoItems.length > 4) lines.push(`… ${todoItems.length - 4} more steps`);
			if (ctx.mode === "tui") {
				ctx.ui.setWidget("plan-todos", (_tui, theme) => ({
					render: (width: number) => lines.map((line, i) => truncateToWidth(theme.fg(i === 0 ? "accent" : "muted", line), width)),
					invalidate() {},
				}));
			} else ctx.ui.setWidget("plan-todos", lines);
		} else ctx.ui.setWidget("plan-todos", undefined);
	}

	function enablePlanModeTools(ctx: Pick<ExtensionContext, "mode">): void {
		if (toolsBeforePlanMode === undefined) {
			toolsBeforePlanMode = pi.getActiveTools();
		}
		const planTools = getPlanModeTools(toolsBeforePlanMode).filter((name) => trustedTool(name, ctx.mode));
		pi.setActiveTools(ctx.mode === "tui" ? planTools : planTools.filter((name) => name !== "ask_user_question"));
	}

	function restoreNormalModeTools(): void {
		if (toolsBeforePlanMode !== undefined) pi.setActiveTools(toolsBeforePlanMode);
		toolsBeforePlanMode = undefined;
	}

	function publishMode(): void {
		pi.events.emit("plan-mode:state", { enabled: planModeEnabled });
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			todos: todoItems,
			executing: executionMode,
			toolsBeforePlanMode,
		});
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		if (!ctx.isIdle()) {
			ctx.ui.notify("Wait for the current turn to finish (or abort it) before changing plan mode.", "warning");
			return;
		}
		planModeEnabled = !planModeEnabled;
		executionMode = false;
		todoItems = [];

		if (planModeEnabled) {
			enablePlanModeTools(ctx);
			ctx.ui.notify("Plan mode enabled. Bash, when available, uses a read-only sandbox; no escalation.");
		} else {
			restoreNormalModeTools();
			ctx.ui.notify("Plan mode disabled. Full access restored.");
		}
		publishMode();
		updateStatus(ctx);
		persistState();
	}

	async function executePlan(ctx: ExtensionContext, offeredPlan: TodoItem[]): Promise<void> {
		const confirmed = await ctx.ui.confirm(
			"Execute this plan with full tool access?",
			offeredPlan.map((t) => `${t.step}. ${t.text}`).join("\n"),
		);
		if (!confirmed || !planModeEnabled || todoItems !== offeredPlan) return;
		const firstTodoItem = todoItems[0];
		if (!firstTodoItem) return;

		planModeEnabled = false;
		executionMode = true;
		restoreNormalModeTools();
		publishMode();
		updateStatus(ctx);
		persistState();

		const remainingList = todoItems.map((t) => `${t.step}. ${t.text}`).join("\n");
		pi.sendMessage({
			customType: "plan-todo-list",
			content: `**Plan Steps (${todoItems.length}):**\n\n${remainingList}`,
			display: true,
		}, { deliverAs: "followUp" });
		pi.sendMessage({
			customType: "plan-mode-execute",
			content: `Execute the plan.\n\nRemaining steps:\n${remainingList}\n\nStart with: ${firstTodoItem.text}\nAfter completing a step, put [DONE:n] on its own line in your response.`,
			display: true,
		}, { triggerTurn: true, deliverAs: "followUp" });
	}

	pi.registerCommand("plan", {
		description: "Toggle plan mode, or /plan execute to review and run the current plan",
		handler: async (args, ctx) => {
			if (args.trim() === "execute") {
				if (!planModeEnabled || todoItems.length === 0 || !ctx.hasUI) {
					ctx.ui.notify("Draft a plan in interactive plan mode before executing it.", "warning");
					return;
				}
				await executePlan(ctx, todoItems);
			} else if (!args.trim()) togglePlanMode(ctx);
			else ctx.ui.notify("Usage: /plan [execute]", "warning");
		},
	});

	pi.registerCommand("todos", {
		description: "Show current plan todo list",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No todos. Create a plan first with /plan", "info");
				return;
			}
			const list = todoItems.map((item, i) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
			ctx.ui.notify(`Plan Progress:\n${list}`, "info");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// Defense in depth for calls from a turn that started before Plan Mode was enabled.
	pi.on("tool_call", async (event, ctx) => {
		if (!planModeEnabled || trustedTool(event.toolName, ctx.mode)) return;

		return {
			block: true,
			reason: `Plan mode: ${event.toolName} is disabled. Use /plan to disable plan mode first.`,
		};
	});

	// Filter out stale plan mode context when not in plan mode
	pi.on("context", async (event) => {
		if (planModeEnabled) return;

		return {
			messages: event.messages.filter((message) =>
				(message as AgentMessage & { customType?: string }).customType !== "plan-mode-context",
			),
		};
	});

	// Inject plan/execution context before agent starts
	pi.on("before_agent_start", async (_event, ctx) => {
		if (planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- Only already-active trusted read, grep, find, ls, bash, and (interactive only) ask_user_question are allowed
- Bash runs in auto-approve's read-only, network-denied sandbox; no unsandboxed retry is available
- Writes, subagents, and all other tools are disabled

${ctx.mode === "tui" && pi.getActiveTools().includes("ask_user_question") ? "Ask clarifying questions using ask_user_question." : "Ask clarifying questions in ordinary text."}
Use available read-only tools for code analysis. Shell commands that write files (including caches) will fail.

Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes - just describe what you would do.`,
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((t) => !t.completed);
			const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Execute each step in order.
After completing a step, put [DONE:n] on its own line in your response.`,
					display: false,
				},
			};
		}
	});

	// Track progress after each turn
	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		if (markCompletedSteps(text, todoItems) > 0) {
			updateStatus(ctx);
		}
		persistState();
	});

	// Handle plan completion and plan mode UI
	pi.on("agent_end", async (event, ctx) => {
		// Check if execution is complete
		if (executionMode && todoItems.length > 0) {
			if (todoItems.every((t) => t.completed)) {
				const completedList = todoItems.map((t) => `~~${t.text}~~`).join("\n");
				pi.sendMessage(
					{ customType: "plan-complete", content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
					{ triggerTurn: false },
				);
				executionMode = false;
				todoItems = [];
				updateStatus(ctx);
				persistState(); // Save cleared state so resume doesn't restore old execution mode
			}
			return;
		}

		if (!planModeEnabled) return;

		// Only offer a plan when the current response produced one, not on every later turn.
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		const extracted = lastAssistant && (!lastAssistant.stopReason || lastAssistant.stopReason === "stop")
			? extractTodoItems(getTextContent(lastAssistant)) : [];
		if (extracted.length === 0) return;
		todoItems = extracted;
		persistState();
		updateStatus(ctx);
		if (ctx.mode !== "tui") return;

		// Show plan steps and prompt for next action
		const todoListText = todoItems.map((t, i) => `${i + 1}. ☐ ${t.text}`).join("\n");
		const planTodoListMessage = {
			customType: "plan-todo-list",
			content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
			display: true,
		};

		const offeredPlan = todoItems;
		const choice = await ctx.ui.select(`Plan ready (${todoItems.length} steps) · /plan execute later`, [
			"Stay in plan mode",
			"Review and execute",
			"Refine the plan",
		]);
		if (!planModeEnabled || todoItems !== offeredPlan) return;

		if (choice === "Review and execute") {
			await executePlan(ctx, offeredPlan);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (!planModeEnabled || todoItems !== offeredPlan) return;
			if (refinement?.trim()) {
				pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		}
	});

	// Undo the previous branch's tool restriction before restoring the active branch.
	function restoreState(ctx: ExtensionContext, startInPlanMode = false): void {
		restoreNormalModeTools();
		const normalTools = pi.getActiveTools();
		const entries = ctx.sessionManager.getBranch();

		// Restore persisted state
		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: PlanModeState } | undefined;

		planModeEnabled = planModeEntry?.data?.enabled ?? false;
		todoItems = planModeEntry?.data?.todos?.map((item) => ({ ...item })) ?? [];
		executionMode = planModeEntry?.data?.executing ?? false;

		if (startInPlanMode) {
			planModeEnabled = true;
			executionMode = false;
		}

		// On resume: re-scan messages to rebuild completion state
		// Only scan messages AFTER the last "plan-mode-execute" to avoid picking up [DONE:n] from previous plans
		const isResume = planModeEntry !== undefined;
		if (isResume && executionMode && todoItems.length > 0) {
			// Find the index of the last plan-mode-execute entry (marks when current execution started)
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { type: string; customType?: string };
				if (entry.customType === "plan-mode-execute") {
					executeIndex = i;
					break;
				}
			}

			// Only scan messages after the execute marker
			const messages: AssistantMessage[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i];
				if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message as AgentMessage)) {
					messages.push(entry.message as AssistantMessage);
				}
			}
			const allText = messages.map(getTextContent).join("\n");
			markCompletedSteps(allText, todoItems);
		}

		if (planModeEnabled) {
			const savedTools = planModeEntry?.data?.toolsBeforePlanMode;
			toolsBeforePlanMode = savedTools ? normalTools.filter((name) => savedTools.includes(name)) : normalTools;
			enablePlanModeTools(ctx);
		}
		publishMode();
		updateStatus(ctx);
	}

	pi.on("session_start", (_event, ctx) => restoreState(ctx, pi.getFlag("plan") === true));
	pi.on("session_tree", (_event, ctx) => restoreState(ctx));
}
