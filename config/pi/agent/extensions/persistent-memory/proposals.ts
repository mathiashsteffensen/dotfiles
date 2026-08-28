import { Value } from "typebox/value";
import { hashCanonicalJson } from "./canonical.ts";
import {
	ProposalSchema,
	ProposalStatusSchema,
	UUID_V7_PATTERN,
	type MemoryCandidate,
	type MemoryProposal,
	type ProposalGenerator,
	type ProposalSource,
	type ProposalStatus,
} from "./schemas.ts";
import { validateCandidate } from "./validation.ts";

export const PROPOSAL_CUSTOM_TYPE = "persistent-memory-proposal";
export const PROPOSAL_STATUS_CUSTOM_TYPE = "persistent-memory-proposal-status";
const UUID_V7 = new RegExp(UUID_V7_PATTERN, "u");

export interface ProposalEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

export interface FoldedProposal {
	proposalId: string;
	proposal?: Readonly<MemoryProposal>;
	decision?: Readonly<ProposalStatus>;
	invalidReason?: string;
}

export interface ProposalIndex {
	byId: ReadonlyMap<string, FoldedProposal>;
	pending: readonly Readonly<MemoryProposal>[];
}

export function proposalHashInput(proposal: Pick<
	MemoryProposal,
	"schemaVersion" | "proposalId" | "revision" | "source" | "candidate"
>): object {
	return {
		schemaVersion: proposal.schemaVersion,
		proposalId: proposal.proposalId,
		revision: proposal.revision,
		source: proposal.source,
		candidate: proposal.candidate,
	};
}

export function computeCandidateHash(
	proposal: Pick<MemoryProposal, "schemaVersion" | "proposalId" | "revision" | "source" | "candidate">,
): string {
	return hashCanonicalJson(proposalHashInput(proposal));
}

function validTimestamp(value: string): boolean {
	return !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function validateProposal(value: unknown): value is MemoryProposal {
	if (!Value.Check(ProposalSchema, value)) return false;
	const proposal = value as MemoryProposal;
	if (!validTimestamp(proposal.createdAt)) return false;
	if (new Set(proposal.source.entryIds).size !== proposal.source.entryIds.length) return false;
	const candidate = validateCandidate(proposal.candidate);
	if (!candidate.candidate || candidate.issues.length > 0) return false;
	if (JSON.stringify(candidate.candidate) !== JSON.stringify(proposal.candidate)) return false;
	return proposal.candidateHash === computeCandidateHash(proposal);
}

export function validateProposalStatus(value: unknown): value is ProposalStatus {
	if (!Value.Check(ProposalStatusSchema, value)) return false;
	const status = value as ProposalStatus;
	if (!validTimestamp(status.decidedAt)) return false;
	return status.status === "approved" ? status.memoryId !== null : status.memoryId === null;
}

function statusEquals(left: ProposalStatus, right: ProposalStatus): boolean {
	return (
		left.proposalId === right.proposalId &&
		left.candidateHash === right.candidateHash &&
		left.status === right.status &&
		left.memoryId === right.memoryId &&
		left.decidedAt === right.decidedAt
	);
}

export function foldProposals(entries: readonly ProposalEntryLike[]): ProposalIndex {
	const revisions = new Map<string, Map<number, MemoryProposal>>();
	const decisions = new Map<string, ProposalStatus>();
	const invalid = new Map<string, string>();

	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType === PROPOSAL_CUSTOM_TYPE) {
			const rawId =
				entry.data && typeof entry.data === "object" && "proposalId" in entry.data
					? (entry.data as { proposalId?: unknown }).proposalId
					: undefined;
			if (!validateProposal(entry.data)) {
				if (typeof rawId === "string" && UUID_V7.test(rawId)) invalid.set(rawId, "invalid proposal entry");
				continue;
			}
			const proposal = entry.data;
			const byRevision = revisions.get(proposal.proposalId) ?? new Map<number, MemoryProposal>();
			const prior = byRevision.get(proposal.revision);
			if (prior && prior.candidateHash !== proposal.candidateHash) {
				invalid.set(proposal.proposalId, "conflicting proposal revision");
			} else if (!prior) {
				byRevision.set(proposal.revision, proposal);
				revisions.set(proposal.proposalId, byRevision);
			}
			continue;
		}
		if (entry.customType === PROPOSAL_STATUS_CUSTOM_TYPE) {
			const rawId =
				entry.data && typeof entry.data === "object" && "proposalId" in entry.data
					? (entry.data as { proposalId?: unknown }).proposalId
					: undefined;
			if (!validateProposalStatus(entry.data)) {
				if (typeof rawId === "string" && UUID_V7.test(rawId)) invalid.set(rawId, "invalid proposal status entry");
				continue;
			}
			const status = entry.data;
			const key = `${status.proposalId}:${status.candidateHash}`;
			const prior = decisions.get(key);
			if (prior && !statusEquals(prior, status)) {
				invalid.set(status.proposalId, "conflicting proposal decision");
			} else if (!prior) {
				decisions.set(key, status);
			}
		}
	}

	const byId = new Map<string, FoldedProposal>();
	const allIds = new Set([...revisions.keys(), ...invalid.keys()]);
	for (const proposalId of allIds) {
		const byRevision = revisions.get(proposalId);
		let proposal: MemoryProposal | undefined;
		if (byRevision && byRevision.size > 0) {
			const ordered = [...byRevision.values()].sort((left, right) => left.revision - right.revision);
			const baseline = ordered[0];
			if (!baseline || baseline.revision !== 1) {
				invalid.set(proposalId, "proposal revisions must begin at one");
			} else {
				for (const [index, current] of ordered.entries()) {
					if (current.revision !== index + 1) invalid.set(proposalId, "proposal revision gap");
					if (
						current.source.sessionId !== baseline.source.sessionId ||
						JSON.stringify(current.source.entryIds) !== JSON.stringify(baseline.source.entryIds) ||
						current.source.sourceDigest !== baseline.source.sourceDigest ||
						current.generator.provider !== baseline.generator.provider ||
						current.generator.model !== baseline.generator.model ||
						current.createdAt !== baseline.createdAt
					) {
						invalid.set(proposalId, "immutable proposal fields changed");
					}
				}
				proposal = ordered.at(-1);
			}
		}
		const decision = proposal ? decisions.get(`${proposalId}:${proposal.candidateHash}`) : undefined;
		const invalidReason = invalid.get(proposalId);
		const folded: FoldedProposal = { proposalId };
		if (proposal) folded.proposal = proposal;
		if (decision) folded.decision = decision;
		if (invalidReason) folded.invalidReason = invalidReason;
		byId.set(proposalId, folded);
	}

	const pending = [...byId.values()]
		.filter((state) => state.proposal && !state.decision && !state.invalidReason)
		.map((state) => state.proposal as Readonly<MemoryProposal>)
		.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.proposalId.localeCompare(right.proposalId));
	return { byId, pending };
}

export function createProposal(input: {
	proposalId: string;
	source: ProposalSource;
	candidate: MemoryCandidate;
	generator: ProposalGenerator;
	createdAt: string;
}): MemoryProposal {
	const base = {
		schemaVersion: 1 as const,
		proposalId: input.proposalId,
		revision: 1,
		source: input.source,
		candidate: input.candidate,
		generator: input.generator,
		createdAt: input.createdAt,
	};
	return { ...base, candidateHash: computeCandidateHash(base) };
}

export function reviseProposal(proposal: Readonly<MemoryProposal>, candidate: MemoryCandidate): MemoryProposal {
	const base = {
		schemaVersion: 1 as const,
		proposalId: proposal.proposalId,
		revision: proposal.revision + 1,
		source: proposal.source,
		candidate,
		generator: proposal.generator,
		createdAt: proposal.createdAt,
	};
	return { ...base, candidateHash: computeCandidateHash(base) };
}

export function makeProposalStatus(input: {
	proposal: Readonly<MemoryProposal>;
	status: "approved" | "rejected";
	memoryId: string | null;
	decidedAt: string;
}): ProposalStatus {
	return {
		schemaVersion: 1,
		proposalId: input.proposal.proposalId,
		candidateHash: input.proposal.candidateHash,
		status: input.status,
		memoryId: input.memoryId,
		decidedAt: input.decidedAt,
	};
}

export function resolveProposal(
	index: ProposalIndex,
	input: string,
): FoldedProposal | undefined {
	const normalized = input.toLowerCase().replaceAll("-", "");
	if (!/^[0-9a-f]{8,32}$/u.test(normalized)) return undefined;
	const matches = [...index.byId.values()].filter((state) =>
		state.proposalId.replaceAll("-", "").startsWith(normalized),
	);
	return matches.length === 1 ? matches[0] : undefined;
}
