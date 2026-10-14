"""Sinh lại testdata/home: transcript giả (không lấy từ máy thật) để test tokenreport.

Chạy: python3 -I gen.py <thư mục đích>. Số mong đợi trong testdata/expected.json do scripts/token-audit.ts tính trên
đúng thư mục này (HOME=<thư mục đích> node scripts/token-audit.ts --json), nên đổi fixture thì sinh lại cả hai.
"""

import json
import os
import sys
from datetime import datetime, timezone

root = sys.argv[1]


def w(rel, lines, raw_tail=None):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        for line in lines:
            f.write(line if isinstance(line, str) else json.dumps(line, ensure_ascii=False, separators=(",", ":")))
            f.write("\n")
        if raw_tail is not None:
            f.write(raw_tail)


def asst(mid, ts, usage, blocks, model="claude-opus-5-5"):
    return {"type": "assistant", "timestamp": ts, "message": {"id": mid, "model": model, "usage": usage, "content": blocks}}


def use(i, name, inp):
    return {"type": "tool_use", "id": i, "name": name, "input": inp}


def res(ts, i, content):
    return {"type": "user", "timestamp": ts, "message": {"content": [{"type": "tool_result", "tool_use_id": i, "content": content}]}}


def u(inp, out, cr, cw, w1=None, w5=None):
    d = {"input_tokens": inp, "output_tokens": out, "cache_read_input_tokens": cr, "cache_creation_input_tokens": cw}
    if w1 is not None:
        d["cache_creation"] = {"ephemeral_1h_input_tokens": w1, "ephemeral_5m_input_tokens": w5}
    return d


def head(ts, cwd, ep, ver="2.1.296"):
    return {"type": "user", "timestamp": ts, "cwd": cwd, "entrypoint": ep, "version": ver, "message": {"role": "user", "content": "xin chào"}}


def instr(ts, **files):
    return {"type": "attachment", "timestamp": ts, "attachment": {"type": "instructions", "files": [{"type": k, "content": "x" * v} for k, v in files.items()]}}


def hook(ts, cmd):
    return {"type": "attachment", "timestamp": ts, "attachment": {"type": "hook_success", "command": cmd}}


A = ".xdev-hive/accounts/"

# Phiên worker có compact, đọc lại file, hook RTK. Trước mốc 2026-10-10.
t = "2026-10-01T01:00:0%dZ"
w(A + "claude-1/projects/-p1/worker-1.jsonl", [
    head(t % 0, "/Users/u/.xdev-hive/worktrees/task-1", "sdk-cli"),
    instr(t % 1, Project=400, AutoMem=120),
    hook(t % 1, "rtk hook claude"),
    asst("m1", t % 2, u(10, 20, 1000, 300, 100, 200), [use("t1", "Bash", {"command": "cd /w && GOFLAGS=-v go test ./..."})]),
    res(t % 3, "t1", "a" * 400),
    asst("m2", t % 4, u(5, 10, 1200, 0), [use("t2", "Read", {"file_path": "/w/a.go", "offset": 1, "limit": 50})]),
    res(t % 5, "t2", [{"type": "text", "text": "b" * 80}]),
    asst("m2", t % 5, u(5, 10, 1200, 0), [use("t3", "Read", {"file_path": "/w/a.go", "offset": 1, "limit": 50})]),
    res(t % 6, "t3", [{"type": "text", "text": "b" * 80}]),
    asst("m3", t % 6, u(4, 6, 1300, 50, 0, 50), [use("t4", "Bash", {"command": "pnpm --filter @xdev-hive/hub test"})]),
    res(t % 7, "t4", "c" * 2000),
    {"type": "system", "subtype": "compact_boundary", "timestamp": t % 7},
    asst("m4", t % 8, u(3, 4, 900, 10, 10, 0), [use("t5", "Bash", {"command": "git status"})]),
    res(t % 9, "t5", "d" * 40),
    res(t % 9, "tX", "orphan result"),
])
# Subagent của phiên trên, hook guard.
w(A + "claude-1/projects/-p1/worker-1/subagents/agent-a.jsonl", [
    head(t % 0, "/Users/u/.xdev-hive/worktrees/task-1", "sdk-cli", "2.1.250"),
    hook(t % 1, "/x/hive-worker hook post-tool"),
    asst("s1", t % 2, u(2, 3, 100, 20, 0, 20), [use("u1", "Grep", {"pattern": "x"})]),
    res(t % 3, "u1", "e" * 100),
])
# Hai thư mục không được đọc: memory/ và tool-results/.
w(A + "claude-1/projects/-p1/worker-1/tool-results/skip.jsonl", [asst("z1", t % 2, u(99, 99, 99, 99), [])])
w(A + "claude-1/projects/-p1/memory/skip.jsonl", [asst("z2", t % 2, u(99, 99, 99, 99), [])])
w(A + "claude-1/projects/-p1/memory/MEMORY.md", ["- [A](feedback.md) hook", "- [Gone](missing.md) hook"])
w(A + "claude-1/projects/-p1/memory/feedback.md", ["---", "name: feedback-a", "---", "xem [[ref-b]] và [[nope]]"])
w(A + "claude-1/projects/-p1/memory/ref.md", ["---", "name: ref-b", "---", "mồ côi, không có trong MEMORY.md"])

# Phiên tương tác sau mốc: dòng hỏng giữa file, dòng ghi dở cuối file, ảnh, chữ có dấu và emoji.
t2 = "2026-10-12T08:00:0%dZ"
w(A + "claude-2/projects/-p1/inter-1.jsonl", [
    head(t2 % 0, "/Users/u/work/app", "cli"),
    instr(t2 % 1, Project=800, User=60),
    asst("n1", t2 % 2, u(20, 40, 5000, 1000, 1000, 0), [use("v1", "Read", {"file_path": "/work/app/x.ts"}), use("v2", "Bash", {"command": "ls -la"})]),
    "{not json",
    res(t2 % 3, "v1", [{"type": "image", "source": {"data": "A" * 400}}, {"type": "text", "text": "Tiếng Việt có dấu 😀"}]),
    res(t2 % 3, "v2", "f" * 200),
    asst("n2", t2 % 4, u(8, 9, 6000, 0), [use("v3", "Read", {"file_path": "/work/app/x.ts"})]),
    res(t2 % 5, "v3", "g" * 60),
], raw_tail='{"type":"assistant","message":{"id":"n3","usage":{"input_tok')
# Terminal do Leader điều khiển: cwd trong worktree nhưng không phải sdk-cli.
w(A + "claude-2/projects/-p1/hubterm.jsonl", [
    head(t2 % 0, "/Users/u/.xdev-hive/runs/r1", "cli"),
    asst("h1", t2 % 1, u(1, 2, 300, 0), [use("w1", "Edit", {"file_path": "/x"})]),
    res(t2 % 2, "w1", "ok"),
])
w(A + "claude-2/projects/-p1/memory/MEMORY.md", ["- [A](feedback.md) hook"])
w(A + "claude-2/projects/-p1/memory/feedback.md", ["---", "name: feedback-a", "---", "trùng tên với gói claude-1"])

# Đăng nhập mặc định của CLI.
D = ".claude/projects/-p3/"
t3 = "2026-10-02T10:00:0%dZ"
w(D + "head-1.jsonl", [
    head(t3 % 0, "/work/repo", "sdk-cli"),
    asst("k1", t3 % 1, u(7, 8, 200, 30, 0, 30), [use("y1", "Bash", {"command": "FOO=1 cargo test"})]),
    res(t3 % 2, "y1", "h" * 120),
])
w(D + "test-1.jsonl", [
    head(t3 % 0, "/var/folders/ab/T/TestZZ123", "cli"),
    asst("k2", t3 % 1, u(1, 1, 10, 10, 0, 10), []),
])
t4 = "2026-10-13T10:00:0%dZ"
w(D + "int-1.jsonl", [
    head(t4 % 0, "/Users/u/work/other", "cli"),
    asst("i1", t4 % 1, u(10, 10, 160000, 500, 0, 500), [use("x1", "Bash", {"command": "rtk git log"})]),
    res(t4 % 2, "x1", "i" * 4000),
    hook(t4 % 2, "rtk hook claude"),
    asst("i2", t4 % 3, u(10, 10, 161000, 0), []),
])


# Codex.
def cx(ts, typ, payload):
    return {"timestamp": ts, "type": typ, "payload": payload}


def tc(ts, tot, last):
    return cx(ts, "event_msg", {"type": "token_count", "info": {"total_token_usage": tot, "last_token_usage": last}})


c1 = "2026-10-01T12:00:0%dZ"
w(A + "codex-1/sessions/2026/10/rollout-a.jsonl", [
    cx(c1 % 0, "session_meta", {"cwd": "/Users/u/work/app", "originator": "codex_cli", "cli_version": "0.99.0"}),
    cx(c1 % 0, "turn_context", {"model": "gpt-6"}),
    cx(c1 % 1, "response_item", {"type": "function_call", "call_id": "c1", "name": "shell"}),
    tc(c1 % 2, {"input_tokens": 1000, "cached_input_tokens": 600, "cache_write_input_tokens": 0, "output_tokens": 50, "reasoning_output_tokens": 10}, {"input_tokens": 1000}),
    cx(c1 % 3, "response_item", {"type": "function_call_output", "call_id": "c1", "output": "j" * 300}),
    cx(c1 % 3, "response_item", {"type": "custom_tool_call", "call_id": "c2", "name": "apply_patch"}),
    tc(c1 % 4, {"input_tokens": 2500, "cached_input_tokens": 1800, "cache_write_input_tokens": 20, "output_tokens": 90, "reasoning_output_tokens": 30}, {"input_tokens": 1500}),
    cx(c1 % 5, "response_item", {"type": "custom_tool_call_output", "call_id": "c2", "output": {"ok": True, "n": 1}}),
    tc(c1 % 6, {"input_tokens": 4000, "cached_input_tokens": 3000, "cache_write_input_tokens": 20, "output_tokens": 120, "reasoning_output_tokens": 40}, {"input_tokens": 1500}),
])
c2 = "2026-10-11T12:00:0%dZ"
w(".codex/sessions/2026/10/rollout-b.jsonl", [
    cx(c2 % 0, "session_meta", {"cwd": "/work/repo", "originator": "codex_exec", "cli_version": "0.98.0"}),
    cx(c2 % 1, "response_item", {"type": "local_shell_call", "call_id": "d1"}),
    tc(c2 % 2, {"input_tokens": 500, "cached_input_tokens": 100, "output_tokens": 20, "reasoning_output_tokens": 0}, {"input_tokens": 500}),
    cx(c2 % 3, "response_item", {"type": "function_call_output", "call_id": "d1", "output": "k" * 50}),
])
# Tên không bắt đầu bằng rollout- nên không được đọc.
w(".codex/sessions/2026/10/not-a-rollout.jsonl", [tc(c2 % 2, {"input_tokens": 9}, {"input_tokens": 9})])

for rel, body in [
    (A + "codex-1/AGENTS.md", "a" * 123),
    (".codex/memories_1.sqlite", "s" * 456),
    (".gemini/GEMINI.md", "g" * 78),
]:
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as f:
        f.write(body)

# Sổ hook cục bộ (chỉ số): ts dạng RFC 3339, giây Unix và mili giây Unix, một dòng hỏng, một dòng cũ.
w(".xdev-hive/optimizer/sessions/s1/ledger.jsonl", [
    {"ts": "2026-10-11T09:00:00Z", "tool": "Bash", "before": 30000, "after": 12000},
    {"ts": int(datetime(2026, 10, 11, 10, tzinfo=timezone.utc).timestamp()), "tool": "Bash", "before": 5000, "after": 5000},
    {"ts": "2026-10-12T09:00:00Z", "tool": "Read", "before": 20000, "after": 8000},
    "{torn",
])
w(".xdev-hive/optimizer/sessions/s2/ledger.jsonl", [
    {"ts": int(datetime(2026, 10, 13, 10, tzinfo=timezone.utc).timestamp() * 1000), "tool": "Bash", "before": 9000, "after": 3000},
    {"ts": "2026-09-01T00:00:00Z", "tool": "Bash", "before": 100000, "after": 1000},
])
