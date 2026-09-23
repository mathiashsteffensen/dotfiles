// Run: node --experimental-vm-modules --test config/pi/agent/extensions/plan-mode/*.test.ts
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import * as utils from "./utils.ts";

async function harness(initialTools = ["read", "bash", "edit", "write", "subagent", "ask_user_question"]) {
	const hooks = new Map<string, Function>();
	const commands = new Map<string, any>();
	const published: boolean[] = [];
	const selected: string[] = [];
	const confirmations: string[] = [];
	const notifications: string[] = [];
	let idle = true;
	let activeTools = [...initialTools];
	const sources = new Map(initialTools.map((name) => [name, { source: "builtin", path: `<builtin:${name}>` }]));
	sources.set("bash", { source: "extension", path: fileURLToPath(new URL("../auto-approve/index.ts", import.meta.url)) });
	sources.set("ask_user_question", { source: "extension", path: fileURLToPath(new URL("../ask-user-question.ts", import.meta.url)) });
	let branch: any[] = [];
	let entries: any[] = [];
	let flag = false;
	const sent: any[] = [];
	const ctx = {
		hasUI: true, mode: "tui" as string,
		isIdle: () => idle,
		ui: {
			notify: (text: string) => notifications.push(text), setStatus() {}, setWidget() {},
			theme: { fg: (_color: string, text: string) => text, strikethrough: (text: string) => text },
			select: async (title: string): Promise<string | undefined> => { selected.push(title); return undefined; },
			confirm: async (_title: string, text: string) => { confirmations.push(text); return false; },
		},
		sessionManager: { getBranch: () => branch, getEntries: () => entries },
	};
	const url = new URL("./index.ts", import.meta.url);
	const module = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(url, "utf8")), { initializeImportMeta: (meta) => { meta.url = url.href; } });
	const imports: Record<string, any> = {
		"./utils.ts": utils,
		"node:fs": { realpathSync }, "node:url": { fileURLToPath },
		"@earendil-works/pi-tui": { Key: { ctrlAlt: (key: string) => key }, truncateToWidth: (line: string, width: number) => line.slice(0, width) },
	};
	await module.link((name) => {
		const exports = imports[name];
		assert.ok(exports, name);
		return new vm.SyntheticModule(Object.keys(exports), function () {
			for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
		});
	});
	await module.evaluate();
	(module.namespace as any).default({
		registerFlag() {}, registerShortcut() {},
		registerCommand: (name: string, definition: unknown) => commands.set(name, definition),
		on: (name: string, handler: Function) => hooks.set(name, handler),
		getFlag: () => flag,
		getActiveTools: () => [...activeTools],
		getAllTools: () => [...sources].map(([name, sourceInfo]) => ({ name, sourceInfo })),
		events: { emit: (name: string, data: { enabled: boolean }) => { assert.equal(name, "plan-mode:state"); published.push(data.enabled); } },
		setActiveTools: (tools: string[]) => { activeTools = [...tools]; },
		appendEntry: (customType: string, data: unknown) => { branch.push({ type: "custom", customType, data: structuredClone(data) }); },
		sendMessage: (message: unknown) => sent.push(message),
	});
	return {
		hooks, ctx, sent, published, selected, confirmations, notifications,
		tools: () => activeTools,
		setIdle: (value: boolean) => { idle = value; },
		setSource: (name: string, path: string) => { sources.set(name, { source: "extension", path }); },
		toggle: () => commands.get("plan").handler("", ctx),
		execute: () => commands.get("plan").handler("execute", ctx),
		todos: () => commands.get("todos").handler("", ctx),
		setFlag: () => { flag = true; },
		setEntries: (active: any[], all = active) => { branch = active; entries = all; },
	};
}

function state(enabled: boolean, toolsBeforePlanMode?: string[]) {
	return { type: "custom", customType: "plan-mode", data: { enabled, todos: [], executing: false, toolsBeforePlanMode } };
}

test("plan mode blocks unknown and mutating tools and restores the exact original tool set", async () => {
	const h = await harness();
	const original = h.tools();
	await h.toggle();
	assert.deepEqual(h.tools(), ["read", "bash", "ask_user_question"]);
	for (const toolName of ["powershell", "edit", "write", "subagent", "custom-mutator"]) {
		assert.equal((await h.hooks.get("tool_call")!({ toolName }, h.ctx))?.block, true, toolName);
	}
	await h.toggle();
	assert.deepEqual(h.tools(), original);
});

test("headless plan mode omits and rejects structured questions, including restored sessions", async () => {
	const h = await harness();
	h.ctx.mode = "print";
	h.ctx.hasUI = false;
	await h.toggle();
	assert.deepEqual(h.tools(), ["read", "bash"]);
	assert.equal((await h.hooks.get("tool_call")!({ toolName: "ask_user_question" }, h.ctx))?.block, true);

	const restored = await harness();
	restored.ctx.mode = "print";
	restored.ctx.hasUI = false;
	restored.setEntries([state(true)]);
	await restored.hooks.get("session_start")!({}, restored.ctx);
	assert.deepEqual(restored.tools(), ["read", "bash"]);
	assert.equal((await restored.hooks.get("tool_call")!({ toolName: "ask_user_question" }, restored.ctx))?.block, true);
});

test("ordinary user messages containing the plan marker survive context filtering", async () => {
	const h = await harness();
	const messages = [
		{ role: "user", content: "What does [PLAN MODE ACTIVE] mean?" },
		{ role: "user", content: [{ type: "text", text: "Quote [PLAN MODE ACTIVE]" }] },
		{ role: "custom", customType: "plan-mode-context", content: "stale" },
	];
	const filtered = await h.hooks.get("context")!({ messages });
	assert.deepEqual(filtered.messages, messages.slice(0, 2));
});

test("restoration ignores other branches and restores normal tools when navigating away", async () => {
	const h = await harness();
	const original = h.tools();
	h.setEntries([], [state(true)]);
	await h.hooks.get("session_start")!({}, h.ctx);
	assert.deepEqual(h.tools(), original);
	h.setEntries([state(true, original)]);
	await h.hooks.get("session_tree")!({}, h.ctx);
	assert.ok(h.tools().includes("bash"));
	h.setEntries([]);
	await h.hooks.get("session_tree")!({}, h.ctx);
	assert.deepEqual(h.tools(), original);
	await h.toggle();
	h.setEntries([]);
	await h.hooks.get("session_start")!({}, h.ctx);
	assert.deepEqual(h.tools(), original);
});

test("restored snapshots never enable tools absent from the current session", async () => {
	const h = await harness(["read", "ask_user_question"]);
	h.setEntries([state(true, ["read", "bash", "write", "subagent", "ask_user_question"])]);
	await h.hooks.get("session_start")!({}, h.ctx);
	await h.toggle();
	assert.deepEqual(h.tools(), ["read", "ask_user_question"]);
});

test("--plan applies at session start, not on every tree navigation", async () => {
	const h = await harness();
	h.setFlag();
	await h.hooks.get("session_start")!({}, h.ctx);
	assert.ok(h.tools().includes("bash"));
	h.setEntries([]);
	await h.hooks.get("session_tree")!({}, h.ctx);
	assert.ok(h.tools().includes("bash"));
});

test("a stale execute-plan dialog cannot change a newly selected branch", async () => {
	const h = await harness();
	await h.toggle();
	let choose: (choice: string) => void;
	h.ctx.ui.select = () => new Promise((resolve) => { choose = resolve; });
	const pending = h.hooks.get("agent_end")!({ messages: [{ role: "assistant", content: [{ type: "text", text: "Plan:\n1. Inspect the source code" }] }] }, h.ctx);
	h.setEntries([]);
	await h.hooks.get("session_tree")!({}, h.ctx);
	choose!("Review and execute");
	await pending;
	assert.deepEqual(h.sent, []);
});

test("planning rejects an untrusted tool override and cannot start during an active turn", async () => {
	const h = await harness();
	h.setIdle(false);
	await h.toggle();
	assert.ok(h.tools().includes("write"));
	assert.match(h.notifications.at(-1)!, /Wait for the current turn/);
	h.setIdle(true);
	h.setSource("read", fileURLToPath(new URL("../auto-approve/index.ts", import.meta.url)));
	h.setSource("bash", fileURLToPath(new URL("../ask-user-question.ts", import.meta.url)));
	await h.toggle();
	assert.deepEqual(h.tools(), ["ask_user_question"]);
	assert.equal((await h.hooks.get("tool_call")!({ toolName: "read" }, h.ctx))?.block, true);
	assert.equal((await h.hooks.get("tool_call")!({ toolName: "bash" }, h.ctx))?.block, true);
	assert.equal(h.published.at(-1), true);
});

test("review shows complete steps and requires confirmation before enabling execution", async () => {
	const h = await harness();
	await h.toggle();
	const message = { role: "assistant", content: [{ type: "text", text: "Plan:\n1. **Update** the very detailed authentication flow without dropping its requirements" }] };
	h.ctx.ui.select = async () => "Stay in plan mode";
	await h.hooks.get("agent_end")!({ messages: [message] }, h.ctx);
	assert.equal(h.selected.length, 0);
	await h.hooks.get("agent_end")!({ messages: [{ role: "assistant", content: [{ type: "text", text: "Let's discuss the tradeoff." }] }] }, h.ctx);
	assert.equal(h.confirmations.length, 0);
	h.ctx.ui.select = async () => "Review and execute";
	await h.hooks.get("agent_end")!({ messages: [message] }, h.ctx);
	assert.match(h.confirmations[0], /\*\*Update\*\* the very detailed authentication flow without dropping its requirements/);
	assert.deepEqual(h.sent, []);
	h.ctx.ui.confirm = async () => true;
	await h.hooks.get("agent_end")!({ messages: [message] }, h.ctx);
	assert.equal(h.published.at(-1), false);
	assert.ok(h.tools().includes("write"));
	assert.match(h.sent.at(-1).content, /very detailed authentication flow without dropping its requirements/);
});

test("a plan kept for later can still be reviewed with /plan execute", async () => {
	const h = await harness();
	await h.toggle();
	h.ctx.ui.select = async () => "Stay in plan mode";
	await h.hooks.get("agent_end")!({ messages: [{ role: "assistant", content: [{ type: "text", text: "Plan:\n1. Inspect the source code" }] }] }, h.ctx);
	await h.execute();
	assert.match(h.confirmations.at(-1)!, /Inspect the source code/);
	assert.ok(!h.tools().includes("write"));
	h.ctx.ui.confirm = async () => true;
	await h.execute();
	assert.ok(h.tools().includes("write"));
});

test("headless planning persists the plan without prompting or using the question tool", async () => {
	const h = await harness();
	h.ctx.mode = "print";
	h.ctx.hasUI = false;
	await h.toggle();
	const context = await h.hooks.get("before_agent_start")!({}, h.ctx);
	assert.match(context.message.content, /clarifying questions in ordinary text/);
	assert.doesNotMatch(context.message.content, /Ask clarifying questions using ask_user_question/);
	await h.hooks.get("agent_end")!({ messages: [{ role: "assistant", content: [{ type: "text", text: "Plan:\n1. Inspect the source code" }] }] }, h.ctx);
	await h.todos();
	assert.match(h.notifications.at(-1)!, /Inspect the source code/);
	assert.deepEqual(h.selected, []);
});
