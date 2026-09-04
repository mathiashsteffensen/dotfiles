import assert from "node:assert/strict";
import test from "node:test";
import { authStatePath, formatViolations, normalizeUrl } from "./index.ts";

test("UI review validates URLs and formats actionable audit output", () => {
	assert.equal(normalizeUrl("http://localhost:3000"), "http://localhost:3000/");
	assert.throws(() => normalizeUrl("file:///tmp/page.html"), /http or https/u);
	assert.equal(
		authStatePath("https://example.com/one", "/agent"),
		authStatePath("https://example.com/two", "/agent"),
	);
	assert.notEqual(
		authStatePath("https://example.com", "/agent"),
		authStatePath("https://other.example.com", "/agent"),
	);
	assert.match(
		formatViolations([{
			id: "button-name",
			impact: "critical",
			help: "Buttons must have discernible text",
			helpUrl: "https://deque.example/button-name",
			nodes: [{ target: ["#save"], failureSummary: "Fix any of the following:\n  Add text" }],
		}]),
		/\[critical\] button-name[\s\S]*#save — Fix any of the following: Add text/u,
	);
});
