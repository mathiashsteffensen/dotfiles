import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import { roles, childPrompt, type Role, type Assignment } from "./roles.ts";

const MAX_LINE_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT = 16_000;
const MAX_LIVE = 24_000;
const MAX_STDERR = 4_000;
const MAX_RUNS = 30;
const TIMEOUT_MS = 30 * 60_000;

export type RunState = "running" | "complete" | "failed" | "stopped" | "timed_out";
export type Run = {
	id: string;
	groupId: string;
	sessionId: string;
	agent: Role;
	task: string;
	cwd: string;
	state: RunState;
	startedAt: number;
	endedAt?: number;
	activity: string;
	live: string;
	output: string;
	error?: string;
	usage?: { input: number; output: number };
};
export type Group = { id: string; sessionId: string; background: boolean; runs: Run[]; delivered: boolean };

// JSON mode is LF-framed, not readline-framed (which also splits Unicode separators).
export class JsonLines {
	private decoder = new StringDecoder("utf8");
	private pending = "";
	private readonly onLine: (line: string) => void;
	constructor(onLine: (line: string) => void) { this.onLine = onLine; }
	push(chunk: Buffer): void {
		this.pending += this.decoder.write(chunk);
		if (Buffer.byteLength(this.pending) > MAX_LINE_BYTES && !this.pending.includes("\n")) throw new Error("Pi JSON event exceeds 16 MiB");
		let end: number;
		while ((end = this.pending.indexOf("\n")) >= 0) {
			const line = this.pending.slice(0, end).replace(/\r$/, "");
			this.pending = this.pending.slice(end + 1);
			if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error("Pi JSON event exceeds 16 MiB");
			if (line) this.onLine(line);
		}
	}
	finish(): void {
		this.pending += this.decoder.end();
		if (this.pending.trim()) this.onLine(this.pending);
		this.pending = "";
	}
}

export function clean(text: string): string {
	return text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))|[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

function toolArgsPreview(args: unknown): string {
	if (args === undefined) return "";
	const text = clean(JSON.stringify(args));
	return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

export function childArgs(run: Run, editBoundary: string | undefined, autoApprovePath: string, model: string, thinking: string): string[] {
	return [
		"--mode", "json", "--no-session", "--no-approve", "--no-extensions",
		"--extension", autoApprovePath, "--no-skills", "--no-prompt-templates", "--no-context-files",
		"--model", `openai-codex/${model}`, "--thinking", thinking,
		"--tools", roles[run.agent].tools, "--",
		childPrompt(run.agent, run.task, run.cwd, editBoundary),
	];
}

type Running = { process: ChildProcessWithoutNullStreams; deadline: ReturnType<typeof setTimeout>; killTimer?: ReturnType<typeof setTimeout>; stopReason?: "stopped" | "timed_out"; settled: boolean; stopReasonFromModel?: string; stderr: string; usageCompleted: { input: number; output: number } };

export class RunManager {
	readonly groups: Group[] = [];
	private running = new Map<string, Running>();
	private readonly autoApprovePath: string;
	private readonly onChange: () => void;
	private readonly onGroupComplete: (group: Group) => void;
	private readonly command: string;
	private readonly extraArgs: string[];
	private readonly timeoutMs: number;
	constructor(autoApprovePath: string, onChange: () => void, onGroupComplete: (group: Group) => void, command = "pi", extraArgs: string[] = [], timeoutMs = TIMEOUT_MS) {
		this.autoApprovePath = autoApprovePath;
		this.onChange = onChange;
		this.onGroupComplete = onGroupComplete;
		this.command = command;
		this.extraArgs = extraArgs;
		this.timeoutMs = timeoutMs;
	}

	get activeCount(): number { return this.running.size; }

	start(sessionId: string, cwd: string, assignments: Assignment[], background: boolean): { group: Group; done: Promise<void> } {
		if (assignments.length < 1 || assignments.length > 3) throw new Error("Specify 1–3 assignments");
		if (this.activeCount + assignments.length > 3) throw new Error("At most three subagents may run at once");
		if (assignments.filter((assignment) => assignment.agent === "worker").length > 1 ||
			(this.groups.some((group) => group.runs.some((run) => run.cwd === cwd && run.agent === "worker" && run.state === "running")) &&
			 assignments.some((assignment) => assignment.agent === "worker"))) {
			throw new Error("Only one writer may use this cwd at a time; worktrees are not supported");
		}
		const group: Group = {
			id: randomUUID(), sessionId, background, delivered: false,
			runs: assignments.map(({ agent, task }) => ({
				id: randomUUID(), groupId: "", sessionId, agent, task, cwd,
				state: "running", startedAt: Date.now(), activity: "Starting", live: "", output: "",
			})),
		};
		for (const run of group.runs) run.groupId = group.id;
		this.groups.push(group);
		while (this.groups.length > MAX_RUNS) {
			const oldestFinished = this.groups.findIndex((item) => item.runs.every((run) => run.state !== "running"));
			if (oldestFinished === -1) break;
			this.groups.splice(oldestFinished, 1);
		}
		const promises = group.runs.map((run, i) => this.launch(run, assignments[i]?.editBoundary));
		const done = Promise.all(promises).then(() => {
			if (!group.delivered) {
				group.delivered = true;
				try { this.onGroupComplete(group); }
				catch (error) { console.error("[subagents] Completion delivery failed:", error); }
			}
		});
		this.onChange();
		return { group, done };
	}

	find(id: string, sessionId: string): Run | undefined {
		return this.groups.filter((group) => group.sessionId === sessionId).flatMap((group) => group.runs).find((run) => run.id === id);
	}

	list(sessionId: string): Run[] {
		return this.groups.filter((group) => group.sessionId === sessionId).flatMap((group) => group.runs);
	}

	stop(id: string, sessionId: string): boolean {
		const run = this.find(id, sessionId);
		if (!run || run.state !== "running") return false;
		this.terminate(run, "stopped");
		return true;
	}

	stopAll(): void {
		for (const group of this.groups) for (const run of group.runs) if (run.state === "running") this.terminate(run, "stopped");
	}

	private terminate(run: Run, reason: "stopped" | "timed_out"): void {
		const active = this.running.get(run.id);
		if (!active || active.stopReason) return;
		active.stopReason = reason;
		run.activity = reason === "timed_out" ? "Timed out; stopping" : "Stopping";
		this.onChange();
		// Child is the leader of its own process group; terminate any tools it started too.
		try { if (active.process.pid) process.kill(-active.process.pid, "SIGTERM"); else active.process.kill("SIGTERM"); }
		catch { active.process.kill("SIGTERM"); }
		active.killTimer = setTimeout(() => {
			try { if (active.process.pid) process.kill(-active.process.pid, "SIGKILL"); else active.process.kill("SIGKILL"); }
			catch { active.process.kill("SIGKILL"); }
		}, 5_000);
		active.killTimer.unref();
	}

	private launch(run: Run, editBoundary?: string): Promise<void> {
		const role = roles[run.agent];
		const env = { ...process.env };
		delete env.PI_SESSION_ID;
		delete env.PI_SESSION_FILE;
		env.PI_SUBAGENT_CHILD = "1";
		const args = [...this.extraArgs, ...childArgs(run, editBoundary, this.autoApprovePath, role.model, role.thinking)];
		let proc: ChildProcessWithoutNullStreams;
		try { proc = spawn(this.command, args, { cwd: run.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true }); }
		catch (error) {
			run.state = "failed"; run.endedAt = Date.now(); run.error = String(error); this.onChange();
			return Promise.resolve();
		}
		proc.stdin.on("error", () => {});
		proc.stdin.end();
		const active: Running = { process: proc, deadline: setTimeout(() => this.terminate(run, "timed_out"), this.timeoutMs), settled: false, stderr: "", usageCompleted: { input: 0, output: 0 } };
		this.running.set(run.id, active);
		const parser = new JsonLines((line) => {
			const event = JSON.parse(line) as Record<string, any>;
			this.handleEvent(run, active, event);
		});
		const failProtocol = (error: unknown) => {
			run.error = `Invalid Pi event stream: ${String(error)}`;
			this.terminate(run, "stopped");
		};
		proc.stdout.on("data", (chunk: Buffer) => { try { parser.push(chunk); } catch (error) { failProtocol(error); } });
		proc.stderr.on("data", (chunk: Buffer) => { active.stderr = (active.stderr + clean(chunk.toString("utf8"))).slice(-MAX_STDERR); });
		return new Promise<void>((resolve) => {
			let finished = false;
			const finish = (code: number | null, error?: Error) => {
				if (finished) return;
				finished = true;
				clearTimeout(active.deadline);
				if (active.killTimer) clearTimeout(active.killTimer);
				try { parser.finish(); } catch (parseError) { run.error ??= String(parseError); }
				this.running.delete(run.id);
				run.endedAt = Date.now();
				run.state = active.stopReason === "timed_out" ? "timed_out" : run.error ? "failed" : active.stopReason ? "stopped" :
					(code === 0 && active.settled && active.stopReasonFromModel === "stop") ? "complete" : "failed";
				if (run.state === "failed") run.error ??= error?.message || active.stderr.slice(-1_000) || `Pi exited ${code} without a successful settled response`;
				run.activity = run.state;
				this.onChange();
				resolve();
			};
			proc.once("error", (error) => finish(null, error));
			proc.once("close", (code) => finish(code));
		});
	}

	private handleEvent(run: Run, active: Running, event: Record<string, any>): void {
		if (run.state !== "running") return;
		switch (event.type) {
			case "message_update":
				if (event.assistantMessageEvent?.type === "thinking_delta") run.activity = "Thinking";
				if (event.assistantMessageEvent?.type === "text_delta") {
					run.live = (run.live + clean(String(event.assistantMessageEvent.delta ?? ""))).slice(-MAX_LIVE);
					run.activity = "Responding";
				}
				if (event.usage) run.usage = {
					input: active.usageCompleted.input + Number(event.usage.input ?? 0),
					output: active.usageCompleted.output + Number(event.usage.output ?? 0),
				};
				break;
			case "tool_execution_start": {
				const name = clean(String(event.toolName)).slice(0, 48);
				const args = toolArgsPreview(event.args);
				run.activity = `Using ${name}`;
				run.live = (run.live + `\n→ ${name}${args ? ` ${args}` : ""}\n`).slice(-MAX_LIVE);
				break;
			}
			case "tool_execution_end":
				run.activity = "Thinking";
				break;
			case "message_end":
				if (event.message?.role === "assistant") {
					active.stopReasonFromModel = event.message.stopReason;
					if (event.message.usage) {
						active.usageCompleted.input += Number(event.message.usage.input ?? 0);
						active.usageCompleted.output += Number(event.message.usage.output ?? 0);
						run.usage = { ...active.usageCompleted };
					}
					if (event.message.stopReason === "stop") {
						run.output = clean((event.message.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n")).slice(-MAX_OUTPUT);
					}
				}
				break;
			case "agent_settled": active.settled = true; break;
		}
		this.onChange();
	}
}
