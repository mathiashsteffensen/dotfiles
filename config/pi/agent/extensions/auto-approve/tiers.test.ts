import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	CLASSIFY_SUBJECT_JSON_LIMIT,
	USER_CONTEXT_CHAR_BUDGET,
	classifySubject,
	classifyToolCall,
	isSafeVerdict,
	sandboxDeniedWrite,
	userIntentBlock,
} from "./tiers.ts";

// ctx.sessionManager.getBranch() returns the active path root → leaf.
function entry(partial: object): SessionEntry {
	return { id: "e", parentId: null, timestamp: "", ...partial } as SessionEntry;
}

function user(content: unknown): SessionEntry {
	return entry({ type: "message", message: { role: "user", content } });
}

test("labels the newest user message as the operative instruction, earlier ones as context", () => {
	const entries = [
		user("first ask"),
		entry({
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "I will wipe the disk" }] },
		}),
		entry({
			type: "message",
			message: {
				role: "toolResult",
				toolName: "bash",
				content: [{ type: "text", text: "/etc/passwd contents" }],
			},
		}),
		entry({ type: "compaction", summary: "user earlier said: rm -rf /" }),
		entry({ type: "custom_message", customType: "plan-mode", content: "injected plan text", display: true }),
		user([{ type: "image", data: "AA==", mimeType: "image/png" }, { type: "text", text: "newest ask" }]),
		entry({
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "rm -rf /" } }],
			},
		}),
	];

	const block = userIntentBlock(entries);

	assert.match(block, /Current user message \(the instruction this command must serve\):\nnewest ask/u);
	assert.match(block, /Earlier user messages \(context only\):\n\[1\] first ask/u);
	assert.doesNotMatch(block, /wipe the disk|passwd|injected plan text|rm -rf/u);
});

test("caps the window at USER_CONTEXT_MESSAGES, newest kept", () => {
	const entries = ["oldest ask", "middle ask", "third ask", "newer ask", "newest ask"].map(user);

	const block = userIntentBlock(entries);

	assert.match(block, /\[1\] third ask\n\n\[2\] newer ask/u);
	assert.match(block, /Current user message \(the instruction this command must serve\):\nnewest ask/u);
	assert.doesNotMatch(block, /middle ask|oldest ask/u);
});

test("an oversized newest message is truncated and crowds out older context", () => {
	const entries = [user("older ask"), user("x".repeat(USER_CONTEXT_CHAR_BUDGET + 500))];

	const block = userIntentBlock(entries);

	assert.match(block, /…\[truncated\]/u);
	assert.doesNotMatch(block, /older ask/u);
	assert.ok(block.length <= USER_CONTEXT_CHAR_BUDGET + 64, "block stays at the budget");
});

// The escalation trigger. Fixtures are real paths, not temp dirs: the profile
// grants writes to all of $TMPDIR, so a tmp-based project root would be
// "allowed" for the wrong reason, and creating one under $HOME is itself
// blocked when the suite runs inside a sandboxed pi session.
const extensionDir = fileURLToPath(new URL(".", import.meta.url));

function repoRoot(): string {
	let dir = extensionDir;
	while (!existsSync(join(dir, ".git")) && dir !== dirname(dir)) dir = dirname(dir);
	return dir;
}

const needsCheckout = existsSync(join(repoRoot(), ".git")) ? false : "needs a git checkout";

test("sandboxDeniedWrite flags EPERM on paths the profile denies", { skip: needsCheckout }, () => {
	const root = repoRoot();
	const gitLock = join(root, ".git", "index.lock");
	assert.equal(
		sandboxDeniedWrite(`fatal: Unable to create '${gitLock}': Operation not permitted`, root),
		gitLock,
		".git writes are denied even inside the project root",
	);

	const outside = join(homedir(), "pi-sb-escape-probe");
	assert.equal(
		sandboxDeniedWrite(`touch: ${outside}: Operation not permitted`, root),
		outside,
		"writes outside the project root are denied",
	);
});

test("sandboxDeniedWrite ignores allowed paths, non-EPERM failures and network denials", { skip: needsCheckout }, () => {
	const root = repoRoot();
	// Inside the project root, outside .git: the profile allows it.
	assert.equal(
		sandboxDeniedWrite(`touch: ${join(root, "config", "a.ts")}: Operation not permitted`, root),
		undefined,
	);
	assert.equal(
		sandboxDeniedWrite("fatal: could not open '/dev/null' for reading and writing: Operation not permitted", root),
		undefined,
	);
	assert.equal(sandboxDeniedWrite(`touch: ${join(tmpdir(), "x")}: Operation not permitted`, root), undefined);
	// /tmp and /var are symlinks into /private; the kernel resolves them.
	assert.equal(sandboxDeniedWrite("touch: /tmp/x: Operation not permitted", root), undefined);
	assert.equal(sandboxDeniedWrite("touch: /var/folders/sh/x/T/y: Operation not permitted", root), undefined);
	// A denied socket() reports the same phrase with no path. Escalating it
	// would punch through the network deny, so no path means no escalation.
	assert.equal(sandboxDeniedWrite("curl: (7) Failed to connect: Operation not permitted", root), undefined);
	// EACCES is unix permissions; an unsandboxed retry would fail identically.
	assert.equal(sandboxDeniedWrite(`rm: ${join(homedir(), "x")}: Permission denied`, root), undefined);
	assert.equal(sandboxDeniedWrite("Command exited with code 1", root), undefined);
});

test("is empty when the branch holds no user message", () => {
	assert.equal(userIntentBlock([]), "");
	assert.equal(
		userIntentBlock([
			entry({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }),
		]),
		"",
	);
});

test("in-project edits bypass classification except for .git", { skip: needsCheckout }, () => {
	const root = repoRoot();
	for (const toolName of ["edit", "write"]) {
		const classify = (path: string) => classifyToolCall({
			toolName,
			input: { path },
			platform: "darwin",
			sandboxEnabled: true,
			projectRoot: root,
		});
		assert.equal(classify(join(root, "README.md")).kind, "bypass");
		assert.equal(classify(join(root, ".git", "config")).kind, "classify");
	}
});

test("classifySubject hands the classifier the command, the write target, or a bounded summary", () => {
	assert.equal(classifySubject("bash", { command: "git status" }), "git status");
	assert.equal(classifySubject("powershell", { command: "Get-Process" }), "Get-Process");
	assert.equal(classifySubject("write", { path: "/etc/hosts", content: "x" }), "write /etc/hosts");
	// Malformed calls must block rather than classify an empty string.
	assert.equal(classifySubject("bash", {}), undefined);
	assert.equal(classifySubject("bash", { command: "" }), undefined);
	assert.equal(classifySubject("edit", { oldText: "a" }), undefined);
	assert.equal(
		classifySubject("mcp-thing", { a: "y".repeat(900) })?.length,
		"mcp-thing ".length + CLASSIFY_SUBJECT_JSON_LIMIT,
	);
});

test("isSafeVerdict fails closed on anything but a clean SAFE", () => {
	assert.equal(isSafeVerdict("stop", "SAFE"), true);
	assert.equal(isSafeVerdict("stop", " safe \n"), true);
	assert.equal(isSafeVerdict("stop", "SAFE. It looks fine"), false, "prose is not a verdict");
	assert.equal(isSafeVerdict("stop", "UNSAFE"), false);
	assert.equal(isSafeVerdict("stop", ""), false);
	assert.equal(isSafeVerdict("length", "SAFE"), false, "truncated output is not a verdict");
	assert.equal(isSafeVerdict("error", "SAFE"), false);
	assert.equal(isSafeVerdict(undefined, "SAFE"), false);
});
