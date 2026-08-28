import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryCandidate, MemoryRecord } from "../schemas.ts";
import { MemoryStore } from "../storage.ts";

export const BASE_TIME = "2026-04-05T12:00:00.000Z";

export function memoryId(number: number): string {
	return `0195f4c7-8b35-7c29-a6b2-${number.toString(16).padStart(12, "0")}`;
}

export function candidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
	return {
		content: "The user prefers concise implementation summaries.",
		kind: "preference",
		recall: "relevant",
		tags: ["summary"],
		supersedes: [],
		...overrides,
	};
}

export function record(number: number, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
	const value: MemoryRecord = {
		schemaVersion: 1,
		id: memoryId(number),
		content: "The user prefers concise implementation summaries.",
		kind: "preference",
		recall: "relevant",
		tags: ["summary"],
		enabled: true,
		createdAt: BASE_TIME,
		updatedAt: BASE_TIME,
		provenance: {
			capture: "direct",
			capturedAt: BASE_TIME,
			sessionId: null,
			entryIds: [],
			sourceDigest: null,
			proposalId: null,
			proposalHash: null,
		},
		supersedes: [],
		modelDisclosure: "allowed",
		...overrides,
	};
	return value;
}

export async function temporaryStore(options: ConstructorParameters<typeof MemoryStore>[1] = {}) {
	const agentDir = await mkdtemp(join(tmpdir(), "persistent-memory-test-"));
	const store = new MemoryStore(agentDir, options);
	await store.initialize();
	return { agentDir, store };
}

export async function writeRecordFile(store: MemoryStore, value: unknown, filename?: string): Promise<string> {
	const id =
		value && typeof value === "object" && "id" in value && typeof (value as { id?: unknown }).id === "string"
			? (value as { id: string }).id
			: memoryId(999);
	const path = join(store.recordsDir, filename ?? `${id}.json`);
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	await chmod(path, 0o600);
	return path;
}

export async function readStoredRecord(store: MemoryStore, id: string): Promise<MemoryRecord> {
	return JSON.parse(await readFile(join(store.recordsDir, `${id}.json`), "utf8")) as MemoryRecord;
}
