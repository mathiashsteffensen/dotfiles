import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "openai-codex";
const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const REFRESH_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

type JsonRecord = Record<string, unknown>;

const asRecord = (value: unknown): JsonRecord | undefined =>
	value !== null && typeof value === "object" ? (value as JsonRecord) : undefined;

const getAccountId = (accessToken: string): string | undefined => {
	try {
		const payload = accessToken.split(".")[1];
		if (!payload) return undefined;

		const claims = asRecord(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
		const auth = asRecord(claims?.["https://api.openai.com/auth"]);
		const accountId = auth?.chatgpt_account_id;
		return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
	} catch {
		return undefined;
	}
};

const getWeeklyWindow = (payload: unknown): JsonRecord | undefined => {
	const root = asRecord(payload);
	const rateLimit = asRecord(root?.rate_limit ?? root?.rateLimit);
	if (!rateLimit) return undefined;

	const windows = [
		asRecord(rateLimit.primary_window ?? rateLimit.primaryWindow),
		asRecord(rateLimit.secondary_window ?? rateLimit.secondaryWindow),
	].filter((window): window is JsonRecord => window !== undefined);

	return windows.find((window) => {
		const rawDuration = window.limit_window_seconds;
		if (typeof rawDuration !== "number" && typeof rawDuration !== "string") return false;
		if (typeof rawDuration === "string" && rawDuration.trim() === "") return false;

		const duration = Number(rawDuration);
		return Number.isFinite(duration) &&
			duration >= WEEK_SECONDS - 24 * 60 * 60 &&
			duration <= WEEK_SECONDS + 24 * 60 * 60;
	});
};

export const getWeeklyUsagePercent = (payload: unknown): number | undefined => {
	const weeklyWindow = getWeeklyWindow(payload);
	if (!weeklyWindow) return undefined;

	const rawPercent = weeklyWindow.used_percent;
	if (typeof rawPercent !== "number" && typeof rawPercent !== "string") return undefined;
	if (typeof rawPercent === "string" && rawPercent.trim() === "") return undefined;

	const percent = Number(rawPercent);
	return Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : undefined;
};

export const getWeeklyUsageResetAt = (payload: unknown): number | undefined => {
	const weeklyWindow = getWeeklyWindow(payload);
	if (!weeklyWindow) return undefined;

	const rawResetAt = weeklyWindow.reset_at ?? weeklyWindow.resetAt;
	if (typeof rawResetAt !== "number" && typeof rawResetAt !== "string") return undefined;
	if (typeof rawResetAt === "string" && rawResetAt.trim() === "") return undefined;

	const resetAt = Number(rawResetAt);
	return Number.isFinite(resetAt) && resetAt > 0 ? resetAt : undefined;
};

export const formatResetDate = (resetAt: number): string => {
	const date = new Date(resetAt * 1000);
	return Number.isNaN(date.getTime())
		? "unknown"
		: new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
};

const getUsage = async (
	accessToken: string,
	accountId: string,
	baseUrl: string,
	signal: AbortSignal,
): Promise<unknown> => {
	const urls = [
		`${baseUrl.replace(/\/$/, "")}/wham/usage`,
		"https://chatgpt.com/backend-api/codex/usage",
	];
	let lastError: Error | undefined;

	for (const url of urls) {
		try {
			const response = await fetch(url, {
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"ChatGPT-Account-Id": accountId,
					"User-Agent": "codex-cli",
					"Cache-Control": "no-cache",
				},
				signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
			});

			if (response.ok) return await response.json();
			lastError = new Error(`Usage request failed with HTTP ${response.status}`);
			if (response.status !== 404) break;
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
		}
	}

	throw lastError ?? new Error("Usage request failed");
};

export default function (pi: ExtensionAPI) {
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let sessionGeneration = 0;
	let activeRefreshController: AbortController | undefined;

	const setStatus = (ctx: ExtensionContext, text: string, color: "dim" | "success" | "warning" | "error" = "dim") => {
		ctx.ui.setStatus("codex-usage", ctx.ui.theme.fg(color, text));
	};

	const refresh = async (ctx: ExtensionContext) => {
		if (activeRefreshController || ctx.mode !== "tui") return;

		const generation = sessionGeneration;
		const controller = new AbortController();
		activeRefreshController = controller;
		const isActive = () => generation === sessionGeneration && !controller.signal.aborted;

		try {
			const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
			const accessToken = auth?.auth.apiKey;
			if (!accessToken) {
				if (isActive()) ctx.ui.setStatus("codex-usage", undefined);
				return;
			}

			const accountId = getAccountId(accessToken);
			if (!accountId) throw new Error("OpenAI Codex account ID is unavailable");

			const payload = await getUsage(accessToken, accountId, DEFAULT_BASE_URL, controller.signal);
			if (!isActive()) return;

			const percent = getWeeklyUsagePercent(payload);
			if (percent === undefined) throw new Error("Weekly usage is unavailable");

			const resetAt = getWeeklyUsageResetAt(payload);
			const resetDate = resetAt === undefined ? "unknown" : formatResetDate(resetAt);
			const color = percent >= 90 ? "error" : percent >= 75 ? "warning" : "success";
			setStatus(
				ctx,
				`Codex Weekly Usage: ${percent % 1 === 0 ? percent : percent.toFixed(1)}% used - resets ${resetDate}`,
				color,
			);
		} catch {
			if (isActive()) setStatus(ctx, "Codex Weekly Usage: unavailable");
		} finally {
			if (activeRefreshController === controller) activeRefreshController = undefined;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		sessionGeneration++;
		activeRefreshController?.abort();
		activeRefreshController = undefined;
		if (refreshTimer) clearInterval(refreshTimer);
		setStatus(ctx, "Codex Weekly Usage: loading...");
		void refresh(ctx);
		refreshTimer = setInterval(() => void refresh(ctx), REFRESH_INTERVAL_MS);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		void refresh(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		sessionGeneration++;
		activeRefreshController?.abort();
		activeRefreshController = undefined;
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = undefined;
		ctx.ui.setStatus("codex-usage", undefined);
	});
}
