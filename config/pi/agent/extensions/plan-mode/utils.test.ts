import assert from "node:assert/strict";
import test from "node:test";
import { getPlanModeTools, isPlanModeBlockedTool } from "./utils.ts";

test("plan mode blocks stale mutation-tool calls from in-flight turns", () => {
	for (const toolName of ["bash", "edit", "write"]) {
		assert.equal(isPlanModeBlockedTool(toolName), true, toolName);
	}
	assert.equal(isPlanModeBlockedTool("read"), false);
});

test("plan mode disables Bash and built-in write tools", () => {
	const tools = getPlanModeTools(["read", "bash", "edit", "write", "custom-tool"]);

	assert.equal(tools.includes("bash"), false);
	assert.equal(tools.includes("edit"), false);
	assert.equal(tools.includes("write"), false);
	assert.equal(tools.includes("custom-tool"), true);
	assert.equal(tools.includes("grep"), true);
	assert.equal(tools.includes("find"), true);
	assert.equal(tools.includes("ls"), true);
	assert.equal(tools.includes("questionnaire"), true);
});
