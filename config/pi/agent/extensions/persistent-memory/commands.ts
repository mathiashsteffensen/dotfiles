import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { uuidv7, type AssistantMessage } from "@earendil-works/pi-ai";
import {
	BorderedLoader,
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { canonicalJson, codePointLength } from "./canonical.ts";
import {
	buildDistillationPrompt,
	normalizeMessageText,
	normalizeSelection,
	parseModelCandidates,
	promptFitsModel,
	type NormalizedSelection,
} from "./distill.ts";
import {
	createProposal,
	foldProposals,
	makeProposalStatus,
	PROPOSAL_CUSTOM_TYPE,
	PROPOSAL_STATUS_CUSTOM_TYPE,
	resolveProposal,
	reviseProposal,
	type ProposalIndex,
} from "./proposals.ts";
import {
	createDirectRecord,
	createDistilledRecord,
	editRecord,
	nextUpdatedAt,
	resolveMemory,
} from "./records.ts";
import {
	findConflicts,
	normalizeRetrievalText,
	rankMemories,
} from "./retrieval.ts";
import type {
	MemoryCandidate,
	MemoryProposal,
	MemoryRecord,
	RecallMode,
} from "./schemas.ts";
import { MemoryStore, MemoryStoreError, type MemorySnapshot } from "./storage.ts";
import {
	formatValidationIssues,
	normalizeTag,
	validateCandidate,
} from "./validation.ts";

export const MANAGEMENT_MODE_ERROR = "memory management requires TUI or RPC";
export const MODEL_DISCLOSURE =
	"This global memory is stored locally and may be sent, without provenance metadata, to any model provider you use when relevant. Do not save secrets or information you do not want disclosed to those providers.";

export interface MemoryRuntimeState {
	store: MemoryStore | undefined;
	proposals: ProposalIndex;
	activeDistillationController?: AbortController;
}

interface ReviewedCandidate {
	candidate: MemoryCandidate;
	reviewedConflictIds: readonly string[];
}

interface ParsedDistillArgs {
	sessionId?: string;
	entries?: readonly [string, string];
}

type DistillableSessionEntry = Extract<SessionEntry, { type: "message" }> & {
	message: Extract<AgentMessage, { role: "user" | "assistant" }>;
};

function splitArguments(input: string): string[] {
	const result: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (const character of input.trim()) {
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else current += character;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (/\s/u.test(character)) {
			if (current) {
				result.push(current);
				current = "";
			}
		} else current += character;
	}
	if (escaped) current += "\\";
	if (quote) throw new Error("unterminated quoted command argument");
	if (current) result.push(current);
	return result;
}

function parseAddArgs(tokens: readonly string[]): { content: string; recall: RecallMode; tags: string[] } {
	let recall: RecallMode = "relevant";
	const tags: string[] = [];
	const content: string[] = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token === "--always") {
			recall = "always";
			continue;
		}
		if (token === "--tag") {
			const tag = tokens[++index];
			if (!tag) throw new Error("--tag requires a value");
			tags.push(tag);
			continue;
		}
		content.push(token ?? "");
	}
	return { content: content.join(" ").trim(), recall, tags };
}

function parseDistillArgs(tokens: readonly string[]): ParsedDistillArgs {
	const parsed: ParsedDistillArgs = {};
	for (let index = 0; index < tokens.length; index++) {
		const flag = tokens[index];
		if (flag === "--session") {
			const sessionId = tokens[++index];
			if (!sessionId) throw new Error("--session requires an ID");
			parsed.sessionId = sessionId;
			continue;
		}
		if (flag === "--entries") {
			const range = tokens[++index];
			const match = range?.match(/^([^.]*)\.\.([^.]*)$/u);
			if (!match?.[1] || !match[2]) throw new Error("--entries requires FIRST..LAST");
			parsed.entries = [match[1], match[2]];
			continue;
		}
		throw new Error("unknown distill argument");
	}
	return parsed;
}

function safeErrorMessage(error: unknown): string {
	if (error instanceof MemoryStoreError) return error.message;
	if (error instanceof Error) return error.message;
	return "persistent memory operation failed";
}

function abbreviate(value: string, maximum = 80): string {
	const points = Array.from(value.replace(/\s+/gu, " "));
	return points.length <= maximum ? points.join("") : `${points.slice(0, maximum - 1).join("")}…`;
}

async function displayText(ctx: ExtensionCommandContext, title: string, text: string): Promise<void> {
	await ctx.ui.editor(title, text);
}

async function showRecord(ctx: ExtensionCommandContext, record: Readonly<MemoryRecord>): Promise<void> {
	await displayText(ctx, `Memory ${record.id}`, `${JSON.stringify(record, null, 2)}\n`);
}

function parseTagEditor(value: string): string[] {
	return value
		.split(/[\s,]+/u)
		.map((tag) => tag.trim())
		.filter(Boolean)
		.map(normalizeTag);
}

function parseSupersedesEditor(
	value: string,
	records: readonly Readonly<MemoryRecord>[],
): string[] | undefined {
	const ids: string[] = [];
	for (const item of value.split(/[\s,]+/u).map((entry) => entry.trim()).filter(Boolean)) {
		const record = resolveMemory(records, item);
		if (record) ids.push(record.id);
		else if (/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(item)) ids.push(item);
		else return undefined;
	}
	return [...new Set(ids)].sort();
}

async function reviewCandidate(
	ctx: ExtensionCommandContext,
	initial: MemoryCandidate,
	snapshot: MemorySnapshot,
	excludeId?: string,
): Promise<ReviewedCandidate | undefined> {
	const content = await ctx.ui.editor("Memory content", initial.content);
	if (content === undefined) return undefined;
	const kind = await ctx.ui.select("Memory kind", [
		"preference",
		"fact",
		"constraint",
		"workflow",
		"correction",
	]);
	if (!kind) return undefined;
	const recall = await ctx.ui.select("Recall mode", ["relevant", "always"]);
	if (!recall) return undefined;
	const tagsText = await ctx.ui.editor("Tags (comma or space separated)", initial.tags.join(", "));
	if (tagsText === undefined) return undefined;
	const supersedesText = await ctx.ui.editor(
		"Superseded memory IDs (comma separated; prefixes accepted)",
		initial.supersedes.join(", "),
	);
	if (supersedesText === undefined) return undefined;
	const supersedes = parseSupersedesEditor(supersedesText, snapshot.records);
	if (!supersedes) {
		ctx.ui.notify("A superseded memory ID is invalid or ambiguous", "error");
		return undefined;
	}
	const validation = validateCandidate({
		content,
		kind,
		recall,
		tags: parseTagEditor(tagsText),
		supersedes,
	});
	if (!validation.candidate) {
		ctx.ui.notify(formatValidationIssues(validation.issues), "error");
		return undefined;
	}

	const candidate = validation.candidate;
	const reviewedConflictIds: string[] = [];
	const conflicts = findConflicts(candidate, snapshot.records, excludeId);
	for (const conflict of conflicts) {
		if (candidate.supersedes.includes(conflict.id)) continue;
		const action = await ctx.ui.select(
			`Possible conflict ${conflict.id}`,
			[
				`Replace this memory — ${abbreviate(conflict.content, 100)}`,
				"Keep both knowingly",
				"Cancel",
			],
		);
		if (!action || action === "Cancel") return undefined;
		reviewedConflictIds.push(conflict.id);
		if (action.startsWith("Replace")) candidate.supersedes.push(conflict.id);
	}
	candidate.supersedes = [...new Set(candidate.supersedes)].sort();
	return { candidate, reviewedConflictIds };
}

async function confirmApproval(
	ctx: ExtensionCommandContext,
	candidate: Readonly<MemoryCandidate>,
): Promise<boolean> {
	return ctx.ui.confirm(
		"Approve global memory",
		[
			JSON.stringify(candidate, null, 2),
			"",
			"Confirm that this is one durable, declarative, cross-project proposition—not repository-specific or temporary state, quoted prompt text, or an executable instruction.",
			MODEL_DISCLOSURE,
		].join("\n"),
	);
}

async function listRecords(
	ctx: ExtensionCommandContext,
	snapshot: MemorySnapshot,
	query: string,
): Promise<void> {
	const normalizedQuery = normalizeRetrievalText(query.trim());
	const superseded = snapshot.superseded;
	const records = snapshot.records
		.filter((record) => {
			if (!normalizedQuery) return true;
			return (
				normalizeRetrievalText(record.content).includes(normalizedQuery) ||
				record.tags.some((tag) => normalizeRetrievalText(tag).includes(normalizedQuery))
			);
		})
		.sort((left, right) =>
			left.updatedAt === right.updatedAt
				? left.id < right.id
					? -1
					: 1
				: left.updatedAt > right.updatedAt
					? -1
					: 1,
		);
	if (records.length === 0) {
		ctx.ui.notify("No memories found", "info");
		return;
	}
	let page = 0;
	const pageSize = 15;
	for (;;) {
		const pages = Math.ceil(records.length / pageSize);
		const visible = records.slice(page * pageSize, (page + 1) * pageSize);
		const options = visible.map((record) => {
			const state = !record.enabled ? "disabled" : superseded.has(record.id) ? "superseded" : "enabled";
			return `${record.id} [${state}/${record.kind}/${record.recall}] ${abbreviate(record.content)}`;
		});
		if (page > 0) options.push("← Previous page");
		if (page + 1 < pages) options.push("Next page →");
		options.push("Close");
		const choice = await ctx.ui.select(`Memories ${page + 1}/${pages}`, options);
		if (!choice || choice === "Close") return;
		if (choice === "← Previous page") {
			page--;
			continue;
		}
		if (choice === "Next page →") {
			page++;
			continue;
		}
		const record = records.find((item) => choice.startsWith(item.id));
		if (record) await showRecord(ctx, record);
	}
}

async function searchRecords(
	ctx: ExtensionCommandContext,
	snapshot: MemorySnapshot,
	query: string,
): Promise<void> {
	if (codePointLength(query.trim()) < 1 || codePointLength(query.trim()) > 500) {
		throw new Error("search query must contain 1–500 Unicode code points");
	}
	const ranked = rankMemories(snapshot.records, query, snapshot.superseded);
	const scores = new Map(ranked.map((item) => [item.record.id, item.score]));
	const lines = snapshot.records.map((record) => {
		let reason: string;
		if (!record.enabled) reason = "excluded: disabled";
		else if (snapshot.superseded.has(record.id)) reason = "excluded: superseded";
		else if (record.recall === "always") reason = "eligible: always";
		else if (!scores.has(record.id)) reason = "excluded: zero lexical score";
		else reason = `eligible: score ${scores.get(record.id)}`;
		return `${record.id} ${reason}\n  ${record.content}`;
	});
	await displayText(ctx, "Memory search", lines.join("\n\n") || "No valid records");
}

async function directAdd(
	ctx: ExtensionCommandContext,
	store: MemoryStore,
	tokens: readonly string[],
): Promise<void> {
	const parsed = parseAddArgs(tokens);
	if (!parsed.content) throw new Error("memory content is required");
	const initial = validateCandidate({
		content: parsed.content,
		kind: "preference",
		recall: parsed.recall,
		tags: parsed.tags,
		supersedes: [],
	});
	if (!initial.candidate) throw new Error(formatValidationIssues(initial.issues));
	const snapshot = await store.loadSnapshot();
	if (snapshot.errors.length > 0) throw new MemoryStoreError("memory store is degraded", "degraded");
	const reviewed = await reviewCandidate(ctx, initial.candidate, snapshot);
	if (!reviewed || !(await confirmApproval(ctx, reviewed.candidate))) return;
	const timestamp = new Date().toISOString();
	const record = createDirectRecord({
		id: uuidv7(),
		candidate: reviewed.candidate,
		timestamp,
		sessionId: ctx.sessionManager.getSessionId() || null,
	});
	const result = await store.createRecord(record, { reviewedConflictIds: reviewed.reviewedConflictIds });
	ctx.ui.notify(`Saved memory ${result.record.id}`, "info");
}

async function editExisting(
	ctx: ExtensionCommandContext,
	store: MemoryStore,
	id: string,
): Promise<void> {
	const snapshot = await store.loadSnapshot();
	if (snapshot.errors.length > 0) throw new MemoryStoreError("memory store is degraded", "degraded");
	const record = resolveMemory(snapshot.records, id);
	if (!record) throw new Error("memory ID is missing or ambiguous");
	const reviewed = await reviewCandidate(
		ctx,
		{
			content: record.content,
			kind: record.kind,
			recall: record.recall,
			tags: [...record.tags],
			supersedes: [...record.supersedes],
		},
		snapshot,
		record.id,
	);
	if (!reviewed || !(await confirmApproval(ctx, reviewed.candidate))) return;
	try {
		const updated = await store.updateRecord(
			record.id,
			record.updatedAt,
			(current) => editRecord(current, reviewed.candidate, nextUpdatedAt(new Date(), current.updatedAt)),
			{ reviewedConflictIds: reviewed.reviewedConflictIds },
		);
		ctx.ui.notify(`Updated memory ${updated.id}`, "info");
	} catch (error) {
		if (error instanceof MemoryStoreError && error.code === "stale") {
			const latest = resolveMemory((await store.loadSnapshot()).records, record.id);
			ctx.ui.notify("Memory changed since preview; showing the latest version", "warning");
			if (latest) await showRecord(ctx, latest);
			return;
		}
		throw error;
	}
}

async function setEnabled(
	ctx: ExtensionCommandContext,
	store: MemoryStore,
	id: string,
	enabled: boolean,
): Promise<void> {
	const snapshot = await store.loadSnapshot();
	if (enabled && snapshot.errors.length > 0) {
		throw new MemoryStoreError("memory store is degraded", "degraded");
	}
	const record = resolveMemory(snapshot.records, id);
	if (!record) throw new Error("memory ID is missing or ambiguous");
	if (record.enabled === enabled) {
		ctx.ui.notify(`Memory ${record.id} is already ${enabled ? "enabled" : "disabled"}`, "info");
		return;
	}
	if (!(await ctx.ui.confirm(`${enabled ? "Enable" : "Disable"} memory`, `${record.id}\n${record.content}`))) return;
	await store.updateRecord(
		record.id,
		record.updatedAt,
		(current) => ({
			...current,
			enabled,
			updatedAt: nextUpdatedAt(new Date(), current.updatedAt),
		}),
		{ allowDegraded: !enabled },
	);
	ctx.ui.notify(`${enabled ? "Enabled" : "Disabled"} memory ${record.id}`, "info");
}

async function forget(
	ctx: ExtensionCommandContext,
	store: MemoryStore,
	id: string,
): Promise<void> {
	const snapshot = await store.loadSnapshot();
	const record = resolveMemory(snapshot.records, id);
	if (!record) throw new Error("memory ID is missing or ambiguous");
	if (
		!(await ctx.ui.confirm(
			"Forget memory permanently",
			`${JSON.stringify(record, null, 2)}\n\nThis physically deletes the record and cannot be undone.`,
		))
	) {
		return;
	}
	await store.forgetRecord(record.id, record.updatedAt);
	ctx.ui.notify(`Forgot memory ${record.id}`, "info");
}

async function chooseSession(
	ctx: ExtensionCommandContext,
	requestedId?: string,
): Promise<{ sessionId: string; branch: SessionEntry[] }> {
	const currentId = ctx.sessionManager.getSessionId();
	if (requestedId === currentId) {
		return { sessionId: currentId, branch: ctx.sessionManager.getBranch() };
	}
	let useAnotherSession = Boolean(requestedId);
	if (!requestedId) {
		const source = await ctx.ui.select("Distillation source", ["Current session", "Another session"]);
		if (!source) throw new Error("distillation cancelled");
		if (source === "Current session") {
			return { sessionId: currentId, branch: ctx.sessionManager.getBranch() };
		}
		useAnotherSession = true;
	}
	const sessions = useAnotherSession ? await SessionManager.listAll() : [];
	let selected = requestedId ? sessions.find((session) => session.id === requestedId) : undefined;
	if (requestedId && !selected) throw new Error("session ID not found");
	if (!selected) {
		const options = sessions.map(
			(session) => `${session.id} ${session.name ?? abbreviate(session.firstMessage, 70)}`,
		);
		const choice = await ctx.ui.select("Select session", [...options, "Cancel"]);
		if (!choice || choice === "Cancel") throw new Error("distillation cancelled");
		selected = sessions.find((session) => choice.startsWith(session.id));
	}
	if (!selected) throw new Error("session selection failed");
	const manager = SessionManager.open(selected.path);
	return { sessionId: manager.getSessionId(), branch: manager.getBranch() };
}

async function chooseEntryRange(
	ctx: ExtensionCommandContext,
	branch: readonly SessionEntry[],
): Promise<readonly [string, string]> {
	const selectable: DistillableSessionEntry[] = [];
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		if (entry.message.role !== "user" && entry.message.role !== "assistant") continue;
		if (!normalizeMessageText(entry.message.content)) continue;
		selectable.push(entry as DistillableSessionEntry);
	}
	if (selectable.length === 0) throw new Error("session has no selectable user or assistant text");
	const options = selectable.map((entry) =>
		`${entry.id} [${entry.message.role}] ${abbreviate(normalizeMessageText(entry.message.content), 90)}`,
	);
	const firstChoice = await ctx.ui.select("First selected entry", options);
	if (!firstChoice) throw new Error("distillation cancelled");
	const first = selectable.findIndex((entry) => firstChoice.startsWith(entry.id));
	const lastChoice = await ctx.ui.select("Last selected entry", options.slice(first));
	if (!lastChoice) throw new Error("distillation cancelled");
	const last = selectable.find((entry) => lastChoice.startsWith(entry.id));
	if (first < 0 || !last) throw new Error("entry selection failed");
	return [selectable[first]!.id, last.id];
}

async function runModelWithCancellation(
	ctx: ExtensionCommandContext,
	prompt: string,
	model: NonNullable<ExtensionCommandContext["model"]>,
	controller: AbortController,
): Promise<AssistantMessage | undefined> {
	const complete = () =>
		ctx.modelRegistry.complete(
			model,
			{
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: prompt }],
						timestamp: Date.now(),
					},
				],
			},
			{
				signal: controller.signal,
				cacheRetention: "none",
				sessionId: uuidv7(),
				maxTokens: model.maxTokens,
				maxRetries: 0,
			},
		);
	if (ctx.mode !== "tui") {
		try {
			const response = await complete();
			return controller.signal.aborted ? undefined : response;
		} catch {
			if (controller.signal.aborted) return undefined;
			throw new Error("distillation provider request failed");
		}
	}
	return ctx.ui.custom<AssistantMessage | undefined>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, "Distilling selected text…");
		let settled = false;
		const finish = (response: AssistantMessage | undefined) => {
			if (settled) return;
			settled = true;
			controller.signal.removeEventListener("abort", onAbort);
			done(response);
		};
		const onAbort = () => finish(undefined);
		controller.signal.addEventListener("abort", onAbort, { once: true });
		loader.onAbort = () => controller.abort();
		complete()
			.then((response) => finish(controller.signal.aborted ? undefined : response))
			.catch(() => finish(undefined));
		return loader;
	});
}

async function distill(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	tokens: readonly string[],
	state: MemoryRuntimeState,
	setProposals: (index: ProposalIndex) => void,
): Promise<void> {
	if (state.activeDistillationController) throw new Error("memory distillation is already in progress");
	const parsed = parseDistillArgs(tokens);
	const selectedSession = await chooseSession(ctx, parsed.sessionId);
	const range = parsed.entries ?? (await chooseEntryRange(ctx, selectedSession.branch));
	let selection: NormalizedSelection;
	try {
		selection = normalizeSelection(selectedSession.branch, range[0], range[1]);
	} catch (error) {
		throw new Error(safeErrorMessage(error));
	}
	const model = ctx.model;
	if (!model) throw new Error("no active model is selected");
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
		throw new Error(`no authentication configured for ${model.provider}/${model.id}`);
	}
	const prompt = buildDistillationPrompt(selection.source);
	if (!promptFitsModel(prompt, model.contextWindow, model.maxTokens)) {
		throw new Error("distillation prompt does not fit the selected model context window");
	}
	const disclosed = await ctx.ui.confirm(
		"Send selected text for distillation",
		[
			`Session: ${selectedSession.sessionId}`,
			`Entries: ${selection.firstEntryId}..${selection.lastEntryId}`,
			`Characters: ${selection.codePoints}`,
			`Provider/model: ${model.provider}/${model.id}`,
			"Selected normalized source will be sent to this provider:",
			canonicalJson(selection.source),
		].join("\n"),
	);
	if (!disclosed) return;
	if (state.activeDistillationController) throw new Error("memory distillation is already in progress");
	const controller = new AbortController();
	state.activeDistillationController = controller;
	let response: AssistantMessage | undefined;
	try {
		response = await runModelWithCancellation(ctx, prompt, model, controller);
	} finally {
		if (state.activeDistillationController === controller) delete state.activeDistillationController;
	}
	if (!response) {
		ctx.ui.notify(controller.signal.aborted ? "Distillation cancelled" : "Distillation failed", "warning");
		return;
	}
	let candidates: MemoryCandidate[];
	try {
		candidates = parseModelCandidates(response);
	} catch {
		throw new Error("distillation model output was invalid");
	}
	if (candidates.length === 0) {
		ctx.ui.notify("Distillation produced no valid candidates", "info");
		return;
	}
	const createdAt = new Date().toISOString();
	for (const candidate of candidates) {
		pi.appendEntry(
			PROPOSAL_CUSTOM_TYPE,
			createProposal({
				proposalId: uuidv7(),
				source: {
					sessionId: selectedSession.sessionId,
					entryIds: [...selection.entryIds],
					sourceDigest: selection.sourceDigest,
				},
				candidate,
				generator: { provider: model.provider, model: model.id },
				createdAt,
			}),
		);
	}
	const index = foldProposals(ctx.sessionManager.getBranch());
	setProposals(index);
	ctx.ui.notify(`Created ${candidates.length} pending memory proposal(s)`, "info");
}

async function listProposals(ctx: ExtensionCommandContext, proposals: ProposalIndex): Promise<void> {
	const lines = proposals.pending.map(
		(proposal) =>
			`${proposal.proposalId} [pending] revision ${proposal.revision}\n${JSON.stringify(proposal.candidate, null, 2)}`,
	);
	await displayText(ctx, "Pending memory proposals", lines.join("\n\n") || "No pending proposals on the active branch");
}

async function approveProposal(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	store: MemoryStore,
	input: string,
	getProposals: () => ProposalIndex,
	setProposals: (index: ProposalIndex) => void,
): Promise<void> {
	let state = resolveProposal(getProposals(), input);
	if (!state?.proposal) throw new Error("proposal ID is missing or ambiguous");
	if (state.invalidReason) throw new Error("proposal is invalid and cannot be approved");
	if (state.decision?.status === "approved") {
		ctx.ui.notify(`Proposal already approved as ${state.decision.memoryId}`, "info");
		return;
	}
	if (state.decision) throw new Error("proposal was already rejected");
	let proposal: Readonly<MemoryProposal> = state.proposal;
	const snapshot = await store.loadSnapshot();
	if (snapshot.errors.length > 0) throw new MemoryStoreError("memory store is degraded", "degraded");
	const existing = snapshot.records.find(
		(record) =>
			record.provenance.proposalId === proposal.proposalId &&
			record.provenance.proposalHash === proposal.candidateHash,
	);
	if (existing) {
		setProposals(foldProposals(ctx.sessionManager.getBranch()));
		const latest = resolveProposal(getProposals(), proposal.proposalId);
		if (latest?.decision?.status === "approved" && latest.decision.memoryId === existing.id) {
			ctx.ui.notify(`Proposal already approved as ${existing.id}`, "info");
			return;
		}
		if (latest?.decision) throw new Error("proposal already has a conflicting decision");
		pi.appendEntry(
			PROPOSAL_STATUS_CUSTOM_TYPE,
			makeProposalStatus({
				proposal,
				status: "approved",
				memoryId: existing.id,
				decidedAt: new Date().toISOString(),
			}),
		);
		setProposals(foldProposals(ctx.sessionManager.getBranch()));
		ctx.ui.notify(`Recovered approved memory ${existing.id}`, "info");
		return;
	}
	const reviewed = await reviewCandidate(ctx, proposal.candidate, snapshot);
	if (!reviewed) return;
	if (JSON.stringify(reviewed.candidate) !== JSON.stringify(proposal.candidate)) {
		const revision = reviseProposal(proposal, reviewed.candidate);
		pi.appendEntry(PROPOSAL_CUSTOM_TYPE, revision);
		setProposals(foldProposals(ctx.sessionManager.getBranch()));
		proposal = revision;
	}
	if (!(await confirmApproval(ctx, proposal.candidate))) return;
	setProposals(foldProposals(ctx.sessionManager.getBranch()));
	state = resolveProposal(getProposals(), proposal.proposalId);
	if (
		!state?.proposal ||
		state.invalidReason ||
		state.proposal.candidateHash !== proposal.candidateHash ||
		state.decision
	) {
		throw new Error("proposal changed since preview; preview it again");
	}
	const timestamp = new Date().toISOString();
	const record = createDistilledRecord({ id: uuidv7(), proposal, timestamp });
	const result = await store.createRecord(record, { reviewedConflictIds: reviewed.reviewedConflictIds });
	setProposals(foldProposals(ctx.sessionManager.getBranch()));
	const decided = resolveProposal(getProposals(), proposal.proposalId)?.decision;
	if (decided?.status === "approved" && decided.memoryId === result.record.id) {
		ctx.ui.notify(`Proposal already approved as ${result.record.id}`, "info");
		return;
	}
	if (decided) throw new Error("proposal already has a conflicting decision");
	const status = makeProposalStatus({
		proposal,
		status: "approved",
		memoryId: result.record.id,
		decidedAt: new Date().toISOString(),
	});
	try {
		pi.appendEntry(PROPOSAL_STATUS_CUSTOM_TYPE, status);
		setProposals(foldProposals(ctx.sessionManager.getBranch()));
	} catch {
		ctx.ui.notify(`Memory ${result.record.id} was committed; proposal status could not be recorded`, "warning");
		return;
	}
	ctx.ui.notify(`${result.existing ? "Recovered" : "Approved"} memory ${result.record.id}`, "info");
}

async function rejectProposal(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	input: string,
	getProposals: () => ProposalIndex,
	setProposals: (index: ProposalIndex) => void,
): Promise<void> {
	const state = resolveProposal(getProposals(), input);
	if (!state?.proposal) throw new Error("proposal ID is missing or ambiguous");
	if (state.invalidReason) throw new Error("proposal is invalid and cannot be rejected");
	if (state.decision) {
		ctx.ui.notify(`Proposal is already ${state.decision.status}`, "info");
		return;
	}
	if (!(await ctx.ui.confirm("Reject memory proposal", `${state.proposal.proposalId}\n${JSON.stringify(state.proposal.candidate, null, 2)}`))) return;
	setProposals(foldProposals(ctx.sessionManager.getBranch()));
	const latest = resolveProposal(getProposals(), state.proposal.proposalId);
	if (latest?.decision) {
		ctx.ui.notify(`Proposal is already ${latest.decision.status}`, "info");
		return;
	}
	if (!latest?.proposal || latest.proposal.candidateHash !== state.proposal.candidateHash) {
		throw new Error("proposal changed since preview; preview it again");
	}
	pi.appendEntry(
		PROPOSAL_STATUS_CUSTOM_TYPE,
		makeProposalStatus({
			proposal: state.proposal,
			status: "rejected",
			memoryId: null,
			decidedAt: new Date().toISOString(),
		}),
	);
	setProposals(foldProposals(ctx.sessionManager.getBranch()));
	ctx.ui.notify(`Rejected proposal ${state.proposal.proposalId}`, "info");
}

async function doctor(ctx: ExtensionCommandContext, store: MemoryStore): Promise<void> {
	let report = await store.doctor({ removeStaleLock: true });
	if (report.temporaryFiles.length > 0) {
		const remove = await ctx.ui.confirm(
			"Remove orphan memory temporary files?",
			report.temporaryFiles.join("\n"),
		);
		if (remove) {
			await store.removeTemporaryFiles(report.temporaryFiles);
			report = await store.doctor();
		}
	}
	await displayText(ctx, "Memory doctor", JSON.stringify(report, null, 2));
}

export function registerMemoryCommand(
	pi: ExtensionAPI,
	state: MemoryRuntimeState,
): void {
	const setProposals = (index: ProposalIndex) => {
		state.proposals = index;
	};
	const requireStore = (): MemoryStore => {
		if (!state.store) throw new Error("memory store is not initialized");
		return state.store;
	};

	pi.registerCommand("memory", {
		description: "Manage explicitly curated global persistent memories",
		handler: async (rawArgs, ctx) => {
			await ctx.waitForIdle();
			if (!ctx.hasUI) throw new Error(MANAGEMENT_MODE_ERROR);
			try {
				const tokens = splitArguments(rawArgs);
				const subcommand = tokens.shift() ?? "list";
				if (subcommand === "cancel-distill") {
					const controller = state.activeDistillationController;
					if (!controller) {
						ctx.ui.notify("No memory distillation is in progress", "info");
						return;
					}
					controller.abort();
					ctx.ui.notify("Memory distillation cancellation requested", "info");
					return;
				}
				const store = requireStore();
				if (subcommand !== "doctor" && subcommand !== "quarantine" && subcommand !== "discard-corrupt") {
					await store.loadSnapshot();
				}
				switch (subcommand) {
					case "list":
						await listRecords(ctx, await store.loadSnapshot(), tokens.join(" "));
						break;
					case "search":
						if (tokens.length === 0) throw new Error("search query is required");
						await searchRecords(ctx, await store.loadSnapshot(), tokens.join(" "));
						break;
					case "show": {
						const snapshot = await store.loadSnapshot();
						const record = resolveMemory(snapshot.records, tokens[0] ?? "");
						if (!record) throw new Error("memory ID is missing or ambiguous");
						await showRecord(ctx, record);
						break;
					}
					case "add":
						await directAdd(ctx, store, tokens);
						break;
					case "distill":
						await distill(pi, ctx, tokens, state, setProposals);
						break;
					case "proposals":
						state.proposals = foldProposals(ctx.sessionManager.getBranch());
						await listProposals(ctx, state.proposals);
						break;
					case "approve":
						state.proposals = foldProposals(ctx.sessionManager.getBranch());
						await approveProposal(pi, ctx, store, tokens[0] ?? "", () => state.proposals, setProposals);
						break;
					case "reject":
						state.proposals = foldProposals(ctx.sessionManager.getBranch());
						await rejectProposal(pi, ctx, tokens[0] ?? "", () => state.proposals, setProposals);
						break;
					case "edit":
						await editExisting(ctx, store, tokens[0] ?? "");
						break;
					case "enable":
						await setEnabled(ctx, store, tokens[0] ?? "", true);
						break;
					case "disable":
						await setEnabled(ctx, store, tokens[0] ?? "", false);
						break;
					case "forget":
						await forget(ctx, store, tokens[0] ?? "");
						break;
					case "quarantine":
						if (!tokens[0]) throw new Error("corrupt-record filename is required");
						if (await ctx.ui.confirm("Quarantine corrupt memory record", tokens[0])) {
							await store.quarantine(tokens[0]);
							ctx.ui.notify(`Quarantined ${tokens[0]}`, "info");
						}
						break;
					case "discard-corrupt":
						if (!tokens[0]) throw new Error("corrupt-record filename is required");
						if (
							(await ctx.ui.confirm("Discard corrupt memory record", tokens[0])) &&
							(await ctx.ui.confirm("Confirm permanent corrupt-record deletion", "This cannot be undone."))
						) {
							await store.discardCorrupt(tokens[0]);
							ctx.ui.notify(`Discarded ${tokens[0]}`, "info");
						}
						break;
					case "reload": {
						const snapshot = await store.loadSnapshot();
						ctx.ui.notify(
							`Memory reload: ${snapshot.records.length} valid, ${snapshot.errors.length} invalid`,
							snapshot.errors.length > 0 ? "warning" : "info",
						);
						break;
					}
					case "doctor":
						await doctor(ctx, store);
						break;
					default:
						throw new Error("unknown /memory subcommand");
				}
			} catch (error) {
				ctx.ui.notify(safeErrorMessage(error), "error");
			}
		},
	});
}
