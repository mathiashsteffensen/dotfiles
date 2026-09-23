// Run: node --experimental-vm-modules --test config/pi/agent/extensions/auto-approve/index.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import * as sandbox from "./sandbox.ts";
import * as tiers from "./tiers.ts";

async function harness(verdict = "SAFE", confirmed = false, hasUI = true,
	configText: string | Error = JSON.stringify({ provider: "test", model: "test", sandbox: { enabled: true } }),
	profileText: string | Error = "trusted policy") {
	const calls: string[] = [];
	const hooks = new Map<string, Function>();
	const events = new Map<string, (data: unknown) => void>();
	let tool: any;
	let failRetry = false;
	let ordinaryFailure = false;
	let failSetup = false;
	let missingExecutable = false;
	let startupError: string | undefined;
	const notifications: string[] = [];
	const approvalNotifications: string[] = [];
	const eventOrder: string[] = [];
	let profileLoads = 0;
	const resolvedProfiles: string[] = [];
	const ctx = {
		cwd: process.cwd(), mode: "tui" as const, hasUI, signal: undefined as AbortSignal | undefined,
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: () => {},
			theme: { fg: (_color: string, text: string) => text },
			confirm: async (_title: string, body: string, _options?: { signal?: AbortSignal }) => {
				calls.push("prompt");
				eventOrder.push("prompt");
				assert.ok(body.length > 0);
				return confirmed;
			},
		},
		sessionManager: { getBranch: () => [] },
		modelRegistry: {
			find: () => ({ id: "test" }),
			complete: async (_model: unknown, _request: unknown, _options: { signal?: AbortSignal }) => {
				calls.push("classify");
				eventOrder.push("classify");
				if (verdict === "error") throw new Error("provider failed");
				return { stopReason: "stop", content: [{ type: "text", text: verdict }] };
			},
		},
	};
	const modules: Record<string, any> = {
		"node:child_process": { execSync: () => { if (missingExecutable) throw new Error("not found"); } },
		"node:fs": { default: {
			...fs, appendFileSync: () => {}, existsSync: () => false,
			readFileSync: () => {
				if (configText instanceof Error) throw configText;
				return configText;
			},
		} },
		"node:path": { default: path },
		"node:url": { fileURLToPath },
		"typebox": { Type: { Object: (properties: unknown) => ({ properties }), Boolean: () => ({}), Optional: (value: unknown) => value } },
		"./sandbox.ts": {
			...sandbox, getSandboxState: () => "in-sandbox",
			loadSbpl: (_dir: string, filename?: string) => {
				if (filename === "plan.sbpl") return "read-only policy";
				profileLoads++;
				if (profileText instanceof Error) throw profileText;
				return profileText;
			},
			resolveSandbox: (options: { profile: string }) => {
				resolvedProfiles.push(options.profile);
				if (failSetup) throw new Error("profile unavailable");
				return { state: "in-sandbox", command: "wrapped" };
			},
		},
		"./tiers.ts": tiers,
		"../notify.ts": { notifyApproval: () => { approvalNotifications.push("approval"); eventOrder.push("approval"); } },
		"@earendil-works/pi-coding-agent": {
			getAgentDir: () => "/tmp/auto-approve-test",
			createBashToolDefinition: (_cwd: string, options?: any) => ({
				name: "bash", description: "bash", parameters: { properties: {} },
				execute: async (_id: string, _params: unknown, _signal: unknown, _update: unknown, context: unknown) => {
					assert.equal(context, ctx);
					options?.spawnHook({ command: "git status", cwd: ctx.cwd, env: {} });
					calls.push(options ? "sandbox" : "unsandboxed");
					if (options && startupError) throw new Error(startupError);
					if (options) {
						if (ordinaryFailure) throw new Error("Command exited with code 1");
						throw new Error(`fatal: '${path.join(ctx.cwd, ".git", "index.lock")}': Operation not permitted`);
					}
					if (failRetry) throw new Error("Operation not permitted");
					return { content: [{ type: "text", text: "success" }], details: {} };
				},
			}),
		},
	};
	const url = new URL("./index.ts", import.meta.url);
	const module = new vm.SourceTextModule(stripTypeScriptTypes(fs.readFileSync(url, "utf8")), {
		initializeImportMeta: (meta) => { meta.url = url.href; },
	});
	await module.link((specifier) => {
		const exports = modules[specifier];
		assert.ok(exports, specifier);
		return new vm.SyntheticModule(Object.keys(exports), function () {
			for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
		});
	});
	await module.evaluate();
	(module.namespace as any).default({
		registerTool: (definition: unknown) => { tool = definition; },
		on: (name: string, handler: Function) => hooks.set(name, handler),
		events: { on: (name: string, handler: (data: unknown) => void) => events.set(name, handler) },
	});
	const run = (escalate = false, command = "git status", signal?: AbortSignal) => tool.execute("id", { command, escalate }, signal, undefined, ctx);
	return {
		calls, ctx, hooks, run, notifications, approvalNotifications, eventOrder, resolvedProfiles,
		setPlanMode: (enabled: boolean) => events.get("plan-mode:state")!({ enabled }),
		profileLoads: () => profileLoads,
		setProfile: (text: string) => { profileText = text; },
		failRetry: () => { failRetry = true; },
		ordinaryFailure: () => { ordinaryFailure = true; },
		failSetup: () => { failSetup = true; },
		missingExecutable: () => { missingExecutable = true; },
		startupError: (message: string) => { startupError = message; },
	};
}

test("reads and navigation never classify or prompt, regardless of path or model availability", async () => {
	for (const verdict of ["UNSAFE", "error"]) {
		const h = await harness(verdict);
		for (const toolName of ["read", "grep", "find", "ls"]) {
			for (const target of ["README.md", path.join(h.ctx.cwd, "..", "outside"), "~/.ssh/config"]) {
				assert.equal(await h.hooks.get("tool_call")!({ toolName, input: { path: target } }, h.ctx), undefined);
			}
		}
		assert.deepEqual(h.calls, []);
	}
});

test("read-only subagent inspection never classifies or prompts even without UI", async () => {
	const h = await harness("UNSAFE", false, false);
	for (const input of [
		{ action: "list" }, { action: "list", capabilities: true },
		{ action: "get", agent: "reviewer" }, { action: "models" },
		{ action: "guide", topic: "workflows" }, { action: "children.list" },
		{ action: "status", id: "run-1", view: "transcript", lines: 40 },
	]) {
		assert.equal(await h.hooks.get("tool_call")!({ toolName: "subagent", input }, h.ctx), undefined);
	}
	for (const action of ["list", "pending", "status"]) {
		assert.equal(await h.hooks.get("tool_call")!({ toolName: "subagent_supervisor", input: { action } }, h.ctx), undefined);
	}
	assert.equal(await h.hooks.get("tool_call")!({ toolName: "bg_wait", input: { id: "run-1", nonBlocking: true } }, h.ctx), undefined);
	assert.deepEqual(h.calls, []);
});

test("subagent launches, mutations and inspection calls with unexpected fields still require classification", async () => {
	for (const input of [
		{ agent: "worker", task: "change files" },
		{ action: "delete", agent: "worker" },
		{ action: "list", task: "change files" },
		{ action: "status", workflowScript: "return runs.run('x', { agent: 'worker' })" },
	]) {
		const h = await harness("UNSAFE", false, false);
		assert.equal((await h.hooks.get("tool_call")!({ toolName: "subagent", input }, h.ctx))?.block, true);
		assert.deepEqual(h.calls, ["classify"]);
	}
});

test("cached research and memory reads never classify or prompt even when the model fails", async () => {
	const h = await harness("error", false, false);
	for (const toolName of ["get_search_content", "memory_search", "memory_get"]) {
		assert.equal(await h.hooks.get("tool_call")!({ toolName, input: { query: "documentation" } }, h.ctx), undefined);
	}
	assert.deepEqual(h.calls, []);
});

test("research gets complete arguments and explicit routine authorization, but still checks for leakage", async () => {
	for (const toolName of ["web_search", "source_check", "fetch_content"]) {
		const input = { queries: ["public API documentation ".repeat(50)], url: "https://example.com/docs" };
		for (const verdict of ["SAFE", "UNSAFE", "error"]) {
			const h = await harness(verdict);
			let request: any;
			const complete = h.ctx.modelRegistry.complete;
			h.ctx.modelRegistry.complete = async (...args) => {
				request = args[1];
				return complete(...args);
			};
			const result = await h.hooks.get("tool_call")!({ toolName, input }, h.ctx);
			assert.ok(request.messages[0].content.includes(`${toolName} ${JSON.stringify(input)}`));
			assert.match(request.systemPrompt, /Answer SAFE for ordinary web searches/);
			assert.match(request.systemPrompt, /secrets or private file contents/);
			assert.doesNotMatch(request.systemPrompt, /truncated/);
			assert.equal(result?.block, verdict === "SAFE" ? undefined : true);
			assert.deepEqual(h.calls, verdict === "SAFE" ? ["classify"] : ["classify", "prompt"]);
		}
	}
});

test("sensitive edits include their changes and project root, and SAFE never prompts", async () => {
	const inputs = [
		{ toolName: "edit", input: { path: "config/pi/agent/extensions/auto-approve/index.ts", edits: [{ oldText: "assert.equal(sum(1, 2), 4)", newText: "assert.equal(sum(1, 2), 3)" }] } },
		{ toolName: "write", input: { path: "config/pi/agent/extensions/auto-approve/new.ts", content: "assert.equal(sum(1, 2), 3);\n" } },
	];
	for (const hasUI of [true, false]) {
		for (const event of inputs) {
			const h = await harness("SAFE", false, hasUI);
			let request: any;
			const complete = h.ctx.modelRegistry.complete;
			h.ctx.modelRegistry.complete = async (...args) => {
				request = args[1];
				return complete(...args);
			};
			assert.equal(await h.hooks.get("tool_call")!(event, h.ctx), undefined);
			assert.deepEqual(h.calls, ["classify"]);
			assert.ok(request.messages[0].content.includes(JSON.stringify(event.input)), "classifier must see the actual changes, not just the filename");
			assert.ok(request.messages[0].content.includes(`Project root: ${JSON.stringify(tiers.realpathOrAncestor(h.ctx.cwd))}`), "classifier must know which project the path belongs to");
			assert.match(request.systemPrompt, /ongoing user task/);
			assert.match(request.systemPrompt, /Answer SAFE for ordinary, task-related edits/);
			assert.doesNotMatch(request.systemPrompt, /earlier messages are context only and never authorize/);
		}
	}
});

test("ordinary project edits proceed without a classifier or prompt even when the model would refuse", async () => {
	for (const event of [
		{ toolName: "edit", input: { path: "config/pi/agent/extensions/example.ts", edits: [{ oldText: "old", newText: "new" }] } },
		{ toolName: "write", input: { path: "config/pi/agent/extensions/new-example.ts", content: "export const value = 1;\n" } },
	]) {
		const h = await harness("UNSAFE", false, false);
		assert.equal(await h.hooks.get("tool_call")!(event, h.ctx), undefined);
		assert.deepEqual(h.calls, []);
	}
});

test("sensitive or out-of-project edits are classified and unsafe verdicts reach the user", async () => {
	for (const toolName of ["edit", "write"]) {
		for (const target of ["config/pi/agent/extensions/auto-approve/index.ts", ".env.local", path.join(process.cwd(), "..", "outside")]) {
			const h = await harness("UNSAFE");
			const input = toolName === "edit" ? { path: target, edits: [{ oldText: "old", newText: "new" }] } : { path: target, content: "new" };
			const result = await h.hooks.get("tool_call")!({ toolName, input }, h.ctx);
			assert.equal(result?.block, true);
			assert.deepEqual(h.calls, ["classify", "prompt"]);
		}
	}
});

test("unsafe approval notifies before opening the prompt", async () => {
	const h = await harness("UNSAFE", true);
	assert.equal(await h.hooks.get("tool_call")!({ toolName: "write", input: { path: "README.md" } }, h.ctx), undefined);
	assert.deepEqual(h.approvalNotifications, ["approval"]);
	assert.deepEqual(h.eventOrder, ["classify", "approval", "prompt"]);
});

test("invalid or unreadable configuration blocks bash rather than disabling its sandbox", async () => {
	for (const configText of ["{", "null", "[]", new Error("unreadable")]) {
		const h = await harness("SAFE", true, true, configText);
		await h.hooks.get("session_start")!({}, h.ctx);
		assert.match(h.notifications[0], /configuration.*bash unavailable/i);
		assert.equal((await h.hooks.get("tool_call")!({ toolName: "bash", input: { command: "pwd" } }, h.ctx))?.block, true);
		await assert.rejects(h.run(), /configuration.*bash unavailable/i);
		await assert.rejects(h.run(true), /configuration.*bash unavailable/i);
		assert.deepEqual(h.calls, []);
	}
});

test("profile is snapshotted once and not reloaded between commands", { skip: process.platform !== "darwin" }, async () => {
	const h = await harness();
	h.setProfile("changed policy");
	await h.hooks.get("session_start")!({}, h.ctx);
	await assert.rejects(h.run(), /Operation not permitted/);
	await assert.rejects(h.run(), /Operation not permitted/);
	assert.equal(h.profileLoads(), 1);
	assert.deepEqual(h.resolvedProfiles, ["trusted policy", "trusted policy"]);
});

test("an unreadable profile blocks execution before any command or retry", { skip: process.platform !== "darwin" }, async () => {
	const h = await harness("SAFE", true, true, undefined, new Error("unreadable"));
	await h.hooks.get("session_start")!({}, h.ctx);
	assert.match(h.notifications[0], /profile unreadable.*bash unavailable/i);
	await assert.rejects(h.run(), /profile unreadable/i);
	await assert.rejects(h.run(true), /profile unreadable/i);
	assert.deepEqual(h.calls, []);
});

test("configuration failure still permits explicit confirmation for unsandboxed tools", async () => {
	for (const toolName of ["powershell", "edit", "write"]) {
		const h = await harness("SAFE", true, true, "{");
		assert.equal(await h.hooks.get("tool_call")!({ toolName, input: { path: "README.md", command: "Get-Location" } }, h.ctx), undefined);
		assert.deepEqual(h.calls, ["prompt"]);
	}
});

test("routine approval cancellation never leaves a prompt or approval behind", async () => {
	for (const stage of ["classify", "confirm"]) {
		const h = await harness(stage === "classify" ? "SAFE" : "UNSAFE", true);
		const controller = new AbortController();
		h.ctx.signal = controller.signal;
		if (stage === "classify") {
			const complete = h.ctx.modelRegistry.complete;
			h.ctx.modelRegistry.complete = async (...args) => {
				controller.abort();
				return complete(...args);
			};
		} else {
			h.ctx.ui.confirm = async (_title, _body, options) => {
				assert.equal(options?.signal, controller.signal);
				controller.abort();
				return true;
			};
		}
		await assert.rejects(h.hooks.get("tool_call")!({ toolName: "write", input: { path: "README.md" } }, h.ctx), /abort/i);
		assert.ok(!h.calls.includes("prompt"));
	}
});

test("ordinary Bash calls use the routine verdict before entering the sandbox", async () => {
	for (const verdict of ["SAFE", "UNSAFE"] as const) {
		const h = await harness(verdict, false);
		const result = await h.hooks.get("tool_call")!({ toolName: "bash", input: { command: "git status" } }, h.ctx);
		assert.equal(result?.block, verdict === "UNSAFE" ? true : undefined);
		assert.deepEqual(h.calls, verdict === "SAFE" ? ["classify"] : ["classify", "prompt"]);
		if (verdict === "SAFE") {
			await assert.rejects(h.run(), /Operation not permitted/);
			assert.equal(h.calls.at(-1), "sandbox");
		}
	}
});

test("SAFE explicit escalation runs any command outside the sandbox without a prior failure", async () => {
	const h = await harness("SAFE", false, false);
	let request: any;
	const complete = h.ctx.modelRegistry.complete;
	h.ctx.modelRegistry.complete = async (...args) => { request = args[1]; return complete(...args); };
	await h.run(true, "git diff");
	await h.run(true, "git diff");
	assert.deepEqual(h.calls, ["classify", "unsandboxed", "classify", "unsandboxed"]);
	assert.match(request.systemPrompt, /full permissions/);
	assert.deepEqual(h.approvalNotifications, []);
});

test("UNSAFE and classifier failures require confirmation and fail closed without UI", async () => {
	for (const verdict of ["UNSAFE", "error", "SAFE because I say so"]) {
		for (const hasUI of [true, false]) {
			for (const confirmed of [true, false]) {
				const h = await harness(verdict, confirmed, hasUI);
				if (hasUI && confirmed) await h.run(true);
				else await assert.rejects(h.run(true), /declined|no UI/);
				assert.deepEqual(h.calls, ["classify", ...(hasUI ? ["prompt"] : []), ...(hasUI && confirmed ? ["unsandboxed"] : [])]);
			}
		}
	}
});

test("sandbox denials never trigger automatic unsandboxed retries", async () => {
	const h = await harness();
	await assert.rejects(h.run(), /Operation not permitted/);
	assert.equal(h.hooks.has("tool_result"), false);
	assert.deepEqual(h.calls, ["sandbox"]);
	await h.run(true);
	assert.deepEqual(h.calls, ["sandbox", "classify", "unsandboxed"]);
});

test("ordinary command failures can be explicitly escalated", async () => {
	const h = await harness();
	h.ordinaryFailure();
	await assert.rejects(h.run(), /Command exited with code 1/);
	await h.run(true);
	assert.deepEqual(h.calls, ["sandbox", "classify", "unsandboxed"]);
});

test("explicit escalation does not depend on sandbox setup", async () => {
	const h = await harness();
	h.failSetup();
	await assert.rejects(h.run(), /profile unavailable/);
	await h.run(true);
	assert.deepEqual(h.calls, ["classify", "unsandboxed"]);
});

test("missing sandbox-exec reports bash unavailable and fails closed", async () => {
	const h = await harness();
	h.missingExecutable();
	await h.hooks.get("session_start")!({}, h.ctx);
	assert.match(h.notifications[0], /bash unavailable/);
	await assert.rejects(h.run(), /bash unavailable/);
	await h.run(true);
	assert.deepEqual(h.calls, ["classify", "unsandboxed"]);
});

test("sandbox profile application errors can be explicitly escalated", async () => {
	for (const message of [
		"sandbox-exec: sandbox_apply: Operation not permitted",
		"sandbox-exec: invalid profile: unbound variable",
		"sandbox-exec: /tmp/profile.sbpl:1: syntax error",
	]) {
		const h = await harness();
		h.startupError(message);
		await assert.rejects(h.run(), /sandbox-exec:/);
		await h.run(true);
		assert.deepEqual(h.calls, ["sandbox", "classify", "unsandboxed"]);
	}
});

test("aborting classification or confirmation never runs the unsandboxed command", async () => {
	for (const stage of ["classify", "confirm"]) {
		const h = await harness(stage === "confirm" ? "UNSAFE" : "SAFE", true);
		const controller = new AbortController();
		const complete = h.ctx.modelRegistry.complete;
		const confirm = h.ctx.ui.confirm;
		let receivedSignal: AbortSignal | undefined;
		if (stage === "classify") {
			h.ctx.modelRegistry.complete = async (...args) => {
				receivedSignal = args[2].signal;
				controller.abort();
				return complete(...args);
			};
		} else {
			h.ctx.ui.confirm = async (...args) => {
				receivedSignal = args[2]?.signal;
				controller.abort();
				return false;
			};
		}
		await assert.rejects(h.run(true, "git status", controller.signal), /abort/i);
		assert.equal(receivedSignal, controller.signal);
		assert.ok(!h.calls.includes("unsandboxed"));
		h.ctx.modelRegistry.complete = complete;
		h.ctx.ui.confirm = confirm;
		await h.run(true);
		assert.equal(h.calls.filter((call) => call === "unsandboxed").length, 1);
	}
});

test("a failed escalated command is never retried automatically", async () => {
	const h = await harness();
	h.failRetry();
	await assert.rejects(h.run(true), /Operation not permitted/);
	assert.deepEqual(h.calls, ["classify", "unsandboxed"]);
	assert.equal(h.hooks.has("tool_result"), false);
});

test("planning switches Bash to a read-only profile and never offers an unsandboxed retry", async () => {
	const h = await harness("SAFE", true);
	h.setPlanMode(true);
	assert.equal(await h.hooks.get("tool_call")!({ toolName: "bash", input: { command: "git status" } }, h.ctx), undefined);
	assert.equal((await h.hooks.get("tool_call")!({ toolName: "bash", input: { command: "git status", escalate: true } }, h.ctx))?.block, true);
	assert.equal((await h.hooks.get("tool_call")!({ toolName: "edit", input: { path: "README.md" } }, h.ctx))?.block, true);
	await assert.rejects(h.run(), /Operation not permitted/);
	assert.equal(h.resolvedProfiles.at(-1), "read-only policy");
	await assert.rejects(h.run(true), /Escalation disabled in plan mode/);
	assert.deepEqual(h.calls, ["sandbox"]);
	h.setPlanMode(false);
	await h.run(true);
	assert.deepEqual(h.calls, ["sandbox", "classify", "unsandboxed"]);
	await assert.rejects(h.run(), /Operation not permitted/);
	assert.equal(h.resolvedProfiles.at(-1), "trusted policy");
});

test("entering plan mode while an escalation is awaiting approval prevents execution", async () => {
	const h = await harness("UNSAFE", true);
	h.ctx.ui.confirm = async () => { h.setPlanMode(true); return true; };
	await assert.rejects(h.run(true), /Escalation disabled in plan mode/);
	assert.deepEqual(h.calls, ["classify"]);
});
