import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { codePointLength, utf8Length } from "./canonical.ts";
import { registerMemoryCommand, type MemoryRuntimeState } from "./commands.ts";
import {
	foldProposals,
	PROPOSAL_CUSTOM_TYPE,
	PROPOSAL_STATUS_CUSTOM_TYPE,
	type ProposalIndex,
	validateProposal,
	validateProposalStatus,
} from "./proposals.ts";
import { resolveMemory } from "./records.ts";
import {
	computePacketTokenBudget,
	rankMemories,
	RECALL_AUTHORITY_RULE,
	RECALL_CUSTOM_TYPE,
	selectRecallPacket,
	selectToolResults,
	type RankedMemory,
} from "./retrieval.ts";
import { MemoryGetParameters, MemorySearchParameters } from "./schemas.ts";
import { MemoryStore } from "./storage.ts";

function emptyProposals(): ProposalIndex {
	return { byId: new Map(), pending: [] };
}

function packetBudget(ctx: ExtensionContext): number {
	const usage = ctx.getContextUsage();
	const model = ctx.model;
	if (!usage || !model) return 0;
	return computePacketTokenBudget({
		contextWindow: model.contextWindow,
		currentContextTokens: usage.tokens,
		maxOutputTokens: model.maxTokens,
	});
}

function isRecallMessage(message: AgentMessage): boolean {
	return message.role === "custom" && message.customType === RECALL_CUSTOM_TYPE;
}

function insertRecall(
	messages: AgentMessage[],
	block: string,
): AgentMessage[] {
	const result = messages.filter((message) => !isRecallMessage(message));
	let userIndex = -1;
	for (let index = result.length - 1; index >= 0; index--) {
		if (result[index]?.role === "user") {
			userIndex = index;
			break;
		}
	}
	if (userIndex < 0) return result;
	result.splice(userIndex, 0, {
		role: "custom",
		customType: RECALL_CUSTOM_TYPE,
		content: block,
		display: false,
		timestamp: Date.now(),
	});
	return result;
}

export default function persistentMemory(pi: ExtensionAPI): void {
	const state: MemoryRuntimeState = { store: undefined, proposals: emptyProposals() };
	let currentRanking: RankedMemory[] = [];
	let degradedWarningShown = false;
	let readWarningShown = false;

	registerMemoryCommand(pi, state);

	pi.registerEntryRenderer(PROPOSAL_CUSTOM_TYPE, (entry, { expanded }, theme) => {
		if (!validateProposal(entry.data)) return new Text(theme.fg("warning", "Invalid memory proposal"), 0, 0);
		const proposal = entry.data;
		const content = expanded
			? JSON.stringify(proposal, null, 2)
			: `${proposal.proposalId} r${proposal.revision}: ${proposal.candidate.content}`;
		return new Text(theme.fg("muted", content), 0, 0);
	});
	pi.registerEntryRenderer(PROPOSAL_STATUS_CUSTOM_TYPE, (entry, _options, theme) => {
		if (!validateProposalStatus(entry.data)) {
			return new Text(theme.fg("warning", "Invalid memory proposal status"), 0, 0);
		}
		return new Text(
			theme.fg(
				entry.data.status === "approved" ? "success" : "muted",
				`${entry.data.proposalId}: ${entry.data.status}${entry.data.memoryId ? ` as ${entry.data.memoryId}` : ""}`,
			),
			0,
			0,
		);
	});

	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description:
			"Search approved global memories with deterministic local lexical retrieval. Returns at most 10 results and 8 KiB; it cannot mutate memory.",
		parameters: MemorySearchParameters,
		async execute(_toolCallId, params) {
			const query = params.query.trim();
			if (codePointLength(query) < 1 || codePointLength(query) > 500) {
				throw new Error("memory search query must contain 1–500 Unicode code points");
			}
			if (!state.store) throw new Error("memory store is not initialized");
			const snapshot = await state.store.loadSnapshot();
			const ranked = selectToolResults(
				rankMemories(snapshot.records, query, snapshot.superseded),
				params.limit ?? 6,
			);
			const results: Array<{
				id: string;
				kind: string;
				content: string;
				tags: readonly string[];
				score: number;
			}> = [];
			for (const item of ranked) {
				const next = [
					...results,
					{
						id: item.record.id,
						kind: item.record.kind,
						content: item.record.content,
						tags: item.record.tags,
						score: item.score,
					},
				];
				if (utf8Length(JSON.stringify(next)) > 8192) continue;
				results.push(next.at(-1)!);
			}
			return {
				content: [{ type: "text", text: JSON.stringify(results) }],
				details: { count: results.length },
			};
		},
	});

	pi.registerTool({
		name: "memory_get",
		label: "Memory Get",
		description:
			"Get one approved global memory by full UUIDv7 or unique hexadecimal prefix. It cannot mutate memory and never returns provenance.",
		parameters: MemoryGetParameters,
		async execute(_toolCallId, params) {
			if (!state.store) throw new Error("memory store is not initialized");
			const snapshot = await state.store.loadSnapshot();
			const record = resolveMemory(snapshot.records, params.id);
			if (!record) throw new Error("memory ID is invalid, missing, or ambiguous");
			const result = {
				id: record.id,
				kind: record.kind,
				content: record.content,
				tags: record.tags,
				recall: record.recall,
				enabled: record.enabled,
				superseded: snapshot.superseded.has(record.id),
			};
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: { id: record.id },
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		currentRanking = [];
		degradedWarningShown = false;
		readWarningShown = false;
		state.proposals = foldProposals(ctx.sessionManager.getBranch());
		const store = new MemoryStore(getAgentDir());
		state.store = store;
		try {
			await store.initialize();
			const snapshot = await store.loadSnapshot();
			if (snapshot.errors.length > 0 && ctx.hasUI) {
				degradedWarningShown = true;
				ctx.ui.notify(
					`Persistent memory is degraded: ${snapshot.errors.length} invalid record file(s). Valid recall remains available; run /memory doctor.`,
					"warning",
				);
			}
		} catch {
			if (ctx.hasUI) ctx.ui.notify("Persistent memory store is unavailable", "error");
		}
	});

	pi.on("session_tree", (_event, ctx) => {
		state.proposals = foldProposals(ctx.sessionManager.getBranch());
	});

	pi.on("before_agent_start", async (event, ctx) => {
		currentRanking = [];
		if (!state.store) return;
		try {
			const snapshot = await state.store.loadSnapshot();
			if (snapshot.errors.length > 0 && !degradedWarningShown && ctx.hasUI) {
				degradedWarningShown = true;
				ctx.ui.notify(
					`Persistent memory is degraded: ${snapshot.errors.length} invalid record file(s).`,
					"warning",
				);
			}
			currentRanking = rankMemories(snapshot.records, event.prompt, snapshot.superseded);
			if (currentRanking.length > 0 && !event.systemPrompt.includes(RECALL_AUTHORITY_RULE)) {
				return { systemPrompt: `${event.systemPrompt}\n\n${RECALL_AUTHORITY_RULE}` };
			}
		} catch {
			if (!readWarningShown && ctx.hasUI) {
				readWarningShown = true;
				ctx.ui.notify("Persistent memory recall is unavailable for this request", "warning");
			}
		}
	});

	pi.on("context", (event, ctx) => {
		const cleaned = event.messages.filter((message) => !isRecallMessage(message));
		if (currentRanking.length === 0) return { messages: cleaned };
		try {
			const selected = selectRecallPacket(currentRanking, packetBudget(ctx));
			if (!selected.block) return { messages: cleaned };
			return { messages: insertRecall(cleaned, selected.block) };
		} catch {
			if (!readWarningShown && ctx.hasUI) {
				readWarningShown = true;
				ctx.ui.notify("Persistent memory context injection failed", "warning");
			}
			return { messages: cleaned };
		}
	});

	pi.on("agent_settled", () => {
		currentRanking = [];
	});

	pi.on("session_shutdown", () => {
		currentRanking = [];
		state.activeDistillationController?.abort();
		state.proposals = emptyProposals();
		state.store = undefined;
	});
}
