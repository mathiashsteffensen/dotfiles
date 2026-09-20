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
	let tool: any;
	let failRetry = false;
	let maskedNetworkFailure = false;
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
			loadSbpl: () => {
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
					if (options && maskedNetworkFailure) {
						return { content: [{ type: "text", text: "dial tcp [::1]:5432: connect: operation not permitted" }], details: {} };
					}
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
	});
	const run = (escalate = false, command = "git status", signal?: AbortSignal) => tool.execute("id", { command, escalate }, signal, undefined, ctx);
	return {
		calls, ctx, hooks, run, notifications, approvalNotifications, eventOrder, resolvedProfiles,
		profileLoads: () => profileLoads,
		setProfile: (text: string) => { profileText = text; },
		failRetry: () => { failRetry = true; },
		maskedNetworkFailure: () => { maskedNetworkFailure = true; },
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

test("routine edits include their changes and project root, and SAFE never prompts", async () => {
	const inputs = [
		{ toolName: "edit", input: { path: "test/example.ts", edits: [{ oldText: "assert.equal(sum(1, 2), 4)", newText: "assert.equal(sum(1, 2), 3)" }] } },
		{ toolName: "write", input: { path: "test/example.ts", content: "assert.equal(sum(1, 2), 3);\n" } },
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

test("every edit/write is classified and unsafe verdicts reach the user", async () => {
	for (const toolName of ["edit", "write"]) {
		for (const target of ["README.md", path.join(process.cwd(), "..", "outside")]) {
			const h = await harness("UNSAFE");
			const result = await h.hooks.get("tool_call")!({ toolName, input: { path: target } }, h.ctx);
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

test("explicit escalation requires the exact failed command and cwd; SAFE is one-shot without UI", async () => {
	const h = await harness("SAFE", false, false);
	await assert.rejects(h.run(true), /requires this exact command/);
	await assert.rejects(h.run(), /Operation not permitted/);
	await assert.rejects(h.run(true, "git diff"), /requires this exact command/);
	const cwd = h.ctx.cwd;
	h.ctx.cwd = "/tmp";
	await assert.rejects(h.run(true), /requires this exact command/);
	h.ctx.cwd = cwd;
	const results = await Promise.allSettled([h.run(true), h.run(true)]);
	assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
	assert.deepEqual(h.calls, ["sandbox", "classify", "unsandboxed"]);
	await assert.rejects(h.run(), /Operation not permitted/);
	assert.equal(h.calls.at(-1), "sandbox");
	await assert.rejects(h.run(true), /already decided/);
});

test("UNSAFE and classifier failures require confirmation and fail closed without UI", async () => {
	for (const verdict of ["UNSAFE", "error", "SAFE because I say so"]) {
		for (const hasUI of [true, false]) {
			for (const confirmed of [true, false]) {
				const h = await harness(verdict, confirmed, hasUI);
				await assert.rejects(h.run(), /Operation not permitted/);
				if (hasUI && confirmed) await h.run(true);
				else await assert.rejects(h.run(true), /declined|no UI/);
				assert.deepEqual(h.calls, ["sandbox", "classify", ...(hasUI ? ["prompt"] : []), ...(hasUI && confirmed ? ["unsandboxed"] : [])]);
				await assert.rejects(h.run(true), /already decided/);
			}
		}
	}
});

test("network denials masked by a successful pipeline qualify for escalation", async () => {
	const h = await harness();
	h.maskedNetworkFailure();
	await h.run();
	await h.run(true);
	assert.deepEqual(h.calls, ["sandbox", "classify", "unsandboxed"]);
});

test("ordinary command failures do not qualify for escalation", async () => {
	const h = await harness();
	h.ordinaryFailure();
	await assert.rejects(h.run(), /Command exited with code 1/);
	await assert.rejects(h.run(true), /requires this exact command/);
	assert.deepEqual(h.calls, ["sandbox"]);
});

test("sandbox setup failures do not qualify for escalation", async () => {
	const h = await harness();
	h.failSetup();
	await assert.rejects(h.run(), /profile unavailable/);
	await assert.rejects(h.run(true), /requires this exact command/);
	assert.deepEqual(h.calls, []);
});

test("missing sandbox-exec reports bash unavailable and fails closed", async () => {
	const h = await harness();
	h.missingExecutable();
	await h.hooks.get("session_start")!({}, h.ctx);
	assert.match(h.notifications[0], /bash unavailable/);
	await assert.rejects(h.run(), /bash unavailable/);
	await assert.rejects(h.run(true), /requires this exact command/);
	assert.deepEqual(h.calls, []);
});

test("sandbox profile application errors never qualify for escalation", async () => {
	for (const message of [
		"sandbox-exec: sandbox_apply: Operation not permitted",
		"sandbox-exec: invalid profile: unbound variable",
		"sandbox-exec: /tmp/profile.sbpl:1: syntax error",
	]) {
		const h = await harness();
		h.startupError(message);
		await assert.rejects(h.run(), /sandbox-exec:/);
		await assert.rejects(h.run(true), /requires this exact command/);
		assert.deepEqual(h.calls, ["sandbox"]);
	}
});

test("aborting classification or confirmation releases the reservation and uses the tool signal", async () => {
	for (const stage of ["classify", "confirm"]) {
		const h = await harness(stage === "confirm" ? "UNSAFE" : "SAFE", true);
		await assert.rejects(h.run(), /Operation not permitted/);
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
		await assert.rejects(h.run(true), /already decided/);
	}
});

test("an escalated failure is not automatically escalated again", async () => {
	const h = await harness();
	await assert.rejects(h.run(), /Operation not permitted/);
	h.failRetry();
	await assert.rejects(h.run(true), /Operation not permitted/);
	assert.equal(await h.hooks.get("tool_result")!({ toolName: "bash", isError: true, input: { command: "git status", escalate: true } }, h.ctx), undefined);
	await assert.rejects(h.run(true), /already decided/);
});

test("automatic denied-write retries share the escalation gate", async () => {
	const h = await harness();
	const command = "git status";
	await assert.rejects(h.run(), /Operation not permitted/);
	const result = await h.hooks.get("tool_result")!({
		toolName: "bash", toolCallId: "id", isError: true, input: { command },
		content: [{ type: "text", text: `fatal: '${path.join(h.ctx.cwd, ".git/index.lock")}': Operation not permitted` }],
	}, h.ctx);
	assert.equal(result.isError, false);
	assert.deepEqual(h.calls, ["sandbox", "classify", "unsandboxed"]);
	await assert.rejects(h.run(true), /already decided/);
});
