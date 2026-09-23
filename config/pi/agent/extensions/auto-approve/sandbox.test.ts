import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getSandboxState, loadSbpl, resolveSandbox, sandboxArgs, wrapWithSandbox } from "./sandbox.ts";

const extensionDir = fileURLToPath(new URL(".", import.meta.url));
const profile = loadSbpl(extensionDir);
const planProfile = loadSbpl(extensionDir, "plan.sbpl");

// Require actual Seatbelt execution when running this suite from a normal
// terminal; inside Pi's enclosing sandbox the native tests must be skipped.
function seatbeltSkip(extraTool?: string): string | false {
	if (process.platform !== "darwin") return "needs macOS sandbox-exec";
	try {
		execFileSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { stdio: "ignore" });
		if (extraTool) execSync(`command -v ${extraTool}`, { stdio: "ignore" });
		return false;
	} catch {
		return "needs sandbox-exec and no enclosing sandbox";
	}
}

test("default profile keeps deny rules and passes filesystem paths as parameters", () => {
	assert.match(profile, /\(deny default\)/u);
	assert.match(profile, /\(allow network-outbound \(remote tcp "localhost:5432"\)\)/u);
	assert.doesNotMatch(profile, /\(allow network-outbound\*\)/u);
	assert.match(profile, /\(allow file-read\*\)/u);
	assert.ok(profile.includes('(allow file-write* (subpath (param "PROJECT_ROOT")))'));
	assert.ok(profile.includes('(deny file-write* (subpath (param "PROJECT_GIT")))'));
	assert.doesNotMatch(profile, /"<PROJECT_ROOT>/u);
	assert.doesNotMatch(profile, /\.pi\/agent/u);
});

test("planning profile denies writes and all network while preserving read and process access", () => {
	assert.match(planProfile, /\(deny default\)/);
	assert.match(planProfile, /\(allow file-read\*\)/);
	assert.match(planProfile, /\(allow process-exec\)/);
	assert.doesNotMatch(planProfile, /\(allow (?:file-write\* \(subpath|network-outbound)/);
	assert.ok(planProfile.includes('(literal "/dev/stdout")'));
});

test("sandbox state respects explicit disable and unsupported platforms", () => {
	assert.equal(getSandboxState("darwin", true), "in-sandbox");
	assert.equal(getSandboxState("darwin", false), "sandbox-disabled");
	for (const platform of ["linux", "win32", "freebsd"] as const) {
		assert.equal(getSandboxState(platform, true), "sandbox-disabled");
	}
});

test("roots containing quotes, newlines, backslashes and dollar signs never enter policy source", () => {
	for (const root of ['/tmp/project"))\n(allow default)\n;', "/tmp/it's-$&-$1-\\project"]) {
		const args = sandboxArgs(profile, root);
		assert.deepEqual(args, ["-p", profile, "-D", `PROJECT_ROOT=${root}`, "-D", `PROJECT_GIT=${join(root, ".git")}`]);
		assert.equal(args[1], profile);
		assert.ok(!args.includes("-f"), "no mutable policy file may be used");
	}
});

test("wrapper shell-escapes policy, parameters and command, keeping shell syntax inside sandbox", () => {
	const wrapped = wrapWithSandbox("echo it's; touch /tmp/escape", "(version 1)(deny default)", "/tmp/it's");
	assert.match(wrapped, /^'\/usr\/bin\/sandbox-exec' '-p' /u);
	assert.ok(wrapped.includes("'PROJECT_ROOT=/tmp/it'\\''s'"));
	assert.ok(wrapped.endsWith("'/bin/bash' '-c' 'echo it'\\''s; touch /tmp/escape'"));
	assert.ok(!wrapped.includes("'-f'"));
});

test("resolution uses only the supplied policy snapshot and never a temporary profile", () => {
	const resolution = resolveSandbox({ command: "ls", platform: "darwin", enabled: true, profile, projectRoot: "/Users/me/project" });
	assert.equal(resolution.state, "in-sandbox");
	assert.equal(resolution.command, wrapWithSandbox("ls", profile, "/Users/me/project"));
	assert.ok(!("profilePath" in resolution));
	for (const options of [{ platform: "linux" as const, enabled: true }, { platform: "darwin" as const, enabled: false }]) {
		assert.deepEqual(resolveSandbox({ ...options, command: "ls", profile, projectRoot: "/Users/me/project" }), { state: "sandbox-disabled", command: "ls" });
	}
});

test("default profile grants the CLI runtime baseline", () => {
	for (const rule of [
		'(literal "/dev/null")', '(literal "/dev/urandom")', '(literal "/dev/ptmx")',
		"(allow pseudo-tty)", "(allow sysctl-read",
		'(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
		"(allow process-info* (target same-sandbox))", "(allow ipc-posix-sem)",
		'(subpath "/private/var/folders")',
	]) assert.ok(profile.includes(rule), `missing rule: ${rule}`);
});

test("sandbox-exec contains shell metacharacters and treats hostile project roots as data", { skip: seatbeltSkip() }, () => {
	const sandboxDir = mkdtempSync(join(tmpdir(), 'pi-sb-"))\n(allow default)\n;-'));
	const escapeCheck = join(tmpdir(), `sb-escape-${process.pid}-${Date.now()}`);
	try {
		const policy = '(version 1)(deny default)(allow process-exec)(allow process-fork)(allow file-read*)(allow file-write* (subpath (param "PROJECT_ROOT")))';
		const wrapped = wrapWithSandbox(`ls /tmp; touch "${escapeCheck}"; echo done`, policy, sandboxDir);
		execFileSync("/bin/bash", ["-c", wrapped], { stdio: "ignore" });
		assert.equal(existsSync(escapeCheck), false, "shell or SBPL injection escaped containment");
	} finally {
		rmSync(sandboxDir, { recursive: true, force: true });
		rmSync(escapeCheck, { force: true });
	}
});

test("real planning profile reads and prints but cannot write to project or temp", { skip: seatbeltSkip() }, () => {
	const projectRoot = mkdtempSync(join(tmpdir(), "pi-plan-sandbox-"));
	try {
		const run = (command: string) => execFileSync("/bin/bash", ["-c", wrapWithSandbox(command, planProfile, projectRoot)], { cwd: projectRoot, encoding: "utf8" });
		assert.equal(run("pwd").trim(), projectRoot);
		assert.throws(() => run("touch ./not-allowed"));
		assert.equal(existsSync(join(projectRoot, "not-allowed")), false);
		assert.throws(() => run(`touch /tmp/pi-plan-not-allowed-${process.pid}`));
	} finally {
		rmSync(projectRoot, { recursive: true, force: true });
	}
});

test("real profile: /dev/null and read-only git work inside the sandbox", { skip: seatbeltSkip("git") }, () => {
	const projectRoot = mkdtempSync(join(tmpdir(), "pi-auto-approve-git-"));
	try {
		execSync("git init -q . && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m init", { cwd: projectRoot, stdio: "ignore" });
		const command = wrapWithSandbox('echo hi > /dev/null && git log --oneline', profile, projectRoot);
		const output = execFileSync("/bin/bash", ["-c", command], { cwd: projectRoot, encoding: "utf8" });
		assert.match(output, /init/u);
	} finally {
		rmSync(projectRoot, { recursive: true, force: true });
	}
});

test("real profile: node runs, writes outside the project root remain denied", { skip: seatbeltSkip("node") }, () => {
	const projectRoot = mkdtempSync(join(tmpdir(), "pi-auto-approve-node-"));
	const escapeTarget = join(homedir(), `pi-sb-deny-probe-${process.pid}-${Date.now()}`);
	try {
		const run = (command: string) => execFileSync("/bin/bash", ["-c", wrapWithSandbox(command, profile, projectRoot)], { cwd: projectRoot, encoding: "utf8" });
		assert.equal(run('node -e "console.log(7)"').trim(), "7");
		assert.throws(() => run(`touch "${escapeTarget}"`));
		assert.equal(existsSync(escapeTarget), false);
	} finally {
		rmSync(projectRoot, { recursive: true, force: true });
		rmSync(escapeTarget, { force: true });
	}
});
