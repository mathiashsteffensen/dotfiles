// Run: node --experimental-strip-types --test config/pi/agent/extensions/subagent/runner.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { JsonLines, RunManager, childArgs, clean, type Run } from "./runner.ts";
import { validateAssignments } from "./roles.ts";

const cwd = process.cwd();
const fixture = fileURLToPath(new URL("./fixture.mjs", import.meta.url));
const manager = (onComplete = (_group: unknown) => {}) => new RunManager("/local/auto-approve/index.ts", () => {}, onComplete, process.execPath, [fixture]);
const task = (agent: "scout" | "worker", text = "Inspect", editBoundary?: string) => ({ agent, task: text, editBoundary });

test("JSONL decodes split UTF-8 and never splits on Unicode separators", () => {
	const lines: string[] = [];
	const parser = new JsonLines((line) => lines.push(line));
	const bytes = Buffer.from('{"t":"🌍\u2028one"}\n');
	parser.push(bytes.subarray(0, 8));
	parser.push(bytes.subarray(8, 11));
	parser.push(bytes.subarray(11));
	parser.finish();
	assert.deepEqual(lines.map(JSON.parse), [{ t: "🌍\u2028one" }]);
});

test("child command starts fresh and loads only the local safety extension", () => {
	const run = { agent: "worker", task: "Fix it", cwd } as Run;
	const args = childArgs(run, "src/", "/local/auto-approve/index.ts", "gpt-6-luna", "xhigh");
	for (const flag of ["--no-session", "--no-approve", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"]) assert.ok(args.includes(flag));
	assert.equal(args[args.indexOf("--extension") + 1], "/local/auto-approve/index.ts");
	assert.match(args.at(-1)!, /Edit boundary: src\//);
	assert.match(args.at(-1)!, /Allowed tools: read,grep,find,ls,bash,edit,write/);
	assert.doesNotMatch(args.join(" "), /workflowScript/);
});

test("role and group validation rejects invalid assignments", () => {
	assert.throws(() => validateAssignments({ agent: "unknown", task: "Inspect" }), /Unknown role/);
	assert.throws(() => validateAssignments({ agent: "worker", task: "Fix" }), /editBoundary/);
	assert.throws(() => validateAssignments({ agent: "scout", task: "Inspect", editBoundary: "." }), /Read-only/);
	assert.throws(() => validateAssignments({ tasks: [] }), /1–3/);
	assert.throws(() => validateAssignments({ tasks: Array.from({ length: 4 }, () => task("scout")) }), /1–3/);
	assert.deepEqual(validateAssignments({ agent: "worker", task: " Fix ", editBoundary: "src/" }), [task("worker", "Fix", "src/")]);
});

test("bounded groups run in parallel, collect settled output and notify once", async () => {
	let notified = 0;
	const mgr = manager(() => { notified++; });
	const { group, done } = mgr.start("s1", cwd, [task("scout"), task("scout", "Inspect other files")], true);
	assert.equal(group.runs.length, 2);
	assert.throws(() => mgr.start("s1", cwd, [task("scout"), task("scout")], true), /At most three/);
	await done;
	assert.equal(notified, 1);
	assert.deepEqual(group.runs.map((run) => run.state), ["complete", "complete"]);
	assert.ok(group.runs.every((run) => run.output === "finished" && run.live.includes("🌍")));
	assert.ok(group.runs.every((run) => run.live.includes('→ read {"path":"src/file.ts","offset":10}')));
	assert.ok(group.runs.every((run) => run.live.includes('→ grep {"pattern":"foo.*","path":"src"}')));
	assert.equal(mgr.list("another session").length, 0);
});

test("failure, writer conflict and cancellation", async () => {
	const mgr = manager();
	const { group: failed, done: failure } = mgr.start("s1", cwd, [task("scout", "FAIL")], false);
	await failure;
	assert.equal(failed.runs[0]?.state, "failed");
	const { group, done } = mgr.start("s1", cwd, [task("worker", "HANG", "src/")], true);
	assert.throws(() => mgr.start("s1", cwd, [task("worker", "another", "tests/")], true), /one writer/);
	assert.throws(() => mgr.start("s1", cwd, [task("worker", "one", "src/"), task("worker", "two", "tests/")], true), /one writer/);
	assert.equal(mgr.stop(group.runs[0]!.id, "wrong-session"), false);
	assert.equal(mgr.stop(group.runs[0]!.id, "s1"), true);
	await done;
	assert.equal(group.runs[0]?.state, "stopped");
});

test("session shutdown stops all running children", async () => {
	const mgr = manager();
	const { group, done } = mgr.start("s1", cwd, [task("scout", "HANG"), task("scout", "HANG")], true);
	mgr.stopAll();
	await done;
	assert.deepEqual(group.runs.map((run) => run.state), ["stopped", "stopped"]);
});

test("a clean exit without agent_settled or with a nonzero code is not success", async () => {
	const mgr = manager();
	const { group, done } = mgr.start("s1", cwd, [task("scout", "UNSETTLED"), task("scout", "EXITFAIL")], false);
	await done;
	assert.deepEqual(group.runs.map((run) => run.state), ["failed", "failed"]);
});

test("deadline terminates a hung child", async () => {
	const mgr = new RunManager("/local/auto-approve/index.ts", () => {}, () => {}, process.execPath, [fixture], 30);
	const { group, done } = mgr.start("s1", cwd, [task("scout", "HANG")], false);
	await done;
	assert.equal(group.runs[0]?.state, "timed_out");
});

test("terminal control sequences never enter visible output", () => {
	assert.equal(clean("a\x1b[31mb\x1b]8;;https://bad\x07c\x1b]8;;\x07"), "abc");
});
