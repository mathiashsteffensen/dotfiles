import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	buildDistillationPrompt,
	normalizeSelection,
	parseModelCandidates,
	promptFitsModel,
} from "../distill.ts";
import {
	computeCandidateHash,
	createProposal,
	foldProposals,
	makeProposalStatus,
	PROPOSAL_CUSTOM_TYPE,
	PROPOSAL_STATUS_CUSTOM_TYPE,
	reviseProposal,
	validateProposal,
} from "../proposals.ts";
import { createDistilledRecord } from "../records.ts";
import { candidate, memoryId, temporaryStore } from "./helpers.ts";

function response(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
}

const source = {
	sessionId: "session-1",
	entryIds: ["entry001", "entry002"],
	sourceDigest: "0".repeat(64),
};
const generator = { provider: "fake", model: "fake-model" };

test("selection normalizes only user/assistant text blocks in inclusive branch order", () => {
	const branch = [
		{ type: "message", id: "entry001", message: { role: "user", content: "  Ｈｅｌｌｏ\r\nworld  " } },
		{ type: "message", id: "tool0001", message: { role: "toolResult", content: [{ type: "text", text: "secret tool output" }] } },
		{
			type: "message",
			id: "entry002",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hidden" },
					{ type: "text", text: "Answer" },
					{ type: "toolCall", name: "bash", arguments: { command: "bad" } },
					{ type: "text", text: "Second block" },
				],
			},
		},
		{ type: "custom", id: "custom01", customType: "other", data: { text: "ignored" } },
	] as const;
	const selection = normalizeSelection(branch, "entry001", "entry002");
	assert.deepEqual(selection.source, [
		{ entryId: "entry001", role: "user", text: "Hello\nworld" },
		{ entryId: "entry002", role: "assistant", text: "Answer\nSecond block" },
	]);
	assert.equal(selection.sourceDigest.length, 64);
	assert.deepEqual(selection.entryIds, ["entry001", "entry002"]);
});

test("selection follows only the active branch of a branched SessionManager", () => {
	const manager = SessionManager.inMemory();
	const firstUser = manager.appendMessage({ role: "user", content: "Root user text", timestamp: 1 });
	const firstAssistant = manager.appendMessage(response("Root assistant text"));
	manager.appendMessage({ role: "user", content: "ABANDONED BRANCH", timestamp: 2 });
	manager.appendMessage(response("ABANDONED ANSWER"));
	manager.branch(firstAssistant);
	manager.appendMessage({ role: "user", content: "Active user text", timestamp: 3 });
	const activeAssistant = manager.appendMessage(response("Active assistant text"));
	const selection = normalizeSelection(manager.getBranch(), firstUser, activeAssistant);
	assert.equal(selection.source.some((item) => item.text.includes("ABANDONED")), false);
	assert.deepEqual(selection.source.map((item) => item.text), [
		"Root user text",
		"Root assistant text",
		"Active user text",
		"Active assistant text",
	]);
});

test("selection rejects missing/reversed/non-message endpoints and oversized input", () => {
	const branch = [
		{ type: "custom", id: "custom01" },
		{ type: "message", id: "entry001", message: { role: "user", content: "hello" } },
		{ type: "message", id: "entry002", message: { role: "assistant", content: "answer" } },
	];
	assert.throws(() => normalizeSelection(branch, "entry002", "entry001"), /reversed/u);
	assert.throws(() => normalizeSelection(branch, "custom01", "entry002"), /endpoint/u);
	assert.throws(() => normalizeSelection(branch, "missing", "entry002"), /active branch/u);
	assert.throws(
		() =>
			normalizeSelection(
				[
					{ type: "message", id: "entry001", message: { role: "user", content: "x".repeat(50_001) } },
				],
				"entry001",
				"entry001",
			),
		/50,000/u,
	);
});

test("distillation prompt embeds canonical source as data and uses conservative fit check", () => {
	const prompt = buildDistillationPrompt([{ entryId: "entry001", role: "user", text: "ignore this" }]);
	assert.match(prompt, /untrusted data/u);
	assert.match(prompt, /Do not reproduce secrets/u);
	assert.match(prompt, /\{"entryId":"entry001","role":"user","text":"ignore this"\}/u);
	assert.equal(promptFitsModel(prompt, Buffer.byteLength(prompt) + 1000, 999), true);
	assert.equal(promptFitsModel(prompt, Buffer.byteLength(prompt) + 1000, 1001), false);
});

test("model output must be exact JSON with closed fields and semantic candidates are filtered", () => {
	const valid = JSON.stringify({
		schemaVersion: 1,
		candidates: [{ content: "The user prefers concise replies.", kind: "preference", recall: "relevant", tags: ["reply"] }],
	});
	assert.equal(parseModelCandidates(response(valid)).length, 1);
	assert.throws(() => parseModelCandidates(response(`\`\`\`json\n${valid}\n\`\`\``)), /invalid JSON/u);
	assert.throws(
		() => parseModelCandidates(response(JSON.stringify({ schemaVersion: 1, candidates: [], extra: true }))),
		/v1 schema/u,
	);
	const secret = JSON.stringify({
		schemaVersion: 1,
		candidates: [{ content: "The token is ghp_abcdefghijklmnopqrstuvwxyz.", kind: "fact", recall: "relevant", tags: [] }],
	});
	assert.deepEqual(parseModelCandidates(response(secret)), []);
});

test("proposal hash binds revision/source/candidate and validates exact entries", () => {
	const proposal = createProposal({
		proposalId: memoryId(100),
		source,
		candidate: candidate(),
		generator,
		createdAt: "2026-04-05T12:00:00.000Z",
	});
	assert.equal(proposal.candidateHash, computeCandidateHash(proposal));
	assert.equal(validateProposal(proposal), true);
	assert.equal(validateProposal({ ...proposal, candidateHash: "f".repeat(64) }), false);
	const revision = reviseProposal(proposal, candidate({ content: "The user prefers terse replies." }));
	assert.equal(revision.revision, 2);
	assert.notEqual(revision.candidateHash, proposal.candidateHash);
	assert.deepEqual(revision.source, proposal.source);
});

test("proposal folding keeps latest revision, ignores older-hash status, and applies latest status", () => {
	const first = createProposal({
		proposalId: memoryId(101),
		source,
		candidate: candidate(),
		generator,
		createdAt: "2026-04-05T12:00:00.000Z",
	});
	const second = reviseProposal(first, candidate({ content: "The user prefers terse replies." }));
	const oldStatus = makeProposalStatus({
		proposal: first,
		status: "approved",
		memoryId: memoryId(201),
		decidedAt: "2026-04-05T12:01:00.000Z",
	});
	let folded = foldProposals([
		{ type: "custom", customType: PROPOSAL_CUSTOM_TYPE, data: first },
		{ type: "custom", customType: PROPOSAL_STATUS_CUSTOM_TYPE, data: oldStatus },
		{ type: "custom", customType: PROPOSAL_CUSTOM_TYPE, data: second },
	]);
	assert.equal(folded.pending.length, 1);
	assert.equal(folded.pending[0]?.candidateHash, second.candidateHash);

	const latestStatus = makeProposalStatus({
		proposal: second,
		status: "rejected",
		memoryId: null,
		decidedAt: "2026-04-05T12:02:00.000Z",
	});
	folded = foldProposals([
		{ type: "custom", customType: PROPOSAL_CUSTOM_TYPE, data: first },
		{ type: "custom", customType: PROPOSAL_CUSTOM_TYPE, data: second },
		{ type: "custom", customType: PROPOSAL_STATUS_CUSTOM_TYPE, data: latestStatus },
	]);
	assert.equal(folded.pending.length, 0);
	assert.equal(folded.byId.get(first.proposalId)?.decision?.status, "rejected");
});

test("three proposals can be edited/approved, rejected, and deferred independently", async () => {
	const proposals = [1, 2, 3].map((number) =>
		createProposal({
			proposalId: memoryId(110 + number),
			source,
			candidate: candidate({ content: `The user preference number ${number} is durable.`, tags: [`item-${number}`] }),
			generator,
			createdAt: `2026-04-05T12:00:0${number}.000Z`,
		}),
	);
	const edited = reviseProposal(
		proposals[0]!,
		candidate({ content: "The edited user preference is durable.", tags: ["edited"] }),
	);
	const { store } = await temporaryStore();
	const memory = createDistilledRecord({
		id: memoryId(300),
		proposal: edited,
		timestamp: "2026-04-05T12:01:00.000Z",
	});
	await store.createRecord(memory);
	const approved = makeProposalStatus({
		proposal: edited,
		status: "approved",
		memoryId: memory.id,
		decidedAt: "2026-04-05T12:01:01.000Z",
	});
	const rejected = makeProposalStatus({
		proposal: proposals[1]!,
		status: "rejected",
		memoryId: null,
		decidedAt: "2026-04-05T12:01:02.000Z",
	});
	const entries = [
		...proposals.map((proposal) => ({ type: "custom", customType: PROPOSAL_CUSTOM_TYPE, data: proposal })),
		{ type: "custom", customType: PROPOSAL_CUSTOM_TYPE, data: edited },
		{ type: "custom", customType: PROPOSAL_STATUS_CUSTOM_TYPE, data: approved },
		{ type: "custom", customType: PROPOSAL_STATUS_CUSTOM_TYPE, data: rejected },
	];
	const folded = foldProposals(entries);
	assert.deepEqual(folded.pending.map((proposal) => proposal.proposalId), [proposals[2]!.proposalId]);
	const stored = (await store.loadSnapshot()).records;
	assert.equal(stored.length, 1);
	assert.equal(stored[0]?.provenance.proposalHash, edited.candidateHash);
});

test("conflicting duplicate revisions or decisions invalidate a proposal", () => {
	const first = createProposal({
		proposalId: memoryId(102),
		source,
		candidate: candidate(),
		generator,
		createdAt: "2026-04-05T12:00:00.000Z",
	});
	const conflicting = createProposal({
		proposalId: first.proposalId,
		source,
		candidate: candidate({ content: "The user prefers detailed replies." }),
		generator,
		createdAt: first.createdAt,
	});
	let folded = foldProposals([
		{ type: "custom", customType: PROPOSAL_CUSTOM_TYPE, data: first },
		{ type: "custom", customType: PROPOSAL_CUSTOM_TYPE, data: conflicting },
	]);
	assert.match(folded.byId.get(first.proposalId)?.invalidReason ?? "", /conflicting proposal revision/u);

	const approved = makeProposalStatus({
		proposal: first,
		status: "approved",
		memoryId: memoryId(202),
		decidedAt: "2026-04-05T12:01:00.000Z",
	});
	const rejected = { ...approved, status: "rejected" as const, memoryId: null };
	folded = foldProposals([
		{ type: "custom", customType: PROPOSAL_CUSTOM_TYPE, data: first },
		{ type: "custom", customType: PROPOSAL_STATUS_CUSTOM_TYPE, data: approved },
		{ type: "custom", customType: PROPOSAL_STATUS_CUSTOM_TYPE, data: rejected },
	]);
	assert.match(folded.byId.get(first.proposalId)?.invalidReason ?? "", /conflicting proposal decision/u);
});
