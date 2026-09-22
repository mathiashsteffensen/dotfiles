import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const setStatus = (ctx: ExtensionContext, provider?: string) => {
		ctx.ui.setStatus("openai-priority", provider === "openai-codex" ? ctx.ui.theme.fg("accent", "· ⚡ Fast mode") : undefined);
	};

	pi.on("session_start", (_event, ctx) => setStatus(ctx, ctx.model?.provider));
	pi.on("model_select", (event, ctx) => setStatus(ctx, event.model.provider));
	pi.on("session_shutdown", (_event, ctx) => ctx.ui.setStatus("openai-priority", undefined));

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider === "openai-codex" && event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
			return { ...event.payload, service_tier: "priority" };
		}
	});
}
