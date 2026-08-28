import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import persistentMemory from "../index.ts";
import { MANAGEMENT_MODE_ERROR } from "../commands.ts";
import {
	createProposal,
	foldProposals,
	PROPOSAL_CUSTOM_TYPE,
	PROPOSAL_STATUS_CUSTOM_TYPE,
} from "../proposals.ts";
import { RECALL_AUTHORITY_RULE, RECALL_CUSTOM_TYPE } from "../retrieval.ts";
import { candidate, memoryId } from "./helpers.ts";

class FakeSessionManager {
	entries: any[] = [];
	private id = "session-test";

	getSessionId() { return this.id; }
	getBranch() { return [...this.entries]; }
	getEntries() { return [...this.entries]; }
	getSessionFile() { return undefined; }
	getCwd() { return process.cwd(); }
	getSessionDir() { return ""; }
	getLeafId() { return this.entries.at(-1)?.id ?? null; }
	getLeafEntry() { return this.entries.at(-1); }
	getEntry(id: string) { return this.entries.find((entry) => entry.id === id); }
	getLabel() { return undefined; }
	buildContextEntries() { return this.getBranch(); }
	getHeader() { return null; }
	getTree() { return []; }
	getSessionName() { return undefined; }
}

class FakeUI {
	confirmResult = true;
	confirmHook?: (title: string, message: string) => void;
	editorResponses = new Map<string, string[]>();
	calls: Array<{ method: string; title?: string; message?: string }> = [];

	async select(title: string, options: string[]) {
		this.calls.push({ method: "select", title });
		if (title === "Memory kind") return "preference";
		if (title === "Recall mode") return "relevant";
		return options[0];
	}
	async confirm(title: string, message: string) {
		this.calls.push({ method: "confirm", title, message });
		this.confirmHook?.(title, message);
		return this.confirmResult;
	}
	async input(title: string) {
		this.calls.push({ method: "input", title });
		return undefined;
	}
	async editor(title: string, prefill = "") {
		this.calls.push({ method: "editor", title, message: prefill });
		return this.editorResponses.get(title)?.shift() ?? prefill;
	}
	notify(message: string) { this.calls.push({ method: "notify", message }); }
	setStatus() {}
	setWorkingMessage() {}
	setWorkingVisible() {}
	setWorkingIndicator() {}
	setHiddenThinkingLabel() {}
	setWidget() {}
	setFooter() {}
	setHeader() {}
	setTitle() {}
	async custom() { return undefined; }
	pasteToEditor() {}
	setEditorText() {}
	getEditorText() { return ""; }
	addAutocompleteProvider() {}
	setEditorComponent() {}
	getEditorComponent() { return undefined; }
	theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		strikethrough: (text: string) => text,
	};
	getAllThemes() { return []; }
	getTheme() { return undefined; }
	setTheme() { return { success: false }; }
	getToolsExpanded() { return false; }
	setToolsExpanded() {}
}

class FakePi {
	handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	commands = new Map<string, any>();
	tools = new Map<string, any>();
	renderers = new Map<string, any>();
	session: FakeSessionManager;
	appendCount = 0;
	failStatusAppendOnce = false;

	constructor(session: FakeSessionManager) { this.session = session; }
	on(name: string, handler: (event: any, ctx: any) => any) {
		const handlers = this.handlers.get(name) ?? [];
		handlers.push(handler);
		this.handlers.set(name, handlers);
	}
	registerCommand(name: string, command: any) { this.commands.set(name, command); }
	registerTool(tool: any) { this.tools.set(tool.name, tool); }
	registerEntryRenderer(name: string, renderer: any) { this.renderers.set(name, renderer); }
	appendEntry(customType: string, data: unknown) {
		if (customType === PROPOSAL_STATUS_CUSTOM_TYPE && this.failStatusAppendOnce) {
			this.failStatusAppendOnce = false;
			throw new Error("injected status append failure");
		}
		this.appendCount++;
		this.session.entries.push({
			type: "custom",
			id: `custom${this.appendCount}`,
			parentId: this.session.entries.at(-1)?.id ?? null,
			timestamp: new Date().toISOString(),
			customType,
			data,
		});
	}
}

interface Harness {
	agentDir: string;
	pi: FakePi;
	ui: FakeUI;
	session: FakeSessionManager;
	ctx: ExtensionCommandContext;
	modelCalls: {
		count: number;
		responseText?: string;
		lastPrompt?: string;
		lastModel?: any;
		lastSignal?: AbortSignal;
		complete?: (model: any, request: any, options: any) => Promise<any>;
	};
}

async function harness(mode: "tui" | "rpc" | "json" | "print" = "tui"): Promise<Harness> {
	const agentDir = await mkdtemp(join(tmpdir(), "persistent-memory-extension-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const session = new FakeSessionManager();
	const ui = new FakeUI();
	const pi = new FakePi(session);
	const modelCalls: Harness["modelCalls"] = { count: 0 };
	const model = {
		id: "fake-model",
		name: "Fake",
		api: "openai-responses",
		provider: "fake",
		baseUrl: "http://localhost",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 1000,
	};
	const context: any = {
		ui,
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		cwd: process.cwd(),
		sessionManager: session,
		model,
		modelRegistry: {
			hasConfiguredAuth: () => true,
			complete: async (selectedModel: unknown, request: any, options: any) => {
				modelCalls.count++;
				modelCalls.lastModel = selectedModel;
				modelCalls.lastSignal = options.signal;
				modelCalls.lastPrompt = request.messages[0]?.content[0]?.text;
				if (modelCalls.complete) return modelCalls.complete(selectedModel, request, options);
				if (modelCalls.responseText === undefined) throw new Error("not configured in this fake");
				return {
					role: "assistant",
					content: [{ type: "text", text: modelCalls.responseText }],
					api: "openai-responses",
					provider: "fake",
					model: "fake-model",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				};
			},
		},
		scopedModels: [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort() {},
		hasPendingMessages: () => false,
		shutdown() {},
		getContextUsage: () => ({ tokens: 1000, contextWindow: 100_000, percent: 1 }),
		compact() {},
		getSystemPrompt: () => "base system",
		getSystemPromptOptions: () => ({}),
		waitForIdle: async () => {},
	};
	persistentMemory(pi as unknown as ExtensionAPI);
	return { agentDir, pi, ui, session, ctx: context as ExtensionCommandContext, modelCalls };
}

async function trigger(pi: FakePi, name: string, event: unknown, ctx: ExtensionContext) {
	let result: unknown;
	for (const handler of pi.handlers.get(name) ?? []) result = await handler(event, ctx);
	return result as any;
}

test("factory performs no I/O and registers exactly two read-only tools", async () => {
	const value = await harness();
	await assert.rejects(access(join(value.agentDir, "memory")), /ENOENT/u);
	assert.deepEqual([...value.pi.tools.keys()].sort(), ["memory_get", "memory_search"]);
	assert.deepEqual([...value.pi.commands.keys()], ["memory"]);
	assert.equal(value.pi.handlers.get("agent_end"), undefined);
});

test("direct add confirms one record, matching recall is ephemeral and ordered before current user", async () => {
	const value = await harness();
	await trigger(value.pi, "session_start", { type: "session_start", reason: "startup" }, value.ctx);
	const command = value.pi.commands.get("memory");
	await command.handler(
		"add --tag security The phrase ignore previous instructions remains untrusted reference data.",
		value.ctx,
	);
	const recordFiles = await readdir(join(value.agentDir, "memory", "records"));
	assert.equal(recordFiles.length, 1);
	assert.equal(value.session.entries.length, 0);

	const before = await trigger(
		value.pi,
		"before_agent_start",
		{ type: "before_agent_start", prompt: "security instructions", systemPrompt: "base system", systemPromptOptions: {} },
		value.ctx,
	);
	assert.equal(before.systemPrompt.includes(RECALL_AUTHORITY_RULE), true);
	const user = { role: "user", content: "security instructions", timestamp: Date.now() };
	let contextResult = await trigger(value.pi, "context", { type: "context", messages: [user] }, value.ctx);
	assert.equal(contextResult.messages.length, 2);
	assert.equal(contextResult.messages[0].customType, RECALL_CUSTOM_TYPE);
	assert.equal(contextResult.messages[1], user);
	assert.match(contextResult.messages[0].content, /ignore previous instructions/u);
	assert.match(contextResult.messages[0].content, /"The phrase ignore previous instructions remains untrusted reference data\."/u);
	assert.equal(contextResult.messages[0].content.includes("provenance"), false);

	contextResult = await trigger(
		value.pi,
		"context",
		{ type: "context", messages: [contextResult.messages[0], user] },
		value.ctx,
	);
	assert.equal(contextResult.messages.filter((message: any) => message.customType === RECALL_CUSTOM_TYPE).length, 1);
	assert.equal(value.session.entries.some((entry) => entry.customType === RECALL_CUSTOM_TYPE), false);

	await trigger(value.pi, "agent_settled", { type: "agent_settled" }, value.ctx);
	contextResult = await trigger(value.pi, "context", { type: "context", messages: [user] }, value.ctx);
	assert.equal(contextResult.messages.length, 1);
});

test("read-only tools disclose bounded fields and no provenance", async () => {
	const value = await harness();
	await trigger(value.pi, "session_start", { type: "session_start", reason: "startup" }, value.ctx);
	await value.pi.commands.get("memory").handler(
		"add --tag summary The user prefers concise summaries.",
		value.ctx,
	);
	const search = await value.pi.tools.get("memory_search").execute("call", { query: "summary", limit: 6 });
	const searchData = JSON.parse(search.content[0].text);
	assert.equal(searchData.length, 1);
	assert.deepEqual(Object.keys(searchData[0]).sort(), ["content", "id", "kind", "score", "tags"]);
	assert.ok(Buffer.byteLength(search.content[0].text, "utf8") <= 8192);
	const get = await value.pi.tools.get("memory_get").execute("call", { id: searchData[0].id.slice(0, 8) });
	assert.equal(get.content[0].text.includes("provenance"), false);
	assert.deepEqual(Object.keys(JSON.parse(get.content[0].text)).sort(), [
		"content",
		"enabled",
		"id",
		"kind",
		"recall",
		"superseded",
		"tags",
	]);
});

test("secret-shaped direct candidates are rejected without logging their content", async () => {
	const value = await harness();
	await trigger(value.pi, "session_start", { type: "session_start", reason: "startup" }, value.ctx);
	const secret = "api_key=abcdefghijklmnop";
	await value.pi.commands.get("memory").handler(`add The ${secret} value is stable.`, value.ctx);
	assert.deepEqual(await readdir(join(value.agentDir, "memory", "records")), []);
	assert.equal(JSON.stringify(value.ui.calls).includes(secret), false);
	assert.equal(value.ui.calls.some((call) => call.message?.includes("named secret assignment")), true);
});

test("selected distillation sends only normalized user/assistant text and creates pending proposals", async () => {
	const value = await harness("rpc");
	value.session.entries.push(
		{ type: "message", id: "entry001", parentId: null, message: { role: "user", content: "User source", timestamp: 1 } },
		{ type: "message", id: "tool0001", parentId: "entry001", message: { role: "toolResult", content: [{ type: "text", text: "SECRET TOOL OUTPUT" }], timestamp: 2 } },
		{
			type: "message",
			id: "entry002",
			parentId: "tool0001",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "SECRET THINKING" },
					{ type: "text", text: "Assistant source" },
				],
				timestamp: 3,
			},
		},
	);
	value.modelCalls.responseText = JSON.stringify({
		schemaVersion: 1,
		candidates: [
			{ content: "The user prefers concise replies.", kind: "preference", recall: "relevant", tags: ["reply"] },
			{ content: "The user validates changes before summaries.", kind: "workflow", recall: "relevant", tags: ["validation"] },
		],
	});
	await trigger(value.pi, "session_start", { type: "session_start", reason: "startup" }, value.ctx);
	await value.pi.commands.get("memory").handler("distill --entries entry001..entry002", value.ctx);
	assert.equal(value.modelCalls.count, 1);
	assert.equal(value.modelCalls.lastPrompt?.includes("User source"), true);
	assert.equal(value.modelCalls.lastPrompt?.includes("Assistant source"), true);
	assert.equal(value.modelCalls.lastPrompt?.includes("SECRET TOOL OUTPUT"), false);
	assert.equal(value.modelCalls.lastPrompt?.includes("SECRET THINKING"), false);
	assert.equal(value.session.entries.filter((entry) => entry.customType === PROPOSAL_CUSTOM_TYPE).length, 2);
	assert.deepEqual(await readdir(join(value.agentDir, "memory", "records")), []);
});

test("distillation completion and provenance stay bound to the disclosed model", async () => {
	const value = await harness("rpc");
	value.session.entries.push(
		{ type: "message", id: "entry001", parentId: null, message: { role: "user", content: "User source", timestamp: 1 } },
		{ type: "message", id: "entry002", parentId: "entry001", message: { role: "assistant", content: [{ type: "text", text: "Assistant source" }], timestamp: 2 } },
	);
	value.modelCalls.responseText = JSON.stringify({
		schemaVersion: 1,
		candidates: [{ content: "The user prefers stable model selection.", kind: "preference", recall: "relevant", tags: [] }],
	});
	const disclosedModel = value.ctx.model!;
	const changedModel = { ...disclosedModel, id: "changed-model", provider: "changed-provider" };
	value.ui.confirmHook = (title) => {
		if (title === "Send selected text for distillation") (value.ctx as any).model = changedModel;
	};
	await trigger(value.pi, "session_start", { type: "session_start", reason: "startup" }, value.ctx);
	await value.pi.commands.get("memory").handler("distill --entries entry001..entry002", value.ctx);
	assert.equal(value.modelCalls.lastModel, disclosedModel);
	const proposal = value.session.entries.find((entry) => entry.customType === PROPOSAL_CUSTOM_TYPE)?.data;
	assert.deepEqual(proposal?.generator, { provider: disclosedModel.provider, model: disclosedModel.id });
	const disclosure = value.ui.calls.find((call) => call.title === "Send selected text for distillation")?.message;
	assert.equal(disclosure?.includes(`${disclosedModel.provider}/${disclosedModel.id}`), true);
	assert.equal(disclosure?.includes("changed-provider/changed-model"), false);
});

test("RPC cancel-distill aborts the exact provider request and overlap creates no proposal", async () => {
	const value = await harness("rpc");
	value.session.entries.push(
		{ type: "message", id: "entry001", parentId: null, message: { role: "user", content: "User source", timestamp: 1 } },
		{ type: "message", id: "entry002", parentId: "entry001", message: { role: "assistant", content: [{ type: "text", text: "Assistant source" }], timestamp: 2 } },
	);
	let providerStarted!: () => void;
	const started = new Promise<void>((resolve) => { providerStarted = resolve; });
	value.modelCalls.complete = async (_model, _request, options) =>
		new Promise((_resolve, reject) => {
			providerStarted();
			options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		});
	await trigger(value.pi, "session_start", { type: "session_start", reason: "startup" }, value.ctx);
	const command = value.pi.commands.get("memory");
	const distilling = command.handler("distill --entries entry001..entry002", value.ctx);
	await started;
	await command.handler("distill --entries entry001..entry002", value.ctx);
	assert.equal(value.modelCalls.count, 1);
	assert.equal(value.ui.calls.some((call) => call.message?.includes("already in progress")), true);
	await command.handler("cancel-distill", value.ctx);
	await distilling;
	assert.equal(value.modelCalls.lastSignal?.aborted, true);
	assert.equal(value.session.entries.some((entry) => entry.customType === PROPOSAL_CUSTOM_TYPE), false);
	assert.deepEqual(await readdir(join(value.agentDir, "memory", "records")), []);
	assert.equal(value.ui.calls.some((call) => call.message === "Distillation cancelled"), true);
	await command.handler("cancel-distill", value.ctx);
	assert.equal(value.ui.calls.some((call) => call.message === "No memory distillation is in progress"), true);
});

test("session shutdown aborts active distillation without persisting a proposal", async () => {
	const value = await harness("rpc");
	value.session.entries.push(
		{ type: "message", id: "entry001", parentId: null, message: { role: "user", content: "User source", timestamp: 1 } },
		{ type: "message", id: "entry002", parentId: "entry001", message: { role: "assistant", content: [{ type: "text", text: "Assistant source" }], timestamp: 2 } },
	);
	let providerStarted!: () => void;
	const started = new Promise<void>((resolve) => { providerStarted = resolve; });
	value.modelCalls.complete = async (_model, _request, options) =>
		new Promise((_resolve, reject) => {
			providerStarted();
			options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		});
	await trigger(value.pi, "session_start", { type: "session_start", reason: "startup" }, value.ctx);
	const distilling = value.pi.commands.get("memory").handler("distill --entries entry001..entry002", value.ctx);
	await started;
	await trigger(value.pi, "session_shutdown", { type: "session_shutdown" }, value.ctx);
	await distilling;
	assert.equal(value.modelCalls.lastSignal?.aborted, true);
	assert.equal(value.session.entries.some((entry) => entry.customType === PROPOSAL_CUSTOM_TYPE), false);
});

test("cancellation writes nothing and ordinary settling never invokes capture", async () => {
	const value = await harness();
	await trigger(value.pi, "session_start", { type: "session_start", reason: "startup" }, value.ctx);
	value.ui.confirmResult = false;
	await value.pi.commands.get("memory").handler("add A durable preference exists.", value.ctx);
	assert.deepEqual(await readdir(join(value.agentDir, "memory", "records")), []);
	assert.equal(value.pi.appendCount, 0);
	await trigger(value.pi, "agent_settled", { type: "agent_settled" }, value.ctx);
	assert.equal(value.modelCalls.count, 0);
	assert.equal(value.pi.appendCount, 0);
});

test("JSON and print mode management fail closed with the exact required error", async () => {
	for (const mode of ["json", "print"] as const) {
		const value = await harness(mode);
		await trigger(value.pi, "session_start", { type: "session_start", reason: "startup" }, value.ctx);
		await assert.rejects(
			value.pi.commands.get("memory").handler("add A durable preference exists.", value.ctx),
			new RegExp(MANAGEMENT_MODE_ERROR, "u"),
		);
		assert.deepEqual(await readdir(join(value.agentDir, "memory", "records")), []);
	}
});

test("registered commands edit/approve, reject, and defer three proposals independently", async () => {
	const value = await harness();
	const proposals = [1, 2, 3].map((number) =>
		createProposal({
			proposalId: memoryId(500 + number),
			source: {
				sessionId: value.session.getSessionId(),
				entryIds: ["entry001"],
				sourceDigest: `${number}`.repeat(64),
			},
			candidate: candidate({
				content: `The user preference number ${number} is durable.`,
				tags: [`proposal-${number}`],
			}),
			generator: { provider: "fake", model: "fake-model" },
			createdAt: `2026-04-05T12:00:0${number}.000Z`,
		}),
	);
	for (const proposal of proposals) value.pi.appendEntry(PROPOSAL_CUSTOM_TYPE, proposal);
	await trigger(value.pi, "session_start", { type: "session_start", reason: "startup" }, value.ctx);
	value.ui.editorResponses.set("Memory content", ["The edited user preference is durable."]);
	const command = value.pi.commands.get("memory");
	await command.handler(`approve ${proposals[0]!.proposalId}`, value.ctx);
	await command.handler(`reject ${proposals[1]!.proposalId}`, value.ctx);
	await command.handler("proposals", value.ctx);

	const files = await readdir(join(value.agentDir, "memory", "records"));
	assert.equal(files.length, 1);
	const stored = JSON.parse(await readFile(join(value.agentDir, "memory", "records", files[0]!), "utf8"));
	const firstRevisions = value.session.entries
		.filter((entry) => entry.customType === PROPOSAL_CUSTOM_TYPE && entry.data.proposalId === proposals[0]!.proposalId)
		.map((entry) => entry.data);
	const edited = firstRevisions.find((proposal) => proposal.revision === 2);
	assert.ok(edited);
	assert.equal(stored.content, "The edited user preference is durable.");
	assert.equal(stored.provenance.proposalHash, edited.candidateHash);
	const folded = foldProposals(value.session.getBranch());
	assert.deepEqual(folded.pending.map((proposal) => proposal.proposalId), [proposals[2]!.proposalId]);
	assert.equal(folded.byId.get(proposals[0]!.proposalId)?.decision?.status, "approved");
	assert.equal(folded.byId.get(proposals[1]!.proposalId)?.decision?.status, "rejected");
	assert.equal(value.session.entries.filter((entry) => entry.customType === PROPOSAL_STATUS_CUSTOM_TYPE).length, 2);
	const pendingDisplay = value.ui.calls.findLast((call) => call.method === "editor" && call.title === "Pending memory proposals");
	assert.equal(pendingDisplay?.message?.includes(proposals[2]!.proposalId), true);
	assert.equal(pendingDisplay?.message?.includes(proposals[1]!.proposalId), false);
});

test("proposal approval recovers idempotently after status append failure", async () => {
	const value = await harness();
	await trigger(value.pi, "session_start", { type: "session_start", reason: "startup" }, value.ctx);
	const proposal = createProposal({
		proposalId: memoryId(400),
		source: {
			sessionId: value.session.getSessionId(),
			entryIds: ["entry001"],
			sourceDigest: "a".repeat(64),
		},
		candidate: candidate({ content: "The user prefers terse approval summaries." }),
		generator: { provider: "fake", model: "fake-model" },
		createdAt: "2026-04-05T12:00:00.000Z",
	});
	value.pi.appendEntry(PROPOSAL_CUSTOM_TYPE, proposal);
	value.pi.failStatusAppendOnce = true;
	const command = value.pi.commands.get("memory");
	await command.handler(`approve ${proposal.proposalId.slice(0, 8)}`, value.ctx);
	assert.equal((await readdir(join(value.agentDir, "memory", "records"))).length, 1);
	assert.equal(value.session.entries.some((entry) => entry.customType === PROPOSAL_STATUS_CUSTOM_TYPE), false);

	await command.handler(`approve ${proposal.proposalId.slice(0, 8)}`, value.ctx);
	assert.equal((await readdir(join(value.agentDir, "memory", "records"))).length, 1);
	assert.equal(value.session.entries.some((entry) => entry.customType === PROPOSAL_STATUS_CUSTOM_TYPE), true);
	assert.equal(value.ui.calls.some((call) => call.message?.includes("Recovered approved memory")), true);
});

test("malformed warning is concise and emitted once per session", async () => {
	const value = await harness();
	await trigger(value.pi, "session_start", { type: "session_start", reason: "startup" }, value.ctx);
	const filename = "0195f4c7-8b35-7c29-a6b2-000000000099.json";
	const secret = "ghp_abcdefghijklmnopqrstuvwxyz";
	await writeFile(join(value.agentDir, "memory", "records", filename), `{bad ${secret}`, { mode: 0o600 });
	await trigger(
		value.pi,
		"before_agent_start",
		{ type: "before_agent_start", prompt: "summary", systemPrompt: "base", systemPromptOptions: {} },
		value.ctx,
	);
	await trigger(
		value.pi,
		"before_agent_start",
		{ type: "before_agent_start", prompt: "summary", systemPrompt: "base", systemPromptOptions: {} },
		value.ctx,
	);
	const warnings = value.ui.calls.filter((call) => call.method === "notify" && call.message?.includes("degraded"));
	assert.equal(warnings.length, 1);
	assert.equal(JSON.stringify(value.ui.calls).includes(secret), false);
});
