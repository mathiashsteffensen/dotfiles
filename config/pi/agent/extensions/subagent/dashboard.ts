import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import { type Run, type RunManager } from "./runner.ts";

export function runningRoleLabel(runs: readonly Run[]): string | undefined {
	const active = runs.filter((run) => run.state === "running");
	return active.length ? `${active.length} ${active.length === 1 ? "agent" : "agents"}: ${active.map((run) => run.agent).join(", ")}` : undefined;
}

function fit(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(1, width), "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export class Dashboard {
	private selected = 0;
	private scroll = new Map<string, number>();
	private readonly manager: RunManager;
	private readonly sessionId: string;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly close: () => void;
	private readonly timer: ReturnType<typeof setInterval>;
	constructor(manager: RunManager, sessionId: string, tui: TUI, theme: Theme, close: () => void) {
		this.manager = manager;
		this.sessionId = sessionId;
		this.tui = tui;
		this.theme = theme;
		this.close = close;
		this.timer = setInterval(() => tui.requestRender(), 1_000);
		this.timer.unref();
	}

	private shown(): Run[] {
		const runs = this.manager.list(this.sessionId);
		return [...runs.filter((run) => run.state === "running"), ...runs.filter((run) => run.state !== "running").reverse()].slice(0, 3);
	}

	handleInput(key: string): void {
		const runs = this.shown();
		if (matchesKey(key, "escape")) { this.close(); return; }
		if (matchesKey(key, "tab") || matchesKey(key, "right")) this.selected = (this.selected + 1) % Math.max(1, runs.length);
		if (matchesKey(key, "shift+tab") || matchesKey(key, "left")) this.selected = (this.selected - 1 + Math.max(1, runs.length)) % Math.max(1, runs.length);
		const run = runs[this.selected];
		if (run) {
			const n = this.scroll.get(run.id) ?? 0;
			if (matchesKey(key, "up")) this.scroll.set(run.id, Math.min(n + 1, 100));
			if (matchesKey(key, "down")) this.scroll.set(run.id, Math.max(n - 1, 0));
			if (matchesKey(key, "end")) this.scroll.set(run.id, 0);
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const runs = this.shown();
		if (this.selected >= runs.length) this.selected = 0;
		if (width < 12) return [fit("Subagents", width)];
		const height = Math.max(8, Math.min(30, this.tui.terminal.rows - 7));
		const compact = width < 90;
		const shown = compact ? runs.slice(this.selected, this.selected + 1) : runs;
		const count = Math.max(1, shown.length);
		const paneWidth = Math.max(1, Math.floor((width - count + 1) / count));
		const widths = shown.map((_, i) => i === count - 1 ? width - (paneWidth + 1) * (count - 1) : paneWidth);
		const panes = shown.map((run, i) => this.pane(run, widths[i]!, height, this.selected === (compact ? this.selected : i)));
		const header = fit(` Subagents · ${runs.filter((run) => run.state === "running").length} running · Tab/←→ select · ↑↓ scroll · End follow · Esc close`, width);
		if (!panes.length) return [header, fit(" No subagent runs in this session", width)];
		return [header, ...Array.from({ length: height }, (_, row) => panes.map((pane) => pane[row] ?? "").join(" "))];
	}

	private pane(run: Run, width: number, height: number, selected: boolean): string[] {
		const inner = Math.max(1, width - 2);
		const border = (text: string) => this.theme.fg(selected ? "accent" : "borderMuted", text);
		const body = (text: string) => border("│") + fit(` ${text}`, inner) + border("│");
		const title = `${run.agent} · ${run.state} · ${Math.floor(((run.endedAt ?? Date.now()) - run.startedAt) / 1000)}s`;
		const lines = [border(`╭${"─".repeat(inner)}╮`), body(title), body(run.task.replace(/\s+/g, " ")), body(run.activity)];
		const text = (run.live || run.output || run.error || "Waiting for output…").split("\n").flatMap((line) => {
			const segments = wrapTextWithAnsi(line, Math.max(1, inner - 2));
			return segments.length ? segments : [""];
		});
		const visible = height - lines.length - 1;
		const offset = this.scroll.get(run.id) ?? 0;
		const start = Math.max(0, text.length - visible - offset);
		for (const line of text.slice(start, start + visible)) lines.push(body(line));
		while (lines.length < height - 1) lines.push(body(""));
		lines.push(border(`╰${"─".repeat(inner)}╯`));
		return lines;
	}
	invalidate(): void {}
	dispose(): void { clearInterval(this.timer); }
}
