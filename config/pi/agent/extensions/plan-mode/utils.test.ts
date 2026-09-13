import assert from "node:assert/strict";
import test from "node:test";
import { getPlanModeTools, isPlanModeBlockedTool } from "./utils.ts";

test("plan mode blocks stale mutation-tool calls from in-flight turns", () => {
	for (const toolName of ["bash", "powershell", "edit", "write", "subagent", "custom-tool"]) {
		assert.equal(isPlanModeBlockedTool(toolName), true, toolName);
	}
	assert.equal(isPlanModeBlockedTool("read"), false);
});

test("plan mode keeps only already-active read-only tools", () => {
	assert.deepEqual(getPlanModeTools(["read", "bash", "edit", "write", "custom-tool", "ask_user_question"]), ["read", "ask_user_question"]);
	assert.deepEqual(getPlanModeTools(["grep", "find", "ls"]), ["grep", "find", "ls"]);
	assert.deepEqual(getPlanModeTools([]), []);
});
