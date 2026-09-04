import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { chromium, type Page } from "playwright-core";
import { getAgentDir, truncateHead, truncateLine, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const viewportProperties = {
	width: Type.Optional(Type.Integer({ minimum: 320, maximum: 3840, description: "Viewport width (default: 1440)" })),
	height: Type.Optional(Type.Integer({ minimum: 200, maximum: 2160, description: "Viewport height (default: 900)" })),
};

const CaptureParameters = Type.Object({
	url: Type.String({ description: "HTTP(S) page URL to capture" }),
	...viewportProperties,
	fullPage: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page (default: false)" })),
	useAuth: Type.Optional(Type.Boolean({ description: "Apply saved authentication for this origin (default: true)" })),
});

const AuditParameters = Type.Object({
	url: Type.String({ description: "HTTP(S) page URL to audit" }),
	...viewportProperties,
	useAuth: Type.Optional(Type.Boolean({ description: "Apply saved authentication for this origin (default: true)" })),
});

interface AxeViolation {
	id: string;
	impact?: string | null;
	help: string;
	helpUrl: string;
	nodes: Array<{ target: unknown[]; failureSummary?: string }>;
}

export function normalizeUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`Invalid URL: ${value}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("URL must use http or https");
	}
	return url.href;
}

export function authStatePath(value: string, agentDir = getAgentDir()): string {
	const origin = new URL(normalizeUrl(value)).origin;
	const id = createHash("sha256").update(origin).digest("hex");
	return join(agentDir, "ui-auth", `${id}.json`);
}

async function storedAuthState(value: string): Promise<string | undefined> {
	const path = authStatePath(value);
	try {
		await access(path);
		return path;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function clean(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

export function formatViolations(violations: readonly AxeViolation[]): string {
	if (violations.length === 0) {
		return "No automated accessibility violations found. Manual keyboard and screen-reader testing is still required.";
	}

	const shown = violations.slice(0, 20);
	const sections = shown.map((violation) => {
		const nodes = violation.nodes.slice(0, 5).map((node) => {
			const selector = node.target.map(String).join(" ");
			const summary = node.failureSummary ? ` — ${clean(node.failureSummary)}` : "";
			return `  - ${truncateLine(selector + summary, 400).text}`;
		});
		if (violation.nodes.length > nodes.length) nodes.push(`  - … ${violation.nodes.length - nodes.length} more node(s)`);
		const heading = truncateLine(`[${violation.impact ?? "unknown"}] ${violation.id}: ${violation.help}`, 400).text;
		return `${heading}\n${truncateLine(violation.helpUrl, 400).text}\n${nodes.join("\n")}`;
	});
	if (violations.length > shown.length) sections.push(`… ${violations.length - shown.length} more violation type(s)`);
	return sections.join("\n\n");
}

async function withPage<T>(
	url: string,
	width: number,
	height: number,
	useAuth: boolean,
	signal: AbortSignal | undefined,
	work: (page: Page) => Promise<T>,
): Promise<{ value: T; authenticated: boolean }> {
	if (signal?.aborted) throw new Error("Operation aborted");
	const storageState = useAuth ? await storedAuthState(url) : undefined;
	const browser = await chromium.launch({ headless: true });
	const abort = () => void browser.close();
	signal?.addEventListener("abort", abort, { once: true });
	try {
		const context = await browser.newContext({
			viewport: { width, height },
			...(storageState ? { storageState } : {}),
		});
		const page = await context.newPage();
		await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
		await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
		if (signal?.aborted) throw new Error("Operation aborted");
		return { value: await work(page), authenticated: storageState !== undefined };
	} catch (error) {
		if (signal?.aborted) throw new Error("Operation aborted");
		throw error;
	} finally {
		signal?.removeEventListener("abort", abort);
		await browser.close().catch(() => undefined);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "UI authentication failed";
}

export default function uiReview(pi: ExtensionAPI): void {
	pi.registerCommand("ui-login", {
		description: "Log in manually and save private browser state for an origin",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			if (!args.trim()) {
				ctx.ui.notify("Usage: /ui-login <URL>", "error");
				return;
			}
			try {
				const url = normalizeUrl(args.trim());
				const path = authStatePath(url);
				await mkdir(dirname(path), { recursive: true, mode: 0o700 });
				await chmod(dirname(path), 0o700);
				const existingState = await storedAuthState(url);
				const browser = await chromium.launch({ headless: false });
				try {
					const context = await browser.newContext(existingState ? { storageState: existingState } : {});
					const page = await context.newPage();
					await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
					const save = await ctx.ui.confirm(
						"Complete login in Chromium",
						`Log in fully, return here, then confirm to save sensitive cookies and browser storage to:\n${path}`,
					);
					if (!save) {
						ctx.ui.notify("Login state was not saved", "info");
						return;
					}
					await context.storageState({ path, indexedDB: true });
					await chmod(path, 0o600);
					ctx.ui.notify(`Saved UI authentication for ${new URL(url).origin}`, "info");
				} finally {
					await browser.close();
				}
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});

	pi.registerCommand("ui-logout", {
		description: "Delete saved browser state for an origin",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			if (!args.trim()) {
				ctx.ui.notify("Usage: /ui-logout <URL>", "error");
				return;
			}
			try {
				const url = normalizeUrl(args.trim());
				const path = await storedAuthState(url);
				if (!path) {
					ctx.ui.notify(`No saved UI authentication for ${new URL(url).origin}`, "info");
					return;
				}
				if (await ctx.ui.confirm("Delete saved UI authentication?", `${new URL(url).origin}\n${path}`)) {
					await unlink(path);
					ctx.ui.notify("Saved UI authentication deleted", "info");
				}
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});

	pi.registerCommand("ux-review", {
		description: "Review a web UI from screenshots and an automated accessibility audit",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			pi.sendUserMessage(`Run a UX review. Do not edit code unless I explicitly ask afterward.

User-supplied target and context: ${args.trim() || "not supplied"}

If the target URL, intended audience, primary task, or success criterion cannot be inferred, use ask_user_question for only the minimum missing information. Then call ui_capture and ui_audit on the target. Saved login state is applied automatically; if the page still redirects to login, tell me to run /ui-login <URL>. Evaluate task clarity, information hierarchy, navigation, interaction feedback, copy, responsive risks, and accessibility. Report a ranked list of concrete findings with screenshot or audit evidence, followed by the three highest-value changes. Clearly separate automated accessibility findings from manual checks still needed.`);
		},
	});

	pi.registerTool({
		name: "ui_capture",
		label: "UI Capture",
		description: "Capture a rendered HTTP(S) page as a PNG at a specified viewport. Applies saved authentication for the origin by default. Returns the image and saved temporary path.",
		promptSnippet: "Capture a rendered web page screenshot for visual UI review",
		parameters: CaptureParameters,
		async execute(_toolCallId, params, signal) {
			const url = normalizeUrl(params.url);
			const width = params.width ?? 1440;
			const height = params.height ?? 900;
			const directory = await mkdtemp(join(tmpdir(), "pi-ui-capture-"));
			const path = join(directory, "screenshot.png");
			const { value: pageDetails, authenticated } = await withPage(
				url,
				width,
				height,
				params.useAuth ?? true,
				signal,
				async (page) => {
					await page.screenshot({ path, fullPage: params.fullPage ?? false });
					return { title: await page.title(), finalUrl: page.url() };
				},
			);
			const data = await readFile(path, "base64");
			return {
				content: [
					{ type: "text", text: `Captured ${pageDetails.finalUrl} at ${width}×${height}. Authentication state applied: ${authenticated ? "yes" : "no"}. PNG: ${path}` },
					{ type: "image", data, mimeType: "image/png" },
				],
				details: { ...pageDetails, path, width, height, fullPage: params.fullPage ?? false, authenticated },
			};
		},
	});

	pi.registerTool({
		name: "ui_audit",
		label: "UI Audit",
		description: "Run axe-core automated accessibility checks against a rendered HTTP(S) page. Applies saved authentication for the origin by default. Reports up to 20 violation types and 5 affected nodes per type; manual testing is still required.",
		promptSnippet: "Run an automated axe accessibility audit on a web page",
		parameters: AuditParameters,
		async execute(_toolCallId, params, signal) {
			const url = normalizeUrl(params.url);
			const width = params.width ?? 1440;
			const height = params.height ?? 900;
			const { value: results, authenticated } = await withPage(
				url,
				width,
				height,
				params.useAuth ?? true,
				signal,
				(page) => new AxeBuilder({ page }).analyze(),
			);
			const affectedNodes = results.violations.reduce((count, violation) => count + violation.nodes.length, 0);
			const fullText = `Automated accessibility audit: ${results.violations.length} violation type(s), ${affectedNodes} affected node(s), ${results.incomplete.length} incomplete check(s). Authentication state applied: ${authenticated ? "yes" : "no"}.\n\n${formatViolations(results.violations)}`;
			const output = truncateHead(fullText);
			let fullOutputPath: string | undefined;
			if (output.truncated) {
				const directory = await mkdtemp(join(tmpdir(), "pi-ui-audit-"));
				fullOutputPath = join(directory, "audit.txt");
				await writeFile(fullOutputPath, fullText);
			}
			return {
				content: [{
					type: "text",
					text: output.content + (fullOutputPath ? `\n\n[Output truncated. Full audit: ${fullOutputPath}]` : ""),
				}],
				details: {
					url: results.url,
					violations: results.violations.length,
					affectedNodes,
					incomplete: results.incomplete.length,
					passes: results.passes.length,
					authenticated,
					...(fullOutputPath ? { fullOutputPath } : {}),
				},
			};
		},
	});
}
