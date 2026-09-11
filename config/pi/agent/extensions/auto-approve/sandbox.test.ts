import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	getSandboxState,
	loadSbpl,
	materializeSbpl,
	resolveSandbox,
	wrapWithSandbox,
	writeProfile,
} from "./sandbox.ts";

const extensionDir = fileURLToPath(new URL(".", import.meta.url));

test("default SBPL profile contains the expected deny/allow rules", () => {
	const profile = loadSbpl(extensionDir);
	assert.match(profile, /\(deny default\)/u);
	assert.match(profile, /\(deny network\*\)/u);
	assert.match(profile, /\(allow file-read\*\)/u);
	assert.match(profile, /\(allow file-write\*/u);
	assert.match(profile, /<PROJECT_ROOT>/u);
	// P0 #2: ~/.pi/agent must NOT be writable from the sandbox.
	assert.doesNotMatch(profile, /\.pi\/agent/u);
	// P1: .git must be denied.
	// new RegExp avoids the `</` lexing ambiguity in regex literals under `--experimental-strip-types`.
	const denyGitPattern = new RegExp(String.raw`\(deny file-write\* \(subpath "<PROJECT_ROOT>/\.git"\)\)`, "u");
	assert.match(profile, denyGitPattern);
});

test("getSandboxState returns sandbox-disabled on non-darwin platforms", () => {
	assert.equal(getSandboxState("linux", true), "sandbox-disabled");
	assert.equal(getSandboxState("win32", true), "sandbox-disabled");
	assert.equal(getSandboxState("freebsd", true), "sandbox-disabled");
});

test("getSandboxState returns sandbox-disabled when disabled regardless of platform", () => {
	assert.equal(getSandboxState("darwin", false), "sandbox-disabled");
	assert.equal(getSandboxState("linux", false), "sandbox-disabled");
});

test("getSandboxState returns in-sandbox on darwin when enabled", () => {
	assert.equal(getSandboxState("darwin", true), "in-sandbox");
});

// P0 #1 fix: outer shell sees argv tokens, not a metacharacter-bearing string.
test("wrapWithSandbox puts /bin/bash -c into argv to prevent metacharacter escape", () => {
	const wrapped = wrapWithSandbox("ls -la", "/tmp/profile.sbpl");
	assert.equal(wrapped, "sandbox-exec -f '/tmp/profile.sbpl' /bin/bash -c 'ls -la'");

	const wrapped2 = wrapWithSandbox("echo hello world", "/var/profile.sbpl");
	assert.equal(wrapped2, "sandbox-exec -f '/var/profile.sbpl' /bin/bash -c 'echo hello world'");

	// The wrapped command must NOT contain `-- <command>` (the broken form).
	assert.doesNotMatch(wrapped, /-- /u);
});

test("wrapWithSandbox shell-escapes single quotes in the command", () => {
	const wrapped = wrapWithSandbox("echo it's", "/tmp/p.sbpl");
	// `it's` -> `'it'\''s'`
	assert.equal(wrapped, "sandbox-exec -f '/tmp/p.sbpl' /bin/bash -c 'echo it'\\''s'");
});

test("materializeSbpl substitutes project root via function replacer", () => {
	const template = "(allow file-write* (subpath \"<PROJECT_ROOT>\"))\n(deny file-write* (subpath \"<PROJECT_ROOT>/.git\"))";
	const materialized = materializeSbpl(template, "/Users/me/project");
	assert.match(materialized, /\/Users\/me\/project/u);
	assert.doesNotMatch(materialized, /<PROJECT_ROOT>/u);
});

test("materializeSbpl does not interpret $-sequences in the project root", () => {
	// String-replace would mangle `$&` to the match. Function replacer must not.
	const tricky = "/path/$with-&dollar";
	const template = "(allow file-write* (subpath \"<PROJECT_ROOT>\"))";
	const materialized = materializeSbpl(template, tricky);
	assert.match(materialized, /\$with-&dollar/u);
});

test("writeProfile writes the content to a deterministic tmp path", () => {
	const dir = join(tmpdir(), "pi-auto-approve-test");
	const content = "(version 1)\n(deny default)\n";
	const path1 = writeProfile(content, dir);
	const path2 = writeProfile(content, dir);
	try {
		assert.equal(path1, path2);
		assert.ok(existsSync(path1));
		const readBack = readFileSync(path1, "utf8");
		assert.equal(readBack, content);
	} finally {
		rmSync(path1, { force: true });
	}
});

test("writeProfile reuses an existing profile file (no per-call write)", () => {
	const dir = join(tmpdir(), "pi-auto-approve-test-reuse");
	const content = "(version 1)\n";
	const path = writeProfile(content, dir);
	try {
		const before = readFileSync(path, "utf8");
		// Subsequent call should not modify the file (writeProfile returns existing path).
		writeProfile(content, dir);
		const after = readFileSync(path, "utf8");
		assert.equal(before, after);
	} finally {
		rmSync(path, { force: true });
	}
});

test("resolveSandbox wraps the command when on darwin and enabled", () => {
	const resolution = resolveSandbox({
		command: "ls",
		platform: "darwin",
		enabled: true,
		extensionDir,
		projectRoot: "/Users/me/project",
		profileDir: join(tmpdir(), "pi-auto-approve-resolve"),
	});
	try {
		assert.equal(resolution.state, "in-sandbox");
		assert.match(resolution.command, /^sandbox-exec -f '.*' \/bin\/bash -c 'ls'$/u);
		assert.ok(resolution.profilePath);
	} finally {
		if (resolution.profilePath) rmSync(resolution.profilePath, { force: true });
	}
});

test("resolveSandbox does not wrap the command when sandbox is disabled", () => {
	const resolution = resolveSandbox({
		command: "ls",
		platform: "darwin",
		enabled: false,
		extensionDir,
		projectRoot: "/Users/me/project",
	});
	assert.equal(resolution.state, "sandbox-disabled");
	assert.equal(resolution.command, "ls");
	assert.equal(resolution.profilePath, undefined);
});

test("resolveSandbox does not wrap the command on non-darwin platforms", () => {
	const resolution = resolveSandbox({
		command: "ls",
		platform: "linux",
		enabled: true,
		extensionDir,
		projectRoot: "/Users/me/project",
	});
	assert.equal(resolution.state, "sandbox-disabled");
	assert.equal(resolution.command, "ls");
	assert.equal(resolution.profilePath, undefined);
});

test("resolveSandbox substitutes project root into the materialized profile", () => {
	const resolution = resolveSandbox({
		command: "ls",
		platform: "darwin",
		enabled: true,
		extensionDir,
		projectRoot: "/Users/me/project",
		profileDir: join(tmpdir(), "pi-auto-approve-resolve-2"),
	});
	try {
		assert.ok(resolution.profilePath);
		const profileContents = readFileSync(resolution.profilePath, "utf8");
		assert.match(profileContents, /\/Users\/me\/project/u);
		assert.doesNotMatch(profileContents, /<PROJECT_ROOT>/u);
	} finally {
		if (resolution.profilePath) rmSync(resolution.profilePath, { force: true });
	}
});

// Integration test for P0 #1: outer-shell metacharacter escape.
// Skipped on non-darwin (no sandbox-exec) or when sandbox-exec is absent.
test(
	"sandbox-exec contains metacharacter escape at runtime",
	{ skip: seatbeltSkip() },
	() => {
		const sandboxDir = mkdtempSync(join(tmpdir(), "pi-auto-approve-runtime-"));
		const profilePath = join(sandboxDir, "test.sbpl");
		// Allow writes only to <sandboxDir>. /tmp writes are denied inside the sandbox.
		writeFileSync(
			profilePath,
			`(version 1)\n(deny default)\n(allow process-exec)\n(allow process-fork)\n(allow signal (target self))\n(allow file-read*)\n(allow file-write* (subpath "${sandboxDir}"))\n`,
		);

		const escapeCheck = join(tmpdir(), `sb-escape-${process.pid}-${Date.now()}`);
		const cmd = `ls /tmp; touch ${escapeCheck}; echo escaped`;
		const wrapped = wrapWithSandbox(cmd, profilePath);

		// Run the wrapped command via outer bash -c (the same way Pi does).
		execSync(`/bin/bash -c '${wrapped.replace(/'/gu, "'\\''")}'`, { stdio: "ignore" });

		// If wrapping is correct: `touch` runs INSIDE the sandbox, /tmp is denied → file not created.
		// If wrapping regressed: outer bash parses `;` and `touch` runs unsandboxed → file IS created.
		assert.equal(existsSync(escapeCheck), false, `metacharacter escape detected: ${escapeCheck} was created`);

		rmSync(sandboxDir, { recursive: true, force: true });
	},
);

// The runtime baseline. Without it tools fail in confusing ways instead of
// being contained: git dies with `could not open '/dev/null'`, xcrun cannot
// cache, node/bun abort while sizing the heap.
test("default SBPL profile grants the runtime baseline", () => {
	const profile = loadSbpl(extensionDir);
	for (const rule of [
		'(literal "/dev/null")',
		'(literal "/dev/urandom")',
		'(literal "/dev/ptmx")',
		"(allow pseudo-tty)",
		"(allow sysctl-read",
		'(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
		"(allow process-info* (target same-sandbox))",
		"(allow ipc-posix-sem)",
		'(subpath "/private/var/folders")',
	]) {
		assert.ok(profile.includes(rule), `missing rule: ${rule}`);
	}
	// The baseline must not reopen what the profile exists to close.
	assert.match(profile, /\(deny network\*\)/u);
	assert.doesNotMatch(profile, /\.pi\/agent/u);
});

// Regression for the reported breakage: read-only git failed under the sandbox
// because file-write* was project-only, so git's write-to-/dev/null hit EPERM.
// The repo is created OUTSIDE the sandbox first — `.git` writes are denied
// inside it by design.
test(
	"real profile: /dev/null and read-only git work inside the sandbox",
	{ skip: seatbeltSkip("git") },
	() => {
		const projectRoot = mkdtempSync(join(tmpdir(), "pi-auto-approve-git-"));
		try {
			execSync("git init -q . && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m init", {
				cwd: projectRoot,
				stdio: "ignore",
			});

			const resolution = resolveSandbox({
				command: 'echo hi > /dev/null && touch "$TMPDIR/pi-sb-probe" && rm "$TMPDIR/pi-sb-probe" && git log --oneline',
				platform: "darwin",
				enabled: true,
				extensionDir,
				projectRoot,
			});
			const output = execSync(`/bin/bash -c '${resolution.command.replace(/'/gu, "'\\''")}'`, {
				cwd: projectRoot,
				encoding: "utf8",
			});

			assert.match(output, /init/u, "git log must succeed inside the sandbox");
		} finally {
			rmSync(projectRoot, { recursive: true, force: true });
		}
	},
);

// node needs sysctl-read (heap sizing), mach-host* and file-ioctl; the deny of
// writes outside the project root must survive the baseline grant.
test(
	"real profile: node runs inside the sandbox, writes outside the project root still denied",
	{ skip: seatbeltSkip("node") },
	() => {
		const projectRoot = mkdtempSync(join(tmpdir(), "pi-auto-approve-node-"));
		const escapeTarget = join(homedir(), `pi-sb-deny-probe-${process.pid}-${Date.now()}`);
		try {
			const run = (command: string): string => {
				const resolution = resolveSandbox({
					command,
					platform: "darwin",
					enabled: true,
					extensionDir,
					projectRoot,
				});
				return execSync(`/bin/bash -c '${resolution.command.replace(/'/gu, "'\\''")}'`, {
					cwd: projectRoot,
					encoding: "utf8",
				});
			};

			assert.equal(run('node -e "console.log(7)"').trim(), "7");

			assert.throws(() => run(`touch "${escapeTarget}"`), "write outside the project root must fail");
			assert.equal(existsSync(escapeTarget), false, "write outside the project root escaped the sandbox");
		} finally {
			rmSync(projectRoot, { recursive: true, force: true });
			rmSync(escapeTarget, { force: true });
		}
	},
);

function commandExists(cmd: string): boolean {
	try {
		execSync(`command -v ${cmd}`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

// A sandboxed process cannot sandbox_apply another profile, so the runtime
// tests cannot run from inside a pi session that is already wrapped. Probe once
// and skip with a reason instead of failing red.
function sandboxApplyWorks(): boolean {
	try {
		execSync("sandbox-exec -p '(version 1)(allow default)' /usr/bin/true", { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function seatbeltSkip(extraTool?: string): string | false {
	if (process.platform !== "darwin" || !commandExists("sandbox-exec") || !sandboxApplyWorks()) {
		return "needs sandbox-exec and no enclosing sandbox";
	}
	if (extraTool !== undefined && !commandExists(extraTool)) return `needs ${extraTool}`;
	return false;
}
