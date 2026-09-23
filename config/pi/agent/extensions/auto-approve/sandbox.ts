import { readFileSync } from "node:fs";
import { join } from "node:path";

export type SandboxState = "in-sandbox" | "out-of-sandbox" | "sandbox-disabled";

export const SBPL_PROFILE_FILENAME = "default.sbpl";

export function loadSbpl(extensionDir: string, filename = SBPL_PROFILE_FILENAME): string {
	// Convert template markers to parameters, never interpolate filesystem paths
	// into executable policy source. Keep the template readable by older installs.
	return readFileSync(join(extensionDir, filename), "utf8")
		.replaceAll('"<PROJECT_ROOT>/.git"', '(param "PROJECT_GIT")')
		.replaceAll('"<PROJECT_ROOT>"', '(param "PROJECT_ROOT")');
}

export function getSandboxState(platform: NodeJS.Platform, enabled: boolean): SandboxState {
	if (!enabled) return "sandbox-disabled";
	if (platform !== "darwin") return "sandbox-disabled";
	return "in-sandbox";
}

export function sandboxArgs(profile: string, projectRoot: string): string[] {
	return [
		"-p", profile,
		"-D", `PROJECT_ROOT=${projectRoot}`,
		"-D", `PROJECT_GIT=${join(projectRoot, ".git")}`,
	];
}

function shellEscape(value: string): string {
	return `'${value.replace(/'/gu, "'\\''")}'`;
}

// Inline policy avoids a writable profile cache. The shell belongs INSIDE the
// sandbox, so metacharacters in command cannot escape through the outer shell.
export function wrapWithSandbox(command: string, profile: string, projectRoot: string): string {
	return ["/usr/bin/sandbox-exec", ...sandboxArgs(profile, projectRoot), "/bin/bash", "-c", command]
		.map(shellEscape).join(" ");
}

export interface ResolveSandboxOptions {
	command: string;
	platform: NodeJS.Platform;
	enabled: boolean;
	profile: string;
	projectRoot: string;
}

export function resolveSandbox(opts: ResolveSandboxOptions): { state: SandboxState; command: string } {
	const state = getSandboxState(opts.platform, opts.enabled);
	return {
		state,
		command: state === "in-sandbox" ? wrapWithSandbox(opts.command, opts.profile, opts.projectRoot) : opts.command,
	};
}
