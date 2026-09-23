import assert from "node:assert/strict";
import test from "node:test";
import { extractTodoItems, getPlanModeTools, isPlanModeBlockedTool, markCompletedSteps } from "./utils.ts";

test("plan mode blocks stale mutation-tool calls from in-flight turns", () => {
	for (const toolName of ["powershell", "edit", "write", "subagent", "custom-tool"]) {
		assert.equal(isPlanModeBlockedTool(toolName), true, toolName);
	}
	assert.equal(isPlanModeBlockedTool("read"), false);
	assert.equal(isPlanModeBlockedTool("bash"), false);
});

test("plan mode keeps only already-active read-only tools", () => {
	assert.deepEqual(getPlanModeTools(["read", "bash", "edit", "write", "custom-tool", "ask_user_question"]), ["read", "bash", "ask_user_question"]);
	assert.deepEqual(getPlanModeTools(["grep", "find", "ls"]), ["grep", "find", "ls"]);
	assert.deepEqual(getPlanModeTools([]), []);
});

test("plan extraction keeps full Markdown steps and their details, not later sections", () => {
	const steps = extractTodoItems(`Plan:\n1. **Add authentication** to **the API**\n   - Include refresh tokens\n2) Verify a long requirement with details that must not be cut off when executing\n\n## Risks\n1. This is not a plan step`);
	assert.deepEqual(steps.map((step) => step.text), [
		"**Add authentication** to **the API**\n- Include refresh tokens",
		"Verify a long requirement with details that must not be cut off when executing",
	]);
});

test("completion markers only count standalone lines outside code fences", () => {
	const steps = extractTodoItems("Plan:\n1. Inspect source files\n2. Verify the behavior");
	assert.equal(markCompletedSteps("We might print [DONE:1] later.\n```\n[DONE:2]\n```\n[DONE:1]", steps), 1);
	assert.equal(markCompletedSteps("[DONE:1]", steps), 0);
	assert.deepEqual(steps.map((step) => step.completed), [true, false]);
});
