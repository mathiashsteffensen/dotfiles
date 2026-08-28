import { Value } from "typebox/value";
import { codePointLength, isUnicodeScalarString } from "./canonical.ts";
import {
	MemoryRecordSchema,
	type MemoryCandidate,
	type MemoryKind,
	type MemoryRecord,
	type RecallMode,
	UUID_V7_PATTERN,
} from "./schemas.ts";

const UUID_V7 = new RegExp(UUID_V7_PATTERN, "u");
const SHA256 = /^[0-9a-f]{64}$/u;
const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;
const TAG = /^[\p{L}\p{N}_-]+$/u;
const KINDS = new Set<MemoryKind>(["preference", "fact", "constraint", "workflow", "correction"]);
const RECALL_MODES = new Set<RecallMode>(["relevant", "always"]);

export type SecretRule = "private key" | "known token" | "JWT-shaped value" | "named secret assignment";

export interface ValidationIssue {
	field: string;
	code: string;
	message: string;
	rule?: SecretRule;
	range?: readonly [number, number];
}

export interface CandidateInput {
	content: unknown;
	kind: unknown;
	recall: unknown;
	tags: unknown;
	supersedes?: unknown;
}

export interface CandidateValidation {
	candidate?: MemoryCandidate;
	issues: ValidationIssue[];
}

interface SecretMatch {
	rule: SecretRule;
	range: readonly [number, number];
}

function pointOffset(value: string, utf16Offset: number): number {
	return codePointLength(value.slice(0, utf16Offset));
}

function matchRange(value: string, match: RegExpMatchArray, group = 0): readonly [number, number] {
	const indices = match.indices?.[group];
	if (indices) return [pointOffset(value, indices[0]), pointOffset(value, indices[1])];
	const start = match.index ?? 0;
	return [pointOffset(value, start), pointOffset(value, start + match[0].length)];
}

export function detectSecrets(value: string): SecretMatch[] {
	const normalized = value.normalize("NFKC");
	const matches: SecretMatch[] = [];
	const rules: Array<{ rule: Exclude<SecretRule, "named secret assignment">; expression: RegExp }> = [
		{
			rule: "private key",
			expression: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/du,
		},
		{
			rule: "known token",
			expression:
				/(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,})/du,
		},
		{
			rule: "JWT-shaped value",
			expression:
				/(?:^|[^A-Za-z0-9_-])[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:$|[^A-Za-z0-9_-])/du,
		},
	];
	for (const { rule, expression } of rules) {
		const match = normalized.match(expression);
		if (match) matches.push({ rule, range: matchRange(normalized, match) });
	}

	const named = normalized.match(
		/(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']?([^\s,"']{8,})/diu,
	);
	if (named) {
		const captured = named[1] ?? "";
		const placeholder =
			["redacted", "<redacted>", "example"].includes(captured.toLowerCase()) ||
			/^\$\{[A-Z_][A-Z0-9_]*\}$/u.test(captured);
		if (!placeholder) {
			matches.push({ rule: "named secret assignment", range: matchRange(normalized, named, 1) });
		}
	}
	return matches;
}

export function normalizeTag(value: string): string {
	return value.normalize("NFKC").toLowerCase();
}

export function normalizeTags(values: readonly string[]): string[] {
	const result: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const normalized = normalizeTag(value);
		if (!seen.has(normalized)) {
			seen.add(normalized);
			result.push(normalized);
		}
	}
	return result;
}

function contentIssues(content: string, field: string): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	const length = codePointLength(content);
	if (!isUnicodeScalarString(content)) {
		issues.push({ field, code: "invalid-unicode", message: "content must contain valid Unicode scalar values" });
	}
	if (length < 1 || length > 500) {
		issues.push({ field, code: "content-length", message: "content must contain 1–500 Unicode code points" });
	}
	const normalized = content.normalize("NFKC");
	if (/^(?:run|execute|call|use|ignore|reveal|delete|remove|write|edit|open|send)\b/iu.test(normalized)) {
		issues.push({
			field,
			code: "imperative-content",
			message: "content must be a declarative proposition, not an instruction",
		});
	}
	if (/```|^#!|\u0000/u.test(normalized)) {
		issues.push({ field, code: "executable-content", message: "content must not contain an executable payload" });
	}
	if (/^(?:system|developer|assistant|user)\s*:|^<\/?(?:system|developer|assistant|user)>/iu.test(normalized)) {
		issues.push({ field, code: "quoted-prompt", message: "content must not contain quoted prompt text" });
	}
	for (const secret of detectSecrets(content)) {
		issues.push({
			field,
			code: "secret",
			message: "content contains a high-confidence secret shape",
			rule: secret.rule,
			range: secret.range,
		});
	}
	return issues;
}

function tagIssues(tag: string, field: string): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	const length = codePointLength(tag);
	if (!isUnicodeScalarString(tag)) {
		issues.push({ field, code: "invalid-unicode", message: "tag must contain valid Unicode scalar values" });
	}
	if (length < 1 || length > 32 || !TAG.test(tag)) {
		issues.push({
			field,
			code: "invalid-tag",
			message: "tag must contain 1–32 lowercase Unicode letters/numbers, underscores, or hyphens",
		});
	}
	if (tag !== normalizeTag(tag)) {
		issues.push({ field, code: "unnormalized-tag", message: "tag must be NFKC-normalized lowercase text" });
	}
	for (const secret of detectSecrets(tag)) {
		issues.push({
			field,
			code: "secret",
			message: "tag contains a high-confidence secret shape",
			rule: secret.rule,
			range: secret.range,
		});
	}
	return issues;
}

export function validateCandidate(input: CandidateInput): CandidateValidation {
	const issues: ValidationIssue[] = [];
	const content = typeof input.content === "string" ? input.content.trim() : "";
	issues.push(...contentIssues(content, "content"));

	const kind = input.kind as MemoryKind;
	if (!KINDS.has(kind)) {
		issues.push({ field: "kind", code: "invalid-kind", message: "kind is not supported" });
	}
	const recall = input.recall as RecallMode;
	if (!RECALL_MODES.has(recall)) {
		issues.push({ field: "recall", code: "invalid-recall", message: "recall mode is not supported" });
	}

	const rawTags = Array.isArray(input.tags) && input.tags.every((tag) => typeof tag === "string")
		? (input.tags as string[])
		: [];
	if (!Array.isArray(input.tags) || !input.tags.every((tag) => typeof tag === "string")) {
		issues.push({ field: "tags", code: "invalid-tags", message: "tags must be an array of strings" });
	}
	const tags = normalizeTags(rawTags);
	if (tags.length > 8) {
		issues.push({ field: "tags", code: "too-many-tags", message: "at most eight tags are allowed" });
	}
	for (const [index, tag] of tags.entries()) issues.push(...tagIssues(tag, `tags[${index}]`));

	const rawSupersedes = input.supersedes ?? [];
	const supersedes = Array.isArray(rawSupersedes) && rawSupersedes.every((id) => typeof id === "string")
		? [...new Set(rawSupersedes as string[])].sort()
		: [];
	if (!Array.isArray(rawSupersedes) || !rawSupersedes.every((id) => typeof id === "string")) {
		issues.push({ field: "supersedes", code: "invalid-supersedes", message: "supersedes must be an array of IDs" });
	}
	for (const [index, id] of supersedes.entries()) {
		if (!UUID_V7.test(id)) {
			issues.push({
				field: `supersedes[${index}]`,
				code: "invalid-id",
				message: "superseded memory ID must be a lowercase UUIDv7",
			});
		}
	}

	if (issues.length > 0) return { issues };
	return { candidate: { content, kind, recall, tags, supersedes }, issues };
}

function isTimestamp(value: string): boolean {
	return TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function schemaIssues(value: unknown): ValidationIssue[] {
	if (Value.Check(MemoryRecordSchema, value)) return [];
	const issues: ValidationIssue[] = [];
	for (const error of Value.Errors(MemoryRecordSchema, value)) {
		issues.push({
			field: error.instancePath || "record",
			code: "schema",
			message: `record schema violation${error.instancePath ? ` at ${error.instancePath}` : ""}`,
		});
		if (issues.length === 12) break;
	}
	return issues.length > 0
		? issues
		: [{ field: "record", code: "schema", message: "record schema violation" }];
}

export function validateMemoryRecord(value: unknown): ValidationIssue[] {
	const issues = schemaIssues(value);
	if (issues.length > 0) return issues;
	const record = value as MemoryRecord;

	if (record.content !== record.content.trim()) {
		issues.push({ field: "content", code: "untrimmed-content", message: "content must be trimmed" });
	}
	issues.push(...contentIssues(record.content, "content"));
	for (const [index, tag] of record.tags.entries()) issues.push(...tagIssues(tag, `tags[${index}]`));
	if (new Set(record.tags).size !== record.tags.length) {
		issues.push({ field: "tags", code: "duplicate-tags", message: "tags must be duplicate-free" });
	}
	if (!isTimestamp(record.createdAt) || !isTimestamp(record.updatedAt) || !isTimestamp(record.provenance.capturedAt)) {
		issues.push({ field: "timestamps", code: "invalid-timestamp", message: "timestamps must be UTC with millisecond precision" });
	} else if (record.updatedAt < record.createdAt) {
		issues.push({ field: "updatedAt", code: "timestamp-order", message: "updatedAt must not precede createdAt" });
	}
	if (record.supersedes.includes(record.id)) {
		issues.push({ field: "supersedes", code: "self-supersession", message: "a memory cannot supersede itself" });
	}
	if (
		new Set(record.supersedes).size !== record.supersedes.length ||
		[...record.supersedes].sort().some((id, index) => id !== record.supersedes[index])
	) {
		issues.push({ field: "supersedes", code: "supersedes-order", message: "supersedes must be sorted and duplicate-free" });
	}

	const provenance = record.provenance;
	if (provenance.capture === "direct") {
		if (
			provenance.entryIds.length !== 0 ||
			provenance.sourceDigest !== null ||
			provenance.proposalId !== null ||
			provenance.proposalHash !== null
		) {
			issues.push({ field: "provenance", code: "direct-provenance", message: "direct provenance fields are inconsistent" });
		}
	} else if (
		provenance.sessionId === null ||
		provenance.entryIds.length === 0 ||
		!provenance.sourceDigest ||
		!SHA256.test(provenance.sourceDigest) ||
		!provenance.proposalId ||
		!provenance.proposalHash
	) {
		issues.push({ field: "provenance", code: "distilled-provenance", message: "distilled provenance fields are incomplete" });
	}
	if (new Set(provenance.entryIds).size !== provenance.entryIds.length) {
		issues.push({ field: "provenance.entryIds", code: "duplicate-entry-id", message: "provenance entry IDs must be duplicate-free" });
	}
	return issues;
}

export function formatValidationIssues(issues: readonly ValidationIssue[]): string {
	return issues
		.map((issue) => {
			if (issue.rule && issue.range) {
				return `${issue.field}: ${issue.rule} at code-point range ${issue.range[0]}..${issue.range[1]}`;
			}
			return `${issue.field}: ${issue.message}`;
		})
		.join("\n");
}
