/**
 * Pure utility functions for plan mode.
 * Extracted for testability.
 */

export const PLAN_MODE_TOOLS = ["read", "grep", "find", "ls", "bash", "ask_user_question"];
export function isPlanModeBlockedTool(toolName: string): boolean {
	return !PLAN_MODE_TOOLS.includes(toolName);
}

export function getPlanModeTools(activeToolNames: string[]): string[] {
	return activeToolNames.filter((name) => !isPlanModeBlockedTool(name));
}

export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

export function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // Remove bold/italic
		.replace(/`([^`]+)`/g, "$1") // Remove code
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	if (cleaned.length > 50) {
		cleaned = `${cleaned.slice(0, 47)}...`;
	}
	return cleaned;
}

export function extractTodoItems(message: string): TodoItem[] {
	const items: TodoItem[] = [];
	const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!headerMatch) return items;

	const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
	let inCodeBlock = false;
	for (const line of planSection.split("\n")) {
		if (/^\s*```/.test(line)) {
			inCodeBlock = !inCodeBlock;
			continue;
		}
		if (inCodeBlock) continue;
		if (/^\s*(?:#{1,6}\s+)?[\w][^\n]*:\s*$/.test(line) || /^\s*#{1,6}\s+\S/.test(line)) break;
		const match = line.match(/^(\d+)[.)]\s+(.+?)\s*$/);
		if (match) {
			const text = match[2].trim();
			if (text.length > 3) items.push({ step: items.length + 1, text, completed: false });
		} else if (/^\s{2,}\S/.test(line) && items.length > 0) {
			items[items.length - 1].text += `\n${line.trim()}`;
		}
	}
	return items;
}

export function extractDoneSteps(message: string): number[] {
	const steps: number[] = [];
	let inCodeBlock = false;
	for (const line of message.split("\n")) {
		if (/^\s*```/.test(line)) {
			inCodeBlock = !inCodeBlock;
			continue;
		}
		if (inCodeBlock) continue;
		const match = line.match(/^\s*\[DONE:(\d+)\]\s*$/i);
		if (match) steps.push(Number(match[1]));
	}
	return steps;
}

export function markCompletedSteps(text: string, items: TodoItem[]): number {
	const doneSteps = extractDoneSteps(text);
	let changed = 0;
	for (const step of doneSteps) {
		const item = items.find((t) => t.step === step);
		if (item && !item.completed) {
			item.completed = true;
			changed++;
		}
	}
	return changed;
}
