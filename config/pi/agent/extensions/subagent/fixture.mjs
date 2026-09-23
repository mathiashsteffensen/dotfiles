// A fake Pi JSON-mode child used only by runner.test.ts.
const prompt = process.argv.at(-1);
if (!process.argv.includes("--no-extensions") || !process.argv.includes("--extension") || !process.argv.includes("--no-session")) process.exit(2);
if (prompt.includes("HANG")) setInterval(() => {}, 1_000);
else {
  const mode = prompt.includes("FAIL") ? "error" : "stop";
  process.stdout.write(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello 🌍" } }) + "\n");
  process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "src/file.ts", offset: 10 } }) + "\n");
  process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolName: "grep", args: { pattern: "foo.*", path: "src" } }) + "\n");
  process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: mode, content: [{ type: "text", text: "finished" }] } }) + "\n");
  if (!prompt.includes("UNSETTLED")) process.stdout.write('{"type":"agent_settled"}\n');
  if (prompt.includes("EXITFAIL")) process.exitCode = 1;
}
