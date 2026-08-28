import assert from "node:assert/strict";
import test from "node:test";
import {
	computePacketTokenBudget,
	effectiveSupersededIds,
	findConflicts,
	findSupersessionCycleIds,
	formatRecallBlock,
	rankMemories,
	selectRecallPacket,
	selectToolResults,
	tokenize,
} from "../retrieval.ts";
import { record } from "./helpers.ts";

test("tokenization is NFKC/lowercase, keeps underscore and hyphen, and drops one-point tokens", () => {
	assert.deepEqual(tokenize("Ａ a I naïve-workflow foo_bar 7 77"), ["naïve-workflow", "foo_bar", "77"]);
});

test("ranking uses exact distinct tag/content scores and omits zero scores", () => {
	const memories = [
		record(1, {
			content: "The user prefers TypeScript summaries and TypeScript checks.",
			tags: ["typescript"],
		}),
		record(2, { content: "The user prefers Rust tests.", tags: ["rust"] }),
	];
	const ranked = rankMemories(memories, "typescript summaries summaries x");
	assert.equal(ranked.length, 1);
	assert.equal(ranked[0]?.record.id, memories[0]?.id);
	assert.equal(ranked[0]?.score, 16);
});

test("always records sort first, then score, updated time, and ID", () => {
	const memories = [
		record(4, { recall: "relevant", content: "Alpha topic.", tags: [], updatedAt: "2026-04-05T12:03:00.000Z" }),
		record(3, { recall: "always", content: "Always three.", tags: [], updatedAt: "2026-04-05T12:01:00.000Z" }),
		record(2, { recall: "always", content: "Always two.", tags: [], updatedAt: "2026-04-05T12:02:00.000Z" }),
		record(1, { recall: "relevant", content: "Alpha item.", tags: [], updatedAt: "2026-04-05T12:03:00.000Z" }),
	];
	assert.deepEqual(
		rankMemories(memories, "alpha").map((item) => item.record.id),
		[memories[2]!.id, memories[1]!.id, memories[3]!.id, memories[0]!.id],
	);
});

test("effective supersession traverses disabled targets transitively", () => {
	const oldest = record(1, { content: "Old preference." });
	const middle = record(2, { content: "Middle correction.", kind: "correction", enabled: false, supersedes: [oldest.id] });
	const newest = record(3, { content: "Newest correction.", kind: "correction", supersedes: [middle.id] });
	const superseded = effectiveSupersededIds([oldest, middle, newest]);
	assert.deepEqual([...superseded].sort(), [oldest.id, middle.id]);
	assert.deepEqual(rankMemories([oldest, middle, newest], "preference correction").map((item) => item.record.id), [newest.id]);
});

test("cycle detection marks every member of each supersession cycle", () => {
	const first = record(1, { supersedes: [record(2).id] });
	const second = record(2, { supersedes: [first.id] });
	const third = record(3);
	assert.deepEqual([...findSupersessionCycleIds([first, second, third])].sort(), [first.id, second.id]);
});

test("supersession traversal remains iterative across a 10,000-record chain", () => {
	const chain = Array.from({ length: 10_000 }, (_, index) =>
		record(index + 1, {
			enabled: index === 9_999,
			supersedes: index === 0 ? [] : [record(index).id],
		}),
	);
	assert.equal(findSupersessionCycleIds(chain).size, 0);
	assert.equal(effectiveSupersededIds(chain).size, 9_999);
});

test("conflict review uses kind, tags, two content tokens, and correction cross-kind matching", () => {
	const preference = record(1, { content: "The user prefers concise summaries.", tags: ["communication"] });
	const fact = record(2, { kind: "fact", content: "The user uses concise summaries.", tags: [] });
	assert.deepEqual(
		findConflicts(
			{ content: "Concise summaries are preferred.", kind: "preference", tags: [] },
			[preference, fact],
		).map((item) => item.id),
		[preference.id],
	);
	assert.equal(
		findConflicts(
			{ content: "The communication preference changed.", kind: "correction", tags: ["communication"] },
			[preference, fact],
		).length,
		1,
	);
});

test("packet budget follows headroom formula and fails closed on unavailable usage", () => {
	assert.equal(
		computePacketTokenBudget({ contextWindow: 100_000, currentContextTokens: 80_000, maxOutputTokens: 10_000 }),
		1000,
	);
	assert.equal(
		computePacketTokenBudget({ contextWindow: 10_000, currentContextTokens: 8_900, maxOutputTokens: 100 }),
		0,
	);
	assert.equal(
		computePacketTokenBudget({ contextWindow: 100_000, currentContextTokens: null, maxOutputTokens: 10_000 }),
		0,
	);
});

test("recall selection enforces six records and emits JSON-encoded whole content", () => {
	const memories = Array.from({ length: 8 }, (_, index) =>
		record(index + 1, {
			content: index === 0 ? 'The alpha preference says "quoted"\nand remains data.' : `The alpha preference number ${index + 1}.`,
			tags: ["alpha"],
			updatedAt: index === 0 ? "2026-04-05T13:00:00.000Z" : `2026-04-05T12:00:0${index}.000Z`,
		}),
	);
	const selected = selectRecallPacket(rankMemories(memories, "alpha"), 10_000);
	assert.equal(selected.ranked.length, 6);
	assert.ok(selected.block);
	assert.match(selected.block!, /\\"quoted\\"\\nand remains data/u);
	assert.ok(Buffer.byteLength(selected.block!, "utf8") < 4000);
});

test("selection enforces 2,400 content points and skips an oversized whole record", () => {
	const long = Array.from({ length: 6 }, (_, index) =>
		record(index + 1, {
			content: `alpha ${"z".repeat(493)}`,
			tags: ["alpha"],
			updatedAt: `2026-04-05T12:00:0${index}.000Z`,
		}),
	);
	assert.equal(selectRecallPacket(rankMemories(long, "alpha"), 10_000).ranked.length, 4);

	const oversized = record(20, {
		content: `alpha ${"😀".repeat(190)}`,
		tags: ["alpha"],
		updatedAt: "2026-04-05T13:00:00.000Z",
	});
	const small = record(21, { content: "Alpha short.", tags: ["alpha"] });
	const selected = selectRecallPacket(rankMemories([oversized, small], "alpha"), 300);
	assert.deepEqual(selected.ranked.map((item) => item.record.id), [small.id]);
});

test("tool selection uses requested limit and the same 2,400-point budget", () => {
	const ranked = rankMemories(
		Array.from({ length: 10 }, (_, index) => record(index + 1, { content: `Alpha ${index}`, tags: ["alpha"] })),
		"alpha",
	);
	assert.equal(selectToolResults(ranked, 3).length, 3);
	assert.ok(formatRecallBlock(ranked.slice(0, 1)).startsWith("Persistent memory references"));
});
