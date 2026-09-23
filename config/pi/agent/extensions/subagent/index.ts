import { fileURLToPath } from "node:url";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Dashboard, runningRoleLabel } from "./dashboard.ts";
import { roles, validateAssignments } from "./roles.ts";
import { RunManager, type Group, type Run } from "./runner.ts";

const autoApprovePath = fileURLToPath(new URL("../auto-approve/index.ts", import.meta.url));
const { timeoutMs } = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8")) as { timeoutMs: number };
if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error("Invalid subagent timeoutMs");
const AssignmentSchema = Type.Object({
	agent: Type.String(),
	task: Type.String({ maxLength: 12_000 }),
	editBoundary: Type.Optional(Type.String({ maxLength: 1_000 })),
});
const Params = Type.Object({
	action: Type.Union([Type.Literal("run"), Type.Literal("status"), Type.Literal("stop")]),
	agent: Type.Optional(Type.String()),
	task: Type.Optional(Type.String()),
	editBoundary: Type.Optional(Type.String()),
	tasks: Type.Optional(Type.Array(AssignmentSchema, { minItems: 1, maxItems: 3 })),
	background: Type.Optional(Type.Boolean()),
	id: Type.Optional(Type.String()),
});

function brief(run: Run, full = false) {
	return {
		id: run.id, agent: run.agent, task: run.task.slice(0, 160), state: run.state,
		activity: run.activity, elapsedSeconds: Math.floor(((run.endedAt ?? Date.now()) - run.startedAt) / 1000),
		output: run.state === "running" ? undefined : full ? run.output : run.output.slice(-300),
		error: run.error?.slice(-500), usage: run.usage,
	};
}

export default function (pi: ExtensionAPI) {
	let sessionId: string | undefined;
	let uiCtx: ExtensionContext | undefined;
	let dashboard: Dashboard | undefined;
	let dashboardRender: (() => void) | undefined;
	let updateTimer: ReturnType<typeof setTimeout> | undefined;
	let shuttingDown = false;

	const update = () => {
		if (updateTimer) return;
		updateTimer = setTimeout(() => {
			updateTimer = undefined;
			if (uiCtx?.mode === "tui" && sessionId) {
				const label = runningRoleLabel(manager.list(sessionId));
				uiCtx.ui.setStatus("local-subagents", label ? uiCtx.ui.theme.fg("accent", `· ${label}`) : undefined);
				dashboardRender?.();
			}
		}, 80);
	};
	const completed = (group: Group) => {
		if (!group.background || shuttingDown || group.sessionId !== sessionId) return;
		const results = group.runs.map((run) => brief(run, true));
		pi.sendMessage({
			customType: "local-subagents-complete",
			content: `Subagent group ${group.id} finished:\n${JSON.stringify(results)}`,
			display: true,
		}, { triggerTurn: true, deliverAs: "followUp" });
	};
	const manager = new RunManager(autoApprovePath, update, completed, "pi", [], timeoutMs);

	const show = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") { ctx.ui.notify("The dashboard requires the Pi terminal UI; use subagent status instead.", "info"); return; }
		if (dashboard) return;
		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			dashboard = new Dashboard(manager, ctx.sessionManager.getSessionId(), tui, theme, () => done());
			dashboardRender = () => tui.requestRender();
			return dashboard;
		});
		dashboard = undefined;
		dashboardRender = undefined;
	};

	pi.registerTool({
		name: "subagent",
		label: "Subagents",
		description: "Run 1–3 fresh-context local Pi agents (scout, reviewer, oracle, worker). Use tasks for parallel jobs or agent/task for one. Worker needs editBoundary; only one writer per cwd. background returns immediately; status and stop take an optional/exact run id. No nested agents or scripted workflows.",
		parameters: Params,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const currentSession = ctx.sessionManager.getSessionId();
			if (params.action === "status") {
				const runs = params.id ? [manager.find(params.id, currentSession)].filter((run): run is Run => !!run) : manager.list(currentSession);
				const view = runs.map((run) => brief(run, !!params.id));
				return { content: [{ type: "text", text: JSON.stringify(view) }], details: { runs: view } };
			}
			if (params.action === "stop") {
				if (!params.id) throw new Error("stop requires a run id");
				const stopped = manager.stop(params.id, currentSession);
				return { content: [{ type: "text", text: stopped ? `Stopping ${params.id}` : "Run not active or not found" }], details: { stopped } };
			}
			if (shuttingDown || (sessionId && sessionId !== currentSession)) throw new Error("Session is changing; no new subagents can start");
			if (params.background && ctx.mode !== "tui") throw new Error("Background runs require an interactive Pi session");
			const assignments = validateAssignments(params);
			const cwd = realpathSync(resolve(ctx.cwd));
			for (const assignment of assignments) {
				const role = roles[assignment.agent];
				if (!ctx.modelRegistry.find("openai-codex", role.model)) throw new Error(`Model unavailable for ${assignment.agent}: openai-codex/${role.model}`);
			}
			const { group, done } = manager.start(currentSession, cwd, assignments, params.background ?? false);
			if (params.background) return { content: [{ type: "text", text: `Started group ${group.id}: ${group.runs.map((run) => `${run.agent} ${run.id}`).join(", ")}. Use /subagents or subagent status.` }], details: { groupId: group.id, runs: group.runs.map((run) => brief(run)) } };
			const abort = () => { for (const run of group.runs) manager.stop(run.id, currentSession); };
			signal?.addEventListener("abort", abort, { once: true });
			try { await done; } finally { signal?.removeEventListener("abort", abort); }
			const results = group.runs.map((run) => brief(run, true));
			return { content: [{ type: "text", text: JSON.stringify(results) }], details: { groupId: group.id, runs: results } };
		},
	});

	pi.registerCommand("subagents", { description: "Open the live split-pane subagent dashboard", handler: async (_args, ctx) => show(ctx) });
	pi.registerShortcut(Key.ctrlAlt("f"), { description: "Open subagent dashboard", handler: show });
	pi.on("session_start", (_event, ctx) => { shuttingDown = false; sessionId = ctx.sessionManager.getSessionId(); uiCtx = ctx; update(); });
	pi.on("session_before_switch", () => { shuttingDown = true; manager.stopAll(); });
	pi.on("session_shutdown", (_event, ctx) => {
		shuttingDown = true;
		manager.stopAll();
		if (updateTimer) clearTimeout(updateTimer);
		updateTimer = undefined;
		ctx.ui.setStatus("local-subagents", undefined);
		uiCtx = undefined;
		sessionId = undefined;
	});
}
