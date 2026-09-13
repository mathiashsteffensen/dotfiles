// Run: node --experimental-vm-modules --test config/pi/agent/extensions/plan-mode/*.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import * as utils from "./utils.ts";

async function harness(initialTools = ["read", "bash", "edit", "write", "subagent", "ask_user_question"]) {
	const hooks = new Map<string, Function>();
	const commands = new Map<string, any>();
	let activeTools = [...initialTools];
	let branch: any[] = [];
	let entries: any[] = [];
	let flag = false;
	const sent: any[] = [];
	const ctx = {
		hasUI: true,
		ui: {
			notify() {}, setStatus() {}, setWidget() {},
			theme: { fg: (_color: string, text: string) => text, strikethrough: (text: string) => text },
			select: async (): Promise<string | undefined> => undefined,
		},
		sessionManager: { getBranch: () => branch, getEntries: () => entries },
	};
	const module = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(new URL("./index.ts", import.meta.url), "utf8")));
	const imports: Record<string, any> = { "./utils.ts": utils, "@earendil-works/pi-tui": { Key: { ctrlAlt: (key: string) => key } } };
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
		setActiveTools: (tools: string[]) => { activeTools = [...tools]; },
		appendEntry: (customType: string, data: unknown) => { branch.push({ type: "custom", customType, data: structuredClone(data) }); },
		sendMessage: (message: unknown) => sent.push(message),
	});
	return {
		hooks, ctx, sent,
		tools: () => activeTools,
		toggle: () => commands.get("plan").handler("", ctx),
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
	assert.deepEqual(h.tools(), ["read", "ask_user_question"]);
	for (const toolName of ["bash", "powershell", "edit", "write", "subagent", "custom-mutator"]) {
		assert.equal((await h.hooks.get("tool_call")!({ toolName }, h.ctx))?.block, true, toolName);
	}
	await h.toggle();
	assert.deepEqual(h.tools(), original);
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
	assert.ok(!h.tools().includes("bash"));
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
	assert.ok(!h.tools().includes("bash"));
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
	choose!("Execute the plan (track progress)");
	await pending;
	assert.deepEqual(h.sent, []);
});
