import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type SandboxState = "in-sandbox" | "out-of-sandbox" | "sandbox-disabled";

export const SBPL_PROFILE_FILENAME = "default.sbpl";
export const DEFAULT_PROFILE_DIR = join(tmpdir(), "pi-auto-approve-profiles");

export function loadSbpl(extensionDir: string): string {
	return readFileSync(join(extensionDir, SBPL_PROFILE_FILENAME), "utf8");
}

// Function replacer — string form interprets $& $1 $$ etc. and would break on
// project roots containing those characters.
export function materializeSbpl(template: string, projectRoot: string): string {
	return template.replace(/<PROJECT_ROOT>/gu, () => projectRoot);
}

export function writeProfile(content: string, targetDir: string = DEFAULT_PROFILE_DIR): string {
	mkdirSync(targetDir, { recursive: true, mode: 0o700 });
	const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
	const profilePath = join(targetDir, `auto-approve-${hash}.sbpl`);
	// Write once per unique content; subsequent calls return the existing path.
	if (!existsSync(profilePath)) {
		writeFileSync(profilePath, content, { mode: 0o600 });
	}
	return profilePath;
}

export function getSandboxState(platform: NodeJS.Platform, enabled: boolean): SandboxState {
	if (!enabled) return "sandbox-disabled";
	if (platform !== "darwin") return "sandbox-disabled";
	return "in-sandbox";
}

// Single-quote escape for an argv element. Closes the quote, inserts an escaped
// single quote, reopens. `'foo' -> 'foo'`, `it's -> 'it'\''s'`.
function shellEscape(value: string): string {
	return `'${value.replace(/'/gu, "'\\''")}'`;
}

// P0 fix: the outer shell parses the wrapped string. Wrapping as
// `sandbox-exec -f P -- cmd` lets the outer bash parse `;`, `&&`, `|`, `>`, `$()`
// in `cmd` and run those parts unsandboxed. Put the shell inside the sandbox
// instead — the outer bash sees argv tokens `sandbox-exec -f 'P' /bin/bash -c 'cmd'`
// and passes them straight to exec. Sandbox then enforces SBPL on /bin/bash -c 'cmd'.
export function wrapWithSandbox(command: string, profilePath: string): string {
	return [
		"sandbox-exec",
		"-f", shellEscape(profilePath),
		"/bin/bash", "-c", shellEscape(command),
	].join(" ");
}

export interface ResolveSandboxOptions {
	command: string;
	platform: NodeJS.Platform;
	enabled: boolean;
	extensionDir: string;
	projectRoot: string;
	profileDir?: string;
}

export interface SandboxResolution {
	state: SandboxState;
	command: string;
	profilePath: string | undefined;
}

export function resolveSandbox(opts: ResolveSandboxOptions): SandboxResolution {
	const state = getSandboxState(opts.platform, opts.enabled);
	if (state !== "in-sandbox") {
		return { state, command: opts.command, profilePath: undefined };
	}
	const template = loadSbpl(opts.extensionDir);
	const sbpl = materializeSbpl(template, opts.projectRoot);
	const profilePath = writeProfile(sbpl, opts.profileDir);
	return { state, command: wrapWithSandbox(opts.command, profilePath), profilePath };
}
