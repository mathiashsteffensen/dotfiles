import assert from "node:assert/strict";
import { test } from "node:test";
import usageDisplay from "../config/omp/agent/extensions/usage-display/index.ts";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext, OAuthAccountIdentity } from "@oh-my-pi/pi-coding-agent";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;
function report(accountId: string, used: number | undefined, days = 7): UsageReport {
	return {
		provider: "openai-codex",
		fetchedAt: Date.now(),
		metadata: { accountId },
		limits: [{
			id: "openai-codex:secondary",
			scope: { provider: "openai-codex" },
			label: "Weekly",
			window: { id: "7d", label: "Weekly", durationMs: days * 86_400_000 },
			amount: { unit: "percent", used },
		}],
	};
}

function harness() {
	const handlers = new Map<string, Handler>();
	let tick: (() => Promise<void>) | undefined;
	let status: string | undefined;
	let provider = "openai-codex";
	let identity: OAuthAccountIdentity | undefined = { accountId: "active" };
	let reports: () => Promise<UsageReport[]> = async () => [report("active", 25)];
	const ctx = {
		mode: "tui",
		models: { current: () => ({ provider, id: "model" }) },
		sessionManager: { getSessionId: () => "session" },
		modelRegistry: {
			getProviderBaseUrl: () => undefined,
			authStorage: { oauth: { identity: () => identity }, usage: { reports: () => reports() } },
		},
		ui: {
			setStatus: (_key: string, value: string | undefined) => { status = value; },
			theme: { fg: (_color: string, value: string) => value },
		},
		setInterval: (callback: () => Promise<void>) => { tick = callback; return 1; },
		clearTimer: () => { tick = undefined; },
	} as unknown as ExtensionContext;
	usageDisplay({ on: (event: string, handler: Handler) => {
		handlers.set(event, handler);
	} } as unknown as ExtensionAPI);
	return {
		ctx,
		get status() { return status; },
		get ticking() { return tick !== undefined; },
		setProvider(value: string) { provider = value; },
		setIdentity(value: OAuthAccountIdentity | undefined) { identity = value; },
		setReports(value: () => Promise<UsageReport[]>) { reports = value; },
		async tick() { await tick?.(); },
		async emit(name: string) { await handlers.get(name)?.({}, ctx); },
	};
}

test("shows the selected account's weekly subscription, not sibling or additional quotas", async () => {
	const h = harness();
	const active = report("active", 42.5);
	const spark = report("active", 99).limits[0];
	spark.id = "openai-codex:spark:secondary";
	active.limits.unshift(spark, report("active", 88, 5 / 24).limits[0]);
	h.setReports(async () => [report("sibling", 97), active]);
	await h.emit("session_start");
	assert.equal(h.status, "Codex Weekly Usage: 42.5% used - resets unknown");
});

test("missing, malformed, short-window and ambiguous data never become zero usage", async () => {
	const h = harness();
	for (const reports of [[], [report("active", undefined)], [report("active", NaN)],
		[report("active", 20, 5 / 24)], [report("other", 50)], [report("active", 1), report("active", 2)]]) {
		h.setReports(async () => reports);
		await h.emit("agent_end");
		assert.equal(h.status, "Codex Weekly Usage: unavailable");
	}
	h.setReports(async () => [report("active", 0)]);
	await h.emit("agent_end");
	assert.equal(h.status, "Codex Weekly Usage: 0% used - resets unknown");
	h.setReports(async () => { throw new Error("offline"); });
	await h.emit("agent_end");
	assert.equal(h.status, "Codex Weekly Usage: unavailable");
	h.setIdentity(undefined);
	await h.emit("agent_end");
	assert.equal(h.status, "Codex Weekly Usage: unavailable");
});

test("reset timestamps use milliseconds and preserve a real zero percent", async () => {
	const h = harness();
	const data = report("active", 0);
	const resetAt = Date.UTC(2026, 9, 2, 12, 30);
	data.limits[0].window!.resetsAt = resetAt;
	h.setReports(async () => [data]);
	await h.emit("session_start");
	const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(resetAt));
	assert.equal(h.status, `Codex Weekly Usage: 0% used - resets ${date}`);
});

test("model/account switches and shutdown reject in-flight stale quota results", async () => {
	const h = harness();
	const first = Promise.withResolvers<UsageReport[]>();
	h.setReports(() => first.promise);
	const started = h.emit("session_start");
	h.setProvider("openrouter");
	await h.tick();
	first.resolve([report("active", 90)]);
	await started;
	assert.equal(h.status, undefined);

	h.setReports(async () => [report("next", 12)]);
	h.setIdentity({ accountId: "next" });
	h.setProvider("openai-codex");
	await h.tick();
	assert.equal(h.status, "Codex Weekly Usage: 12% used - resets unknown");

	const second = Promise.withResolvers<UsageReport[]>();
	h.setReports(() => second.promise);
	const refreshing = h.emit("agent_end");
	await h.emit("session_shutdown");
	second.resolve([report("next", 80)]);
	await refreshing;
	assert.equal(h.status, undefined);
	assert.equal(h.ticking, false);
});

test("headless sessions neither fetch quotas nor start background polling", async () => {
	const h = harness();
	h.ctx.mode = "print";
	let fetched = false;
	h.setReports(async () => { fetched = true; return [report("active", 50)]; });
	await h.emit("session_start");
	await h.emit("agent_end");
	assert.equal(fetched, false);
	assert.equal(h.ticking, false);
	assert.equal(h.status, undefined);
});
