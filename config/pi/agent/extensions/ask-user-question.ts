/**
 * Structured clarification tool for Pi.
 *
 * Presents selectable options, an optional multi-select mode, a free-text
 * fallback, and a way for the user to defer the decision to conversation.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	Key,
	matchesKey,
	type EditorTheme,
	type Focusable,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

const MAX_VISIBLE_OPTIONS = 10;
const TYPE_SOMETHING = "Type something.";
const CHAT_ABOUT_THIS = "Chat about this";
const NO_INPUT = "(no input)";
const NAVIGATION_HINT = "↑↓ navigate · Enter select · Esc cancel";
const MULTISELECT_HINT = "↑↓ navigate · Space toggle · Enter confirm · Esc cancel";

type Answer = string | string[] | null;

interface Option {
	label: string;
	description?: string;
}

interface QuestionDetails {
	question: string;
	header?: string;
	options: string[];
	answer: Answer;
	multiSelect: boolean;
	wasCustom?: boolean;
	wasChat?: boolean;
	cancelled?: boolean;
}

type DisplayOption = Option & {
	isOther?: boolean;
	isChat?: boolean;
};

const OptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below the label" })),
});

const QuestionSchema = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	header: Type.Optional(Type.String({ description: "Optional short header shown above the question" })),
	options: Type.Array(OptionSchema, { description: "Selectable options" }),
	multiSelect: Type.Optional(Type.Boolean({ description: "Allow multiple options to be selected", default: false })),
});

export default function askUserQuestion(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User Question",
		description:
			"Ask the user a structured question with selectable options. Use when you need a concrete decision to proceed, such as choosing an approach, resolving ambiguity, or confirming scope. The user can select an option, choose multiple options, type a custom answer, or ask to discuss the decision.",
		promptSnippet: "Ask the user a structured question when requirements are ambiguous",
		promptGuidelines: [
			"Use ask_user_question when the request is underspecified and you cannot safely proceed without a concrete decision.",
			"Prefer ask_user_question over asking for clarification in prose; its answer is recorded in the session and the user gets concrete options.",
			"Set multiSelect to true only when more than one option may be selected independently.",
		],
		parameters: QuestionSchema,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const details = {
				question: params.question,
				header: params.header,
				options: params.options.map((option) => option.label),
				answer: null,
				multiSelect: params.multiSelect === true,
			} satisfies QuestionDetails;

			if (ctx.mode !== "tui") {
				throw new Error("UI not available (running in non-interactive mode)");
			}
			if (params.options.length === 0) {
				throw new Error("No options provided");
			}

			let aborted = signal?.aborted ?? false;
			let dismiss: (() => void) | undefined;
			const onAbort = () => {
				aborted = true;
				dismiss?.();
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();

			const openUi = () => ctx.ui.custom<SelectionResult | null>((tui, theme, keybindings, done) => {
				dismiss = () => done(null);
				if (aborted) queueMicrotask(dismiss);
				const options: DisplayOption[] = [
					...params.options,
					{ label: TYPE_SOMETHING, isOther: true },
					{ label: CHAT_ABOUT_THIS, isChat: true },
				];
				const multiSelect = params.multiSelect === true;
				const selected = new Set<number>();
				let selectedIndex = 0;
				let editing = false;
				let cachedLines: string[] | undefined;
				let cachedWidth: number | undefined;
				let focused = false;

				const editorTheme: EditorTheme = {
					borderColor: (s: string) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (text: string) => theme.fg("accent", text),
						selectedText: (text: string) => theme.fg("accent", text),
						description: (text: string) => theme.fg("muted", text),
						scrollInfo: (text: string) => theme.fg("dim", text),
						noMatch: (text: string) => theme.fg("warning", text),
					},
				};
				const editor = new Editor(tui, editorTheme);

				const invalidate = () => {
					editor.invalidate();
					cachedLines = undefined;
					cachedWidth = undefined;
				};

				const refresh = () => {
					invalidate();
					tui.requestRender();
				};

				const getSelectedLabels = () => [...selected].sort((a, b) => a - b)
					.map((index) => options[index]?.label)
					.filter((label): label is string => label !== undefined);

				const finish = () => {
					const selectedLabels = getSelectedLabels();
					if (selectedLabels.length === 0) return;
					done({ answer: multiSelect ? selectedLabels : selectedLabels[0]!, wasCustom: false });
				};

				editor.onSubmit = (value) => {
					const trimmed = value.trim();
					if (!trimmed) {
						editing = false;
						editor.setText("");
						refresh();
						return;
					}

					const selectedLabels = getSelectedLabels();
					selectedLabels.push(trimmed);
					done({ answer: multiSelect ? selectedLabels : trimmed, wasCustom: true });
				};

				const openEditor = () => {
					editing = true;
					editor.setText("");
					refresh();
				};

				const selectCurrent = () => {
					const current = options[selectedIndex];
					if (!current || current.isOther || current.isChat) return;
					if (multiSelect) {
						if (selected.has(selectedIndex)) selected.delete(selectedIndex);
						else selected.add(selectedIndex);
						refresh();
						return;
					}
					done({ answer: current.label, wasCustom: false });
				};

				const move = (amount: number) => {
					selectedIndex = (selectedIndex + amount + options.length) % options.length;
					refresh();
				};

				const handleInput = (data: string) => {
					if (editing) {
						if (matchesKey(data, Key.escape)) {
							editing = false;
							editor.setText("");
							refresh();
							return;
						}
						if (keybindings.matches(data, "tui.select.cancel")) {
							done(null);
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					if (keybindings.matches(data, "tui.select.up")) {
						move(-1);
						return;
					}
					if (keybindings.matches(data, "tui.select.down")) {
						move(1);
						return;
					}
					if (multiSelect && matchesKey(data, Key.space)) {
						const current = options[selectedIndex];
						if (current?.isOther) openEditor();
						else selectCurrent();
						return;
					}
					if (keybindings.matches(data, "tui.select.confirm")) {
						const current = options[selectedIndex];
						if (current?.isChat) {
							done({ answer: "User wants to chat about this", wasChat: true });
						} else if (current?.isOther) {
							openEditor();
						} else if (multiSelect) {
							if (selected.size === 0) selected.add(selectedIndex);
							finish();
						} else {
							selectCurrent();
						}
						return;
					}
					if (keybindings.matches(data, "tui.select.cancel")) done(null);
				};

				const addWrapped = (lines: string[], text: string, width: number) => {
					lines.push(...wrapTextWithAnsi(text, width));
				};

				const addWrappedWithPrefix = (lines: string[], prefix: string, text: string, width: number) => {
					const prefixWidth = visibleWidth(prefix);
					if (prefixWidth >= width) {
						addWrapped(lines, prefix + text, width);
						return;
					}
					const wrapped = wrapTextWithAnsi(text, width - prefixWidth);
					const continuation = " ".repeat(prefixWidth);
					wrapped.forEach((line, index) => lines.push(`${index === 0 ? prefix : continuation}${line}`));
				};

				const render = (width: number): string[] => {
					const renderWidth = Math.max(1, width);
					if (cachedLines && cachedWidth === renderWidth) return cachedLines;
					const lines: string[] = [theme.fg("accent", "─".repeat(renderWidth))];
					if (params.header) {
						addWrappedWithPrefix(lines, " ", theme.bg("selectedBg", ` ${params.header} `), renderWidth);
						lines.push("");
					}
					addWrappedWithPrefix(lines, " ", theme.bold(params.question), renderWidth);
					lines.push("");

					const firstVisible = Math.max(0, Math.min(
						selectedIndex - Math.floor(MAX_VISIBLE_OPTIONS / 2),
						options.length - MAX_VISIBLE_OPTIONS,
					));
					const visibleOptions = options.slice(firstVisible, firstVisible + MAX_VISIBLE_OPTIONS);
					visibleOptions.forEach((option, visibleIndex) => {
						const index = firstVisible + visibleIndex;
						const active = index === selectedIndex;
						const isSelected = selected.has(index);
						const pointer = active ? theme.fg("accent", "> ") : "  ";
						const marker = multiSelect ? (isSelected ? "☑ " : "☐ ") : "";
						const label = option.label;
						const color = active ? "accent" : option.isChat ? "muted" : "text";
						addWrappedWithPrefix(lines, pointer, theme.fg(color, `${index + 1}. ${marker}${label}`), renderWidth);
						if (option.description) {
							addWrappedWithPrefix(lines, "     ", theme.fg("muted", option.description), renderWidth);
						}
					});

					if (firstVisible > 0 || firstVisible + MAX_VISIBLE_OPTIONS < options.length) {
						addWrappedWithPrefix(lines, " ", theme.fg("dim", `${selectedIndex + 1}/${options.length}`), renderWidth);
					}
					if (editing) {
						lines.push("");
						addWrappedWithPrefix(lines, " ", theme.fg("muted", "Your answer:"), renderWidth);
						for (const line of editor.render(Math.max(1, renderWidth - 2))) lines.push(` ${line}`);
					}
					lines.push("");
					addWrappedWithPrefix(
						lines,
						" ",
						theme.fg("dim", editing ? "Enter to save · Esc to go back" : multiSelect ? MULTISELECT_HINT : NAVIGATION_HINT),
						renderWidth,
					);
					lines.push(theme.fg("accent", "─".repeat(renderWidth)));
					cachedLines = lines;
					cachedWidth = renderWidth;
					return lines;
				};

				return {
					get focused() {
						return focused;
					},
					set focused(value: boolean) {
						if (focused === value) return;
						focused = value;
						editor.focused = value;
						invalidate();
					},
					render,
					invalidate,
					handleInput,
				} satisfies Component & Focusable;
			});

			let result: SelectionResult | null;
			try {
				result = await openUi();
			} finally {
				signal?.removeEventListener("abort", onAbort);
				dismiss = undefined;
			}

			if (!result) return toolResult("User cancelled the question", { ...details, cancelled: true });
			if (result.wasChat) {
				return toolResult(
					"User wants to chat about this. Continue the conversation to help them decide.",
					{ ...details, answer: result.answer, wasChat: true },
				);
			}
			if (result.wasCustom) {
				const answerText = Array.isArray(result.answer) ? result.answer.join(", ") : result.answer;
				return toolResult(`User answered: ${answerText || NO_INPUT}`, {
					...details,
					answer: result.answer,
					wasCustom: true,
				});
			}
			const answerText = Array.isArray(result.answer) ? result.answer.join(", ") : result.answer;
			return toolResult(`User selected: ${answerText}`, { ...details, answer: result.answer });
		},

		renderCall(args, theme) {
			const count = Array.isArray(args.options) ? args.options.length : 0;
			const mode = args.multiSelect ? "multiple selections" : "one selection";
			return new Text(
				theme.fg("toolTitle", theme.bold("ask_user_question ")) +
					theme.fg("muted", `${args.question} (${count} options, ${mode})`),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as QuestionDetails | undefined;
			if (!details) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
			if (details.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			if (details.wasChat) return new Text(theme.fg("muted", "User wants to chat about this"), 0, 0);
			const answer = Array.isArray(details.answer) ? details.answer.join(", ") : details.answer;
			return new Text(
				theme.fg("success", "✓ ") +
					(details.wasCustom ? theme.fg("muted", "(custom) ") : "") +
					theme.fg("accent", answer ?? NO_INPUT),
				0,
				0,
			);
		},
	});
}

interface SelectionResult {
	answer: Answer;
	wasCustom?: boolean;
	wasChat?: boolean;
}

function toolResult(text: string, details: QuestionDetails) {
	return { content: [{ type: "text" as const, text }], details };
}
