import type {
	MemoryCandidate,
	MemoryProposal,
	MemoryRecord,
} from "./schemas.ts";

export function createDirectRecord(input: {
	id: string;
	candidate: MemoryCandidate;
	timestamp: string;
	sessionId: string | null;
}): MemoryRecord {
	return {
		schemaVersion: 1,
		id: input.id,
		content: input.candidate.content,
		kind: input.candidate.kind,
		recall: input.candidate.recall,
		tags: [...input.candidate.tags],
		enabled: true,
		createdAt: input.timestamp,
		updatedAt: input.timestamp,
		provenance: {
			capture: "direct",
			capturedAt: input.timestamp,
			sessionId: input.sessionId,
			entryIds: [],
			sourceDigest: null,
			proposalId: null,
			proposalHash: null,
		},
		supersedes: [...input.candidate.supersedes],
		modelDisclosure: "allowed",
	};
}

export function createDistilledRecord(input: {
	id: string;
	proposal: Readonly<MemoryProposal>;
	timestamp: string;
}): MemoryRecord {
	return {
		schemaVersion: 1,
		id: input.id,
		content: input.proposal.candidate.content,
		kind: input.proposal.candidate.kind,
		recall: input.proposal.candidate.recall,
		tags: [...input.proposal.candidate.tags],
		enabled: true,
		createdAt: input.timestamp,
		updatedAt: input.timestamp,
		provenance: {
			capture: "distilled",
			capturedAt: input.timestamp,
			sessionId: input.proposal.source.sessionId,
			entryIds: [...input.proposal.source.entryIds],
			sourceDigest: input.proposal.source.sourceDigest,
			proposalId: input.proposal.proposalId,
			proposalHash: input.proposal.candidateHash,
		},
		supersedes: [...input.proposal.candidate.supersedes],
		modelDisclosure: "allowed",
	};
}

export function editRecord(
	record: Readonly<MemoryRecord>,
	candidate: MemoryCandidate,
	updatedAt: string,
): MemoryRecord {
	return {
		...record,
		content: candidate.content,
		kind: candidate.kind,
		recall: candidate.recall,
		tags: [...candidate.tags],
		supersedes: [...candidate.supersedes],
		updatedAt,
	};
}

export function nextUpdatedAt(now: Date, previous: string): string {
	const next = Math.max(now.getTime(), Date.parse(previous) + 1);
	return new Date(next).toISOString();
}

export function resolveMemory(
	records: readonly Readonly<MemoryRecord>[],
	input: string,
): Readonly<MemoryRecord> | undefined {
	const raw = input.trim().toLowerCase();
	const exact = records.find((record) => record.id === raw);
	if (exact) return exact;
	const normalized = raw.replaceAll("-", "");
	if (!/^[0-9a-f]{8,32}$/u.test(normalized)) return undefined;
	const matches = records.filter((record) => record.id.replaceAll("-", "").startsWith(normalized));
	return matches.length === 1 ? matches[0] : undefined;
}
