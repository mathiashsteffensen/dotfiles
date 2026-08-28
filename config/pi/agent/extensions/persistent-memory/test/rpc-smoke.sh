#!/usr/bin/env bash
set -euo pipefail

command -v pi >/dev/null 2>&1 || {
    echo "pi executable is required for the RPC smoke test" >&2
    exit 1
}

extension_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_root="$(mktemp -d)"
trap 'rm -rf "$tmp_root"' EXIT
mkdir -p "$tmp_root/extensions/persistent-memory" "$tmp_root/sessions"
tar -C "$extension_dir" --exclude='./node_modules' -cf - . |
    tar -C "$tmp_root/extensions/persistent-memory" -xf -

session_file="$({ TMP_ROOT="$tmp_root" node --input-type=module; } <<'NODE'
import { SessionManager } from "@earendil-works/pi-coding-agent";

const manager = SessionManager.create(process.cwd(), `${process.env.TMP_ROOT}/sessions`, {
  id: "0195f4c7-8b35-7c29-a6b2-123456789abc",
});
manager.appendMessage({
  role: "user",
  content: "Persistent-memory smoke seed.",
  timestamp: Date.now(),
});
manager.appendMessage({
  role: "assistant",
  content: [{ type: "text", text: "Seed complete." }],
  api: "openai-responses",
  provider: "fake",
  model: "fake",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
});
console.log(manager.getSessionFile());
NODE
)"

TMP_ROOT="$tmp_root" SESSION_FILE="$session_file" python3 <<'PY'
import json
import os
import pathlib
import select
import signal
import subprocess
import time

root = pathlib.Path(os.environ["TMP_ROOT"])
session_file = pathlib.Path(os.environ["SESSION_FILE"])
environment = os.environ.copy()
environment.update({
    "PI_CODING_AGENT_DIR": str(root),
    "PI_OFFLINE": "1",
    "PI_SKIP_VERSION_CHECK": "1",
})
process = subprocess.Popen(
    ["pi", "--mode", "rpc", "--session", str(session_file), "--session-dir", str(root / "sessions")],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    bufsize=1,
    env=environment,
)
assert process.stdin and process.stdout and process.stderr
confirm_value = True


def send(value):
    process.stdin.write(json.dumps(value, separators=(",", ":")) + "\n")
    process.stdin.flush()


def await_response(request_id, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        ready, _, _ = select.select([process.stdout], [], [], 0.25)
        if not ready:
            if process.poll() is not None:
                break
            continue
        line = process.stdout.readline()
        if not line:
            break
        event = json.loads(line)
        if event.get("type") == "extension_ui_request":
            reply = {"type": "extension_ui_response", "id": event["id"]}
            method = event["method"]
            if method == "editor":
                reply["value"] = event.get("prefill", "")
            elif method == "select":
                title = event.get("title", "")
                if title == "Memory kind":
                    reply["value"] = "preference"
                elif title == "Recall mode":
                    reply["value"] = "relevant"
                else:
                    reply["value"] = event.get("options", [None])[0]
            elif method == "confirm":
                reply["confirmed"] = confirm_value
            else:
                continue
            send(reply)
            continue
        if event.get("type") == "response" and event.get("id") == request_id:
            if not event.get("success"):
                raise RuntimeError(str(event))
            return event
    stderr = process.stderr.read() if process.poll() is not None else ""
    raise RuntimeError(f"RPC request {request_id} timed out; stderr={stderr}")


try:
    send({"id": "commands", "type": "get_commands"})
    commands = await_response("commands")["data"]["commands"]
    assert any(command["name"] == "memory" for command in commands)

    send({"id": "cancel-distill", "type": "prompt", "message": "/memory cancel-distill"})
    await_response("cancel-distill")
    assert list((root / "memory" / "records").glob("*.json")) == []

    confirm_value = False
    send({
        "id": "cancel",
        "type": "prompt",
        "message": "/memory add --tag smoke The user prefers cancelled smoke-test summaries.",
    })
    await_response("cancel")
    assert list((root / "memory" / "records").glob("*.json")) == []

    confirm_value = True
    send({
        "id": "add",
        "type": "prompt",
        "message": "/memory add --tag smoke The user prefers concise smoke-test summaries.",
    })
    await_response("add")
    send({"id": "entries", "type": "get_entries"})
    entries = await_response("entries")["data"]["entries"]
    assert not any(entry.get("customType") == "persistent-memory-recall" for entry in entries)
finally:
    process.send_signal(signal.SIGTERM)
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()

records = list((root / "memory" / "records").glob("*.json"))
assert len(records) == 1
assert json.loads(records[0].read_text())["content"] == "The user prefers concise smoke-test summaries."
assert "persistent-memory-recall" not in session_file.read_text()
assert records[0].stat().st_mode & 0o077 == 0
assert (root / "memory" / "records").stat().st_mode & 0o077 == 0
print("persistent-memory RPC smoke: ok")
PY
