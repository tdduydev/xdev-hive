#!/usr/bin/env python3
"""Điều phối agent theo quota: mỗi chu kỳ đo quota phiên 5 giờ và tuần của từng tài khoản, tính số agent mỗi tài khoản
chịu được tới lúc reset, chuyển agent khỏi tài khoản sắp cạn và khởi động việc trong hàng trên tài khoản còn chỗ.

jobs.json: {"<việc>": {"wt": "<worktree>", "perf": 0|1, "account": "claude-N"|null, "status": "running"|"queued"|"done"}}
"""
import datetime as dt
import json
import math
import os
import re
import signal
import subprocess
import sys
import time

A = os.environ.get("AGENT_DIR", os.path.expanduser("~/.cache/xdev-hive-agents"))
SKILL = os.path.dirname(os.path.abspath(__file__))
JOBS = os.path.join(A, "jobs.json")
LOG = os.path.join(A, "supervisor.log")
STATUS = os.path.join(A, "status.txt")
# Tài khoản được giao việc. Không đưa vào: tài khoản của phiên điều phối, tài khoản người dùng đang dùng việc khác.
ACCOUNTS = [a for a in os.environ.get("AGENT_ACCOUNTS", "").split(",") if a]
# Agent còn chạy trên các tài khoản này thì chuyển đi (hoặc về hàng chờ nếu không còn chỗ).
RETIRED = [a for a in os.environ.get("AGENT_RETIRED", "").split(",") if a]
SAFETY = 8  # % phiên chừa lại
WEEK_STOP = 95  # không giao thêm khi tuần đã dùng từ mức này
BURN = float(os.environ.get("AGENT_BURN", "11"))  # % phiên mỗi agent Opus mỗi giờ (ước tính, cập nhật theo đo)
# Sonnet tốn ít quota hơn Opus nhiều; hệ số ước tính, chỉnh theo số đo thật.
MODEL_WEIGHT = {"claude-opus-5-5": 1.0, "claude-sonnet-5-5": 0.5, "claude-haiku-5-5": 0.2}
MAX_RUNNING = int(os.environ.get("AGENT_MAX", "6"))  # máy chỉ chịu được chừng này agent build/test cùng lúc
INTERVAL = int(os.environ.get("AGENT_INTERVAL", "600"))


def log(msg):
    line = f"{dt.datetime.now():%H:%M} {msg}"
    print(line, flush=True)
    with open(LOG, "a") as f:
        f.write(line + "\n")


def parse_reset(text):
    """'Oct 13 at 4:10pm (Asia/Saigon)' hoặc 'Oct 13 at 4pm' -> datetime giờ máy (máy đặt Asia/Saigon)."""
    m = re.match(r"([A-Z][a-z]{2}) (\d+) at (\d+)(?::(\d+))?(am|pm)", text or "")
    if not m:
        return None
    mon, day, h, mi, ap = m.groups()
    h = int(h) % 12 + (12 if ap == "pm" else 0)
    now = dt.datetime.now()
    month = dt.datetime.strptime(mon, "%b").month
    when = dt.datetime(now.year, month, int(day), h, int(mi or 0))
    return when if when > now - dt.timedelta(days=200) else when.replace(year=now.year + 1)


def quota(acct):
    env = dict(os.environ, CLAUDE_CONFIG_DIR=os.path.expanduser(f"~/.xdev-hive/accounts/{acct}"))
    try:
        out = subprocess.run(
            ["claude", "-p", "/usage", "--output-format", "json", "--setting-sources", "user",
             "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'],
            env=env, capture_output=True, text=True, timeout=120, stdin=subprocess.DEVNULL, cwd=A,
        )
        text = json.loads(out.stdout).get("result") or ""
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}

    def grab(key):
        m = re.search(key + r": (\d+)% used(?: · resets (.*))?", text)
        return (int(m.group(1)), parse_reset((m.group(2) or "").strip())) if m else (None, None)

    s, sr = grab("Current session")
    w, wr = grab(r"Current week \(all models\)")
    return {"session": s, "session_reset": sr, "week": w, "week_reset": wr}


def capacity(q):
    """Số agent tài khoản chịu được tới lúc reset phiên mà không chạm (100 - SAFETY)%."""
    if not q or q.get("session") is None:
        return 0
    if q["week"] is not None and q["week"] >= WEEK_STOP:
        return 0
    left = 100 - SAFETY - q["session"]
    if left <= 0:
        return 0
    reset = q["session_reset"]
    hours = max((reset - dt.datetime.now()).total_seconds() / 3600, 0.25) if reset else 5
    return max(0, math.floor(left / (BURN * hours)))


def pids_of(job, wt):
    """Tiến trình wrapper và CLI của việc: wrapper có tên việc trong tham số, CLI có cwd là worktree."""
    out = subprocess.run(["pgrep", "-f", rf"launch(-auto|-claude)?\.sh {job} "], capture_output=True, text=True).stdout
    wrappers = [int(p) for p in out.split()]
    cli = []
    out = subprocess.run(["pgrep", "-f", "claude -p|agy -p"], capture_output=True, text=True).stdout
    for p in out.split():
        cwd = subprocess.run(["lsof", "-a", "-p", p, "-d", "cwd", "-Fn"], capture_output=True, text=True).stdout
        if f"n{wt}\n" in cwd + "\n":
            cli.append(int(p))
    return wrappers, cli


def kill_tree(pid):
    kids = subprocess.run(["pgrep", "-P", str(pid)], capture_output=True, text=True).stdout.split()
    for k in kids:
        kill_tree(int(k))
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass


def start(job, info, acct, others):
    order = ",".join([acct] + [a for a in others if a != acct])
    done = os.path.join(A, f"done-{job}")
    if os.path.exists(done):
        os.remove(done)
    # Worktree đã có commit hay file đổi: agent mới phải đọc lại phần dở thay vì làm lại từ đầu.
    dirty = subprocess.run(["git", "-C", info["wt"], "status", "--porcelain"], capture_output=True, text=True).stdout
    ahead = subprocess.run(["git", "-C", info["wt"], "log", "--oneline", "origin/main..HEAD"], capture_output=True, text=True).stdout
    env = dict(os.environ, RESUME="1") if (dirty.strip() or ahead.strip()) else dict(os.environ)
    env["MODEL"] = info.get("model", "claude-opus-5-5")
    env["EFFORT"] = info.get("effort", "high")
    subprocess.Popen(
        [os.path.join(SKILL, "launch-auto.sh"), job, info["wt"], order, str(info.get("perf", 0))],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, env=env,
    )
    info["account"], info["status"] = acct, "running"


def tick(jobs):
    qs = {a: quota(a) for a in ACCOUNTS}
    # Việc đã xong (wrapper ghi done-<việc>) thì bỏ khỏi đếm.
    for job, info in jobs.items():
        if info["status"] == "running" and os.path.exists(os.path.join(A, f"done-{job}")):
            w, c = pids_of(job, info["wt"])
            if not w and not c:
                info["status"] = "done"
                log(f"{job} xong ({open(os.path.join(A, f'done-{job}')).read().strip()})")
    cap = {a: capacity(qs[a]) for a in ACCOUNTS}
    weight = lambda i: MODEL_WEIGHT.get(i.get("model", "claude-opus-5-5"), 1.0)  # noqa: E731
    used = {a: sum(weight(i) for i in jobs.values() if i["status"] == "running" and i["account"] == a) for a in ACCOUNTS}
    spare = lambda: sorted((a for a in ACCOUNTS if cap[a] - used[a] > 0), key=lambda a: cap[a] - used[a], reverse=True)  # noqa: E731
    for a in RETIRED:
        cap[a], used[a], qs[a] = 0, sum(1 for i in jobs.values() if i["status"] == "running" and i["account"] == a), {}
    # Chuyển agent khỏi tài khoản quá sức hoặc đã loại (agent khởi động muộn nhất đi trước).
    for a in RETIRED + ACCOUNTS:
        while used[a] > cap[a]:
            movable = [j for j, i in jobs.items() if i["status"] == "running" and i["account"] == a]
            target = next((t for t in spare() if t != a), None)
            if movable and not target and a in RETIRED:
                # Tài khoản đã loại (người dùng cần cho việc khác): dừng hẳn, đưa về hàng chờ; phần đã sửa nằm trong worktree.
                job = movable[-1]
                w, c = pids_of(job, jobs[job]["wt"])
                for p in w + c:
                    kill_tree(p)
                jobs[job]["status"], jobs[job]["account"] = "queued", None
                used[a] -= 1
                log(f"dừng {job} trên {a} (đã loại), đưa vào hàng chờ")
                continue
            if not movable or not target:
                if movable:
                    log(f"{a} quá sức ({used[a]}/{cap[a]}) nhưng không còn tài khoản rảnh; để chạy tiếp")
                break
            job = movable[-1]
            info = jobs[job]
            w, c = pids_of(job, info["wt"])
            for p in w + c:
                kill_tree(p)
            time.sleep(3)
            start(job, info, target, ACCOUNTS)
            used[a] -= weight(info)
            used[target] += weight(info)
            log(f"chuyển {job}: {a} -> {target} (phiên {a} {qs[a].get('session')}%, chịu được {cap[a]})")
    # Khởi động việc trong hàng.
    running = sum(used.values())
    for job, info in jobs.items():
        if info["status"] != "queued" or running >= MAX_RUNNING:
            continue
        target = next(iter(spare()), None)
        if not target:
            break
        start(job, info, target, ACCOUNTS)
        used[target] += weight(info)
        running += 1
        log(f"bắt đầu {job} trên {target}")
    with open(STATUS, "w") as f:
        f.write(f"{dt.datetime.now():%H:%M}\n")
        for a in ACCOUNTS:
            q = qs[a]
            r = q.get("session_reset")
            f.write(f"{a}: phiên {q.get('session')}% (reset {r:%H:%M} )" if r else f"{a}: phiên {q.get('session')}%")
            f.write(f", tuần {q.get('week')}%, chịu được {cap[a]}, đang chạy {used[a]}: ")
            f.write(", ".join(j for j, i in jobs.items() if i["status"] == "running" and i["account"] == a) + "\n")
        f.write("hàng chờ: " + ", ".join(j for j, i in jobs.items() if i["status"] == "queued") + "\n")
    with open(JOBS, "w") as f:
        json.dump(jobs, f, indent=2, ensure_ascii=False)


def main():
    once = "--once" in sys.argv
    while True:
        with open(JOBS) as f:
            jobs = json.load(f)
        try:
            tick(jobs)
        except Exception as e:  # noqa: BLE001
            log(f"lỗi chu kỳ: {e}")
        if once or not any(i["status"] in ("running", "queued") for i in jobs.values()):
            break
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
