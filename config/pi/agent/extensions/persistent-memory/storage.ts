import { constants as fsConstants } from "node:fs";
import {
	access,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	rmdir,
	unlink,
	writeFile,
} from "node:fs/promises";
import { hostname as systemHostname } from "node:os";
import { basename, join } from "node:path";
import { randomBytes, randomInt } from "node:crypto";
import { deepFreeze } from "./canonical.ts";
import {
	effectiveSupersededIds,
	findConflicts,
	findSupersessionCycleIds,
} from "./retrieval.ts";
import type { MemoryRecord } from "./schemas.ts";
import { validateMemoryRecord } from "./validation.ts";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_RECORD_BYTES = 1024 * 1024;
const TEMP_NAME = /^\.[0-9a-f-]+\.[0-9a-f]+\.tmp$/u;

export interface SnapshotError {
	filename: string;
	reason: string;
}

export interface MemorySnapshot {
	records: readonly Readonly<MemoryRecord>[];
	byId: ReadonlyMap<string, Readonly<MemoryRecord>>;
	superseded: ReadonlySet<string>;
	errors: readonly SnapshotError[];
	recordFileCount: number;
}

export interface DoctorIssue {
	path: string;
	reason: string;
}

export interface DoctorReport {
	issues: readonly DoctorIssue[];
	invalidFiles: readonly string[];
	temporaryFiles: readonly string[];
	recordCount: number;
	staleLock: boolean;
	staleLockRemoved: boolean;
	corpusWarning: boolean;
}

export interface MutationOptions {
	reviewedConflictIds?: readonly string[];
	allowDegraded?: boolean;
}

export interface CreateResult {
	record: Readonly<MemoryRecord>;
	existing: boolean;
}

interface LockOwner {
	pid: number;
	hostname: string;
	acquiredAt: string;
}

interface LockIdentity {
	device: number;
	inode: number;
	owner: LockOwner;
}

interface StorageHooks {
	beforeRename?: (target: string) => void | Promise<void>;
	afterStaleLockDetected?: () => void | Promise<void>;
}

export interface MemoryStoreOptions {
	lockTimeoutMs?: number;
	now?: () => Date;
	pid?: number;
	hostname?: string;
	hooks?: StorageHooks;
}

type MemoryStoreErrorCode =
	| "security"
	| "permission"
	| "busy"
	| "degraded"
	| "conflict"
	| "stale"
	| "invalid"
	| "not-found"
	| "invariant"
	| "io";

export class MemoryStoreError extends Error {
	readonly code: MemoryStoreErrorCode;

	constructor(message: string, code: MemoryStoreErrorCode) {
		super(message);
		this.name = "MemoryStoreError";
		this.code = code;
	}
}

async function statOrUndefined(path: string) {
	try {
		return await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function hasPrivateMode(mode: number): boolean {
	return (mode & 0o077) === 0;
}

function safeReason(issues: ReturnType<typeof validateMemoryRecord>): string {
	const reasons = [...new Set(issues.map((issue) => issue.code))];
	return reasons.slice(0, 4).join(", ") || "record validation failed";
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function compareIds(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export class MemoryStore {
	readonly root: string;
	readonly recordsDir: string;
	readonly quarantineDir: string;
	readonly lockDir: string;
	private readonly lockTimeoutMs: number;
	private readonly now: () => Date;
	private readonly pid: number;
	private readonly hostname: string;
	private readonly hooks: StorageHooks;

	constructor(agentDir: string, options: MemoryStoreOptions = {}) {
		this.root = join(agentDir, "memory");
		this.recordsDir = join(this.root, "records");
		this.quarantineDir = join(this.root, "quarantine");
		this.lockDir = join(this.root, ".write-lock");
		this.lockTimeoutMs = options.lockTimeoutMs ?? 2000;
		this.now = options.now ?? (() => new Date());
		this.pid = options.pid ?? process.pid;
		this.hostname = options.hostname ?? systemHostname();
		this.hooks = options.hooks ?? {};
	}

	private async createOrCheckDirectory(path: string, label: string): Promise<void> {
		let stat = await statOrUndefined(path);
		if (!stat) {
			try {
				await mkdir(path, { mode: DIRECTORY_MODE });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
					throw new MemoryStoreError(`cannot create ${label}`, "io");
				}
			}
			stat = await statOrUndefined(path);
		}
		if (!stat || stat.isSymbolicLink()) {
			throw new MemoryStoreError(`${label} must not be a symlink`, "security");
		}
		if (!stat.isDirectory()) throw new MemoryStoreError(`${label} is not a directory`, "security");
		if (!hasPrivateMode(stat.mode)) {
			throw new MemoryStoreError(`${label} permissions are too broad`, "permission");
		}
	}

	async initialize(): Promise<void> {
		await this.createOrCheckDirectory(this.root, "memory directory");
		await this.createOrCheckDirectory(this.recordsDir, "records directory");
		await this.createOrCheckDirectory(this.quarantineDir, "quarantine directory");
		const lock = await statOrUndefined(this.lockDir);
		if (lock) {
			if (lock.isSymbolicLink() || !lock.isDirectory()) {
				throw new MemoryStoreError("memory write lock path is unsafe", "security");
			}
			if (!hasPrivateMode(lock.mode)) {
				throw new MemoryStoreError("memory write lock permissions are too broad", "permission");
			}
		}
	}

	private async assertInitialized(): Promise<void> {
		for (const [path, label] of [
			[this.root, "memory directory"],
			[this.recordsDir, "records directory"],
			[this.quarantineDir, "quarantine directory"],
		] as const) {
			const stat = await statOrUndefined(path);
			if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
				throw new MemoryStoreError(`${label} is missing or unsafe`, "security");
			}
			if (!hasPrivateMode(stat.mode)) {
				throw new MemoryStoreError(`${label} permissions are too broad`, "permission");
			}
		}
	}

	private async parseRecordFile(filename: string, strictSecurity: boolean): Promise<{
		record?: MemoryRecord;
		error?: SnapshotError;
	}> {
		const path = join(this.recordsDir, filename);
		let stat;
		try {
			stat = await lstat(path);
		} catch {
			if (strictSecurity) throw new MemoryStoreError("memory record stat failed", "io");
			return { error: { filename, reason: "record stat failed" } };
		}
		if (stat.isSymbolicLink()) {
			if (strictSecurity) throw new MemoryStoreError("record symlink rejected", "security");
			return { error: { filename, reason: "record symlink rejected" } };
		}
		if (!stat.isFile()) return { error: { filename, reason: "record path is not a regular file" } };
		if (!hasPrivateMode(stat.mode)) {
			if (strictSecurity) throw new MemoryStoreError("record permissions are too broad", "permission");
			return { error: { filename, reason: "record permissions are too broad" } };
		}
		if (stat.size > MAX_RECORD_BYTES) return { error: { filename, reason: "record file is too large" } };

		let bytes: Buffer;
		try {
			bytes = await readFile(path);
		} catch {
			if (strictSecurity) throw new MemoryStoreError("memory record read failed", "io");
			return { error: { filename, reason: "record read failed" } };
		}
		let parsed: unknown;
		try {
			const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			parsed = JSON.parse(text);
		} catch {
			return { error: { filename, reason: "invalid UTF-8 or JSON" } };
		}
		const issues = validateMemoryRecord(parsed);
		if (issues.length > 0) return { error: { filename, reason: safeReason(issues) } };
		const record = parsed as MemoryRecord;
		if (filename !== `${record.id}.json`) {
			return { error: { filename, reason: "filename does not match record ID" } };
		}
		return { record };
	}

	private async scanRecords(strictSecurity: boolean): Promise<{
		records: MemoryRecord[];
		errors: SnapshotError[];
		recordFileCount: number;
		temporaryFiles: string[];
	}> {
		if (strictSecurity) await this.assertInitialized();
		const entries = await readdir(this.recordsDir, { withFileTypes: true });
		const filenames = entries.map((entry) => entry.name).sort(compareIds);
		const records: MemoryRecord[] = [];
		const errors: SnapshotError[] = [];
		const temporaryFiles: string[] = [];
		let recordFileCount = 0;
		for (const filename of filenames) {
			if (TEMP_NAME.test(filename)) {
				temporaryFiles.push(filename);
				continue;
			}
			if (!filename.endsWith(".json")) continue;
			recordFileCount++;
			const result = await this.parseRecordFile(filename, strictSecurity);
			if (result.record) records.push(result.record);
			if (result.error) errors.push(result.error);
		}

		const cycleIds = findSupersessionCycleIds(records);
		if (cycleIds.size > 0) {
			for (const id of [...cycleIds].sort(compareIds)) {
				errors.push({ filename: `${id}.json`, reason: "supersession cycle" });
			}
		}
		return {
			records: records.filter((record) => !cycleIds.has(record.id)),
			errors,
			recordFileCount,
			temporaryFiles,
		};
	}

	async loadSnapshot(): Promise<MemorySnapshot> {
		let scanned;
		try {
			scanned = await this.scanRecords(true);
		} catch (error) {
			if (error instanceof MemoryStoreError) throw error;
			throw new MemoryStoreError("memory store read failed", "io");
		}
		const records = scanned.records.map((record) => deepFreeze(record));
		const byId = new Map(records.map((record) => [record.id, record]));
		const superseded = effectiveSupersededIds(records);
		return Object.freeze({
			records: Object.freeze(records),
			byId,
			superseded,
			errors: Object.freeze(scanned.errors.map((error) => Object.freeze(error))),
			recordFileCount: scanned.recordFileCount,
		});
	}

	private async readOwnerFile(path: string): Promise<LockOwner | undefined> {
		try {
			const stat = await lstat(path);
			if (stat.isSymbolicLink() || !stat.isFile() || !hasPrivateMode(stat.mode)) return undefined;
			const value = JSON.parse(await readFile(path, "utf8")) as Partial<LockOwner>;
			if (
				typeof value.pid !== "number" ||
				!Number.isSafeInteger(value.pid) ||
				value.pid <= 0 ||
				typeof value.hostname !== "string" ||
				typeof value.acquiredAt !== "string" ||
				Number.isNaN(Date.parse(value.acquiredAt)) ||
				new Date(value.acquiredAt).toISOString() !== value.acquiredAt
			) {
				return undefined;
			}
			return { pid: value.pid, hostname: value.hostname, acquiredAt: value.acquiredAt };
		} catch {
			return undefined;
		}
	}

	private async readLockOwner(): Promise<LockOwner | undefined> {
		return this.readOwnerFile(join(this.lockDir, "owner.json"));
	}

	private async readLockIdentity(): Promise<LockIdentity | undefined> {
		try {
			const stat = await lstat(this.lockDir);
			if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
			const owner = await this.readLockOwner();
			return owner ? { device: stat.dev, inode: stat.ino, owner } : undefined;
		} catch {
			return undefined;
		}
	}

	private lockIdentityIsDemonstrablyStale(identity: LockIdentity): boolean {
		return identity.owner.hostname === this.hostname && !isProcessAlive(identity.owner.pid);
	}

	private sameLockIdentity(left: LockIdentity, right: LockIdentity): boolean {
		return (
			left.device === right.device &&
			left.inode === right.inode &&
			left.owner.pid === right.owner.pid &&
			left.owner.hostname === right.owner.hostname &&
			left.owner.acquiredAt === right.owner.acquiredAt
		);
	}

	private async acquireRecoveryClaim(path: string): Promise<boolean> {
		const owner: LockOwner = {
			pid: this.pid,
			hostname: this.hostname,
			acquiredAt: this.now().toISOString(),
		};
		try {
			await writeFile(path, `${JSON.stringify(owner, null, 2)}\n`, {
				encoding: "utf8",
				mode: FILE_MODE,
				flag: "wx",
			});
			return true;
		} catch (error) {
			if (["EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
			throw error;
		}
	}

	private async reclaimStaleLock(expected: LockIdentity): Promise<boolean> {
		await this.hooks.afterStaleLockDetected?.();
		const claim = join(this.lockDir, ".recovery-claim");
		const reclaimed = join(this.root, `.write-lock.reclaimed-${randomBytes(8).toString("hex")}`);
		let claimed = false;
		let moved = false;
		try {
			claimed = await this.acquireRecoveryClaim(claim);
			if (!claimed) return false;
			const current = await this.readLockIdentity();
			if (
				!current ||
				!this.sameLockIdentity(expected, current) ||
				!this.lockIdentityIsDemonstrablyStale(current)
			) {
				return false;
			}
			await rename(this.lockDir, reclaimed);
			moved = true;
			await rm(reclaimed, { recursive: true });
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		} finally {
			if (claimed && !moved) await unlink(claim).catch(() => undefined);
		}
	}

	private async acquireLock(): Promise<() => Promise<void>> {
		const started = Date.now();
		for (;;) {
			try {
				await mkdir(this.lockDir, { mode: DIRECTORY_MODE });
				const owner: LockOwner = {
					pid: this.pid,
					hostname: this.hostname,
					acquiredAt: this.now().toISOString(),
				};
				try {
					await writeFile(join(this.lockDir, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, {
						encoding: "utf8",
						mode: FILE_MODE,
						flag: "wx",
					});
				} catch {
					await rm(this.lockDir, { recursive: true, force: true });
					throw new MemoryStoreError("cannot initialize memory write lock", "io");
				}
				return async () => {
					try {
						await unlink(join(this.lockDir, "owner.json"));
					} catch {
						// The lock directory removal below is authoritative.
					}
					const started = Date.now();
					for (;;) {
						try {
							await rmdir(this.lockDir);
							return;
						} catch (error) {
							if (
								(error as NodeJS.ErrnoException).code !== "ENOTEMPTY" ||
								Date.now() - started >= this.lockTimeoutMs
							) {
								return;
							}
							await new Promise((resolve) => setTimeout(resolve, 10));
						}
					}
				};
			} catch (error) {
				if (error instanceof MemoryStoreError) throw error;
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
					throw new MemoryStoreError("cannot acquire memory write lock", "io");
				}
				if (Date.now() - started >= this.lockTimeoutMs) {
					throw new MemoryStoreError("memory store busy", "busy");
				}
				await new Promise((resolve) => setTimeout(resolve, randomInt(25, 76)));
			}
		}
	}

	private async withLock<T>(operation: () => Promise<T>): Promise<T> {
		await this.assertInitialized();
		const release = await this.acquireLock();
		try {
			return await operation();
		} finally {
			await release();
		}
	}

	private async syncDirectory(path = this.recordsDir): Promise<void> {
		const handle = await open(path, fsConstants.O_RDONLY);
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	private async atomicWrite(record: MemoryRecord, create: boolean): Promise<void> {
		const target = join(this.recordsDir, `${record.id}.json`);
		const temporary = join(
			this.recordsDir,
			`.${record.id}.${randomBytes(8).toString("hex")}.tmp`,
		);
		let renamed = false;
		let handle;
		try {
			handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, FILE_MODE);
			await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
			await handle.sync();
			await handle.close();
			handle = undefined;
			if (create) {
				try {
					await access(target, fsConstants.F_OK);
					throw new MemoryStoreError("memory ID already exists", "invariant");
				} catch (error) {
					if (error instanceof MemoryStoreError) throw error;
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
						throw new MemoryStoreError("cannot verify memory target", "io");
					}
				}
			} else {
				const targetStat = await lstat(target);
				if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
					throw new MemoryStoreError("record target is unsafe", "security");
				}
			}
			await this.hooks.beforeRename?.(target);
			await rename(temporary, target);
			renamed = true;
			try {
				await this.syncDirectory();
			} catch {
				// Rename committed the authoritative complete record.
			}
		} catch (error) {
			if (error instanceof MemoryStoreError) throw error;
			throw new MemoryStoreError("memory record write failed", "io");
		} finally {
			if (handle) await handle.close().catch(() => undefined);
			if (!renamed) await unlink(temporary).catch(() => undefined);
		}
	}

	private validateResultingRecords(records: readonly MemoryRecord[]): void {
		for (const record of records) {
			if (validateMemoryRecord(record).length > 0) {
				throw new MemoryStoreError("memory record validation failed", "invalid");
			}
		}
		if (findSupersessionCycleIds(records).size > 0) {
			throw new MemoryStoreError("supersession cycle rejected", "invariant");
		}
		const superseded = effectiveSupersededIds(records);
		const alwaysCount = records.filter(
			(record) => record.enabled && record.recall === "always" && !superseded.has(record.id),
		).length;
		if (alwaysCount > 3) {
			throw new MemoryStoreError("at most three active always-recalled memories are allowed", "invariant");
		}
	}

	private validateConflictReview(
		record: MemoryRecord,
		snapshot: MemorySnapshot,
		reviewedConflictIds: readonly string[],
	): void {
		const reviewed = new Set(reviewedConflictIds);
		const unreviewed = findConflicts(record, snapshot.records, record.id).filter(
			(conflict) => !record.supersedes.includes(conflict.id) && !reviewed.has(conflict.id),
		);
		if (unreviewed.length > 0) {
			throw new MemoryStoreError("memory conflict review required", "conflict");
		}
	}

	async createRecord(record: MemoryRecord, options: MutationOptions = {}): Promise<CreateResult> {
		return this.withLock(async () => {
			const snapshot = await this.loadSnapshot();
			const duplicate = snapshot.records.find(
				(item) =>
					record.provenance.proposalId !== null &&
					item.provenance.proposalId === record.provenance.proposalId &&
					item.provenance.proposalHash === record.provenance.proposalHash,
			);
			if (duplicate) return { record: duplicate, existing: true };
			if (snapshot.errors.length > 0) {
				throw new MemoryStoreError("memory store is degraded", "degraded");
			}
			if (snapshot.byId.has(record.id)) throw new MemoryStoreError("memory ID already exists", "invariant");
			this.validateConflictReview(record, snapshot, options.reviewedConflictIds ?? []);
			this.validateResultingRecords([...snapshot.records, record] as MemoryRecord[]);
			await this.atomicWrite(record, true);
			return { record: deepFreeze(record), existing: false };
		});
	}

	async updateRecord(
		id: string,
		expectedUpdatedAt: string,
		update: (record: Readonly<MemoryRecord>) => MemoryRecord,
		options: MutationOptions = {},
	): Promise<Readonly<MemoryRecord>> {
		return this.withLock(async () => {
			const snapshot = await this.loadSnapshot();
			if (snapshot.errors.length > 0 && !options.allowDegraded) {
				throw new MemoryStoreError("memory store is degraded", "degraded");
			}
			const current = snapshot.byId.get(id);
			if (!current) throw new MemoryStoreError("memory not found", "not-found");
			if (current.updatedAt !== expectedUpdatedAt) {
				throw new MemoryStoreError("memory changed since preview", "stale");
			}
			const next = update(current);
			if (
				next.id !== current.id ||
				next.createdAt !== current.createdAt ||
				JSON.stringify(next.provenance) !== JSON.stringify(current.provenance)
			) {
				throw new MemoryStoreError("immutable memory fields changed", "invariant");
			}
			const conflictFieldsChanged =
				next.content !== current.content ||
				next.kind !== current.kind ||
				JSON.stringify(next.tags) !== JSON.stringify(current.tags) ||
				JSON.stringify(next.supersedes) !== JSON.stringify(current.supersedes);
			if (conflictFieldsChanged) {
				this.validateConflictReview(next, snapshot, options.reviewedConflictIds ?? []);
			}
			const records = snapshot.records.map((record) => (record.id === id ? next : record)) as MemoryRecord[];
			this.validateResultingRecords(records);
			await this.atomicWrite(next, false);
			return deepFreeze(next);
		});
	}

	private async removeTemporaryCopies(id: string): Promise<void> {
		const prefix = `.${id}.`;
		for (const entry of await readdir(this.recordsDir, { withFileTypes: true })) {
			if (!entry.name.startsWith(prefix) || !TEMP_NAME.test(entry.name)) continue;
			const path = join(this.recordsDir, entry.name);
			const stat = await lstat(path);
			if (stat.isSymbolicLink() || !stat.isFile()) {
				throw new MemoryStoreError("memory temporary copy is unsafe", "security");
			}
			try {
				await unlink(path);
			} catch {
				throw new MemoryStoreError("memory temporary copy deletion failed", "io");
			}
		}
	}

	async forgetRecord(id: string, expectedUpdatedAt: string): Promise<void> {
		await this.withLock(async () => {
			const snapshot = await this.loadSnapshot();
			const current = snapshot.byId.get(id);
			if (!current) throw new MemoryStoreError("memory not found", "not-found");
			if (current.updatedAt !== expectedUpdatedAt) {
				throw new MemoryStoreError("memory changed since preview", "stale");
			}
			for (const targetId of current.supersedes) {
				if (await statOrUndefined(join(this.recordsDir, `${targetId}.json`))) {
					throw new MemoryStoreError("forget older superseded memories first", "invariant");
				}
			}
			await this.removeTemporaryCopies(id);
			try {
				await unlink(join(this.recordsDir, `${id}.json`));
			} catch {
				throw new MemoryStoreError("memory forget failed", "io");
			}
			try {
				await this.syncDirectory();
			} catch {
				// Unlink committed physical deletion.
			}
		});
	}

	private validateCorruptFilename(filename: string): void {
		if (basename(filename) !== filename || filename === "." || filename === "..") {
			throw new MemoryStoreError("invalid corrupt-record filename", "invalid");
		}
	}

	async quarantine(filename: string): Promise<void> {
		this.validateCorruptFilename(filename);
		await this.withLock(async () => {
			const source = join(this.recordsDir, filename);
			const target = join(this.quarantineDir, filename);
			const stat = await statOrUndefined(source);
			if (!stat || stat.isDirectory()) throw new MemoryStoreError("corrupt record not found", "not-found");
			const scanned = await this.scanRecords(false);
			if (!scanned.errors.some((error) => error.filename === filename)) {
				throw new MemoryStoreError("refusing to quarantine a valid record", "invalid");
			}
			if (await statOrUndefined(target)) throw new MemoryStoreError("quarantine target already exists", "invariant");
			try {
				await rename(source, target);
			} catch {
				throw new MemoryStoreError("record quarantine failed", "io");
			}
			try {
				await this.syncDirectory();
				await this.syncDirectory(this.quarantineDir);
			} catch {
				// Rename committed the quarantine move.
			}
		});
	}

	async discardCorrupt(filename: string): Promise<void> {
		this.validateCorruptFilename(filename);
		await this.withLock(async () => {
			const target = join(this.recordsDir, filename);
			const stat = await statOrUndefined(target);
			if (!stat || stat.isDirectory()) throw new MemoryStoreError("corrupt record not found", "not-found");
			if (!stat.isSymbolicLink()) {
				const scanned = await this.scanRecords(false);
				if (!scanned.errors.some((error) => error.filename === filename)) {
					throw new MemoryStoreError("refusing to discard a valid record", "invalid");
				}
			}
			try {
				await unlink(target);
			} catch {
				throw new MemoryStoreError("corrupt record deletion failed", "io");
			}
			try {
				await this.syncDirectory();
			} catch {
				// Unlink committed physical deletion.
			}
		});
	}

	async removeTemporaryFiles(filenames: readonly string[]): Promise<number> {
		return this.withLock(async () => {
			let removed = 0;
			for (const filename of filenames) {
				if (!TEMP_NAME.test(filename)) continue;
				const target = join(this.recordsDir, filename);
				const stat = await statOrUndefined(target);
				if (!stat || stat.isSymbolicLink() || !stat.isFile()) continue;
				await unlink(target);
				removed++;
			}
			if (removed > 0) await this.syncDirectory().catch(() => undefined);
			return removed;
		});
	}

	async doctor(options: { removeStaleLock?: boolean } = {}): Promise<DoctorReport> {
		const issues: DoctorIssue[] = [];
		let staleLock = false;
		let staleLockRemoved = false;
		let recordCount = 0;
		let invalidFiles: string[] = [];
		let temporaryFiles: string[] = [];

		for (const [path, label] of [
			[this.root, "memory"],
			[this.recordsDir, "records"],
			[this.quarantineDir, "quarantine"],
		] as const) {
			const stat = await statOrUndefined(path);
			if (!stat) {
				issues.push({ path: label, reason: "missing" });
				continue;
			}
			if (stat.isSymbolicLink()) issues.push({ path: label, reason: "symlink rejected" });
			else if (!stat.isDirectory()) issues.push({ path: label, reason: "not a directory" });
			else if (!hasPrivateMode(stat.mode)) issues.push({ path: label, reason: "permissions are too broad" });
		}

		const recordsStat = await statOrUndefined(this.recordsDir);
		if (recordsStat?.isDirectory() && !recordsStat.isSymbolicLink()) {
			try {
				const scanned = await this.scanRecords(false);
				recordCount = scanned.recordFileCount;
				invalidFiles = [...new Set(scanned.errors.map((error) => error.filename))].sort(compareIds);
				temporaryFiles = scanned.temporaryFiles;
				for (const error of scanned.errors) issues.push({ path: error.filename, reason: error.reason });
			} catch {
				issues.push({ path: "records", reason: "scan failed" });
			}
		}

		const lock = await statOrUndefined(this.lockDir);
		if (lock) {
			if (lock.isSymbolicLink() || !lock.isDirectory()) {
				issues.push({ path: ".write-lock", reason: "unsafe lock path" });
			} else {
				if (!hasPrivateMode(lock.mode)) {
					issues.push({ path: ".write-lock", reason: "permissions are too broad" });
				}
				const ownerStat = await statOrUndefined(join(this.lockDir, "owner.json"));
				if (!ownerStat) issues.push({ path: ".write-lock/owner.json", reason: "missing" });
				else if (ownerStat.isSymbolicLink() || !ownerStat.isFile()) {
					issues.push({ path: ".write-lock/owner.json", reason: "unsafe owner file" });
				} else if (!hasPrivateMode(ownerStat.mode)) {
					issues.push({ path: ".write-lock/owner.json", reason: "permissions are too broad" });
				} else if (!(await this.readLockOwner())) {
					issues.push({ path: ".write-lock/owner.json", reason: "invalid owner metadata" });
				}
				const identity = await this.readLockIdentity();
				staleLock = Boolean(identity && this.lockIdentityIsDemonstrablyStale(identity));
				if (staleLock && identity) {
					issues.push({ path: ".write-lock", reason: "same-host owner PID is not alive" });
					if (options.removeStaleLock) {
						try {
							staleLockRemoved = await this.reclaimStaleLock(identity);
						} catch {
							issues.push({ path: ".write-lock", reason: "stale lock removal failed" });
						}
					}
				}
			}
		}
		if (recordCount > 10_000) issues.push({ path: "records", reason: "corpus exceeds 10,000 records" });
		return {
			issues,
			invalidFiles,
			temporaryFiles,
			recordCount,
			staleLock,
			staleLockRemoved,
			corpusWarning: recordCount > 10_000,
		};
	}

}
