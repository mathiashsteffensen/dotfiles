/**
 * Pi Notify Extension
 *
 * Sends a native terminal notification when Pi agent is done and waiting for input.
 * Supports only OSC 777: Ghostty, iTerm2, WezTerm, rxvt-unicode
 *
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function notifyOSC777(title: string, body: string): void {
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

function notify(title: string, body: string): void {
	notifyOSC777(title, body);
}

export default function (pi: ExtensionAPI) {
	// `agent_end` fires after each low-level run; Pi may still retry, compact,
	// or continue with queued follow-ups. Notify only after the full run settles.
	pi.on("agent_settled", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		notify("Pi", "Ready for input");
	});
}
