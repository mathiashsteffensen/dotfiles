import { isAbsolute, normalize, sep } from "node:path";

export const roles = {
	scout: {
		model: "gpt-6-luna", thinking: "xhigh", tools: "read,grep,find,ls",
		instructions: "Inspect the codebase and return relevant paths, behavior, and risks. Do not change files.",
	},
	reviewer: {
		model: "gpt-6-sol", thinking: "medium", tools: "read,grep,find,ls",
		instructions: "Review the requested change for concrete defects. Give file/line evidence and distinguish findings from suggestions. Do not change files.",
	},
	oracle: {
		model: "gpt-6-sol", thinking: "medium", tools: "read,grep,find,ls",
		instructions: "Challenge assumptions and compare options with clear tradeoffs. Do not change files.",
	},
	worker: {
		model: "gpt-6-luna", thinking: "xhigh", tools: "read,grep,find,ls,bash,edit,write",
		instructions: "Implement only the assigned task within its edit boundary. Preserve existing unrelated changes. Validate your changes and report changed files, tests, and remaining risks. Stop rather than guess when a decision is needed.",
	},
} as const;

export type Role = keyof typeof roles;
export type Assignment = { agent: Role; task: string; editBoundary?: string };

export function isRole(value: string): value is Role {
	return Object.prototype.hasOwnProperty.call(roles, value);
}

export function validateAssignments(params: { agent?: string; task?: string; editBoundary?: string; tasks?: { agent: string; task: string; editBoundary?: string }[] }): Assignment[] {
	if (params.tasks && (params.agent || params.task || params.editBoundary)) throw new Error("Use either tasks or agent/task, not both");
	const requests = params.tasks ?? [{ agent: params.agent ?? "", task: params.task ?? "", editBoundary: params.editBoundary }];
	if (!requests.length || requests.length > 3) throw new Error("Specify 1–3 tasks");
	return requests.map(({ agent, task, editBoundary }) => {
		if (!isRole(agent)) throw new Error(`Unknown role: ${agent}. Available: scout, reviewer, oracle, worker`);
		if (!task.trim() || task.length > 12_000) throw new Error("Tasks must be 1–12,000 characters");
		if (agent === "worker" && (!editBoundary?.trim() || editBoundary.length > 1_000)) throw new Error("A worker requires an explicit editBoundary");
		if (agent !== "worker" && editBoundary) throw new Error("Read-only roles cannot have an editBoundary");
		if (editBoundary) {
			const path = normalize(editBoundary.trim());
			if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) throw new Error("editBoundary must stay inside the project");
		}
		return { agent, task: task.trim(), editBoundary: editBoundary?.trim() };
	});
}

export function childPrompt(role: Role, task: string, cwd: string, editBoundary?: string): string {
	return [
		`Role: ${role}. ${roles[role].instructions}`,
		`Working directory: ${cwd}`,
		`Allowed tools: ${roles[role].tools}`,
		`Edit boundary: ${role === "worker" ? editBoundary : "No edits allowed"}`,
		`Task: ${task}`,
		"Return a concise report. You cannot ask the parent questions during this run; if blocked, explain why and stop.",
	].join("\n\n");
}
