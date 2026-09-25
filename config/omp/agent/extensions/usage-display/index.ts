import type { UsageReport } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext, OAuthAccountIdentity } from "@oh-my-pi/pi-coding-agent";

const PROVIDER = "openai-codex";
const REFRESH_INTERVAL_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const STATUS_KEY = "usage-display";

function accountReport(reports: UsageReport[], identity: OAuthAccountIdentity | undefined): UsageReport | undefined {
	if (!identity) return undefined;
	const matches = reports.filter((report) => {
		if (report.provider !== PROVIDER) return false;
		const metadata = report.metadata;
		if (identity.accountId) return metadata?.accountId === identity.accountId;
		return Boolean(identity.email) && metadata?.email === identity.email && metadata?.orgId === identity.orgId;
	});
	// Never guess which subscription to display when identity is ambiguous.
	return matches.length === 1 ? matches[0] : undefined;
}

function weeklyStatus(report: UsageReport | undefined): string {
	const weekly = report?.limits.find((limit) => {
		// Exclude additional meters (Spark, reserve, etc.) and the five-hour quota.
		if (limit.id !== "openai-codex:primary" && limit.id !== "openai-codex:secondary") return false;
		const duration = limit.window?.durationMs;
		return duration !== undefined && duration >= 6 * DAY_MS && duration <= 8 * DAY_MS;
	});
	const percent = weekly?.amount.used;
	if (weekly?.amount.unit !== "percent" || percent === undefined || !Number.isFinite(percent)) {
		return "Codex Weekly Usage: unavailable";
	}
	const used = Math.max(0, Math.min(100, percent));
	const resetAt = weekly.window?.resetsAt;
	const reset = resetAt === undefined ? undefined : new Date(resetAt);
	const resetDate = reset && Number.isFinite(reset.getTime())
		? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(reset)
		: "unknown";
	return `Codex Weekly Usage: ${Number.isInteger(used) ? used : used.toFixed(1)}% used - resets ${resetDate}`;
}

export default function usageDisplay(omp: ExtensionAPI): void {
	let timer: Timer | undefined;
	let controller: AbortController | undefined;
	let activeKey = "";
	let refreshedAt = 0;

	const selection = (ctx: ExtensionContext) => {
		const model = ctx.models.current();
		const sessionId = ctx.sessionManager.getSessionId();
		const identity = ctx.modelRegistry.authStorage.oauth.identity(PROVIDER, sessionId);
		return { model, identity, key: JSON.stringify([sessionId, model?.provider, model?.id, identity]) };
	};

	const refresh = async (ctx: ExtensionContext, force = false) => {
		if (ctx.mode !== "tui") return;
		const { model, identity, key } = selection(ctx);
		if (key !== activeKey) {
			controller?.abort();
			controller = undefined;
			activeKey = key;
			refreshedAt = 0;
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
		if (model?.provider !== PROVIDER || controller) return;
		if (!force && Date.now() - refreshedAt < REFRESH_INTERVAL_MS) return;

		refreshedAt = Date.now();
		const pending = new AbortController();
		controller = pending;
		const isCurrent = () => !pending.signal.aborted && selection(ctx).key === key;
		const setStatus = (text: string) => ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", text));
		try {
			if (!identity) {
				setStatus("Codex Weekly Usage: unavailable");
				return;
			}
			// Reuse omp's OAuth refresh, account-aware usage cache and broker support.
			const reports = await ctx.modelRegistry.authStorage.usage.reports({
				baseUrlResolver: (provider) => ctx.modelRegistry.getProviderBaseUrl(provider),
				signal: AbortSignal.any([pending.signal, AbortSignal.timeout(10_000)]),
			});
			if (isCurrent()) setStatus(weeklyStatus(accountReport(reports ?? [], identity)));
		} catch {
			if (isCurrent()) setStatus("Codex Weekly Usage: unavailable");
		} finally {
			if (controller === pending) controller = undefined;
		}
	};

	const stop = (ctx: ExtensionContext) => {
		controller?.abort();
		controller = undefined;
		if (timer) ctx.clearTimer(timer);
		timer = undefined;
		activeKey = "";
		refreshedAt = 0;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	};

	const start = async (ctx: ExtensionContext) => {
		stop(ctx);
		if (ctx.mode !== "tui") return;
		// omp has no model_select extension event. Check the live model/account
		// each second, but request usage only on changes or once per minute.
		timer = ctx.setInterval(() => refresh(ctx), 1_000);
		await refresh(ctx);
	};

	omp.on("session_start", (_event, ctx) => start(ctx));
	omp.on("session_switch", (_event, ctx) => start(ctx));
	omp.on("agent_end", (_event, ctx) => refresh(ctx, true));
	omp.on("session_shutdown", (_event, ctx) => stop(ctx));
}
