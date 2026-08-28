import assert from "node:assert/strict";
import test from "node:test";
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { MemoryStore, MemoryStoreError } from "../storage.ts";
import { memoryId, record, temporaryStore, writeRecordFile } from "./helpers.ts";

function updated(number: number, content: string, timestamp = "2026-04-05T12:01:00.000Z") {
	return { ...record(number), content, updatedAt: timestamp };
}

test("initialization creates private fixed-layout directories", async () => {
	const { store } = await temporaryStore();
	for (const path of [store.root, store.recordsDir, store.quarantineDir]) {
		const stat = await lstat(path);
		assert.equal(stat.isDirectory(), true);
		assert.equal(stat.mode & 0o077, 0);
	}
});

test("create writes one pretty JSON record with newline and private mode", async () => {
	const { store } = await temporaryStore();
	const value = record(1);
	await store.createRecord(value);
	const path = join(store.recordsDir, `${value.id}.json`);
	const text = await readFile(path, "utf8");
	assert.equal(text.endsWith("\n"), true);
	assert.match(text, /^\{\n  "schemaVersion": 1,/u);
	assert.equal((await lstat(path)).mode & 0o077, 0);
	assert.deepEqual((await store.loadSnapshot()).records.map((item) => item.id), [value.id]);
});

test("concurrent stores serialize independent creations without lost records", async () => {
	const { agentDir, store } = await temporaryStore();
	const other = new MemoryStore(agentDir);
	const first = record(1, { content: "The user prefers concise summaries.", tags: ["first"] });
	const second = record(2, { content: "Detailed validation notes are expected.", tags: ["second"] });
	await Promise.all([
		store.createRecord(first),
		other.createRecord(second),
	]);
	assert.deepEqual(
		(await store.loadSnapshot()).records.map((item) => item.id).sort(),
		[first.id, second.id].sort(),
	);
});

test("conflict acknowledgement is bound to exact previewed IDs", async () => {
	const { store } = await temporaryStore();
	const first = record(1, { content: "The user prefers concise summaries.", tags: ["summary"] });
	const reviewed = record(2, { content: "The user prefers detailed summaries.", tags: ["summary"] });
	const arrivedLater = record(3, { content: "The user prefers structured summaries.", tags: ["summary"] });
	await store.createRecord(first);
	await store.createRecord(arrivedLater, { reviewedConflictIds: [first.id] });
	await assert.rejects(
		store.createRecord(reviewed, { reviewedConflictIds: [first.id] }),
		(error: unknown) => error instanceof MemoryStoreError && error.code === "conflict",
	);
	await store.createRecord(reviewed, { reviewedConflictIds: [first.id, arrivedLater.id] });
	assert.equal((await store.loadSnapshot()).byId.has(reviewed.id), true);
});

test("a second session sees another session's commit on its next snapshot", async () => {
	const { agentDir, store } = await temporaryStore();
	const otherSession = new MemoryStore(agentDir);
	assert.equal((await otherSession.loadSnapshot()).records.length, 0);
	await store.createRecord(record(1));
	assert.equal((await otherSession.loadSnapshot()).byId.has(record(1).id), true);
});

test("optimistic timestamps prevent stale overwrite", async () => {
	const { store } = await temporaryStore();
	const original = record(1);
	await store.createRecord(original);
	const committed = await store.updateRecord(original.id, original.updatedAt, () =>
		updated(1, "The user prefers terse implementation summaries."),
	);
	assert.equal(committed.content, "The user prefers terse implementation summaries.");
	await assert.rejects(
		store.updateRecord(original.id, original.updatedAt, () =>
			updated(1, "The user prefers verbose implementation summaries."),
		),
		(error: unknown) => error instanceof MemoryStoreError && error.code === "stale",
	);
	assert.equal((await store.loadSnapshot()).byId.get(original.id)?.content, committed.content);
});

test("failure before rename leaves the old complete record authoritative", async () => {
	const { agentDir, store } = await temporaryStore();
	const original = record(1);
	await store.createRecord(original);
	const failing = new MemoryStore(agentDir, {
		hooks: { beforeRename: () => { throw new Error("injected"); } },
	});
	await assert.rejects(
		failing.updateRecord(original.id, original.updatedAt, () =>
			updated(1, "The user prefers another summary format."),
		),
		(error: unknown) => error instanceof MemoryStoreError && error.code === "io",
	);
	assert.equal((await store.loadSnapshot()).byId.get(original.id)?.content, original.content);
	assert.deepEqual((await store.doctor()).temporaryFiles, []);
});

test("malformed records are isolated, valid recall continues, and additive mutation is degraded", async () => {
	const { store } = await temporaryStore();
	const valid = record(1);
	await store.createRecord(valid);
	await writeFile(join(store.recordsDir, `${memoryId(2)}.json`), "{bad json\n", { mode: 0o600 });
	const snapshot = await store.loadSnapshot();
	assert.deepEqual(snapshot.records.map((item) => item.id), [valid.id]);
	assert.equal(snapshot.errors.length, 1);
	const report = await store.doctor();
	assert.deepEqual(report.invalidFiles, [`${memoryId(2)}.json`]);
	assert.equal(JSON.stringify(report).includes("{bad json"), false);
	await assert.rejects(
		store.createRecord(record(3)),
		(error: unknown) => error instanceof MemoryStoreError && error.code === "degraded",
	);
	await store.forgetRecord(valid.id, valid.updatedAt);
	assert.equal((await store.loadSnapshot()).byId.has(valid.id), false);
});

test("unsupported versions and secret-shaped manual records are invalid without exposing content", async () => {
	const { store } = await temporaryStore();
	const unsupported = { ...record(1), schemaVersion: 2 };
	const secret = record(2, { content: "The token is ghp_abcdefghijklmnopqrstuvwxyz." });
	await writeRecordFile(store, unsupported);
	await writeRecordFile(store, secret);
	const snapshot = await store.loadSnapshot();
	assert.equal(snapshot.records.length, 0);
	assert.equal(snapshot.errors.length, 2);
	const rendered = JSON.stringify(snapshot.errors);
	assert.equal(rendered.includes("ghp_abcdefghijklmnopqrstuvwxyz"), false);
});

test("every record in a persisted supersession cycle is omitted and degrades management", async () => {
	const { store } = await temporaryStore();
	const first = record(1, { supersedes: [record(2).id] });
	const second = record(2, { supersedes: [first.id] });
	const valid = record(3, { content: "The user prefers independent validation notes.", tags: ["independent"] });
	await writeRecordFile(store, first);
	await writeRecordFile(store, second);
	await writeRecordFile(store, valid);
	const snapshot = await store.loadSnapshot();
	assert.deepEqual(snapshot.records.map((item) => item.id), [valid.id]);
	assert.deepEqual(snapshot.errors.map((error) => error.filename).sort(), [`${first.id}.json`, `${second.id}.json`]);
	await assert.rejects(
		store.createRecord(record(4)),
		(error: unknown) => error instanceof MemoryStoreError && error.code === "degraded",
	);
});

test("record and store symlinks fail closed without being followed", async () => {
	const { agentDir, store } = await temporaryStore();
	const outside = join(agentDir, "outside.json");
	await writeFile(outside, `${JSON.stringify(record(1))}\n`, { mode: 0o600 });
	await symlink(outside, join(store.recordsDir, `${record(1).id}.json`));
	await assert.rejects(
		store.loadSnapshot(),
		(error: unknown) => error instanceof MemoryStoreError && error.code === "security",
	);

	const secondAgent = join(agentDir, "second");
	await mkdir(secondAgent, { mode: 0o700 });
	await symlink(store.root, join(secondAgent, "memory"));
	await assert.rejects(
		new MemoryStore(secondAgent).initialize(),
		(error: unknown) => error instanceof MemoryStoreError && error.code === "security",
	);
});

test("a persisted correction suppresses its old conflict without rewriting the old file", async () => {
	const { store } = await temporaryStore();
	const old = record(1, { content: "The user prefers concise summaries.", tags: ["summary"] });
	const correction = record(2, {
		content: "The user prefers detailed summaries.",
		kind: "correction",
		tags: ["summary"],
		supersedes: [old.id],
	});
	await store.createRecord(old);
	await store.createRecord(correction);
	const snapshot = await store.loadSnapshot();
	assert.equal(snapshot.records.length, 2);
	assert.equal(snapshot.superseded.has(old.id), true);
	assert.equal((await readFile(join(store.recordsDir, `${old.id}.json`), "utf8")).includes(old.content), true);
});

test("physical forget leaves no extension backup and protects live supersession chains", async () => {
	const { store } = await temporaryStore();
	const old = record(1, { content: "The old preference is concise output." });
	const correction = record(2, {
		content: "The newer preference is detailed output.",
		kind: "correction",
		supersedes: [old.id],
	});
	await store.createRecord(old);
	await store.createRecord(correction);
	await assert.rejects(
		store.forgetRecord(correction.id, correction.updatedAt),
		(error: unknown) => error instanceof MemoryStoreError && error.code === "invariant",
	);
	await writeFile(
		join(store.recordsDir, `.${old.id}.deadbeef.tmp`),
		`${JSON.stringify(old)}\n`,
		{ mode: 0o600 },
	);
	await store.forgetRecord(old.id, old.updatedAt);
	await store.forgetRecord(correction.id, correction.updatedAt);
	assert.equal((await store.loadSnapshot()).records.length, 0);
	assert.deepEqual(await (await import("node:fs/promises")).readdir(store.recordsDir), []);
	assert.deepEqual(await (await import("node:fs/promises")).readdir(store.quarantineDir), []);
});

test("doctor removes only demonstrably stale same-host locks", async () => {
	const { store } = await temporaryStore();
	await mkdir(store.lockDir, { mode: 0o700 });
	await writeFile(
		join(store.lockDir, "owner.json"),
		JSON.stringify({ pid: 999_999_999, hostname: hostname(), acquiredAt: "2026-04-05T12:00:00.000Z" }),
		{ mode: 0o600 },
	);
	let report = await store.doctor({ removeStaleLock: true });
	assert.equal(report.staleLock, true);
	assert.equal(report.staleLockRemoved, true);

	await mkdir(store.lockDir, { mode: 0o700 });
	await writeFile(
		join(store.lockDir, "owner.json"),
		JSON.stringify({ pid: 999_999_999, hostname: "foreign-host", acquiredAt: "2026-04-05T12:00:00.000Z" }),
		{ mode: 0o600 },
	);
	report = await store.doctor({ removeStaleLock: true });
	assert.equal(report.staleLock, false);
	assert.equal(report.staleLockRemoved, false);
});

test("an existing recovery claim makes competing doctors fail closed around a replacement writer", async () => {
	const { agentDir, store } = await temporaryStore();
	await mkdir(store.lockDir, { mode: 0o700 });
	await writeFile(
		join(store.lockDir, "owner.json"),
		JSON.stringify({ pid: 999_999_999, hostname: hostname(), acquiredAt: "2026-04-05T12:00:00.000Z" }),
		{ mode: 0o600 },
	);
	await writeFile(
		join(store.lockDir, ".recovery-claim"),
		JSON.stringify({ pid: 999_999_998, hostname: hostname(), acquiredAt: "2026-04-05T12:00:01.000Z" }),
		{ mode: 0o600 },
	);
	let detected!: () => void;
	const staleDetected = new Promise<void>((resolve) => { detected = resolve; });
	let continueRecovery!: () => void;
	const recoveryCanContinue = new Promise<void>((resolve) => { continueRecovery = resolve; });
	const delayedDoctor = new MemoryStore(agentDir, {
		hooks: {
			afterStaleLockDetected: async () => {
				detected();
				await recoveryCanContinue;
			},
		},
	});
	const delayedReport = delayedDoctor.doctor({ removeStaleLock: true });
	await staleDetected;
	const competingReport = await store.doctor({ removeStaleLock: true });
	assert.equal(competingReport.staleLockRemoved, false);
	assert.equal((await lstat(store.lockDir)).isDirectory(), true);

	await rm(store.lockDir, { recursive: true });
	let writerLocked!: () => void;
	const writerHasLock = new Promise<void>((resolve) => { writerLocked = resolve; });
	let finishWrite!: () => void;
	const writeCanFinish = new Promise<void>((resolve) => { finishWrite = resolve; });
	const writer = new MemoryStore(agentDir, {
		hooks: {
			beforeRename: async () => {
				writerLocked();
				await writeCanFinish;
			},
		},
	});
	const writing = writer.createRecord(record(1));
	await writerHasLock;
	continueRecovery();
	const report = await delayedReport;
	assert.equal(report.staleLockRemoved, false);
	assert.equal((await lstat(store.lockDir)).isDirectory(), true);
	finishWrite();
	await writing;
	assert.equal((await store.loadSnapshot()).byId.has(record(1).id), true);
});

test("live or foreign lock times out as busy without mutation", async () => {
	const { agentDir, store } = await temporaryStore();
	await mkdir(store.lockDir, { mode: 0o700 });
	await writeFile(
		join(store.lockDir, "owner.json"),
		JSON.stringify({ pid: process.pid, hostname: hostname(), acquiredAt: new Date().toISOString() }),
		{ mode: 0o600 },
	);
	const impatient = new MemoryStore(agentDir, { lockTimeoutMs: 20 });
	await assert.rejects(
		impatient.createRecord(record(1)),
		(error: unknown) => error instanceof MemoryStoreError && error.code === "busy",
	);
	assert.equal((await (await import("node:fs/promises")).readdir(store.recordsDir)).length, 0);
});

test("doctor reports/removes orphan temporary files and quarantine never exposes corrupt content", async () => {
	const { store } = await temporaryStore();
	const temporary = `.${record(1).id}.abcdef12.tmp`;
	await writeFile(join(store.recordsDir, temporary), "orphan", { mode: 0o600 });
	let report = await store.doctor();
	assert.deepEqual(report.temporaryFiles, [temporary]);
	assert.equal(await store.removeTemporaryFiles(report.temporaryFiles), 1);

	const corrupt = `${memoryId(2)}.json`;
	const corruptContent = "not json and must not be exposed by quarantine";
	await writeFile(join(store.recordsDir, corrupt), corruptContent, { mode: 0o600 });
	await store.quarantine(corrupt);
	assert.equal((await lstat(join(store.quarantineDir, corrupt))).isFile(), true);
	report = await store.doctor();
	assert.deepEqual(report.invalidFiles, []);
	assert.equal(JSON.stringify(report).includes(corruptContent), false);
});

test("quarantine refuses a currently valid record", async () => {
	const { store } = await temporaryStore();
	const valid = record(1);
	await store.createRecord(valid);
	await assert.rejects(
		store.quarantine(`${valid.id}.json`),
		(error: unknown) => error instanceof MemoryStoreError && error.code === "invalid",
	);
	assert.equal((await store.loadSnapshot()).byId.has(valid.id), true);
	await assert.rejects(lstat(join(store.quarantineDir, `${valid.id}.json`)), /ENOENT/u);
});

test("discard-corrupt refuses valid records and physically removes invalid records", async () => {
	const { store } = await temporaryStore();
	const valid = record(1);
	await store.createRecord(valid);
	await assert.rejects(
		store.discardCorrupt(`${valid.id}.json`),
		(error: unknown) => error instanceof MemoryStoreError && error.code === "invalid",
	);
	const corrupt = `${memoryId(2)}.json`;
	await writeFile(join(store.recordsDir, corrupt), "bad", { mode: 0o600 });
	await store.discardCorrupt(corrupt);
	await assert.rejects(lstat(join(store.recordsDir, corrupt)), /ENOENT/u);
});

test("write-time invariants enforce conflict review, always cap, and cycle rejection", async () => {
	const { store } = await temporaryStore();
	const first = record(1, { content: "The user prefers concise summaries.", tags: ["communication"] });
	await store.createRecord(first);
	await assert.rejects(
		store.createRecord(record(2, { content: "The user prefers concise reports.", tags: ["communication"] })),
		(error: unknown) => error instanceof MemoryStoreError && error.code === "conflict",
	);

	const reviewedAlwaysIds: string[] = [];
	for (let number = 10; number <= 12; number++) {
		const always = record(number, { recall: "always", content: `The always fact number ${number} is stable.`, kind: "fact", tags: [`always-${number}`] });
		await store.createRecord(always, { reviewedConflictIds: reviewedAlwaysIds });
		reviewedAlwaysIds.push(always.id);
	}
	await assert.rejects(
		store.createRecord(
			record(13, { recall: "always", content: "The fourth always fact is stable.", kind: "fact", tags: ["always-13"] }),
			{ reviewedConflictIds: reviewedAlwaysIds },
		),
		(error: unknown) => error instanceof MemoryStoreError && error.code === "invariant",
	);

	const second = record(3, { content: "The second workflow replaces the first.", kind: "workflow", tags: ["cycle"], supersedes: [first.id] });
	await store.createRecord(second);
	await assert.rejects(
		store.updateRecord(first.id, first.updatedAt, (current) => ({
			...current,
			supersedes: [second.id],
			updatedAt: "2026-04-05T12:02:00.000Z",
		})),
		(error: unknown) => error instanceof MemoryStoreError && error.code === "invariant",
	);
});

test("proposal approval is idempotent by proposal ID and hash", async () => {
	const { store } = await temporaryStore();
	const provenance = {
		capture: "distilled" as const,
		capturedAt: "2026-04-05T12:00:00.000Z",
		sessionId: "session-1",
		entryIds: ["entry001"],
		sourceDigest: "a".repeat(64),
		proposalId: memoryId(100),
		proposalHash: "b".repeat(64),
	};
	const first = record(1, { provenance });
	const retry = record(2, { provenance });
	const created = await store.createRecord(first);
	const recovered = await store.createRecord(retry);
	assert.equal(created.existing, false);
	assert.equal(recovered.existing, true);
	assert.equal(recovered.record.id, first.id);
	assert.equal((await store.loadSnapshot()).records.length, 1);
});

test("broad record permissions block recall and management", async () => {
	const { store } = await temporaryStore();
	const value = record(1);
	const path = await writeRecordFile(store, value);
	await chmod(path, 0o644);
	await assert.rejects(
		store.loadSnapshot(),
		(error: unknown) => error instanceof MemoryStoreError && error.code === "permission",
	);
});
