import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";

interface RegisteredTool {
	name: string;
	execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
}

test("UI capture reuses saved authentication by origin", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-ui-auth-test-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const { authStatePath, default: uiReview } = await import("./index.ts");
	const tools = new Map<string, RegisteredTool>();
	uiReview({
		registerCommand() {},
		registerTool(tool: { name: string }) {
			tools.set(tool.name, tool as RegisteredTool);
		},
	} as unknown as Parameters<typeof uiReview>[0]);

	const server = createServer((request, response) => {
		response.setHeader("content-type", "text/html");
		if (request.url === "/login") {
			response.setHeader("set-cookie", "session=valid; Path=/; HttpOnly; SameSite=Lax");
			response.end("<!doctype html><title>Logged in</title>");
			return;
		}
		const authenticated = request.headers.cookie?.includes("session=valid") === true;
		response.end(`<!doctype html><title>${authenticated ? "Private" : "Login required"}</title>`);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

	try {
		const address = server.address();
		assert(address && typeof address === "object");
		const origin = `http://127.0.0.1:${address.port}`;
		const statePath = authStatePath(origin, agentDir);
		await mkdir(dirname(statePath), { recursive: true });
		const browser = await chromium.launch({ headless: true });
		try {
			const context = await browser.newContext();
			const page = await context.newPage();
			await page.goto(`${origin}/login`);
			await context.storageState({ path: statePath });
		} finally {
			await browser.close();
		}

		const capture = tools.get("ui_capture");
		assert(capture);
		const authenticated = await capture.execute("auth", { url: `${origin}/private` }) as {
			details: { title: string; authenticated: boolean };
		};
		assert.equal(authenticated.details.title, "Private");
		assert.equal(authenticated.details.authenticated, true);

		const anonymous = await capture.execute("anonymous", { url: `${origin}/private`, useAuth: false }) as {
			details: { title: string; authenticated: boolean };
		};
		assert.equal(anonymous.details.title, "Login required");
		assert.equal(anonymous.details.authenticated, false);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
});
