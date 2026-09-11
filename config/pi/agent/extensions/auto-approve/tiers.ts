import { realpathSync } from "node:fs";
import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { getSandboxState, type SandboxState } from "./sandbox.ts";

export type BypassReason = "read-only-tool" | "in-project" | "in-sandbox";

export type TierDecision =
	| { kind: "bypass"; reason: BypassReason; sandboxState: SandboxState }
	| { kind: "classify"; sandboxState: SandboxState };

// Tools that cannot mutate state and therefore never need the safety
// classifier. ask_user_question is also here: it surfaces a UI dialog to the
// user, no filesystem or network capability.
export const TIER_BYPASS_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"ask_user_question",
]);

export interface ClassifyToolInput {
	toolName: string;
	input: unknown;
	platform: NodeJS.Platform;
	sandboxEnabled: boolean;
	// Canonical (realpath-resolved) project root.
	projectRoot: string;
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
	let realTarget: string;
	try {
		realTarget = realpathOrAncestor(target);
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
// ponytail: getBranch() copies the whole active path per call — fine while
// classified bash is the rare path (in-sandbox bash bypasses); key a cache on
// getLeafId() if that changes.
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

// What the classifier judges: the shell command for bash/powershell, the target
// path for edit/write, a bounded JSON summary for anything else. `undefined`
// means the call is malformed (a shell tool with no command, a write with no
// path) and the caller blocks it instead of classifying nothing.
export const CLASSIFY_SUBJECT_JSON_LIMIT = 600;

export function classifySubject(toolName: string, input: unknown): string | undefined {
	if (toolName === "bash" || toolName === "powershell") {
		const command = (input as { command?: unknown } | null)?.command;
		return typeof command === "string" && command !== "" ? command : undefined;
	}
	if (toolName === "edit" || toolName === "write") {
		const target = extractTargetPath(input);
		return target === undefined ? undefined : `${toolName} ${target}`;
	}
	let serialized: string;
	try {
		serialized = JSON.stringify(input) ?? String(input);
	} catch {
		serialized = String(input);
	}
	return `${toolName} ${serialized.slice(0, CLASSIFY_SUBJECT_JSON_LIMIT)}`;
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
	if (!output.includes("Operation not permitted")) return undefined;
	for (const match of output.matchAll(/(?:^|[\s'"(\[=])(\/[^\s'"()\[\];,:<>|&]+)/gu)) {
		const target = match[1];
		if (target === undefined) continue;
		if (!isSandboxWritable(target, projectRoot)) return target;
	}
	return undefined;
}

export function classifyToolCall(opts: ClassifyToolInput): TierDecision {
	const sandboxState = getSandboxState(opts.platform, opts.sandboxEnabled);

	if (TIER_BYPASS_TOOLS.has(opts.toolName)) {
		return { kind: "bypass", reason: "read-only-tool", sandboxState };
	}

	if (opts.toolName === "bash") {
		if (sandboxState === "in-sandbox") {
			return { kind: "bypass", reason: "in-sandbox", sandboxState };
		}
		return { kind: "classify", sandboxState };
	}

	if (opts.toolName === "powershell") {
		// Powershell goes through the classifier (same prompt) but is never
		// sandbox-bypassed: there is no spawnHook for it on this Pi version.
		return { kind: "classify", sandboxState };
	}

	if (opts.toolName === "edit" || opts.toolName === "write") {
		const targetPath = extractTargetPath(opts.input);
		if (targetPath === undefined) return { kind: "classify", sandboxState };
		return isInProject(targetPath, opts.projectRoot) &&
			!isInProject(targetPath, path.join(opts.projectRoot, ".git"))
			? { kind: "bypass", reason: "in-project", sandboxState }
			: { kind: "classify", sandboxState };
	}

	return { kind: "classify", sandboxState };
}
