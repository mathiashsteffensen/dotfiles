import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Dashboard, runningRoleLabel } from "./dashboard.ts";
import type { Run } from "./runner.ts";

const runs: Run[] = ["scout", "reviewer", "oracle"].map((agent, index) => ({
	id: `r${index}`, groupId: "g", sessionId: "mine", agent: agent as Run["agent"], task: `Task ${index}`,
	cwd: "/tmp", state: "running", startedAt: Date.now(), activity: "Reading", live: `Live output ${index}`, output: "",
}));
const fakeTui = { terminal: { rows: 28 }, requestRender() {} };
const theme = { fg: (_color: string, text: string) => text };

function dashboard(onClose = () => {}) {
	return new Dashboard({ list: (id: string) => id === "mine" ? runs : [] } as never, "mine", fakeTui as never, theme as never, onClose);
}

test("status label shows every running role, including duplicates", () => {
	assert.equal(runningRoleLabel(runs), "3 agents: scout, reviewer, oracle");
	assert.equal(runningRoleLabel([runs[0]!, { ...runs[0]! }]), "2 agents: scout, scout");
	assert.equal(runningRoleLabel([{ ...runs[0]!, state: "complete" }]), undefined);
});

test("dashboard renders three live panes, narrow fallback and scroll keys", () => {
	const board = dashboard();
	const wide = board.render(120);
	assert.ok(wide.some((line) => line.includes("scout") && line.includes("reviewer") && line.includes("oracle")));
	assert.ok(wide.some((line) => line.includes("Live output 0") && line.includes("Live output 1")));
	assert.ok(wide.every((line) => !line.includes("undefined")));
	assert.ok(wide.every((line) => line.length <= 120));
	runs[0]!.live = '→ read {"path":"src/a.ts"}';
	assert.ok(board.render(120).some((line) => line.includes('read {"path":"src/a.ts"}')));
	const narrow = board.render(60);
	assert.ok(narrow.some((line) => line.includes("scout")));
	assert.ok(narrow.every((line) => !line.includes("reviewer")));
	board.handleInput("\t");
	assert.ok(board.render(60).some((line) => line.includes("reviewer")));
	board.handleInput("\x1b[A");
	board.handleInput("\x1b[B");
	runs[1]!.live = "Updated while running";
	assert.ok(board.render(120).some((line) => line.includes("Updated while running")));
	runs[1]!.state = "complete";
	assert.ok(board.render(120).some((line) => line.includes("reviewer · complete")));
	assert.ok(board.render(12).every((line) => visibleWidth(line) <= 12));
	board.dispose();
	let closed = 0;
	const reopened = dashboard(() => { closed++; });
	assert.ok(reopened.render(120).some((line) => line.includes("reviewer · complete")));
	reopened.handleInput("\x1b");
	assert.equal(closed, 1);
	assert.equal(runs[0]?.state, "running");
	reopened.dispose();
});
