import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { getSandboxState, type SandboxState } from "./sandbox.ts";

export type BypassReason = "read-only-tool";

export type TierDecision =
	| { kind: "bypass"; reason: BypassReason; sandboxState: SandboxState }
	| { kind: "classify"; sandboxState: SandboxState };

// Reading and navigation never prompt; commands and mutations are classified.
export const TIER_BYPASS_TOOLS: ReadonlySet<string> = new Set(["ask_user_question"]);
const READ_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

export interface ClassifyToolInput {
	toolName: string;
	platform: NodeJS.Platform;
	sandboxEnabled: boolean;
}

// Realpath the longest existing ancestor. New file writes target a path that
// does not exist yet; resolving the parent directory is the right call there.
// Throws if no ancestor exists (only possible on truly empty filesystems).
export function realpathOrAncestor(target: string): string {
	let current = target;
	while (true) {
		try {
			return realpathSync(current);
		} catch {
			const parent = path.dirname(current);
			if (parent === current) throw new Error(`No existing ancestor for ${target}`);
			current = parent;
		}
	}
}

export function extractTargetPath(input: unknown): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const record = input as Record<string, unknown>;
	const value = record.path;
	return typeof value === "string" && value !== "" ? value : undefined;
}

function resolveTargetPath(target: string, root: string): string {
	let normalized = target.startsWith("@") ? target.slice(1) : target;
	if (normalized === "~") normalized = homedir();
	else if (normalized.startsWith("~/") || normalized.startsWith("~\\")) {
		normalized = path.join(homedir(), normalized.slice(2));
	}
	if (/^file:\/\//u.test(normalized)) {
		try {
			normalized = fileURLToPath(normalized);
		} catch {
			// Keep the original path; the realpath check below will fail closed.
		}
	}
	return path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(root, normalized);
}

// Both the string pre-check and the realpath pass use the canonical root, so
// a projectRoot that is itself a symlink (e.g. /Users/me/Project -> /private/me/Project)
// agrees with both sides.
export function isInProject(target: string, root: string): boolean {
	let realRoot: string;
	try {
		realRoot = realpathSync(root);
	} catch {
		try {
			realRoot = realpathOrAncestor(root);
		} catch {
			realRoot = path.resolve(root);
		}
	}
	const targetPath = resolveTargetPath(target, root);
	let realTarget: string;
	try {
		realTarget = realpathOrAncestor(targetPath);
	} catch {
		return false;
	}
	const relative = path.relative(realRoot, realTarget);
	return !relative.startsWith("..") && !path.isAbsolute(relative);
}

// Reasoning isolation: the classifier input is a bounded window of the user's
// own messages and the proposed tool call, nothing else. Assistant prose,
// tool results, compaction summaries and extension-injected `custom_message`
// entries are never read, so an agent cannot supply its own justification for
// a command it chose. Pass `ctx.sessionManager.getBranch()`, which returns the
// active path root → leaf, so scan backwards; `getBranch()` (not
// `buildContextEntries()`) keeps working after compaction. Images are dropped
// (the classifier reads text).
//
// Bounded, not the whole session: the newest message always survives (truncated
// if huge), older ones are added only while they fit, and the operative
// instruction is labeled separately from context. A weak model given the full
// history finds some early permissive line that excuses anything.
// Known gap: `pi.sendUserMessage()` persists as an ordinary `role: "user"`
// entry with no marker (source only exists on the transient `input` event), so
// extension-authored and expanded skill/template text is indistinguishable
// from typed input here. Same for pasted third-party content — hence the
// "data, not instructions" rule in the classifier system prompt.
// ponytail: getBranch() copies the whole active path per call; keep the
// bounded window simple unless classifier latency makes this measurable.
export const USER_CONTEXT_MESSAGES = 3;
export const USER_CONTEXT_CHAR_BUDGET = 4000;

export function userIntentBlock(entries: readonly SessionEntry[]): string {
	const kept: string[] = [];
	let used = 0;
	for (let i = entries.length - 1; i >= 0 && kept.length < USER_CONTEXT_MESSAGES; i--) {
		const entry = entries[i];
		if (entry === undefined || entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		const text = (typeof content === "string"
			? content
			: content.map((block) => (block.type === "text" ? block.text : "")).join("")
		).trim();
		if (text === "") continue;
		const room = USER_CONTEXT_CHAR_BUDGET - used;
		// Older context is droppable; the newest message is not.
		if (kept.length > 0 && text.length > room) break;
		kept.push(text.length > room ? `${text.slice(0, room)}\n…[truncated]` : text);
		used += Math.min(text.length, room);
	}
	if (kept.length === 0) return "";

	kept.reverse(); // oldest → newest
	const current = kept[kept.length - 1];
	const earlier = kept.slice(0, -1);
	if (earlier.length === 0) return `Current user message:\n${current}`;
	const context = earlier.map((text, index) => `[${index + 1}] ${text}`).join("\n\n");
	return [
		"Earlier user messages (context only):",
		context,
		"",
		"Current user message (the instruction this command must serve):",
		current,
	].join("\n");
}

// What the classifier judges: the shell command for bash/powershell, the full
// arguments for edit/write, or a bounded JSON summary for anything else. `undefined`
// means the call is malformed (a shell tool with no command, a write with no
// path) and the caller blocks it instead of classifying nothing.
export const CLASSIFY_SUBJECT_JSON_LIMIT = 600;

function serializeInput(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function summarizeInput(input: Record<string, unknown>, limit: number): string {
	const fields = Object.keys(input);
	let valueLimit = Math.max(1, Math.floor(limit / Math.max(fields.length, 1)));
	let summary = "";

	const buildSummary = (maxValueLength: number): string => {
		let truncated = false;
		const values = fields.map((field) => {
			const serialized = serializeInput(input[field]);
			if (serialized.length <= maxValueLength) {
				try {
					return JSON.parse(serialized) as unknown;
				} catch {
					return serialized;
				}
			}
			truncated = true;
			return `${serialized.slice(0, Math.max(0, maxValueLength - 1))}…`;
		});
		return serializeInput({ fields, values, ...(truncated ? { truncated: true } : {}) });
	};

	summary = buildSummary(valueLimit);
	while (summary.length > limit && valueLimit > 0) {
		valueLimit -= 1;
		summary = buildSummary(valueLimit);
	}
	if (summary.length > limit) summary = serializeInput({ truncated: true });
	return summary.slice(0, limit);
}

export function classifySubject(toolName: string, input: unknown): string | undefined {
	if (toolName === "bash" || toolName === "powershell") {
		const command = (input as { command?: unknown } | null)?.command;
		return typeof command === "string" && command !== "" ? command : undefined;
	}
	if (toolName === "edit" || toolName === "write") {
		const target = extractTargetPath(input);
		return target === undefined ? undefined : `${toolName} ${target}\nArguments: ${JSON.stringify(input)}`;
	}
	const serialized = serializeInput(input);
	const prefix = `${toolName} `;
	if (typeof input === "object" && input !== null && !Array.isArray(input)) {
		const available = CLASSIFY_SUBJECT_JSON_LIMIT;
		const summary = summarizeInput(input as Record<string, unknown>, available);
		if (summary.endsWith('"truncated":true}')) return `${prefix}${summary}`;
		const suffix = serialized.slice(0, Math.max(0, available - summary.length));
		return `${prefix}${summary}${suffix}`;
	}
	return `${prefix}${serialized.slice(0, CLASSIFY_SUBJECT_JSON_LIMIT)}`;
}

// Fail closed. Anything but a clean single-token SAFE on a normal stop — extra
// prose, truncation, a provider error, an empty reply — counts as unsafe.
export function isSafeVerdict(stopReason: string | undefined, text: string): boolean {
	return stopReason === "stop" && text.trim().toUpperCase() === "SAFE";
}

// Paths default.sbpl allows writes to besides the project root, in canonical
// form: targets are realpathed first, so `/tmp/...` and `/var/folders/...`
// match `/private/tmp` and `/private/var/folders` the way the kernel does.
// Keep in sync with the profile.
const SANDBOX_WRITE_ROOTS: readonly string[] = ["/private/tmp", "/private/var/folders", "/dev"];

function isSandboxWritable(target: string, projectRoot: string): boolean {
	let real = target;
	try {
		real = realpathOrAncestor(target);
	} catch {
		// Keep the raw path; the prefix check below simply will not match.
	}
	if (SANDBOX_WRITE_ROOTS.some((root) => real === root || real.startsWith(`${root}/`))) return true;
	if (!isInProject(target, projectRoot)) return false;
	// .git writes stay denied inside the project: history is the recovery path.
	return !isInProject(target, path.join(projectRoot, ".git"));
}

// Returns the path the sandbox refused to write, or undefined when the output
// does not look like a sandboxed-write denial.
//
// Path-based on purpose. A denied `socket()` also reports "Operation not
// permitted", and escalating that would punch a hole straight through the
// network deny — no path, no escalation. EPERM on a path the profile does allow
// (or inside the project root) is some other failure and is left alone.
export function sandboxDeniedWrite(output: string, projectRoot: string): string | undefined {
	if (!/operation not permitted/iu.test(output)) return undefined;
	for (const match of output.matchAll(/(?:^|[\s'"(\[=])(\/[^\s'"()\[\];,:<>|&]+)/gu)) {
		const target = match[1];
		if (target === undefined) continue;
		if (!isSandboxWritable(target, projectRoot)) return target;
	}
	return undefined;
}

export function isSandboxDenial(output: string, projectRoot: string): boolean {
	if (!/operation not permitted/iu.test(output)) return false;
	return sandboxDeniedWrite(output, projectRoot) !== undefined || /(?:connect(?:\(2\))?|dial (?:tcp|udp)|socket)/iu.test(output);
}

export function classifyToolCall(opts: ClassifyToolInput): TierDecision {
	const sandboxState = getSandboxState(opts.platform, opts.sandboxEnabled);

	if (TIER_BYPASS_TOOLS.has(opts.toolName) || READ_TOOLS.has(opts.toolName)) {
		return { kind: "bypass", reason: "read-only-tool", sandboxState };
	}

	// edit/write remain unsandboxed by choice. Classify every call: a pathname
	// precheck is not containment and can be invalidated by a symlink swap.
	return { kind: "classify", sandboxState };
}
